import { stDebugLog } from './render/st-debug-log'

/**
 * 识别 /assets/ 链接并尝试用系统默认程序打开本地文件（Excel 等）。
 *
 * 背景：白板卡片里的附件链接形如 https://127.0.0.1:64486/assets/xxx.xlsx，
 * window.open 会走系统浏览器并撞思源自签证书（Privacy error）。
 * 这里把链接换算成本地绝对路径（<dataDir>/assets/<文件名>），
 * 通过思源主进程的 shell.openPath 调起本地默认程序（如 Excel）。
 *
 * 成功返回 true，调用方应直接 return，不再走 window.open 兜底。
 */
export function tryOpenAssetLocally(href: string): boolean {
	if (!href) return false

	// 提取 assets/<文件名> 段（兼容相对、绝对、带 origin 三种形式）
	let name: string | null = null
	try {
		const url = new URL(href, 'http://localhost')
		const match = url.pathname.match(/\/assets\/([^/?#]+)$/i)
		if (match) name = match[1]
	} catch {
		const match = String(href).replace(/[?#].*$/, '').match(/assets\/([^/]+)$/i)
		if (match) name = match[1]
	}
	if (!name) return false

	try {
		name = decodeURIComponent(name)
	} catch {
		// 保留原样
	}
	// 防目录穿越：资产文件名不应包含路径分隔符
	if (!name || /[\\/]/.test(name) || name === '..') return false

	const win = window as any
	const dataDir = win.siyuan?.config?.system?.dataDir
	if (!dataDir) {
		stDebugLog('[ST-debug] openAsset failed: no dataDir', href)
		return false
	}

	try {
		const pathMod = win.require?.('path')
		const ipcRenderer = win.require?.('electron')?.ipcRenderer
		if (!pathMod || !ipcRenderer) {
			stDebugLog('[ST-debug] openAsset failed: no ipcRenderer', href)
			return false
		}
		const filePath = pathMod.join(dataDir, 'assets', name)
		ipcRenderer.send('siyuan-cmd', { cmd: 'openPath', filePath })
		stDebugLog('[ST-debug] openAsset opened', filePath)
		return true
	} catch (err) {
		stDebugLog('[ST-debug] openAsset failed', href, err)
		return false
	}
}
