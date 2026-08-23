/**
 * 统一内容渲染管理器
 * 使用思源自带的 ProtyleMethod 进行渲染
 * 
 * 优化：
 * - 支持空闲调度，在交互时暂停渲染
 * - 使用思源原生渲染方法，保证一致性
 */
import { Protyle, ProtyleMethod } from 'siyuan'
import { cancelIdleRender, IdleRenderCancelledError, isIdleRenderCancelledError, isInteracting, scheduleIdleRender } from '../idle-scheduler'
import { getBlockDOMsWithEmbed } from '@/api/api'
import { stDebugLog } from './st-debug-log'

// 用于生成唯一的渲染任务 ID
let renderTaskIdCounter = 0

// CDN 配置（可根据需要自定义）
const CDN = undefined // 使用思源默认 CDN

/**
 * Resolve query embeds before any optional rich-content rendering. A query
 * result replaces the source node, so it must run while that source DOM is
 * still mounted and must not be swallowed when its Card is cancelled.
 */
export async function renderBlockQueryEmbeds(container: HTMLElement, signal?: AbortSignal): Promise<void> {
	const throwIfAborted = () => {
		if (signal?.aborted) throw new IdleRenderCancelledError()
	}

	throwIfAborted()
	if (signal && !container.isConnected) return

	const embedNodes = Array.from(container.querySelectorAll('[data-type="NodeBlockQueryEmbed"]'))
	if (embedNodes.length === 0) return

	const idsToResolve = embedNodes
		.map((node) => node.getAttribute('data-node-id')?.trim() || '')
		.filter(Boolean)
	const uniqueIds = Array.from(new Set(idsToResolve))
	if (uniqueIds.length === 0) return

	try {
		const embedDomMap = await getBlockDOMsWithEmbed(uniqueIds)
		throwIfAborted()
		if (!embedDomMap) return

		const buildFragmentFromHtml = (html: string) => {
			const temp = document.createElement('div')
			temp.innerHTML = html
			const fragment = document.createDocumentFragment()
			while (temp.firstChild) fragment.appendChild(temp.firstChild)
			return fragment
		}

		for (const node of embedNodes) {
			if (!node.isConnected) continue
			const targetId = node.getAttribute('data-node-id')?.trim()
			if (!targetId) continue
			const replacementHtml = embedDomMap[targetId]
			if (!replacementHtml) continue
			node.replaceWith(buildFragmentFromHtml(replacementHtml))
		}
	} catch (err) {
		if (isIdleRenderCancelledError(err)) throw err
		console.error('获取嵌入 DOM 内容失败:', err)
	}
}

/**
 * 在 HTML 挂载前预渲染其中的 mermaid 节点，返回带 SVG 的 HTML。
 *
 * 背景：白板卡片内异步插入的 SVG 不触发重绘（灰卡，直到最小化/恢复等窗口级
 * 重绘才出现）。把 SVG 预先渲染进挂载载荷，让图和卡片内容一起完成首次绘制。
 * 未命中的节点保持原样，交给挂载后的 renderAllContent 异步路径兜底。
 */
export async function preRenderMermaidHtml(html: string, cdn?: string, timeoutMs = 10000): Promise<string> {
	if (typeof document === 'undefined' || !html.includes('data-subtype="mermaid"')) return html

	const decodeHtml = (raw: string): string => {
		const txt = document.createElement('textarea')
		txt.innerHTML = raw
		return txt.value
	}

	const ensureMermaidReady = async (): Promise<boolean> => {
		// 触发 ProtyleMethod 的脚本加载（幂等；已加载则无操作）
		try {
			ProtyleMethod.mermaidRender(document.createElement('div'), cdn)
		} catch { /* ignore */ }
		const start = Date.now()
		while (typeof (window as any).mermaid === 'undefined') {
			if (Date.now() - start > timeoutMs) return false
			await new Promise((resolve) => setTimeout(resolve, 200))
		}
		return true
	}

	const wrapper = document.createElement('div')
	wrapper.innerHTML = html
	const nodes = Array.from(
		wrapper.querySelectorAll<HTMLElement>('[data-subtype="mermaid"]:not([data-render="true"])')
	)
	if (nodes.length === 0) return html

	const ready = await ensureMermaidReady()
	if (!ready) {
		stDebugLog('[ST-debug] preRenderMermaid: mermaid lib 未就绪，跳过预渲染')
		return html
	}
	// 主动初始化（与思源配置一致；ProtyleMethod 的异步初始化后到也不冲突）
	try {
		;(window as any).mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'loose',
			fontFamily: 'sans-serif',
			flowchart: { htmlLabels: true, useMaxWidth: true },
		})
	} catch { /* ignore */ }

	for (const node of nodes) {
		const rawContent = node.getAttribute('data-content')
		if (!rawContent) continue
		const content = decodeHtml(rawContent)
		const id = 'mermaid-st-pre-' + Math.random().toString(36).slice(2, 10)
		// 挂一个真实节点到 document，保证 mermaid.render 能找到渲染目标
		const temp = document.createElement('div')
		temp.id = id
		temp.style.position = 'absolute'
		temp.style.left = '-9999px'
		document.body.appendChild(temp)
		try {
			const { svg } = await (window as any).mermaid.render(id, content)
			const cleanSvg =
				typeof (window as any).DOMPurify?.sanitize === 'function'
					? (window as any).DOMPurify.sanitize(svg, {
							// 与思源 mermaidSanitize 一致：保留 foreignObject（文字标签在其中渲染），
							// 默认配置会删除它导致只剩图形没有文字
							USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
							ADD_TAGS: ['foreignObject', 'use', 'style'],
							ADD_ATTR: ['dominant-baseline', 'xlink:href', 'href'],
							HTML_INTEGRATION_POINTS: { foreignobject: true },
					  })
					: svg
			node.setAttribute('data-render', 'true')
			// 结构与思源 initMermaid 一致：保留占位容器，SVG 放入 contenteditable 包裹层
			const spinDiv = node.querySelector<HTMLElement>('div[spin="1"]')
			if (spinDiv) {
				spinDiv.innerHTML = `<div contenteditable="false">${cleanSvg}</div>`
			} else {
				node.insertAdjacentHTML(
					'beforeend',
					`<div><div contenteditable="false">${cleanSvg}</div></div>`
				)
			}
			stDebugLog('[ST-debug] preRenderMermaid rendered', 'id=', id, 'len=', cleanSvg.length)
		} catch (err) {
			// 语法错误等情况：保持原样，交给异步路径（会显示错误提示）
			stDebugLog('[ST-debug] preRenderMermaid failed', err)
		} finally {
			temp.remove()
		}
	}
	return wrapper.innerHTML
}

/**
 * 渲染容器内的所有内容
 * @param container 容器元素
 */
export async function renderAllContent(container: HTMLElement, signal?: AbortSignal): Promise<void> {
	const throwIfAborted = () => {
		if (signal?.aborted) throw new IdleRenderCancelledError()
	}

	try {
		throwIfAborted()
		// 已被 React 替换的预览不应继续触发网络/DOM 渲染。
		if (signal && !container.isConnected) return
		await renderBlockQueryEmbeds(container, signal)
		throwIfAborted()
		// eslint-disable-next-line no-console
		stDebugLog('[ST-debug] renderAllContent start', 'connected=', container.isConnected, 'renderNodes=', container.querySelectorAll('.render-node').length, 'mermaid=', container.querySelectorAll('[data-subtype="mermaid"]').length)

		// 思源的图表渲染器会跳过 firstElementChild.clientWidth===0 的占位节点，并等待
		// fold/card__block 变化才重试——白板卡片内两者都不存在，导致图表永不渲染。
		// 对未渲染的 mermaid 节点强制首个占位子元素获得最小宽度（无论它是原始
		// spin 占位 div 还是上次渲染残留的 protyle-icons）。
		container
			.querySelectorAll<HTMLElement>('[data-subtype="mermaid"]:not([data-render="true"])')
			.forEach((node) => {
				const placeholder = node.firstElementChild as HTMLElement | null
				if (placeholder && placeholder.clientWidth === 0) placeholder.style.minWidth = '1px'
			})
		// eslint-disable-next-line no-console
		stDebugLog('[ST-debug] placeholders total=', container.querySelectorAll('[data-subtype="mermaid"]:not([data-render="true"])').length, 'mermaidScriptLoaded=', typeof (window as any).mermaid !== 'undefined')

		// 使用思源的渲染方法
		ProtyleMethod.mathRender(container, CDN, false)
		ProtyleMethod.mermaidRender(container, CDN)
		ProtyleMethod.chartRender(container, CDN)
		ProtyleMethod.mindmapRender(container, CDN)
		ProtyleMethod.abcRender(container, CDN)
		ProtyleMethod.flowchartRender(container, CDN)
		ProtyleMethod.graphvizRender(container, CDN)
		ProtyleMethod.plantumlRender(container, CDN)
		// ProtyleMethod.htmlRender(container)
		ProtyleMethod.highlightRender(container)

		// —— mermaid 渲染结果验证 ——
		// 隐藏等待路径/毒缓存：未渲染（无 data-render）或标记已渲染但无 SVG 的节点重跑。
		// （显示层不刷新问题由 custom-tldraw.css 里 .tl-canvas content-visibility 覆盖解决）
		let repaintDone = false
		// SVG 在窗口隐藏期间异步插入时，Chromium 会跳过其绘制记录，恢复可见后
		// 图层仍复用旧栅格 → 灰卡直到最小化/恢复强制全量重绘。
		// 方案：在窗口恢复可见的那一刻（visibilitychange），强制容器重绘。
		const scheduleVisibleRepaintNudge = () => {
			const doNudge = () => {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						try {
							const targets: HTMLElement[] = [container]
							const htmlHost = container.closest<HTMLElement>('.tl-html-container')
							if (htmlHost) targets.push(htmlHost)
							targets.forEach((el) => {
								el.style.display = 'none'
								void el.offsetHeight
								el.style.display = ''
							})
						} catch { /* ignore */ }
					})
				})
				document.removeEventListener('visibilitychange', doNudge)
			}
			if (document.visibilityState === 'visible') {
				doNudge()
			} else {
				document.addEventListener('visibilitychange', doNudge)
			}
		}

		const checkMermaidState = (label: string) => {
			if (signal?.aborted || !container.isConnected) return
			const mermaidNodes = Array.from(
				container.querySelectorAll<HTMLElement>('[data-subtype="mermaid"]')
			)
			if (mermaidNodes.length === 0) return
			const states = mermaidNodes.map((el) => {
				const ph = el.firstElementChild as HTMLElement | null
				const svg = el.querySelector('svg')
				const svgW = svg ? Math.round(svg.getBoundingClientRect().width) : -1
				return `render=${el.getAttribute('data-render')} childW=${ph?.clientWidth} svg=${svg ? 'yes' : 'no'} svgW=${svgW}`
			})
			// eslint-disable-next-line no-console
			stDebugLog(`[ST-debug] mermaid check ${label}:`, states.join(' | '))

			// 可见性链诊断（只做一次）：SVG 已在 DOM 但屏幕不显示时，逐层记录
			// 祖先链的 display/visibility/opacity/content-visibility/rect，以及
			// SVG 中心点的 elementFromPoint 命中结果。
			if (label === 't+3s' && mermaidNodes.some((el) => el.querySelector('svg'))) {
				const svg = mermaidNodes.find((el) => el.querySelector('svg'))!.querySelector('svg') as SVGSVGElement
				const chain: string[] = []
				let cur: HTMLElement | null = svg.parentElement
				let depth = 0
				while (cur && cur !== document.body && depth < 12) {
					const cs = window.getComputedStyle(cur)
					const r = cur.getBoundingClientRect()
					const cls = typeof cur.className === 'string' ? String(cur.className).trim().split(/\s+/).slice(0, 2).join('.') : ''
					chain.push(`${cur.tagName.toLowerCase()}${cls ? '.' + cls : ''}|disp=${cs.display}|vis=${cs.visibility}|op=${cs.opacity}|cv=${cs.contentVisibility}|${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`)
					cur = cur.parentElement
					depth++
				}
				stDebugLog('[ST-debug] VIS-CHAIN:', chain.join(' <= '))
				const r2 = svg.getBoundingClientRect()
				const hit = document.elementFromPoint(r2.x + r2.width / 2, r2.y + r2.height / 2)
				stDebugLog('[ST-debug] HIT-TEST at svg center:', hit ? `${hit.tagName.toLowerCase()}.${typeof hit.className === 'string' ? String(hit.className).split(' ').slice(0, 3).join('.') : ''}` : 'null', 'docVisibility=', document.visibilityState, 'svgRect=', `${Math.round(r2.width)}x${Math.round(r2.height)}@${Math.round(r2.x)},${Math.round(r2.y)}`)
			}

			const pending = mermaidNodes.filter(
				(el) => el.getAttribute('data-render') !== 'true' || !el.querySelector('svg')
			)
			if (pending.length > 0) {
				const libReady = typeof (window as any).mermaid !== 'undefined'
				stDebugLog('[ST-debug] mermaid pending count=', pending.length, 'mermaidLib=', libReady)
				if (libReady) {
					pending.forEach((el) => {
						if (el.getAttribute('data-render') === 'true') el.removeAttribute('data-render')
						const ph = el.firstElementChild as HTMLElement | null
						if (ph && ph.clientWidth === 0) ph.style.minWidth = '1px'
					})
					try {
						ProtyleMethod.mermaidRender(container, CDN)
					} catch (err) {
						stDebugLog('[ST-debug] mermaid 重试渲染失败:', err)
					}
				}
			}
			if (!repaintDone && mermaidNodes.some((el) => el.querySelector('svg'))) {
				repaintDone = true
				stDebugLog('[ST-debug] svg-in-dom confirmed at', label, 'docVisible=', document.visibilityState === 'visible')
				scheduleVisibleRepaintNudge()
			}
		}
		setTimeout(() => checkMermaidState('t+1.5s'), 1500)
		setTimeout(() => checkMermaidState('t+3s'), 3000)
		setTimeout(() => checkMermaidState('t+5s'), 5000)

		// avRender is asynchronous and records a render token on each database view.
		// Rendering the whole container once avoids concurrent calls invalidating each
		// other's token; the temporary Protyle must remain alive until it settles.
		const attributeViews = Array.from(
			container.querySelectorAll<HTMLElement>('[data-type="NodeAttributeView"][data-av-id]')
		)
		const blockId = attributeViews.find((view) => Boolean(view.dataset.nodeId))?.dataset.nodeId
		const needsAttributeViewRender = attributeViews.some(
			(view) => view.getAttribute('data-render') !== 'true'
		)
		if (blockId && needsAttributeViewRender && window.siyuan?.ws?.app) {
			let temporaryProtyle: Protyle | null = null
			try {
				temporaryProtyle = new Protyle(window.siyuan.ws.app, document.createElement('div'), {
					blockId,
					rootId: blockId,
				})
				await ProtyleMethod.avRender(container, temporaryProtyle.protyle)
				throwIfAborted()
			} finally {
				try {
					temporaryProtyle?.destroy()
				} catch (err) {
					console.warn('销毁数据库临时 Protyle 失败:', err)
				}
			}
		}

	} catch (err) {
		if (!isIdleRenderCancelledError(err)) {
			console.warn('内容渲染失败:', err)
		}
		throw err
	}
}

/**
 * 使用空闲调度渲染容器内的所有内容
 * 在交互时（拖动、缩放等）会暂停渲染，避免卡顿
 * @param container 容器元素
 * @param priority 优先级（数字越小优先级越高，默认为 10）
 * @returns Promise，渲染完成时 resolve
 */
export async function renderAllContentIdle(
	container: HTMLElement,
	priority = 10,
	taskId?: string,
	forceIdle = false,
	externalSignal?: AbortSignal,
): Promise<void> {
	const effectiveTaskId = taskId || `render-${++renderTaskIdCounter}`
	if (externalSignal?.aborted) return
	const cancelOnAbort = () => cancelIdleRender(effectiveTaskId)
	externalSignal?.addEventListener('abort', cancelOnAbort, { once: true })

	// The Card loading queue owns the network/DOM admission decision, while the
	// idle scheduler owns expensive rich-content rendering. Link their signals
	// so a Card that leaves the viewport can abandon both phases instead of
	// keeping an idle task alive until all formulas/embeds finish rendering.
	const renderWithLinkedSignal = async (schedulerSignal?: AbortSignal) => {
		const controller = new AbortController()
		const abort = () => controller.abort()
		if (externalSignal?.aborted || schedulerSignal?.aborted) {
			controller.abort()
		}
		externalSignal?.addEventListener('abort', abort, { once: true })
		schedulerSignal?.addEventListener('abort', abort, { once: true })
		try {
			if (controller.signal.aborted) return
			await renderAllContent(container, controller.signal)
		} finally {
			externalSignal?.removeEventListener('abort', abort)
			schedulerSignal?.removeEventListener('abort', abort)
		}
	}

	// 非交互、且调用方未明确要求延后时立即完成，保持普通内容的响应速度。
	if (!forceIdle && !isInteracting()) {
		try {
			await renderWithLinkedSignal()
			return
		} finally {
			externalSignal?.removeEventListener('abort', cancelOnAbort)
		}
	}

	try {
		await scheduleIdleRender(effectiveTaskId, async (signal) => {
			await renderWithLinkedSignal(signal)
		}, priority)
	} catch (error) {
		// 组件 cleanup 主动取消是预期控制流；调用方不应因此把预览标成失败。
		if (isIdleRenderCancelledError(error)) return
		throw error
	} finally {
		externalSignal?.removeEventListener('abort', cancelOnAbort)
	}
}

/**
 * 渲染HTML字符串中的所有内容
 * @param html HTML字符串
 * @returns 渲染后的HTML字符串
 */
export async function renderHtmlContent(html: string): Promise<string> {
	if (typeof document === 'undefined') return html

	try {
		const wrapper = document.createElement('div')
		wrapper.innerHTML = html
		await renderAllContent(wrapper)
		return wrapper.innerHTML
	} catch (err) {
		console.warn('HTML内容渲染失败:', err)
		return html
	}
}
