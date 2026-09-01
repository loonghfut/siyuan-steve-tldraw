/**
 * Window the static DOM preview of a Card by top-level SiYuan blocks.
 *
 * The Card itself keeps its normal fixed-size scroll container. This class only
 * mounts the blocks that can be displayed in that container (plus an overscan
 * buffer) and represents the rest with height spacers. It deliberately stores
 * detached blocks as HTML strings rather than Elements, so hidden document
 * content does not remain as a large detached DOM tree.
 *
 * 富内容渲染完成后可通过 snapshotRenderedWindow() 把渲染结果回写到对应块的
 * HTML 字符串上：重新滚动到该窗口时无需再次执行公式/mermaid 渲染。
 */

export interface CardContentVirtualizerOptions {
	/**
	 * Called after a fresh window of blocks is mounted.
	 * generation 用于调用方在异步渲染完成后判断窗口是否已被滚动替换
	 * （同 ID 渲染任务 latest-wins，旧调用会随新窗口 resolve）。
	 */
	onMount?: (container: HTMLElement, generation: number) => void | Promise<void>
	/** Fixed nodes, such as the document title, that must always stay mounted. */
	isPinned?: (element: HTMLElement) => boolean
	/**
	 * Return true when the preview must retain its original DOM. Native media and
	 * embedded documents keep loading/playback state on their element instances,
	 * so recreating them from HTML would restart that state.
	 */
	shouldSkipVirtualization?: (content: readonly HTMLElement[]) => boolean
	overscanPx?: number
	minBlockCount?: number
}

interface VirtualBlock {
	html: string
	height: number
	/** 该块是否已完成富内容渲染（结果已回写到 html）。 */
	rendered?: boolean
}

const DEFAULT_BLOCK_HEIGHT = 56
const MIN_ESTIMATED_HEIGHT = 32
const MAX_ESTIMATED_HEIGHT = 720
const DEFAULT_OVERSCAN_PX = 280
const DEFAULT_MIN_BLOCK_COUNT = 12
// 42 个拉丁字符一行；CJK 字符宽度约为拉丁字符两倍，按加权长度估算行数。
const LATIN_CHARS_PER_LINE = 42

function estimateBlockHeight(element: HTMLElement): number {
	const text = (element.textContent || '').trim()
	const cjkCount = text ? (text.match(/[^\x00-\x7f]/g) || []).length : 0
	const weightedLength = text.length + cjkCount
	const lineCount = Math.max(1, Math.ceil(weightedLength / LATIN_CHARS_PER_LINE))
	const hasRichContent = Boolean(element.querySelector('img, video, iframe, table, [data-subtype="mermaid"], [data-type="NodeAttributeView"]'))
	const estimated = 20 + lineCount * 24 + (hasRichContent ? 96 : 0)
	return Math.min(MAX_ESTIMATED_HEIGHT, Math.max(MIN_ESTIMATED_HEIGHT, estimated || DEFAULT_BLOCK_HEIGHT))
}

function findIndexAtOffset(blocks: VirtualBlock[], offset: number): number {
	let total = 0
	for (let index = 0; index < blocks.length; index++) {
		total += blocks[index].height
		if (total > offset) return index
	}
	return Math.max(0, blocks.length - 1)
}

function sumHeights(blocks: VirtualBlock[], start: number, end: number): number {
	let total = 0
	for (let index = start; index < end; index++) total += blocks[index].height
	return total
}

export class CardContentVirtualizer {
	private readonly blocks: VirtualBlock[]
	private readonly pinnedElements: HTMLElement[]
	private readonly topSpacer = document.createElement('div')
	private readonly bottomSpacer = document.createElement('div')
	private readonly overscanPx: number
	private readonly onMount?: (container: HTMLElement, generation: number) => void | Promise<void>
	private mountedStart = -1
	private mountedEnd = -1
	private mountedElements: HTMLElement[] = []
	private updateFrame: number | null = null
	private destroyed = false
	private hasRenderedAnyWindow = false
	// 每次窗口内容变化递增；异步渲染完成后据此判断快照是否仍然对应当前窗口
	private windowGeneration = 0
	private readonly resizeObserver: ResizeObserver

	static create(container: HTMLElement, options: CardContentVirtualizerOptions = {}): CardContentVirtualizer | null {
		const isPinned = options.isPinned || (() => false)
		const children = Array.from(container.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
		const pinned = children.filter(isPinned)
		const content = children.filter((child) => !isPinned(child))
		if (options.shouldSkipVirtualization?.(content)) return null
		const estimatedContentHeight = content.reduce((total, element) => total + estimateBlockHeight(element), 0)
		const viewportHeight = container.clientHeight
		const exceedsCardViewport = viewportHeight > 0 && estimatedContentHeight > viewportHeight + DEFAULT_OVERSCAN_PX / 2
		const shouldVirtualize =
			content.length > 1 && (
				exceedsCardViewport ||
				content.length >= (options.minBlockCount ?? DEFAULT_MIN_BLOCK_COUNT) ||
				content.reduce((total, element) => total + (element.textContent || '').length, 0) >= 2400
			)

		if (!shouldVirtualize) return null
		return new CardContentVirtualizer(container, pinned, content, options)
	}

	private constructor(
		private readonly container: HTMLElement,
		pinned: HTMLElement[],
		content: HTMLElement[],
		options: CardContentVirtualizerOptions,
	) {
		// 缓存 HTML 中的块可能带着上一轮渲染的 data-card-rich-rendered 标记：
		// 读回为块级 rendered 真值，滚动到已渲染块时无需重复富渲染，
		// 未渲染块仍会正常渲染（条目级标记只表达"整体已渲染"）。
		this.blocks = content.map((element) => ({
			html: element.outerHTML,
			height: estimateBlockHeight(element),
			rendered: element.dataset.cardRichRendered === '1',
		}))
		this.pinnedElements = pinned
		this.overscanPx = options.overscanPx ?? DEFAULT_OVERSCAN_PX
		this.onMount = options.onMount

		this.topSpacer.className = 'card-virtual-spacer card-virtual-spacer--top'
		this.bottomSpacer.className = 'card-virtual-spacer card-virtual-spacer--bottom'
		this.topSpacer.setAttribute('aria-hidden', 'true')
		this.bottomSpacer.setAttribute('aria-hidden', 'true')
		this.topSpacer.style.pointerEvents = 'none'
		this.bottomSpacer.style.pointerEvents = 'none'

		container.replaceChildren(...pinned, this.topSpacer, this.bottomSpacer)
		this.resizeObserver = new ResizeObserver(this.onMountedResize)

		// A detached or newly inserted Card has no dimensions yet. Render a small
		// first window, then recalculate on the next frame after layout settles.
		this.updateWindow()
		requestAnimationFrame(() => this.scheduleUpdate())
	}

	destroy() {
		if (this.destroyed) return
		this.destroyed = true
		this.resizeObserver.disconnect()
		if (this.updateFrame !== null) cancelAnimationFrame(this.updateFrame)
		this.updateFrame = null
	}

	/** Recalculate the mounted window after the Card shape changes size. */
	refresh() {
		this.scheduleUpdate()
	}

	/** 是否有窗口完成过富内容渲染（可回写缓存）。 */
	hasRenderedContent() {
		return this.hasRenderedAnyWindow
	}

	/** 当前窗口代际；异步渲染完成后与启动时的代际比较，不一致则窗口已被替换。 */
	getWindowGeneration() {
		return this.windowGeneration
	}

	/**
	 * 把当前窗口的渲染结果回写到块的 HTML 字符串上，并标记为已渲染。
	 * 后续挂载同一块时可直接跳过富内容渲染。
	 */
	snapshotRenderedWindow() {
		if (this.destroyed) return
		for (const element of this.mountedElements) {
			const index = Number(element.dataset.cardVirtualIndex)
			if (!Number.isInteger(index) || !this.blocks[index]) continue
			this.blocks[index].html = element.outerHTML
			this.blocks[index].rendered = true
			element.dataset.cardRichRendered = '1'
		}
		this.hasRenderedAnyWindow = true
	}

	/**
	 * 重组完整文档 HTML（固定节点 + 全部块）。窗口之外的块保存的是原始或
	 * 已渲染的 HTML 字符串，因此可作为该文档的完整缓存版本。
	 */
	getFullHtml(): string {
		return this.pinnedElements.map((element) => element.outerHTML).join('') +
			this.blocks.map((block) => block.html).join('')
	}

	private onMountedResize = (entries: ResizeObserverEntry[]) => {
		let changed = false
		for (const entry of entries) {
			const index = Number((entry.target as HTMLElement).dataset.cardVirtualIndex)
			if (!Number.isInteger(index) || !this.blocks[index]) continue
			const height = Math.max(MIN_ESTIMATED_HEIGHT, Math.ceil(entry.contentRect.height))
			if (Math.abs(this.blocks[index].height - height) >= 1) {
				this.blocks[index].height = height
				changed = true
			}
		}
		if (changed) this.scheduleUpdate()
	}

	private scheduleUpdate() {
		if (this.destroyed || this.updateFrame !== null) return
		this.updateFrame = requestAnimationFrame(() => {
			this.updateFrame = null
			this.updateWindow()
		})
	}

	private updateWindow() {
		if (this.destroyed || this.blocks.length === 0) return

		const fixedHeight = this.topSpacer.offsetTop
		const viewportHeight = Math.max(this.container.clientHeight, DEFAULT_BLOCK_HEIGHT * 4)
		const startOffset = Math.max(0, this.container.scrollTop - fixedHeight - this.overscanPx)
		const endOffset = Math.max(0, this.container.scrollTop - fixedHeight + viewportHeight + this.overscanPx)
		const start = findIndexAtOffset(this.blocks, startOffset)
		let end = findIndexAtOffset(this.blocks, endOffset) + 1
		end = Math.min(this.blocks.length, Math.max(start + 1, end))

		this.topSpacer.style.height = `${sumHeights(this.blocks, 0, start)}px`
		this.bottomSpacer.style.height = `${sumHeights(this.blocks, end, this.blocks.length)}px`

		if (start === this.mountedStart && end === this.mountedEnd) return
		this.mountedStart = start
		this.mountedEnd = end
		this.resizeObserver.disconnect()

		for (const element of this.mountedElements) element.remove()
		const template = document.createElement('template')
		template.innerHTML = this.blocks.slice(start, end).map((block) => block.html).join('')
		const fragment = template.content
		this.mountedElements = Array.from(fragment.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
		for (const [offset, element] of this.mountedElements.entries()) {
			element.dataset.cardVirtualIndex = String(start + offset)
			// 显式清理：缓存 HTML 里的块元素可能残留上一轮的渲染标记
			if (this.blocks[start + offset]?.rendered) {
				element.dataset.cardRichRendered = '1'
			} else {
				delete element.dataset.cardRichRendered
			}
		}
		this.container.insertBefore(fragment, this.bottomSpacer)

		for (const element of this.mountedElements) {
			this.resizeObserver.observe(element)
		}

		const generation = ++this.windowGeneration
		const mounted = this.onMount?.(this.container, generation)
		if (mounted) {
			void Promise.resolve(mounted).catch((error) => {
				if (!this.destroyed) console.warn('Card virtualized content mount failed', error)
			})
		}
	}
}
