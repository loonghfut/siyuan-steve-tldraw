import * as api from '@/api/api'

/**
 * 批量块存在性检查：把短时间窗口内的检查合并成少量 SQL 请求。
 * 旧实现（仅 Card 使用）会在延迟后为每个 Card 单独发起一次查询，形状多时
 * 会和首屏 DOM 请求争抢网络与内核线程；SingleBlock 也改为复用该机制，
 * 用一次批量 SQL 判定"块不存在"，省去 DOM/markdown 两级回退请求。
 *
 * 判定分两级：批量 SQL 是快路径；SQL 未命中的块必须再用 /api/block/checkBlocksExist
 * 复核后才算真的不存在。原因是内核 blocks 表由 util.SQLFlushInterval(3s) 定时批量提交，
 * appendBlock 返回时新块往往还查不到，单看 SQL 会把刚创建的块误报为"找不到绑定块"。
 */

interface BlockCheckEntry {
	shapeId: string
	resolve: (exists: boolean) => void
}

const blockCheckQueue = new Map<string, BlockCheckEntry[]>();
const blockExistenceCache = new Map<string, { exists: boolean; checkedAt: number }>();
const BLOCK_EXISTENCE_CACHE_TTL_MS = 30_000;
// “不存在”只做极短缓存：内核 blocks 表最长有 util.SQLFlushInterval(3s) 的提交延迟，
// 长缓存会把一次误判固化，形状得等 TTL 过期才可能自愈。
const BLOCK_MISSING_CACHE_TTL_MS = 3_000;
const BLOCK_CHECK_BATCH_SIZE = 100;
const BLOCK_CHECK_DELAY_MS = 500;
let blockCheckTimer: number | null = null;

function cacheTtlOf(entry: { exists: boolean }) {
	return entry.exists ? BLOCK_EXISTENCE_CACHE_TTL_MS : BLOCK_MISSING_CACHE_TTL_MS;
}

// 存在性缓存只用于短时合并重复检查，读取逻辑已按 TTL 判断命中；这里在
// 写入/读取时顺手清掉过期条目，避免长期切换白板后 Map 只增不减。
function pruneBlockExistenceCache(now = Date.now()) {
	for (const [blockId, entry] of blockExistenceCache) {
		if (now - entry.checkedAt >= cacheTtlOf(entry)) {
			blockExistenceCache.delete(blockId)
		}
	}
}

export function invalidateBlockExistenceCache(blockId: string) {
	blockExistenceCache.delete(blockId)
}

/**
 * 登记“块确实存在”。Card / SingleBlock 首次进入编辑懒创建块后立即调用：
 * appendBlock 返回时内核 SQL 索引可能尚未提交，若形状此时退出编辑（移动端抽屉
 * 编辑会同步撤销内联编辑态），存在性检查会把刚建好的块误报为“找不到绑定块”。
 */
export function markBlockExisting(blockId: string) {
	if (!blockId) return
	blockExistenceCache.set(blockId, { exists: true, checkedAt: Date.now() })
}

export function scheduleBlockCheck(blockId: string, shapeId: string): Promise<boolean> {
	return new Promise((resolve) => {
		const cached = blockExistenceCache.get(blockId);
		if (cached) {
			if (Date.now() - cached.checkedAt < cacheTtlOf(cached)) {
				queueMicrotask(() => resolve(cached.exists));
				return;
			}
			blockExistenceCache.delete(blockId)
		}

		const list = blockCheckQueue.get(blockId) || [];
		list.push({ shapeId, resolve });
		blockCheckQueue.set(blockId, list);

		if (blockCheckTimer === null) {
			blockCheckTimer = window.setTimeout(async () => {
				blockCheckTimer = null;
				const entries = [...blockCheckQueue.entries()];
				blockCheckQueue.clear();

				const ids = entries.map(([bid]) => bid);
				for (let start = 0; start < ids.length; start += BLOCK_CHECK_BATCH_SIZE) {
					const batchEntries = entries.slice(start, start + BLOCK_CHECK_BATCH_SIZE);
					const batchIds = batchEntries.map(([bid]) => bid);
					const escapedIds = batchIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
					const existingIds = new Set<string>();
					let sqlUsable = false;
					try {
						const rows = await api.sql(`SELECT id FROM blocks WHERE id IN (${escapedIds})`);
						// api.request 在 code!==0 时返回 "<url>error" 字符串而非抛异常，
						// 必须显式判定数组，否则 rows.map 抛错会让整批块被误判为不存在
						if (Array.isArray(rows)) {
							sqlUsable = true;
							for (const row of rows as Array<{ id?: string }>) {
								const id = String(row?.id || '');
								if (id) existingIds.add(id);
							}
						}
					} catch {
						// 查询失败不等于块不存在，下面统一用 blocktrees 复核
					}

					// SQL 未命中（或查询不可用）的块用 blocktrees 复核：blocks 表异步提交，
					// 刚创建的块最长 3s 内查不到；blocktrees 在事务内同步写入，无该延迟。
					const unconfirmedIds = batchIds.filter((id) => !existingIds.has(id));
					const treeExists = unconfirmedIds.length
						? await api.checkBlocksExist(unconfirmedIds).catch(() => null)
						: null;

					for (const [bid, callbacks] of batchEntries) {
						let exists = existingIds.has(bid);
						let cacheable = sqlUsable;
						if (!exists) {
							const inTree = treeExists?.get(bid);
							if (inTree === undefined || inTree === null) {
								// 无法判定（内核/网络不可用）：宁可保留形状，也不误报“找不到绑定块”，
								// 且不写缓存，下一次检查重新判定
								exists = true;
								cacheable = false;
							} else {
								exists = inTree;
								cacheable = true;
							}
						}
						if (cacheable) blockExistenceCache.set(bid, { exists, checkedAt: Date.now() });
						callbacks.forEach((cb) => cb.resolve(exists));
					}
				}
				pruneBlockExistenceCache()
			}, BLOCK_CHECK_DELAY_MS);
		}
	});
}
