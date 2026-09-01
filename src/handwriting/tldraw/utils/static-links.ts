/**
 * Card / SingleBlock 共享的静态内容链接解析与导航逻辑。
 * 两个形状此前各自维护一份相同实现，已出现行为漂移，统一收敛到这里。
 */

import { openTab, showMessage } from 'siyuan'

export const SIYUAN_BLOCK_ID_RE = /\b\d{14}-[0-9a-z]{7}\b/i
export const STEVE_TOOLS_PLUGIN_URL_RE = /^(?:https:\/\/|siyuan:\/\/)plugins\/siyuan-steve-tools\//i

export function decodeLinkTarget(value: string) {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.trim()
}

export function getSiyuanBlockIdFromLink(rawHref: string): string | null {
	const href = decodeLinkTarget(rawHref)
	const directMatch = href.match(/^siyuan:\/\/blocks\/(\d{14}-[0-9a-z]{7})/i)
	if (directMatch) return directMatch[1]
	if (/^\d{14}-[0-9a-z]{7}$/i.test(href)) return href

	try {
		const parsed = new URL(href, window.location.href)
		const idFromQuery = parsed.searchParams.get('id') || parsed.searchParams.get('blockId')
		if (idFromQuery && SIYUAN_BLOCK_ID_RE.test(idFromQuery)) return idFromQuery.match(SIYUAN_BLOCK_ID_RE)![0]
		const idFromHash = parsed.hash.match(SIYUAN_BLOCK_ID_RE)
		if (idFromHash) return idFromHash[0]
	} catch {
		// ignore invalid or relative URLs
	}

	return null
}

export function isSteveToolsPluginUrl(rawHref: string) {
	return STEVE_TOOLS_PLUGIN_URL_RE.test(decodeLinkTarget(rawHref))
}

export function clearStaticTextSelection() {
	try {
		window.getSelection()?.removeAllRanges()
	} catch {
		// ignore
	}
}

export function clearStaticTextSelectionSoon() {
	clearStaticTextSelection()
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(clearStaticTextSelection)
	} else {
		window.setTimeout(clearStaticTextSelection, 0)
	}
}

export function findStaticLinkTarget(target: EventTarget | null, root: HTMLElement | null) {
	if (!(target instanceof HTMLElement) || !root) return null

	let el: HTMLElement | null = target
	while (el && root.contains(el)) {
		const dataType = el.getAttribute('data-type') || ''
		const dataHref = el.getAttribute('data-href') || ''
		const href = el instanceof HTMLAnchorElement ? el.getAttribute('href') || dataHref : dataHref
		const nodeId =
			el.getAttribute('data-id') ||
			el.getAttribute('data-node-id') ||
			el.getAttribute('data-av-id') ||
			''

		if ((dataType.includes('block-ref') || dataType.includes('file-annotation-ref')) && SIYUAN_BLOCK_ID_RE.test(nodeId)) {
			return { blockId: nodeId.match(SIYUAN_BLOCK_ID_RE)![0], href: '' }
		}

		if (href) {
			return { blockId: getSiyuanBlockIdFromLink(href), href: decodeLinkTarget(href) }
		}

		if (el === root) break
		el = el.parentElement
	}

	return null
}

/**
 * 打开静态预览中的链接目标：块引用走 openTab，普通链接按协议处理。
 */
export function openStaticLinkTarget(target: { blockId: string | null; href: string }, errorPrefix = '打开链接失败') {
	if (target.blockId) {
		if (!window.siyuan?.ws?.app) return
		void openTab({
			app: window.siyuan.ws.app,
			doc: {
				id: target.blockId,
				action: ['cb-get-hl', 'cb-get-all'],
				zoomIn: false,
			},
			position: 'right',
			keepCursor: false,
		}).catch((err) => {
			console.error('jump to linked block failed', err)
			try {
				showMessage('跳转到链接块失败', 3000, 'error')
			} catch {
				// ignore
			}
		})
		return
	}

	if (!target.href || target.href === '#') return
	const href = target.href.startsWith('assets/') ? `/${target.href}` : target.href
	if (isSteveToolsPluginUrl(href)) return

	try {
		if (href.startsWith('siyuan://')) {
			window.location.href = href
		} else {
			window.open(href, '_blank', 'noopener')
		}
	} catch (err) {
		console.error('open static link failed', err)
		try {
			showMessage(errorPrefix, 3000, 'error')
		} catch {
			// ignore
		}
	}
}
