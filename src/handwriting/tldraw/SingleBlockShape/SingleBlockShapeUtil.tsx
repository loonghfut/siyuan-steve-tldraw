import React, { ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import {
	HTMLContainer,
	EASINGS,
	Rectangle2d,
	ShapeUtil,
	SvgExportContext,
	TLResizeInfo,
	TLShapeId,
	createShapeId,
	resizeBox,
	BindingUtil,
	TLBaseBinding,
	BindingOnShapeChangeOptions,
	Box,
	invLerp,
	lerp,
	VecModel,
	useValue,
} from '@tldraw/tldraw'
import { Protyle, showMessage, TProtyleAction } from 'siyuan'
import * as api from '@/api/api'
import { settingdata } from '@/index'
import { buildTldrawLink } from '../utils/link-builder';
import { singleBlockShapeProps } from './single-block-shape-props'
import { singleBlockShapeMigrations } from './single-block-shape-migrations'
import { ISingleBlockShape } from './single-block-shape-types'
import { enqueueProtyleLoad, ProtyleLoadHandle } from '../protyle-load-queue'
import { shapeLoadManager } from '../shape-load-manager'
import { PortsOverlay } from '../BezierConnectorShape/Port'
import { createArrowBetweenShapes } from '../utils/addConnectedSingleBlock'
import { getShapeHostElement } from '../utils/getShapeHostElement'
import { getCachedHtml, setCachedHtml, cacheFromProtyleHost, invalidateCache, requestBlockDOM, getBlockContent, renderSimpleBlockHtml, preloadBlockContent } from '../block-html-cache'
import { renderAllContentIdle } from '../utils/render/content-renderer'
import { convertProtyleHtmlToDom } from '../utils/render/content-html-converter'
import { cancelIdleRender, isIdleRenderCancelledError, isInteracting } from '../utils/idle-scheduler'
import { scheduleBlockCheck } from '../utils/block-existence'
import { clearStaticTextSelection, findStaticLinkTarget, openStaticLinkTarget } from '../utils/static-links'
import { safeDestroyProtyle } from '../utils/protyle-lifecycle'
import { runExclusiveBlockCreation } from '../utils/pending-creation'
import { MissingBlockOverlay } from '../ui/MissingBlockOverlay'
import { useRestoreCameraOnEdit } from '../utils/use-restore-camera-on-edit'
import {
	getShapeLowDetailCountThreshold,
	getShapeLowDetailFontSize,
	getShapeLowDetailThreshold,
	getShapeRenderPolicy,
	getTotalCardAndSingleBlockCount,
	getViewportCullingCountThreshold,
	getVisibleCardAndSingleBlockCount,
} from '../utils/low-detail'
import { getLightweightPreviewTextFromElement, getLightweightPreviewTextFromHtml } from '../utils/lightweight-preview'
import { getDefaultColorTheme } from '../utils/color-theme'
import { getCachedSvgExportSnapshot, getSvgExportGlobalStyles, isSvgExportOutlineOnly, serializeElementForSvgExport } from '../utils/export-dom-snapshot'
import {
	beginBranchAttachmentDrag,
	beginBranchResize,
	clearBranchInteractionHint,
	createSiblingSingleInBranch,
	endBranchResize,
	getSingleBranchParent,
	getBranchInteractionHintForShape,
	setBranchInteractionHint,
	syncBranchMoveForRootContent,
	updateBranchAttachmentAfterDrag,
	useBranchInteractionHint,
} from '../BranchShape'

const draggingBranchSingleBlockIds = new Set<string>()

// ===== 形状尺寸 =====
// 高度不再由 DOM 自动测量，完全由用户手动调整（与 Card 行为一致）；
// props.h 是唯一的尺寸来源。旧白板中的形状在此前从未把测量高度写回
// props.h，因此组件在首次挂载时做一次一次性测高回填（见组件内 effect），
// 之后完全交给用户手动调整。
const BORDER_PX = 3 // 与样式、SVG 导出保持一致
// 字号回退值：与 getDefaultProps 的 fontSize 默认值保持一致，
// 避免各处 16/20/22 混用导致旧形状（fontSize 为 undefined）在不同视图间字号跳变
const SINGLE_BLOCK_DEFAULT_FONT_SIZE = 22
const MIN_HEIGHT = 30

export class SingleBlockShapeUtil extends ShapeUtil<ISingleBlockShape> {
	static override type = 'single-block' as const
	static override props = singleBlockShapeProps
	static override migrations = singleBlockShapeMigrations

	override isAspectRatioLocked(): boolean {
		return false
	}

	override hideRotateHandle(): boolean {
		return false
	}

	override canBind() {
		return true
	}

	override canCull(_shape: ISingleBlockShape): boolean {
		// Keep the active editor mounted; all other cards can use tldraw's native culling.
		return this.editor.getEditingShapeId() !== _shape.id

	}

	override canResize(): boolean {
		return true
	}

	override canEdit(): boolean {
		return true
	}

	override canScroll(): boolean {
		return true
	}

	override onBeforeUpdate(prev: ISingleBlockShape, next: ISingleBlockShape) {
		if (prev.props.blockId && !next.props.blockId) {
			next.props.blockId = prev.props.blockId
		}

		if (draggingBranchSingleBlockIds.has(next.id as string) && (prev.x !== next.x || prev.y !== next.y)) {
			syncBranchMoveForRootContent(this.editor, prev, next)
			setBranchInteractionHint(getBranchInteractionHintForShape(this.editor, next))
		}

		// 当从允许绑定切换到不允许绑定时，删除已有的 single-block 类型的绑定
		if ((prev.props.allowBinding ?? true) && (next.props.allowBinding === false)) {
			const bindings = this.editor.getBindingsFromShape(prev, 'single-block')
			if (bindings.length > 0) {
				this.editor.deleteBindings(bindings)
			}
		}
	}

	getDefaultProps(): ISingleBlockShape['props'] {
		return {
			w: 300,
			h: 150,
			color: 'black',
			blockId: '',
			// 初始创建时标记为 true，用于后续在用户进入编辑时再创建实际的思源块
			isNewlyCreated: true,
			fontSize: 22,
			refreshNonce: Date.now(),
			connectOnEnter: false,
			// 默认透明（无背景和边框）
			transparentBackground: true,
			// 是否允许与其他形状建立绑定（默认允许）
			allowBinding: true,
			// 新建形状高度即生效为手动模式，不触发旧白板的一次性回填
			heightBackfilled: true,
		}
	}

	getGeometry(shape: ISingleBlockShape) {
		// 高度完全由 props.h 决定，与 Card 行为一致
		return new Rectangle2d({
			width: shape.props.w,
			height: shape.props.h,
			isFilled: true,
		})
	}

	override getBoundsSnapGeometry(shape: ISingleBlockShape) {
		return { points: this.editor.getShapeGeometry(shape).bounds.cornersAndCenter }
	}

	override getIndicatorPath(shape: ISingleBlockShape) {
		const { width, height } = this.editor.getShapeGeometry(shape).bounds
		const path = new Path2D()
		path.rect(0, 0, width, height)
		return path
	}

	component(shape: ISingleBlockShape) {
		const editor = this.editor
		const theme = getDefaultColorTheme({ isDarkMode: editor.user.getIsDarkMode() })
		const isEditing = useValue('single-block is editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
		const branchInteractionHint = useBranchInteractionHint()
		const isRootAttachTarget =
			branchInteractionHint?.mode === 'attach' &&
			branchInteractionHint.slot === 'root' &&
			(branchInteractionHint.targetShapeId === shape.id ||
				(!branchInteractionHint.targetShapeId && branchInteractionHint.draggingShapeId === shape.id))
		const isEditingState = isEditing
		// 始终指向最新编辑态，供 shapeLoadManager 的 metaProvider 读取（避免把 isEditingState 放进 effect 依赖导致重注册）
		const isEditingStateRef = useRef(isEditingState);
		isEditingStateRef.current = isEditingState;
		// Stay blocked until ShapeLoadManager computes this shape's visibility.
		// Effects in the initial commit still see these values after registration.
		const [canLoad, setCanLoad] = useState(false)
		const [inPreloadZone, setInPreloadZone] = useState(false)
		const [hasLoadError, setHasLoadError] = useState(false)
		const totalCardAndSingleBlockCount = useValue(
			'total card and single-block count',
			() => getTotalCardAndSingleBlockCount(editor),
			[editor],
		)
		// 视野裁剪总开关 + 数量门槛：卡片很少的白板直接全部加载，避免加载过程可见
		const viewportCullingCountThreshold = getViewportCullingCountThreshold()
		const isViewportCullingEnabled = settingdata['tldraw-viewport-culling'] !== false &&
			(viewportCullingCountThreshold <= 0 || totalCardAndSingleBlockCount >= viewportCullingCountThreshold)
		const efficientZoom = useValue('single-block efficient zoom', () => editor.getEfficientZoomLevel(), [editor])
		const visibleCardAndSingleBlockCount = useValue(
			'card and single-block low-detail count',
			() => getVisibleCardAndSingleBlockCount(editor),
			[editor],
		)
		const lowDetailThreshold = getShapeLowDetailThreshold()
		const lowDetailCountThreshold = getShapeLowDetailCountThreshold()
		const hasEnoughShapesForLowDetail = lowDetailCountThreshold <= 0 || visibleCardAndSingleBlockCount >= lowDetailCountThreshold
		// 尚未回填高度的形状（heightBackfilled === false，拖入或旧白板迁移）保持完整内容渲染：
		// 若此时降级轻量预览，内容不挂载会导致回填测量无从进行
		const isSmallSingleBlock = !isEditingState && hasEnoughShapesForLowDetail && lowDetailThreshold > 0 && shape.props.heightBackfilled !== false && Math.min(shape.props.w, shape.props.h) * efficientZoom < lowDetailThreshold
		const lowDetailFontSize = getShapeLowDetailFontSize(Math.min(shape.props.w, shape.props.h), efficientZoom)
		const containerRef = useRef<HTMLDivElement>(null)
		const protyleRef = useRef<Protyle | null>(null)
		const protyleHostRef = useRef<HTMLDivElement | null>(null)
		const refreshNonceRef = useRef(shape.props.refreshNonce)
		// 静态 HTML 内容（非编辑态显示）
		const [staticHtml, setStaticHtml] = useState<string>('')
		// 静态内容容器的 ref，用于命令式挂载静态 wrapper
		const staticContentRef = useRef<HTMLDivElement | null>(null)
		// 命令式挂载的静态内容 wrapper（不受 React 协调，避免 avRender 结果被重渲染冲掉，与 Card 一致）
		const staticWrapperRef = useRef<HTMLElement | null>(null)
		// 富内容渲染的中止控制器（与 Card 的 richRenderAbortRef 一致）
		const richRenderAbortRef = useRef<AbortController | null>(null)
		// 标记内容是否已渲染（公式、图表等）
		const [, setIsContentRendered] = useState(false)
		const [isLoadingContent, setIsLoadingContent] = useState(false)
		// When the load manager withholds a full DOM preview, retain a compact
		// summary instead of presenting an action-oriented loading placeholder.
		const renderPolicy = getShapeRenderPolicy({
			isEditing: isEditingState,
			isViewportCullingEnabled,
			canLoad,
			isSmallShape: isSmallSingleBlock,
		})
		const shouldUseLightweightPreview = renderPolicy.shouldUseLightweightPreview
		const detachKeyHandler = useRef<() => void>()
		// 全局由 shapeLoadManager 计算可见性，无需本地定时轮询
		const loadHandleRef = useRef<ProtyleLoadHandle | null>(null)
		// 富内容渲染跟随 ShapeLoadManager 的距离优先级（与 Card 一致）
		const renderPriorityRef = useRef(10)
		const stopMissingStateEvent = (event: React.PointerEvent | React.MouseEvent) => {
			event.preventDefault()
			event.stopPropagation()
		}
		const previewTextRef = useRef(shape.props.previewText || '')
		previewTextRef.current = shape.props.previewText || ''
		const persistPreviewText = useCallback((previewText: string) => {
			if (!previewText || previewText === previewTextRef.current) return
			previewTextRef.current = previewText
			editor.updateShape({
				id: shape.id,
				type: shape.type,
				props: { previewText },
			})
		}, [editor, shape.id, shape.type])
		const persistLightweightPreviewText = useCallback((html: string) => {
			persistPreviewText(getLightweightPreviewTextFromHtml(html))
		}, [persistPreviewText])


		const destroyRuntimeResources = useCallback(() => {
			detachKeyHandler.current?.()
			detachKeyHandler.current = undefined
			if (loadHandleRef.current) {
				loadHandleRef.current.cancel()
				loadHandleRef.current = null
			}
			if (protyleRef.current) {
				safeDestroyProtyle(protyleRef.current)
				protyleRef.current = null
			}
			if (protyleHostRef.current?.parentElement) {
				try {
					protyleHostRef.current.parentElement.removeChild(protyleHostRef.current)
				} catch {
					// ignore
				}
			}
			protyleHostRef.current = null
		}, [])
		const enterMissingLinkedBlockState = useCallback(() => {
			destroyRuntimeResources()
			setStaticHtml('')
			setIsLoadingContent(false)
			setHasLoadError(true)
			try {
				if (editor.getEditingShapeId() === shape.id) {
					editor.setEditingShape(undefined)
				}
			} catch {
				// ignore
			}
		}, [destroyRuntimeResources, editor, shape.id])
		const handleRefreshMissingLinkedBlock = useCallback((event: React.PointerEvent | React.MouseEvent) => {
			stopMissingStateEvent(event)
			if (shape.props.blockId) {
				invalidateCache(shape.props.blockId)
			}
			destroyRuntimeResources()
			setStaticHtml('')
			setIsLoadingContent(false)
			setHasLoadError(false)
			editor.updateShape({
				id: shape.id,
				type: shape.type,
				props: {
					...shape.props,
					refreshNonce: Date.now(),
				},
			})
		}, [destroyRuntimeResources, editor, shape.id, shape.props, shape.type])
		const handleDeleteMissingLinkedBlock = useCallback((event: React.PointerEvent | React.MouseEvent) => {
			stopMissingStateEvent(event)
			editor.deleteShape(shape.id)
		}, [editor, shape.id])

		// 一次性回填：旧白板中的 SingleBlock 此前高度由运行时测量决定、从未写回 props.h，
		// 移除自动测高后会塌缩到默认值的 50px。内容就绪后测量一次并写回（heightBackfilled），
		// 之后高度完全由用户手动调整（与 Card 行为一致）。新建形状的默认 props 已带
		// heightBackfilled: true，不触发回填；仅迁移补齐为 false 的旧形状执行一次。
		useEffect(() => {
			if (shape.props.heightBackfilled !== false) return
			if (shouldUseLightweightPreview || hasLoadError) return
			// 双 rAF：staticHtml 挂载后的首帧布局可能尚未稳定，再等一帧后测量
			let innerFrame = 0
			const frame = requestAnimationFrame(() => {
				innerFrame = requestAnimationFrame(() => {
					const target = isEditingState ? protyleHostRef.current : staticContentRef.current
					if (!target) return
					const wysiwyg = target.querySelector('.protyle-wysiwyg') as HTMLElement | null
					const measured = Math.ceil((wysiwyg || target).scrollHeight || 0)
					if (measured <= 0) return
					const borderPx = shape.props.transparentBackground ? 0 : BORDER_PX
					const addBorder = settingdata["showCardBorder"] !== false && !shape.props.transparentBackground
					const nextHeight = Math.max(measured + (addBorder ? borderPx * 2 : 0), MIN_HEIGHT)
					editor.updateShape({
						id: shape.id,
						type: shape.type,
						props: {
							h: nextHeight,
							heightBackfilled: true,
						},
					})
					})
			})
			return () => {
				cancelAnimationFrame(frame)
				if (innerFrame) cancelAnimationFrame(innerFrame)
			}
		}, [shape.props.heightBackfilled, staticHtml, isEditingState, shouldUseLightweightPreview, hasLoadError, editor, shape.id, shape.type, shape.props.transparentBackground])

		// 编辑模式切换时聚焦到形状，并在退出编辑后恢复之前的视角
		useRestoreCameraOnEdit(editor, isEditing, shape.id, '形状')

		// register with global shape load manager (drives visibility + load admission)
		// 注意：依赖只放 shape.id，编辑态切换通过 isEditingStateRef 读取，避免每次编辑翻转都 unregister/register，
		// 否则 shapeLoadManager 的悲观重置会让入场状态短暂回落到 blocked，导致退出编辑时闪一下。
		useEffect(() => {
			shapeLoadManager.attachEditor(editor as any)
			const unregister = shapeLoadManager.register(
				shape.id,
				editor as any,
				() => ({ editing: isEditingStateRef.current }),
				(allowed, meta) => {
					setCanLoad(allowed)
					setInPreloadZone(meta.inPreloadZone)
					const distance = Number.isFinite(meta.distance) ? Math.max(0, meta.distance) : 1_000_000
					const centerPriority = Math.min(100, Math.floor(distance / 160))
					// 与 Card 一致：富内容渲染顺序跟随 ShapeLoadManager 的距离评分
					renderPriorityRef.current = meta.inViewport ? centerPriority : 1_000 + centerPriority
				}
			)
			return unregister
		}, [shape.id])

		// 预热环预热：尚未获得准入的块提前填充 HTML 缓存（不挂 DOM），
		// 用户平移进入准入环时命中缓存即可立即上屏
		useEffect(() => {
			if (isEditingState || isSmallSingleBlock) return
			if (!isViewportCullingEnabled || !shape.props.blockId) return
			if (canLoad) return
			if (!inPreloadZone) return
			if (isInteracting()) return
			void preloadBlockContent(shape.props.blockId)
		}, [isEditingState, isSmallSingleBlock, isViewportCullingEnabled, shape.props.blockId, canLoad, inPreloadZone])

		// ===== 核心优化：只在编辑态创建 Protyle，非编辑态使用静态 HTML =====

		// 加载静态内容（非编辑态）
		useEffect(() => {
			// 编辑态不需要加载静态内容
			if (isEditingState || isSmallSingleBlock) return

			const blockId = shape.props.blockId
			if (!blockId) return

			// 准入完全跟随管理器：canLoad 已包含"视口 + 准入环"的配额判定与
			// 后台标签页拦截，组件不得再叠加 isInViewport 判断
			if (!canLoad) return

			// refreshNonce 变化时强制刷新缓存
			const forceRefresh = refreshNonceRef.current !== shape.props.refreshNonce
			refreshNonceRef.current = shape.props.refreshNonce

			// 尝试从缓存获取（除非需要强制刷新）；缓存条目自带 previewText，无需重新解析 HTML。
			// 缓存键只含 blockId：字号由静态容器 CSS 继承，变更字号不应触发重新请求。
			if (!forceRefresh) {
				const cached = getCachedHtml(blockId)
				if (cached) {
					persistPreviewText(cached.previewText)
					setStaticHtml(cached.html)
					return
				}
			} else {
				// 刷新时使缓存失效
				invalidateCache(blockId)
			}

			// 从 API 获取块的 DOM HTML（会自动批量合并请求）
			let cancelled = false
			setIsLoadingContent(true)
			setHasLoadError(false)

			// 使用批量请求函数获取 DOM
			requestBlockDOM(blockId).then(async (html) => {
				if (cancelled) return
				if (html) {
					const cached = getCachedHtml(blockId)
					if (cached) persistPreviewText(cached.previewText)
					else persistLightweightPreviewText(html)
					setStaticHtml(html)
					setHasLoadError(false)
					return
				}
				// 先用批量 SQL 确认块是否真的不存在；已删除的块无需再做 markdown 回退请求
				const exists = await scheduleBlockCheck(blockId, shape.id)
				if (cancelled) return
				if (!exists) {
					setStaticHtml('')
					setHasLoadError(true)
					return
				}
				// 备用：使用 getBlockContent + renderSimpleBlockHtml
				const content = await getBlockContent(blockId)
				if (cancelled) return
				if (content) {
					const fallbackHtml = renderSimpleBlockHtml(content.content || content.markdown)
					setCachedHtml(blockId, fallbackHtml)
					const cached = getCachedHtml(blockId)
					if (cached) persistPreviewText(cached.previewText)
					else persistLightweightPreviewText(fallbackHtml)
					setStaticHtml(fallbackHtml)
					setHasLoadError(false)
				} else {
					// 块不存在，设置错误状态
					setStaticHtml('')
					setHasLoadError(true)
				}
			}).catch(() => {
				// API调用失败，设置错误状态
				if (!cancelled) {
					setStaticHtml('')
					setHasLoadError(true)
				}
			}).finally(() => {
				if (!cancelled) setIsLoadingContent(false)
			})

			return () => { cancelled = true }
		}, [isEditingState, isSmallSingleBlock, shape.props.blockId, shape.props.refreshNonce, canLoad, persistPreviewText, persistLightweightPreviewText])

		// ===== 静态内容渲染：命令式挂载 + 富渲染 + 回写缓存（与 Card 一致）=====
		// 关键：静态内容挂到不受 React 协调的 wrapper 上，avRender 的结果不会被重渲染冲掉；
		// 渲染完成后把已渲染 HTML 回写缓存，重挂载时直接复用（数据库因此首帧即可显示）。
		useEffect(() => {
			if (isEditingState || shouldUseLightweightPreview || !staticHtml) return
			const container = staticContentRef.current
			if (!container) return

			// 移除上一次挂载的 wrapper
			if (staticWrapperRef.current?.parentElement) {
				try { staticWrapperRef.current.parentElement.removeChild(staticWrapperRef.current) } catch { /* ignore */ }
			}
			staticWrapperRef.current = null

			// 由 staticHtml 构建 wrapper：复用 .protyle-wysiwyg 根，避免“挂载→回写→再命中”层层嵌套
			let wrapper: HTMLElement
			const temp = document.createElement('div')
			temp.innerHTML = staticHtml
			const root = temp.firstElementChild
			if (root instanceof HTMLElement && root.classList.contains('protyle-wysiwyg') && !root.nextElementSibling) {
				wrapper = root
			} else {
				wrapper = document.createElement('div')
				wrapper.className = 'protyle-wysiwyg protyle-wysiwyg--attr'
				wrapper.innerHTML = staticHtml
			}
			wrapper.style.width = '100%'
			// 解码 protyle-html（与 Card 一致），否则内嵌内容可能藏在 data-content 中不显示
			try { convertProtyleHtmlToDom(wrapper) } catch (error) { console.warn('convertProtyleHtmlToDom failed', error) }

			container.appendChild(wrapper)
			staticWrapperRef.current = wrapper

			// 重置渲染状态
			setIsContentRendered(false)

			const renderTaskId = `render-static-${shape.id}`
			const abortController = new AbortController()
			richRenderAbortRef.current?.abort()
			richRenderAbortRef.current = abortController
			let cancelled = false

			// forceIdle + signal：与 Card 一致，交互时暂停、离开视口可中止
			renderAllContentIdle(wrapper, renderPriorityRef.current, renderTaskId, true, abortController.signal).then(() => {
				if (cancelled) return
				// 回写已渲染 HTML（含 data-render="true" 的数据库），后续重挂载直接复用
				if (shape.props.blockId) setCachedHtml(shape.props.blockId, wrapper.outerHTML)
				setIsContentRendered(true)
			}).catch((error) => {
				if (!isIdleRenderCancelledError(error)) {
					console.warn('单块静态内容渲染失败:', error)
				}
			})

			return () => {
				cancelled = true
				abortController.abort()
				if (richRenderAbortRef.current === abortController) richRenderAbortRef.current = null
				cancelIdleRender(renderTaskId)
				if (wrapper.parentElement) {
					try { wrapper.parentElement.removeChild(wrapper) } catch { /* ignore */ }
				}
				if (staticWrapperRef.current === wrapper) staticWrapperRef.current = null
			}
		}, [staticHtml, isEditingState, shouldUseLightweightPreview, shape.id, shape.props.blockId])

		// ===== 编辑态专用：创建和管理 Protyle 实例 =====
		useEffect(() => {
			if (!isEditingState) {
				// 退出编辑态时：静态快照的保存与 Protyle 的销毁统一在下方 cleanup 中处理，
				// 因为 React 会先执行上一轮编辑态 effect 的 cleanup（此时 Protyle 仍存在），
				// 再执行这里的 effect body（此时 Protyle 已被销毁），所以必须在那里保存快照。
				destroyRuntimeResources()
				return
			}

			const container = containerRef.current
			if (!container || !window.siyuan?.ws?.app) return

			let disposed = false

			const ensureBlockId = async (): Promise<string | null> => {
				let blockId = shape.props.blockId || container.getAttribute('blockid') || null
				if (blockId) return blockId

				// 如果该形状刚创建（isNewlyCreated === true），在编辑态时创建块
				if (shape.props.isNewlyCreated) {
					try {
						editor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, isNewlyCreated: false } })
					} catch (err) {
						// ignore
					}
				}

				const editorElement = container.closest('.tldraw__editor')
				const tldrawId = editorElement?.getAttribute('data-tldraw-id')
				if (!settingdata['tl-draw-create-note-id'] && !tldrawId) {
					showMessage('配置不完整,请检查设置')
					return null
				}

				try {
					blockId = await runExclusiveBlockCreation(shape.id as string, async () => {
						const idid = (await api.generateSiyuanID()) as string
						const link = buildTldrawLink(tldrawId, idid)
						// 将链接保存到自定义属性中
						const redata = await api.appendBlock(
							'markdown',
							`\n{: id="${idid}" custom-st-tldraw-single="1" custom-tldraw-link="${link}" }\n\n`,
							tldrawId!
						)
						return redata[0].doOperations[0].id as string
					})
				} catch (err) {
					console.error('创建块失败', err)
				}

				if (!blockId) {
					showMessage('未找到块')
					return null
				}

				editor.updateShape({
					id: shape.id,
					type: shape.type,
					props: { ...shape.props, blockId },
				})
				container.setAttribute('blockid', blockId)
				// 使旧缓存失效
				invalidateCache(blockId)
				// 重置错误状态
				setHasLoadError(false)
				return blockId
			}

			const mountProtyle = async (blockId: string) => {
				if (disposed) return
				loadHandleRef.current?.cancel()
				// 编辑态始终使用最高优先级
				const handle = enqueueProtyleLoad(shape.id, 0, async (signal) => {
					if (disposed || signal.aborted) return
					const currentContainer = containerRef.current
					if (!currentContainer) return
					if (protyleHostRef.current && protyleHostRef.current.parentElement === currentContainer) {
						try {
							protyleHostRef.current.parentElement.removeChild(protyleHostRef.current)
						} catch {
							// ignore
						}
					}
					if (signal.aborted || disposed) return
					const host = document.createElement('div')
					host.className = 'card-protyle-host'
					host.style.width = '100%'
					host.style.height = '100%'
					host.style.overflow = 'hidden'
					protyleHostRef.current = host
					let resolveReady: (() => void) | null = null
					const readyPromise = new Promise<void>((resolve) => (resolveReady = resolve))
					// 防止 Protyle 无法正常触发 `after` 导致永远等待，增加超时与异常保护
					let readyTimeoutId: number | null = null
					const READY_TIMEOUT_MS = 1000
					const timeoutPromise = new Promise<void>((resolve) => {
						readyTimeoutId = window.setTimeout(resolve, READY_TIMEOUT_MS)
					})
					const readyWithTimeout = Promise.race([readyPromise, timeoutPromise])
					let protyleInstance: Protyle | null = null
					try {
						// 编辑态始终获取焦点
						const actions = ['cb-get-all', 'cb-get-focus'] as TProtyleAction[]
						protyleInstance = new Protyle(window.siyuan.ws.app, host, {
							blockId,
							render: {
								breadcrumb: false,
								gutter: true,
								title: false,
								breadcrumbDocName: false,
							},
							action: actions,
							mode: 'wysiwyg',
							after(protyle) {
								protyle.protyle.wysiwyg.preventKeyup = true
								resolveReady && resolveReady()
							},
							click: {
								preventInsetEmptyBlock: true,
							},
							handleEmptyContent() {
								if (!disposed && !signal.aborted) {
									enterMissingLinkedBlockState()
								}
							},
						})
					} catch (err) {
						console.error('Protyle 构造失败', err)
						if (host.parentElement) {
							try { host.parentElement.removeChild(host) } catch { }
						}
						return
					}

					if (signal.aborted || disposed) {
						safeDestroyProtyle(protyleInstance)
						return
					}
					protyleRef.current = protyleInstance
					currentContainer.appendChild(host)
					if (protyleInstance.protyle?.wysiwyg?.element) {
						protyleInstance.protyle.wysiwyg.element.style.fontSize = `${shape.props.fontSize || SINGLE_BLOCK_DEFAULT_FONT_SIZE}px`
					}
					// 等待 Protyle 就绪
					await readyWithTimeout.catch(() => undefined)
					if (readyTimeoutId) {
						clearTimeout(readyTimeoutId)
						readyTimeoutId = null
					}
					// 启用编辑
					protyleInstance.enable()
					if (signal.aborted || disposed) {
						safeDestroyProtyle(protyleInstance)
						if (protyleHostRef.current === host && host.parentElement) {
							host.parentElement.removeChild(host)
						}
						if (protyleRef.current === protyleInstance) {
							protyleRef.current = null
						}
					}
				})
				loadHandleRef.current = handle
				try {
					await handle.finished
				} catch (err) {
					console.error('加载 Protyle 失败', err)
				} finally {
					if (loadHandleRef.current === handle) {
						loadHandleRef.current = null
					}
				}
			}

			const ensureShapeVisible = (targetId: TLShapeId, retries = 3) => {
				const attempt = (remaining: number) => {
					const viewportBounds = editor.getViewportPageBounds()
					const shapeBounds = editor.getShapePageBounds(targetId)
					if (!viewportBounds || !shapeBounds) {
						if (remaining > 0) {
							requestAnimationFrame(() => attempt(remaining - 1))
						}
						return
					}

					const padding = 32
					const visibleLeft = viewportBounds.minX + padding
					const visibleRight = viewportBounds.maxX - padding
					const visibleTop = viewportBounds.minY + padding
					const visibleBottom = viewportBounds.maxY - padding

					let deltaX = 0
					let deltaY = 0

					if (shapeBounds.minX < visibleLeft) {
						deltaX = shapeBounds.minX - visibleLeft
					} else if (shapeBounds.maxX > visibleRight) {
						deltaX = shapeBounds.maxX - visibleRight
					}

					if (shapeBounds.minY < visibleTop) {
						deltaY = shapeBounds.minY - visibleTop
					} else if (shapeBounds.maxY > visibleBottom) {
						deltaY = shapeBounds.maxY - visibleBottom
					}

					if (deltaX === 0 && deltaY === 0) return

					const newCenter = {
						x: viewportBounds.midX + deltaX,
						y: viewportBounds.midY + deltaY,
					}

					editor.centerOnPoint(newCenter, {
						animation: { duration: 220, easing: EASINGS.easeInOutCubic },
					})
				}

				attempt(retries)
			}

			const registerKeyHandler = () => {
				detachKeyHandler.current?.()
				const wys = protyleRef.current?.protyle?.wysiwyg?.element
				if (!wys) return

				const handleKeyDown = (event: KeyboardEvent) => {
					if (event.isComposing) return
					// 处理 Escape：退出编辑模式
					if (event.key === 'Escape') {
						try {
							event.preventDefault()
							event.stopImmediatePropagation()
							event.stopPropagation()
						} catch (e) {
							// ignore
						}
						editor.setEditingShape(undefined)
						editor.select(shape.id)
						return
					}

					// 仅对 Enter 做原有处理
					if (event.key !== 'Enter') return
					// 拦截所有 Enter 行为，按修饰键决定新块方向
					try {
						event.preventDefault()
						event.stopImmediatePropagation()
						event.stopPropagation()
							; (event as any).returnValue = false
					} catch (e) {
						// ignore
					}
					const branchParentInfo = !event.ctrlKey && !event.metaKey ? getSingleBranchParent(editor, shape.id) : null
					if (branchParentInfo) {
						const newId = createSiblingSingleInBranch(editor, shape.id)
						if (!newId) return
						editor.select(newId)
						editor.setEditingShape(newId)
						requestAnimationFrame(() => ensureShapeVisible(newId))
						return
					}
					const offset = 40
					const width = shape.props.w
					const height = shape.props.h
					const newId = createShapeId()
					const defaultProps = this.getDefaultProps()
					let nextX = shape.x
					let nextY = shape.y

					if (event.altKey) {
						nextX = shape.x - (width + offset)
					} else if (event.shiftKey) {
						nextY = shape.y - (height + offset)
					} else if (event.ctrlKey || event.metaKey) {
						nextY = shape.y + height + offset
					} else {
						nextX = shape.x + width + offset
					}
					editor.createShapes([
						{
							id: newId,
							type: shape.type,
							x: nextX,
							y: nextY,
							props: {
								...defaultProps,
								blockId: '',
								color: shape.props.color,
								fontSize: shape.props.fontSize,
								connectOnEnter: shape.props.connectOnEnter,
							},
						},
					])
					// 如果开启连接功能，创建一条绑定的箭头或曲线指向新形状
					if (shape.props.connectOnEnter !== false) {
						try {
							const createdShape = editor.getShape(newId)
							if (createdShape && createdShape.type === 'single-block') {
								createArrowBetweenShapes(editor, shape as ISingleBlockShape, createdShape as ISingleBlockShape, shape.props.color ?? 'black')
							}
						} catch (err) {
							console.warn('connectOnEnter connector creation failed', err)
						}
					}
					editor.select(newId)
					editor.setEditingShape(newId)
					requestAnimationFrame(() => ensureShapeVisible(newId))
				}

				const handleKeyUp = (event: KeyboardEvent) => {
					if (event.key !== 'Enter' && event.key !== 'Escape') return
					try {
						event.preventDefault()
						event.stopImmediatePropagation()
						event.stopPropagation()
							; (event as any).returnValue = false
					} catch (e) { }
				}

				wys.addEventListener('keydown', handleKeyDown, { capture: true, passive: false } as AddEventListenerOptions)
				wys.addEventListener('keyup', handleKeyUp, { capture: true, passive: false } as AddEventListenerOptions)

				detachKeyHandler.current = () => {
					try {
						wys.removeEventListener('keydown', handleKeyDown, { capture: true } as EventListenerOptions)
					} catch (e) { }
					try {
						wys.removeEventListener('keyup', handleKeyUp, { capture: true } as EventListenerOptions)
					} catch (e) { }
				}
			}

			const setup = async () => {
				const blockId = await ensureBlockId()
				if (!blockId || disposed) return

				// 挂载 Protyle
				await mountProtyle(blockId)

				// 注册键盘处理
				registerKeyHandler()
			}

			setup()

			return () => {
				disposed = true
				// 退出编辑态时，在销毁 Protyle 之前先保存静态快照到缓存与本地状态
				// 必须在此处（cleanup）执行：React 先跑上一轮 effect 的 cleanup（Protyle 仍在），
				// 再跑新一轮非编辑态 effect 的 body（此时若已销毁则取不到内容）
				if (protyleRef.current && protyleHostRef.current && shape.props.blockId) {
					const html = cacheFromProtyleHost(shape.props.blockId, protyleHostRef.current)
					if (html) {
						persistPreviewText(getLightweightPreviewTextFromElement(protyleHostRef.current))
						setStaticHtml(html)
					}
				}
				destroyRuntimeResources()
			}
		}, [destroyRuntimeResources, isEditingState, shape.id, shape.props.blockId, shape.props.refreshNonce, persistPreviewText])

		useEffect(() => {
			if (protyleRef.current?.protyle?.wysiwyg?.element) {
				protyleRef.current.protyle.wysiwyg.element.style.fontSize = `${shape.props.fontSize || SINGLE_BLOCK_DEFAULT_FONT_SIZE}px`;
			} else if (containerRef.current) {
				const wys = containerRef.current.querySelector(".protyle-wysiwyg");
				if (wys) (wys as HTMLElement).style.fontSize = `${shape.props.fontSize || SINGLE_BLOCK_DEFAULT_FONT_SIZE}px`;
			}
		}, [shape.props.fontSize]);


		const handlePointerEvent = (e: React.PointerEvent) => {
			if (isEditingState) {
				e.stopPropagation()
			}
		}

		const handleStaticLinkPointerDown = useCallback(
			(e: React.PointerEvent<HTMLDivElement>) => {
				if (isEditingState) return
				if (findStaticLinkTarget(e.target, staticContentRef.current)) {
					clearStaticTextSelection()
					e.stopPropagation()
				}
			},
			[isEditingState]
		)

		const handleStaticLinkDragStart = useCallback((e: React.DragEvent<HTMLDivElement>) => {
			e.preventDefault()
			e.stopPropagation()
			clearStaticTextSelection()
		}, [])

		const handleStaticLinkClick = useCallback(
			(e: React.MouseEvent<HTMLDivElement>) => {
				if (isEditingState || e.defaultPrevented) return
				const target = findStaticLinkTarget(e.target, staticContentRef.current)
				if (!target) return

				e.preventDefault()
				e.stopPropagation()
				clearStaticTextSelection()

				// 块引用走 openTab，普通链接按协议处理（与 Card 共用同一实现）
				openStaticLinkTarget(target)
			},
			[isEditingState]
		)

		// 计算当前是否需要绘制边框
		const borderPx = shape.props.transparentBackground ? 0 : BORDER_PX

		return (
			<HTMLContainer
				id={shape.id}
				className="st-single-block-shape"
				style={{
					display: 'flex',
					flexDirection: 'column',
					backgroundColor: shape.props.transparentBackground ? 'transparent' : theme[shape.props.color].semi,
					// color: theme[shape.props.color].solid,
					position: 'relative',
					isolation: 'isolate',
					// Always allow pointer events at the container level so hover can be detected
					// (used to reveal connector ports even when not editing). The inner content
					// will still prevent interaction when not in edit mode.
					pointerEvents: 'auto',
					width: '100%',
					height: '100%',
					overflow: 'visible', // 改为 visible 以显示端口
					boxShadow: isRootAttachTarget
						? '0 0 0 4px rgba(34, 197, 94, 0.42), 0 0 20px rgba(34, 197, 94, 0.32)'
						: isEditingState ? '0 0 0 2px #3d8aff' : 'none',
					cursor: isEditingState ? 'text' : 'default',
					padding: 0,
					border: settingdata["showCardBorder"] ? (shape.props.transparentBackground ? 'none' : `${borderPx}px solid ${theme[shape.props.color].solid}`) : 'none',
					borderRadius: '10px',
				}}
				onPointerDown={handlePointerEvent}
				onPointerMove={handlePointerEvent}
				onPointerUp={handlePointerEvent}
			>
				<div
					ref={containerRef}
					className="st-single-block-shape__content"
					blockid={shape.props.blockId}
					style={{
						width: '100%',
						height: '100%',
						// 内容溢出时容器内滚动，编辑态同样允许滚动（与 Card 行为一致）
						overflow: 'auto',
						// Prevent content interactions when not editing to avoid blocking
						// TL editor pointer handling. The overlay itself can still react
						// to hover because HTMLContainer has pointer-events enabled.
						pointerEvents: isEditingState ? 'all' : 'none',
						touchAction: isEditingState ? 'auto' : 'none',
						contain: 'strict',
						padding: '0px',
					}}
				>
					{/* 静态内容交互屏蔽/滚动条样式已迁移至 custom-tldraw.css（避免每个实例重复一份 <style>） */}
					{shouldUseLightweightPreview && (
						<div
							className="card-lightweight-preview"
							style={{
								width: '100%',
								height: '100%',
								background: shape.props.transparentBackground ? theme[shape.props.color].semi : 'transparent',
								pointerEvents: 'none',
								padding: '2px 4px',
								boxSizing: 'border-box',
								color: theme[shape.props.color].solid,
								fontSize: `${lowDetailFontSize}px`,
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								textAlign: 'center',
							}}
						>
							<span style={{
								display: '-webkit-box',
								WebkitBoxOrient: 'vertical',
								WebkitLineClamp: 2,
								overflow: 'hidden',
								lineHeight: 1.1,
								wordBreak: 'break-word',
							}}>
								{shape.props.previewText || (shape.props.blockId ? '单块' : '双击编辑')}
							</span>
						</div>
					)}
					{!isEditingState && !shouldUseLightweightPreview && staticHtml && (
						<div
							className="single-block-static-content"
							ref={staticContentRef}
							onPointerDown={handleStaticLinkPointerDown}
							onPointerUp={handleStaticLinkPointerDown}
							onDragStart={handleStaticLinkDragStart}
							onClick={handleStaticLinkClick}
							style={{
								width: '100%',
								height: '100%',
								// 字号由容器控制并随 props 变化，缓存 HTML 不再内联 font-size
								fontSize: `${shape.props.fontSize || SINGLE_BLOCK_DEFAULT_FONT_SIZE}px`,
								pointerEvents: 'none',
								userSelect: 'none',
							}}
						/>
					)}
					{/* 非编辑态：加载中提示 */}
					{!isEditingState && !isSmallSingleBlock && !staticHtml && isLoadingContent && (
						<div style={{
							width: '100%',
							height: '100%',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							fontSize: `${Math.min(shape.props.fontSize, 16)}px`,
							color: theme[shape.props.color].solid,
							opacity: 0.5,
							textAlign: 'center',
							padding: '4px'
						}}>
							加载中...
						</div>
					)}
					{/* 非编辑态：新块占位符 */}
					{!isEditingState && !isSmallSingleBlock && !staticHtml && !isLoadingContent && !hasLoadError && canLoad && shape.props.isNewlyCreated && (
						<div style={{
							width: '100%',
							height: '100%',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							fontSize: `${Math.min(shape.props.fontSize, 16)}px`,
							color: theme[shape.props.color].solid,
							opacity: 0.5,
							textAlign: 'center',
							padding: '4px'
						}}>
							双击编辑
						</div>
					)}
				</div>
				{!isEditingState && !isSmallSingleBlock && hasLoadError && (
					<MissingBlockOverlay
						textColor={theme[shape.props.color].solid}
						fontSize={shape.props.fontSize || 16}
						transparent={shape.props.transparentBackground}
						compact
						onRefresh={handleRefreshMissingLinkedBlock}
						onDelete={handleDeleteMissingLinkedBlock}
					/>
				)}
				{/* 端口覆盖层 - 用于贝塞尔连接器 */}
				{/* 在透明模式下不显示端点（PortsOverlay） */}
				{!isSmallSingleBlock && !shape.props.transparentBackground && (
					<PortsOverlay shapeId={shape.id} />
				)}
			</HTMLContainer>
		)
	}

	indicator(shape: ISingleBlockShape) {
		const { width, height } = this.editor.getShapeGeometry(shape).bounds
		return <rect width={width} height={height} rx={10} ry={10} />
	}

	override onResize(shape: ISingleBlockShape, info: TLResizeInfo<ISingleBlockShape>) {
		return resizeBox(shape, info)
	}

	override onResizeStart(shape: ISingleBlockShape) {
		beginBranchResize(this.editor, shape.id)
	}

	override onResizeEnd(_initialShape: ISingleBlockShape, currentShape: ISingleBlockShape) {
		endBranchResize(this.editor, currentShape.id)
	}

	override onResizeCancel(_initialShape: ISingleBlockShape, currentShape: ISingleBlockShape) {
		endBranchResize(this.editor, currentShape.id)
	}

	override onTranslateStart(shape: ISingleBlockShape) {
		draggingBranchSingleBlockIds.add(shape.id as string)
		beginBranchAttachmentDrag(this.editor, shape)
		setBranchInteractionHint(getBranchInteractionHintForShape(this.editor, shape))

		const bindings = this.editor.getBindingsFromShape(shape, 'single-block')
		this.editor.deleteBindings(bindings)
	}

	override onTranslateEnd(_initial: ISingleBlockShape, currentShape: ISingleBlockShape) {
		draggingBranchSingleBlockIds.delete(currentShape.id as string)
		clearBranchInteractionHint(currentShape.id as string)
		if (updateBranchAttachmentAfterDrag(this.editor, currentShape)) return

		// 如果当前 shape 标记为不允许绑定，则跳过创建绑定
		if (currentShape.props.allowBinding === false) return
		const pageAnchor = this.editor
			.getShapePageTransform(currentShape)
			.applyToPoint(this.editor.getShapeGeometry(currentShape).bounds.center)
		const target = this.editor.getShapeAtPoint(pageAnchor, {
			hitInside: true,
			filter: (shape) =>
				shape.id !== currentShape.id &&
				this.editor.canBindShapes({ fromShape: currentShape, toShape: shape, binding: 'single-block' }),
		})

		if (!target) return

		const targetBounds = Box.ZeroFix(this.editor.getShapeGeometry(target)!.bounds)
		const pointInTargetSpace = this.editor.getPointInShapeSpace(target, pageAnchor)

		const anchor = {
			x: invLerp(targetBounds.minX, targetBounds.maxX, pointInTargetSpace.x),
			y: invLerp(targetBounds.minY, targetBounds.maxY, pointInTargetSpace.y),
		}

		this.editor.createBinding({
			type: 'single-block',
			fromId: currentShape.id,
			toId: target.id,
			props: {
				anchor,
			},
		})
	}

	override toSvg(shape: ISingleBlockShape, ctx: SvgExportContext): ReactElement | null {
		const theme = getDefaultColorTheme({ isDarkMode: ctx.isDarkMode })
		const { w, h: hProp, color, fontSize = SINGLE_BLOCK_DEFAULT_FONT_SIZE, blockId, transparentBackground } = shape.props
		const showBorder = settingdata["showCardBorder"] !== false && !transparentBackground
		// 背景是否透明与是否显示边框是两个独立的选项。画布上的
		// singleblock 在关闭边框时仍然保留颜色背景，导出也应保持一致。
		const hasBackground = !transparentBackground
		const border = showBorder ? BORDER_PX : 0
		const radius = 10
		const strokeColor = showBorder ? theme[color].solid : 'none'
		const fillColor = hasBackground ? theme[color].semi : 'none'
		const textColor = theme[color].solid
		// 高度与几何一致，直接采用属性高度
		const h = Math.max(hProp, MIN_HEIGHT)
		if (isSvgExportOutlineOnly()) {
			return <rect width={w} height={h} fill="none" stroke={theme[color].solid} strokeWidth={border || 1} rx={radius} ry={radius} />
		}

		// Clamp inner dimensions to avoid negative <foreignObject> size during export
		const innerW = Math.max(w - border * 2, 1)
		const innerH = Math.max(h - border * 2, 1)
		const cachedSnapshot = getCachedSvgExportSnapshot(shape.id)
		let serialized = cachedSnapshot ?? ''
		if (cachedSnapshot === null && typeof document !== 'undefined') {
			const host = getShapeHostElement(shape.id, this.editor.getContainer())
			const content = host?.querySelector('[blockid]') as HTMLElement | null
			if (content) {
				serialized = serializeElementForSvgExport(content, {
					viewportWidth: innerW,
					viewportHeight: innerH,
					fontSize,
				})
			}
		}
		const scopeId = `st-single-block-export-${shape.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`

		return (
			<g>
				{hasBackground || border > 0 ? (
					<rect width={w} height={h} fill={fillColor} stroke={strokeColor} strokeWidth={border} rx={radius} ry={radius} />
				) : (
					// 保持形状几何但不绘制填充与边框
					<rect width={w} height={h} fill="none" stroke="none" strokeWidth={0} rx={radius} ry={radius} />
				)}
				{serialized ? (
					<foreignObject x={border} y={border} width={Math.max(innerW, 1)} height={Math.max(innerH, 1)}>
						<div
							xmlns="http://www.w3.org/1999/xhtml"
							id={scopeId}
							style={{ width: '100%', height: '100%', overflow: 'hidden', fontSize: `${fontSize}px` }}
							dangerouslySetInnerHTML={{ __html: `${getSvgExportGlobalStyles(`#${scopeId}`)}${serialized}` }}
						/>
					</foreignObject>
				) : (
					<text x={w / 2} y={h / 2} fill={textColor} fontSize={fontSize * 0.9} dominantBaseline="middle" textAnchor="middle">
						{blockId ? `Block ${blockId.slice(-6)}` : 'Single Block'}
					</text>
				)}
			</g>
		)
	}
}

// ===== Single Block Binding =====
export type SingleBlockBinding = TLBaseBinding<
	'single-block',
	{
		anchor: VecModel
	}
>

export class SingleBlockBindingUtil extends BindingUtil<SingleBlockBinding> {
	static override type = 'single-block' as const

	override getDefaultProps() {
		return {
			anchor: { x: 0.5, y: 0.5 },
		}
	}

	// 当绑定的目标形状发生变化时，更新 single-block 的位置
	override onAfterChangeToShape({
		binding,
		shapeAfter,
	}: BindingOnShapeChangeOptions<SingleBlockBinding>): void {
		const singleBlock = this.editor.getShape<ISingleBlockShape>(binding.fromId)
		if (!singleBlock) return

		// 如果 single-block 被设置为不允许绑定，则移除此 binding 并返回
		if (singleBlock.props.allowBinding === false) {
			try {
				this.editor.deleteBindings([binding])
			} catch (err) {
				// ignore
			}
			return
		}

		const shapeBounds = this.editor.getShapeGeometry(shapeAfter)!.bounds
		const shapeAnchor = {
			x: lerp(shapeBounds.minX, shapeBounds.maxX, binding.props.anchor.x),
			y: lerp(shapeBounds.minY, shapeBounds.maxY, binding.props.anchor.y),
		}
		const pageAnchor = this.editor.getShapePageTransform(shapeAfter).applyToPoint(shapeAnchor)

		const singleBlockParentAnchor = this.editor
			.getShapeParentTransform(singleBlock)
			.invert()
			.applyToPoint(pageAnchor)

		this.editor.updateShape({
			id: singleBlock.id,
			type: 'single-block',
			x: singleBlockParentAnchor.x,
			y: singleBlockParentAnchor.y,
		})
	}

	// 当绑定的目标形状被删除时，删除 single-block
	// override onBeforeDeleteToShape({ binding }: BindingOnShapeDeleteOptions<SingleBlockBinding>): void {
	// 	this.editor.deleteShape(binding.fromId)
	// }
}
