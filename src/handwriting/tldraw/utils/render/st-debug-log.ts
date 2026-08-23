/**
 * ST-debug 统一日志出口：
 * 1. console.warn（DevTools 默认级别可见）
 * 2. 追加写入 OS 临时目录 st-tldraw-debug.log（供外部读取完整有序证据链）
 *
 * 若 window.require 不可用（如浏览器环境），自动降级为仅 console。
 */

let fsModule: { appendFileSync: (p: string, d: string, e: string) => void } | null = null
let logFilePath = ''

try {
	if (typeof window !== 'undefined' && (window as any).require) {
		const nodeFs = (window as any).require('fs')
		const nodeOs = (window as any).require('os')
		if (nodeFs?.appendFileSync && typeof nodeOs?.tmpdir === 'function') {
			fsModule = nodeFs
			logFilePath =
				String(nodeOs.tmpdir()).replace(/\\/g, '/').replace(/\/+$/, '') + '/st-tldraw-debug.log'
		}
	}
} catch {
	// 降级为仅 console
}

export function stDebugLog(...args: unknown[]): void {
	const line = `[${new Date().toISOString()}] ${args
		.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
		.join(' ')}`
	// eslint-disable-next-line no-console
	console.warn(line)
	if (fsModule && logFilePath) {
		try {
			fsModule.appendFileSync(logFilePath, line + '\n', 'utf-8')
		} catch {
			// 文件写入失败不影响 console 输出
		}
	}
}

export function getStDebugLogPath(): string {
	return logFilePath
}
