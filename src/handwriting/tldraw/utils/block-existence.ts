import * as api from '@/api/api'

/**
 * 批量块存在性检查：把短时间窗口内的检查合并成少量 SQL 请求。
 * 旧实现（仅 Card 使用）会在延迟后为每个 Card 单独发起一次查询，形状多时
 * 会和首屏 DOM 请求争抢网络与内核线程；SingleBlock 也改为复用该机制，
 * 用一次批量 SQL 判定"块不存在"，省去 DOM/markdown 两级回退请求。
 */

interface BlockCheckEntry {
	shapeId: string
	resolve: (exists: boolean) => void
}

const blockCheckQueue = new Map<string, BlockCheckEntry[]>();
const blockExistenceCache = new Map<string, { exists: boolean; checkedAt: number }>();
const BLOCK_EXISTENCE_CACHE_TTL_MS = 30_000;
const BLOCK_CHECK_BATCH_SIZE = 100;
const BLOCK_CHECK_DELAY_MS = 500;
let blockCheckTimer: number | null = null;

// 存在性缓存只用于短时合并重复检查，读取逻辑已按 TTL 判断命中；这里在
// 写入/读取时顺手清掉过期条目，避免长期切换白板后 Map 只增不减。
function pruneBlockExistenceCache(now = Date.now()) {
	for (const [blockId, entry] of blockExistenceCache) {
		if (now - entry.checkedAt >= BLOCK_EXISTENCE_CACHE_TTL_MS) {
			blockExistenceCache.delete(blockId)
		}
	}
}

export function invalidateBlockExistenceCache(blockId: string) {
	blockExistenceCache.delete(blockId)
}

export function scheduleBlockCheck(blockId: string, shapeId: string): Promise<boolean> {
	return new Promise((resolve) => {
		const cached = blockExistenceCache.get(blockId);
		if (cached) {
			if (Date.now() - cached.checkedAt < BLOCK_EXISTENCE_CACHE_TTL_MS) {
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
					let existingIds = new Set<string>();
					let querySucceeded = false;
					try {
						const rows = await api.sql(`SELECT id FROM blocks WHERE id IN (${escapedIds})`);
						existingIds = new Set((rows || []).map((row: { id?: string }) => String(row?.id || '')));
						querySucceeded = true;
					} catch {
						// Keep the previous fail-safe behaviour: an unavailable block
						// check must not keep a stale Protyle alive indefinitely.
					}

					for (const [bid, callbacks] of batchEntries) {
						const exists = existingIds.has(bid);
						if (querySucceeded) blockExistenceCache.set(bid, { exists, checkedAt: Date.now() });
						callbacks.forEach((cb) => cb.resolve(exists));
					}
				}
				pruneBlockExistenceCache()
			}, BLOCK_CHECK_DELAY_MS);
		}
	});
}
