/**
 * Card 静态预览缓存。
 *
 * 独立成模块以便 CardShapeUtil 与预载环预热（card-preview-warmup）共用，
 * 避免两者互相引用形成循环依赖。
 *
 * 缓存键只使用 blockId；条目记录生成时的块窗口上限（blockLimit）。
 * 命中条件是缓存条目覆盖的块数不少于当前需要的窗口（超集即可复用），
 * 因此调整字号不再触发重新请求。命中时会刷新 LRU 位置。
 */

export interface StaticPreviewCacheEntry {
	html: string
	blockLimit: number
	/** 生成该预览时提取的轻量预览文本，命中时直接复用，避免重新解析 HTML。 */
	previewText: string
	/** HTML 中的富内容（公式/mermaid/嵌入等）是否已完成渲染。 */
	rendered?: boolean
}

const staticPreviewCache = new Map<string, StaticPreviewCacheEntry>()
const MAX_CACHE_SIZE = 50;

function evictOldest() {
	if (staticPreviewCache.size < MAX_CACHE_SIZE) return
	const firstKey = staticPreviewCache.keys().next().value
	if (firstKey) staticPreviewCache.delete(firstKey)
}

export function cacheStaticPreview(blockId: string, html: string, blockLimit: number, previewText: string, rendered = false) {
	if (!blockId || !html) return
	// 重新插入使其成为"最新使用"，配合 FIFO 头部淘汰实现 LRU
	staticPreviewCache.delete(blockId)
	evictOldest()
	staticPreviewCache.set(blockId, { html, blockLimit, previewText, rendered })
}

/**
 * 返回覆盖当前所需窗口的缓存条目（blockLimit 为超集即命中），并刷新 LRU 位置。
 */
export function getCachedPreview(blockId: string, blockLimit: number): StaticPreviewCacheEntry | null {
	const cached = staticPreviewCache.get(blockId)
	if (!cached) return null
	if (!Number.isFinite(cached.blockLimit) || cached.blockLimit < blockLimit) return null
	staticPreviewCache.delete(blockId)
	staticPreviewCache.set(blockId, cached)
	return cached
}

export function invalidatePreviewCache(blockId: string) {
	staticPreviewCache.delete(blockId)
}
