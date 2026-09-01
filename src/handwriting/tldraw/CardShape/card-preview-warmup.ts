/**
 * Card 静态预览的预载环预热。
 *
 * ShapeLoadManager 计算了视口外扩 35% 的预载环但从不给完整准入。这里把
 * 预载环内、尚未获得准入的 Card 以最低优先级塞进静态预览队列，提前把
 * getDoc 结果写入缓存（不挂 DOM）。用户平移到位时命中缓存即可立即上屏。
 *
 * 仅用于非 isMain 卡片：isMain 的预览会在正文外拼装题头图与标题，预热
 * 写入的是纯正文包装，二者结构不同，为避免缓存结构分叉暂不覆盖。
 */

import * as api from '@/api/api'
import { enqueueStaticPreviewLoad } from '../static-preview-load-queue'
import { isInteracting } from '../utils/idle-scheduler'
import { getLightweightPreviewTextFromElement } from '../utils/lightweight-preview'
import { convertProtyleHtmlToDom } from '../utils/render/content-html-converter'
import { cacheStaticPreview, getCachedPreview } from './static-preview-cache'

const warmingInFlight = new Set<string>()
const WARM_PRIORITY = 1500

export function warmCardStaticPreview(blockId: string, blockLimit: number) {
	if (!blockId || warmingInFlight.has(blockId)) return
	if (getCachedPreview(blockId, blockLimit)) return
	if (isInteracting()) return

	warmingInFlight.add(blockId)
	void enqueueStaticPreviewLoad(`warm-card-preview-${blockId}`, WARM_PRIORITY, async (signal) => {
		try {
			if (signal.aborted) return
			if (getCachedPreview(blockId, blockLimit)) return
			// 排队期间可能开始交互；交给下一次触发重新预热
			if (isInteracting()) return
			const res = await api.getDoc(blockId, { size: blockLimit, signal })
			if (signal.aborted || !res?.content) return
			// 与挂载路径保持相同结构：protyle-wysiwyg 包一层，便于命中路径直接取 firstElementChild
			const wrapper = document.createElement('div')
			wrapper.className = 'protyle-wysiwyg protyle-wysiwyg--attr'
			wrapper.innerHTML = res.content
			try {
				convertProtyleHtmlToDom(wrapper)
			} catch {
				// 预热失败不致命，挂载路径会再次尝试
			}
			cacheStaticPreview(blockId, wrapper.outerHTML, blockLimit, getLightweightPreviewTextFromElement(wrapper))
		} catch (err) {
			if (!signal.aborted) console.warn('预热卡片静态预览失败:', err)
		} finally {
			warmingInFlight.delete(blockId)
		}
	}).finished.catch(() => {
		warmingInFlight.delete(blockId)
	})
}
