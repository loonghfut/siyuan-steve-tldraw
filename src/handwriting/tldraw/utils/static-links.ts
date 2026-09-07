/**
 * Card / SingleBlock 共享的静态内容链接解析与导航逻辑。
 * 两个形状此前各自维护一份相同实现，已出现行为漂移，统一收敛到这里。
 */

import { fetchSyncPost, showMessage } from 'siyuan'
import { openSiYuanDoc } from './mobile-open'

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

/** 获取 electron ipcRenderer（仅桌面端且开启 node 集成时可用；浏览器/远程内核返回 null） */
function getIpcRenderer(): { send: (channel: string, ...args: any[]) => void } | null {
	try {
		const w = window as any
		const electron = w.require?.('electron') ?? w.electron
		return electron?.ipcRenderer ?? null
	} catch {
		return null
	}
}

/** 是否为本地附件链接（/assets/... 或 assets/...） */
export function isAssetLink(href: string): boolean {
	try {
		const parsed = new URL(href, window.location.href)
		return parsed.pathname.startsWith('/assets/')
	} catch {
		return href.startsWith('/assets/') || href.startsWith('assets/')
	}
}

/**
 * 尝试在本地用系统默认程序打开附件。
 * 附件链接形如 https://127.0.0.1:64486/assets/xxx.xlsx，window.open 会走系统浏览器撞自签证书；
 * 这里先经内核 /api/asset/resolveAssetPath 换算绝对路径，再经 ipc 调主进程 shell.openPath。
 * 返回 true 表示已接管打开；false 表示调用方应回退到 window.open。
 */
export async function tryOpenAssetLocally(href: string): Promise<boolean> {
	if (!isAssetLink(href)) return false
	const ipc = getIpcRenderer()
	if (!ipc) return false
	try {
		const parsed = new URL(href, window.location.href)
		// pathname 为百分号编码，内核按字面路径查找，需先解码（中文/空格文件名）
		const assetPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
		if (!assetPath) return false
		const res = await fetchSyncPost('/api/asset/resolveAssetPath', { path: assetPath })
		const filePath = res?.code === 0 ? res.data : null
		if (!filePath || typeof filePath !== 'string') return false
		ipc.send('siyuan-cmd', { cmd: 'openPath', filePath })
		return true
	} catch (err) {
		console.warn('resolve/open asset locally failed', err)
		return false
	}
}

/**
 * 打开静态预览中的链接目标：块引用跳转对应文档，普通链接按协议处理。
 * （移动端 openTab 为空操作，openSiYuanDoc 内部改走 openMobileFileById）
 */
export function openStaticLinkTarget(target: { blockId: string | null; href: string }, errorPrefix = '打开链接失败') {
	if (target.blockId) {
		if (!window.siyuan?.ws?.app) return
		openSiYuanDoc(window.siyuan.ws.app, target.blockId, { position: 'right', errorPrefix: '跳转到链接块失败' })
		return
	}

	if (!target.href || target.href === '#') return
	const href = target.href.startsWith('assets/') ? `/${target.href}` : target.href
	if (isSteveToolsPluginUrl(href)) return

	try {
		if (href.startsWith('siyuan://')) {
			window.location.href = href
			return
		}
		// 附件链接优先本地打开（桌面端 shell.openPath），不可用时回退 window.open
		void tryOpenAssetLocally(href).then((handled) => {
			if (!handled) window.open(href, '_blank', 'noopener')
		})
	} catch (err) {
		console.error('open static link failed', err)
		try {
			showMessage(errorPrefix, 3000, 'error')
		} catch {
			// ignore
		}
	}
}
