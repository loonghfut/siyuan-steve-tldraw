import React, { ReactElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
	HTMLContainer,
	Rectangle2d,
	ShapeUtil,
	SvgExportContext,
	TLResizeInfo,
	useValue,
	resizeBox,
} from '@tldraw/tldraw'
import { cardShapeMigrations } from './card-shape-migrations'
import { cardShapeProps, getCardShapeDefaultProps } from './card-shape-props'
import { CardRenderMode, ICardShape } from './card-shape-types'
import { Protyle, showMessage, TProtyleAction } from 'siyuan';
import * as api from '@/api/api';
import { settingdata } from '@/index';
import { buildTldrawLink } from '../utils/link-builder';
import { ContentLoadHandle, enqueueProtyleLoad, ProtyleLoadHandle } from '../protyle-load-queue'
import { shapeLoadManager } from '../shape-load-manager'
import { enqueueStaticPreviewLoad } from '../static-preview-load-queue'
import { PortsOverlay } from '../BezierConnectorShape/Port'
import { renderAllContentIdle } from '../utils/render/content-renderer'
import { cancelIdleRender, isIdleRenderCancelledError } from '../utils/idle-scheduler'
import {
	getShapeLowDetailCountThreshold,
	getShapeLowDetailFontSize,
	getShapeLowDetailThreshold,
	getShapeRenderPolicy,
	getTotalCardAndSingleBlockCount,
	getViewportCullingCountThreshold,
	getVisibleCardAndSingleBlockCount,
} from '../utils/low-detail'
import { getLightweightPreviewTextFromElement } from '../utils/lightweight-preview'
import { convertProtyleHtmlToDom } from '../utils/render/content-html-converter'
import { CardContentVirtualizer } from './card-content-virtualizer'
import { exportCardShapeToSvg } from './CardShapeExport'
import { getCardCollapsedHeight } from './card-collapse'
import { cacheStaticPreview, getCachedPreview, invalidatePreviewCache } from './static-preview-cache'
import { warmCardStaticPreview } from './card-preview-warmup'
import { invalidateBlockExistenceCache, scheduleBlockCheck } from '../utils/block-existence'
import { clearStaticTextSelectionSoon, findStaticLinkTarget, isSteveToolsPluginUrl, openStaticLinkTarget } from '../utils/static-links'
import { safeDestroyProtyle } from '../utils/protyle-lifecycle'
import { runExclusiveBlockCreation } from '../utils/pending-creation'
import { MissingBlockOverlay } from '../ui/MissingBlockOverlay'
import { useRestoreCameraOnEdit } from '../utils/use-restore-camera-on-edit'
import { getDefaultColorTheme } from '../utils/color-theme'
import { inputDialogSync } from '@/libs/dialog'
import {
	beginBranchAttachmentDrag,
	beginBranchResize,
	clearBranchInteractionHint,
	endBranchResize,
	getBranchInteractionHintForShape,
	setBranchInteractionHint,
	syncBranchMoveForRootContent,
	updateBranchAttachmentAfterDrag,
	useBranchInteractionHint,
} from '../BranchShape'

// 按卡片隔离创建流程，避免多个新卡片互相复用创建结果
const draggingBranchCardIds = new Set<string>()

// Static Cards are previews, not editors. Keep enough blocks for the visible
// area and overscan, but never inherit SiYuan getDoc's 102400-block default.
// Entering edit mode still mounts the complete Protyle document. The previous
// fixed minimum of 40 made a board with many small Cards download hundreds of
// offscreen blocks before the first pixels could be painted.
const MIN_STATIC_PREVIEW_BLOCKS = 12
const MAX_STATIC_PREVIEW_BLOCKS = 96

const NON_VIRTUALIZABLE_MEDIA_SELECTOR = [
	'[data-type="NodeVideo"]',
	'[data-type="NodeAudio"]',
	'[data-type="NodeIFrame"]',
	'[data-type="NodeWidget"]',
	// Query embeds are asynchronously replaced with their result DOM. Recreating
	// them from outerHTML during card windowing can race that replacement.
	'[data-type="NodeBlockQueryEmbed"]',
	'video',
	'audio',
	'iframe',
].join(', ')
type DefaultCardBlockType = 'heading' | 'blockquote'

function containsNonVirtualizableMedia(element: HTMLElement) {
	return element.matches(NON_VIRTUALIZABLE_MEDIA_SELECTOR) || Boolean(element.querySelector(NON_VIRTUALIZABLE_MEDIA_SELECTOR))
}

function configureStaticPreviewMedia(root: HTMLElement) {
	// 卡片预览不播放视频；仅加载元数据可避免多个可见 Card 同时触发媒体解码。
	root.querySelectorAll<HTMLVideoElement>('video').forEach((video) => {
		if (!video.hasAttribute('preload')) video.preload = 'metadata'
	})
}

function getStaticPreviewBlockLimit(height: number, fontSize: number): number {
	const estimatedRowHeight = Math.max(28, fontSize * 1.7)
	const visibleRows = Math.max(1, Math.ceil(Math.max(1, height) / estimatedRowHeight))
	return Math.min(MAX_STATIC_PREVIEW_BLOCKS, Math.max(MIN_STATIC_PREVIEW_BLOCKS, visibleRows * 3))
}

function getDefaultCardBlockType(): DefaultCardBlockType {
	return settingdata['tldraw-card-default-block-type'] === 'blockquote' ? 'blockquote' : 'heading'
}

function buildDefaultCardBlockMarkdown(
	blockType: DefaultCardBlockType,
	title: string,
	blockId: string,
	link: string,
) {
	const firstLine = blockType === 'blockquote' ? `> ` : `###### ${title}`
	return (
		firstLine +
		'\n' +
		'{: id="' + blockId + '" custom-st-tldraw="1" custom-tldraw-link="' + link + '" }' +
		'\n\n' +
		'{: custom-st-tldraw-none="1" }' +
		'\n'
	)
}

export class CardShapeUtil extends ShapeUtil<ICardShape> {
	static override type = 'card' as const
	// [1]
	static override props = cardShapeProps
	// [2]
	static override migrations = cardShapeMigrations

	// [3]
	override canCull(shape: ICardShape) {
		// Keep the active editor mounted; all other cards can use tldraw's native culling.
		return this.editor.getEditingShapeId() !== shape.id
	}
	override isAspectRatioLocked(_shape: ICardShape) {
		return false
	}
	override hideRotateHandle(_shape: ICardShape) {
		return false
	}
	override canResize(_shape: ICardShape) {
		return true
	}
	override canEdit() {
		return true
	}
	override canScroll(_shape: ICardShape) {
		return true
	}
	// [4]
	override onBeforeUpdate(prev: ICardShape, next: ICardShape) {
		if (prev.props.blockId && next.props.blockId === '') {
			next.props.blockId = prev.props.blockId;
		}

		if (draggingBranchCardIds.has(next.id as string) && (prev.x !== next.x || prev.y !== next.y)) {
			syncBranchMoveForRootContent(this.editor, prev, next)
			setBranchInteractionHint(getBranchInteractionHintForShape(this.editor, next))
		}
	}

	getDefaultProps(): ICardShape['props'] {
		return getCardShapeDefaultProps()
		/*
		return {
			w: 300,
			h: 300,
			color: 'black',
			showMask: true,
			blockId: '',
			isNewlyCreated: true,
			fontSize: 16, // 默认字体大小
			isMain: false, // 是否为主卡片
			refreshNonce: Date.now(), // 用于之后强制刷新
			isCollapsed: false, // 默认不折叠
			renderMode: 'inherit' as CardRenderMode, // 卡片单独渲染模式: inherit | static-dom | live-protyle
			// version: 1, // 版本号
			collapsedTextSize: 21, // 折叠后的文字大小
			collapsedTextAlign: 'center', // 折叠后的文字对齐方式
		}
		*/
	}

	// [5]
	getGeometry(shape: ICardShape) {
		return new Rectangle2d({
			width: shape.props.w,
			height: shape.props.h,
			isFilled: true,
		})
	}

	override getIndicatorPath(shape: ICardShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
	// [6]
	component(shape: ICardShape) {
		// const bounds = this.editor.getShapeGeometry(shape).bounds
		const editor = this.editor
		const theme = getDefaultColorTheme({ isDarkMode: this.editor.user.getIsDarkMode() })
		const isEditing = useValue('card is editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
		const branchInteractionHint = useBranchInteractionHint()
		const isRootAttachTarget =
			branchInteractionHint?.mode === 'attach' &&
			branchInteractionHint.slot === 'root' &&
			(branchInteractionHint.targetShapeId === shape.id ||
				(!branchInteractionHint.targetShapeId && branchInteractionHint.draggingShapeId === shape.id))
		const isEditingState = isEditing
		const [canLoad, setCanLoad] = useState(false); // gating heavy render by global manager
		const [inPreloadZone, setInPreloadZone] = useState(false); // 准入环之外的预热环，用于缓存预热
		const [hasMissingLinkedBlock, setHasMissingLinkedBlock] = useState(false);
		const totalCardAndSingleBlockCount = useValue(
			'total card and single-block count',
			() => getTotalCardAndSingleBlockCount(editor),
			[editor],
		)
		// 视野裁剪总开关 + 数量门槛：卡片很少的白板直接全部加载，避免加载过程可见
		const viewportCullingCountThreshold = getViewportCullingCountThreshold()
		const isViewportCullingEnabled = settingdata['tldraw-viewport-culling'] !== false &&
			(viewportCullingCountThreshold <= 0 || totalCardAndSingleBlockCount >= viewportCullingCountThreshold);
		const tldrawHeaderImage = settingdata['tldraw-header-image'] !== false;
		const [collapsedText, setCollapsedText] = useState<string>('加载中...');
		const [collapsedDocInfo, setCollapsedDocInfo] = useState<{
			title: string;
			titleImg?: string;
			titleImgSrc?: string;
			titleImgBackground?: string;
			titleImgColor?: string;
			titleImgHasUrl?: boolean;
		} | null>(null);
		const isCollapsed = shape.props.isCollapsed || false;
		const efficientZoom = useValue('card efficient zoom', () => editor.getEfficientZoomLevel(), [editor])
		const visibleCardAndSingleBlockCount = useValue(
			'card and single-block low-detail count',
			() => getVisibleCardAndSingleBlockCount(editor),
			[editor],
		)
		const lowDetailThreshold = getShapeLowDetailThreshold()
		const lowDetailCountThreshold = getShapeLowDetailCountThreshold()
		const hasEnoughShapesForLowDetail = lowDetailCountThreshold <= 0 || visibleCardAndSingleBlockCount >= lowDetailCountThreshold
		const isSmallCard = !isEditingState && hasEnoughShapesForLowDetail && lowDetailThreshold > 0 && Math.min(shape.props.w, shape.props.h) * efficientZoom < lowDetailThreshold
		// Shapes outside the full-preview budget keep their persisted text summary.
		// This makes viewport culling visually consistent with low-zoom rendering.
		const exitEditGraceUntilRef = useRef(0)
		// 退出编辑的宽限期内不降级为轻量预览，避免相机动画过程中尺寸/缩放抖动引发的闪动
		const inExitGrace = Date.now() < exitEditGraceUntilRef.current
		const renderPolicy = getShapeRenderPolicy({
			isEditing: isEditingState,
			isViewportCullingEnabled,
			canLoad,
			isSmallShape: isSmallCard,
			isCollapsed,
			inExitGrace,
		})
		const shouldUseLightweightPreview = renderPolicy.shouldUseLightweightPreview
		const lowDetailFontSize = getShapeLowDetailFontSize(Math.min(shape.props.w, shape.props.h), efficientZoom)
		const isMainCard = Boolean(shape.props.isMain);
		const collapsedTextSize = shape.props.collapsedTextSize || 21; // 折叠文字大小，默认21px
		const collapsedTextAlign = shape.props.collapsedTextAlign || 'center'; // 折叠文字对齐，默认居中
		const collapsedTextLineHeight = 1.4;
		const collapsedTextAvailableHeight = Math.max(
			shape.props.h - 20,
			collapsedTextSize * collapsedTextLineHeight
		);
		const collapsedTextLineClamp = Math.max(
			1,
			Math.floor(collapsedTextAvailableHeight / (collapsedTextSize * collapsedTextLineHeight))
		);
		const headerGradientFallback = `linear-gradient(135deg, ${theme[shape.props.color].solid} 0%, ${theme[shape.props.color].semi} 100%)`;
		const cardInnerGap = 4

		// 计算有效渲染模式（不使用 useMemo，确保每次渲染都读取最新的全局设置）
		const globalRenderMode: Exclude<CardRenderMode, 'inherit'> =
			settingdata["card-render-mode"] === 'live-protyle' ? 'live-protyle' : 'static-dom';
		const effectiveRenderMode: Exclude<CardRenderMode, 'inherit'> =
			shape.props.renderMode === 'inherit' || !shape.props.renderMode
				? globalRenderMode
				: (shape.props.renderMode as Exclude<CardRenderMode, 'inherit'>);
		// While editing, viewport admission must not cancel the queued Protyle mount.
		const renderAdmission = renderPolicy.renderAdmission
		const cardInnerEdgeShadow = 'inset 0 0 0 5px var(--b3-body-background, var(--b3-theme-background, #fff))'
		const cardOuterShadow = isRootAttachTarget
			? '0 0 0 4px rgba(34, 197, 94, 0.42), 0 0 20px rgba(34, 197, 94, 0.32)'
			: isEditingState
				? '0 0 0 2px #3d8aff'
				: ''

		// 缓存 blockId 以减少属性访问
		const blockId = shape.props.blockId;
		const fontSize = shape.props.fontSize || 16;
		const staticPreviewBlockLimit = getStaticPreviewBlockLimit(shape.props.h, fontSize)

		// 追踪上一次的编辑状态，用于检测编辑->非编辑的切换
		const prevIsEditingRef = useRef(isEditingState);
		// 始终指向最新编辑态，供 shapeLoadManager 的 metaProvider 读取（避免把 isEditingState 放进 effect 依赖导致重注册）
		const isEditingStateRef = useRef(isEditingState);
		isEditingStateRef.current = isEditingState;
		// 退出编辑后的短暂宽限期：期间不销毁/不降级为轻量预览，避免相机动画与准入重算造成的闪动
		const [exitEditGrace, setExitEditGrace] = useState(false);
		const exitEditGraceTimerRef = useRef<number | null>(null);
		const refreshNonceRef = useRef(shape.props.refreshNonce);
		// 每个新卡片只询问一次用户标题，避免编辑态重渲染时重复弹窗
		const userTitlePromptedRef = useRef(false)
		const prevCollapsedRef = useRef(isCollapsed);

		// 稳定引用当前 shape props，供折叠图标点击回调使用，避免 useCallback 依赖 shape.props 导致频繁重建
		const shapePropsRef = useRef(shape.props);
		shapePropsRef.current = shape.props;

		const handleUncollapse = useCallback((e: React.PointerEvent | React.MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			const props = shapePropsRef.current;
			const storedHeight = props.preCollapseHeight;
			this.editor.updateShape({
				id: shape.id,
				type: shape.type,
				props: {
					...props,
					isCollapsed: false,
					h: storedHeight && storedHeight > 0 ? storedHeight : props.h,
					preCollapseHeight: undefined,
				},
			});
		}, [shape.id, shape.type]);


		// 仅在编辑时创建 Protyle 实例
		const protyleRef = useRef<Protyle | null>(null)
		// Protyle 的承载元素（脱离 containerRef 创建，再 append 进去）
		const protyleHostRef = useRef<HTMLDivElement | null>(null)
		// 非编辑态下的静态预览节点（由 Protyle contentElement 克隆而来）
		const staticPreviewRef = useRef<HTMLElement | null>(null)
		const cardContentVirtualizerRef = useRef<CardContentVirtualizer | null>(null)
		const staticPreviewLoadRef = useRef<ContentLoadHandle | null>(null)
		const richRenderAbortRef = useRef<AbortController | null>(null)
		const staticPreviewPriorityRef = useRef(Number.MAX_SAFE_INTEGER)
		const staticPreviewHandlersRef = useRef<{
			target: HTMLElement
			pointerDown: (event: PointerEvent) => void
			pointerUp: (event: PointerEvent) => void
			click: (event: MouseEvent) => void
			dragStart: (event: DragEvent) => void
		} | null>(null)
		const removeStaticPreviewLinkHandlers = useCallback((preview?: HTMLElement | null) => {
			const handlers = staticPreviewHandlersRef.current
			const target = handlers?.target || preview || staticPreviewRef.current
			if (!target || !handlers) return
			target.removeEventListener('pointerdown', handlers.pointerDown, true)
			target.removeEventListener('pointerup', handlers.pointerUp, true)
			target.removeEventListener('click', handlers.click, true)
			target.removeEventListener('dragstart', handlers.dragStart, true)
			target.classList.remove('card-static-content')
			staticPreviewHandlersRef.current = null
		}, [])
		const destroyCardContentVirtualizer = useCallback(() => {
			const virtualizer = cardContentVirtualizerRef.current
			const preview = staticPreviewRef.current
			// 虚拟化预览在富内容渲染完成后会把渲染结果回写到块 HTML 上（含
			// data-card-rich-rendered 块级标记）；销毁前把完整文档写回缓存。
			// 注意条目级 rendered 必须为 false：只有被窗口化渲染过的块才真正
			// 完成了富渲染，未滚动到的块靠块级标记在后续窗口里按需渲染。
			if (virtualizer && preview && virtualizer.hasRenderedContent()) {
				const previewBlockId = preview.dataset.cardPreviewBlockId
				if (previewBlockId) {
					cacheStaticPreview(
						previewBlockId,
						virtualizer.getFullHtml(),
						Number(preview.dataset.cardPreviewBlockLimit || 0),
						preview.dataset.cardPreviewText || '',
						false,
					)
				}
			}
			virtualizer?.destroy()
			cardContentVirtualizerRef.current = null
		}, [])
		// 统一的静态预览移除入口：回写缓存快照、解绑事件、摘除 DOM
		const removeStaticPreview = useCallback(() => {
			const current = staticPreviewRef.current
			destroyCardContentVirtualizer()
			removeStaticPreviewLinkHandlers()
			if (current?.parentElement) {
				try { current.parentElement.removeChild(current) } catch { }
			}
			staticPreviewRef.current = null
		}, [destroyCardContentVirtualizer, removeStaticPreviewLinkHandlers])
		// tldraw will re-render this component when this shape's props change.
		// React to the two props the virtualizer cares about directly instead of
		// registering one store listener per Card. Store listeners remain active for
		// culled components, so the old approach made every document update fan out
		// to every Card on a large board.
		useEffect(() => {
			cardContentVirtualizerRef.current?.refresh()
		}, [shape.props.w, shape.props.h])
		const installStaticPreviewLinkHandlers = useCallback((preview: HTMLElement) => {
			removeStaticPreviewLinkHandlers()
			preview.classList.add('card-static-content')
			const pointerHandler = (event: PointerEvent) => {
				if (findStaticLinkTarget(event.target, preview)) {
					event.preventDefault()
					clearStaticTextSelectionSoon()
					event.stopPropagation()
				}
			}
			const clickHandler = (event: MouseEvent) => {
				if (event.defaultPrevented) return
				const target = findStaticLinkTarget(event.target, preview)
				if (!target) return
				if (!target.blockId && target.href && isSteveToolsPluginUrl(target.href)) return
				event.preventDefault()
				event.stopPropagation()
				clearStaticTextSelectionSoon()
				openStaticLinkTarget(target)
			}
			const dragStartHandler = (event: DragEvent) => {
				event.preventDefault()
				event.stopPropagation()
				clearStaticTextSelectionSoon()
			}
			staticPreviewHandlersRef.current = {
				target: preview,
				pointerDown: pointerHandler,
				pointerUp: pointerHandler,
				click: clickHandler,
				dragStart: dragStartHandler,
			}
			preview.addEventListener('pointerdown', pointerHandler, true)
			preview.addEventListener('pointerup', pointerHandler, true)
			preview.addEventListener('click', clickHandler, true)
			preview.addEventListener('dragstart', dragStartHandler, true)
		}, [removeStaticPreviewLinkHandlers])
		// 全局由 shapeLoadManager 计算可见性，无需本地定时轮询
		const loadHandleRef = useRef<ProtyleLoadHandle | null>(null)

		const setProtyleHostVisible = useCallback((visible: boolean) => {
			const host = protyleHostRef.current
			if (host) host.style.display = visible ? '' : 'none'
		}, [])

		const destroyRuntimeResources = useCallback(() => {
			richRenderAbortRef.current?.abort()
			richRenderAbortRef.current = null
			if (loadHandleRef.current) {
				loadHandleRef.current.cancel()
				loadHandleRef.current = null
			}
			if (staticPreviewLoadRef.current) {
				staticPreviewLoadRef.current.cancel()
				staticPreviewLoadRef.current = null
			}
			removeStaticPreview()
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
		}, [removeStaticPreview])


		const containerRef = useRef<HTMLDivElement>(null)
		const lastSizeRef = useRef({ h: shape.props.h })
		// 保存编辑前的形状层级索引，用于退出编辑后恢复原层次
		const originalIndexRef = useRef<string | null>(null)
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
		const enterMissingLinkedBlockState = useCallback(() => {
			destroyRuntimeResources()
			setHasMissingLinkedBlock(true)
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
			if (blockId) {
				invalidatePreviewCache(blockId)
				invalidateBlockExistenceCache(blockId)
			}
			destroyRuntimeResources()
			setHasMissingLinkedBlock(false)
			editor.updateShape({
				id: shape.id,
				type: shape.type,
				props: {
					...shape.props,
					refreshNonce: Date.now(),
				},
			})
		}, [blockId, destroyRuntimeResources, editor, shape.id, shape.props, shape.type])
		const handleDeleteMissingLinkedBlock = useCallback((event: React.PointerEvent | React.MouseEvent) => {
			stopMissingStateEvent(event)
			editor.deleteShape(shape.id)
		}, [editor, shape.id])


		// 编辑时临时置顶，退出编辑后恢复原层次
		useEffect(() => {
			if (isEditing) {
				// 进入编辑：保存原始 index 并用原生方法置顶
				if (originalIndexRef.current === null) {
					originalIndexRef.current = shape.index;
				}
				try {
					this.editor.bringToFront([shape.id]);
				} catch (e) {
					// ignore
				}
			} else {
				// 退出编辑：恢复原始层次
				if (originalIndexRef.current !== null) {
					try {
						this.editor.updateShapes([{
							id: shape.id,
							type: shape.type,
							index: originalIndexRef.current,
						}]);
					} catch (e) {
						// ignore
					}
					originalIndexRef.current = null;
				}
			}
		}, [isEditing, shape.id]);

		useLayoutEffect(() => {
			const prevH = lastSizeRef.current.h
			const nextH = shape.props.h
			if (prevH !== nextH) {
				lastSizeRef.current = { h: nextH }
			}
		}, [shape.props.h])

		// 检测编辑状态变化：从编辑 -> 非编辑时，使静态预览缓存失效
		const prevEditingForCacheRef = useRef(isEditingState);
		useEffect(() => {
			const wasEditing = prevEditingForCacheRef.current;
			prevEditingForCacheRef.current = isEditingState;

			// 从编辑状态退出时，使该 blockId 的缓存失效，确保下次使用最新内容
			if (wasEditing && !isEditingState && blockId) {
				invalidatePreviewCache(blockId);
			}
		}, [isEditingState, blockId]);

		// 折叠/展开时记录高度并在展开时恢复
		useEffect(() => {
			const prev = prevCollapsedRef.current;
			const collapsedHeight = getCardCollapsedHeight(shape);
			const storedHeight = shape.props.preCollapseHeight;

			// 折叠状态下进入编辑：临时恢复到折叠前高度，便于编辑
			if (isCollapsed && isEditingState) {
				const restoreHeight = (storedHeight && storedHeight > 0) ? storedHeight : shape.props.h || collapsedHeight;
				const ensuredStoredHeight = storedHeight || shape.props.h || collapsedHeight;
				if (shape.props.h !== restoreHeight) {
					this.editor.updateShape({
						id: shape.id,
						type: shape.type,
						props: {
							...shape.props,
							isCollapsed: true,
							preCollapseHeight: ensuredStoredHeight,
							h: restoreHeight,
						},
					});
				}
				prevCollapsedRef.current = isCollapsed;
				return;
			}

			// 折叠且非编辑：如果未记录高度则记录并收缩；若已记录则确保收缩到折叠高度
			if (isCollapsed) {
				if (!storedHeight) {
					this.editor.updateShape({
						id: shape.id,
						type: shape.type,
						props: {
							...shape.props,
							isCollapsed: true,
							preCollapseHeight: shape.props.h,
							h: collapsedHeight,
						},
					});
				} else if (shape.props.h !== collapsedHeight) {
					this.editor.updateShape({
						id: shape.id,
						type: shape.type,
						props: {
							...shape.props,
							isCollapsed: true,
							preCollapseHeight: storedHeight,
							h: collapsedHeight,
						},
					});
				}
				prevCollapsedRef.current = isCollapsed;
				return;
			}

			// 从折叠 -> 展开时恢复高度
			if (prev && !isCollapsed && storedHeight && storedHeight > 0) {
				this.editor.updateShape({
					id: shape.id,
					type: shape.type,
					props: {
						...shape.props,
						h: storedHeight,
						isCollapsed: false,
						preCollapseHeight: undefined,
					},
				});
				prevCollapsedRef.current = isCollapsed;
				return;
			}

			// 同步记录当前折叠状态
			prevCollapsedRef.current = isCollapsed;
		}, [isCollapsed, isEditingState, shape.props.h, shape.props.preCollapseHeight, shape.id, shape.props.fontSize, shape.type, isMainCard]);

		// 编辑模式切换时聚焦到形状，并在退出编辑后恢复之前的视角
		useRestoreCameraOnEdit(this.editor, isEditing, shape.id, 'Card形状')

		// 解析题头图：提取背景图 URL/渐变，并返回 img src 以及背景信息
		const parseTitleImg = (titleImg?: string): {
			src: string;
			backgroundImage?: string;
			backgroundColor?: string;
			hasUrl?: boolean;
		} => {
			const fallback = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
			if (!titleImg) return { src: fallback };
			let imgSrc = fallback;
			let hasUrl = false;
			let backgroundImage: string | undefined;
			let backgroundColor: string | undefined;

			// 先检查是否包含 url()（可能是 background 属性中的 url）
			const urlMatch = titleImg.match(/url\(["']?([^"')]+)["']?\)/i);
			if (urlMatch) {
				hasUrl = true;
				const imgPath = urlMatch[1];
				imgSrc = `${imgPath}`;
				backgroundImage = `url(${imgSrc})`;
			} else {
				// 尝试从 background-image 属性提取
				const bgImageMatch = titleImg.match(/background-image\s*:\s*([^;]+);?/i);
				if (bgImageMatch) {
					backgroundImage = bgImageMatch[1].trim(); // 支持线性渐变等
				} else {
					// 尝试从 background 属性中提取（包含渐变的完整背景定义）
					// 如: "background: linear-gradient(...)" 或复合 background 定义
					const bgMatch = titleImg.match(/background\s*:\s*([^;]+)/i);
					if (bgMatch) {
						const bgValue = bgMatch[1].trim();
						// 检查是否包含渐变或图片
						if (bgValue.includes('gradient') || bgValue.includes('url(')) {
							backgroundImage = bgValue;
						}
					}
				}
			}

			const bgColorMatch = titleImg.match(/background-color\s*:\s*([^;]+);?/i);
			if (bgColorMatch) {
				backgroundColor = bgColorMatch[1].trim();
			}

			return { src: imgSrc, backgroundImage, backgroundColor, hasUrl };
		};

		// 折叠状态下的展示内容：
		// - isMain: 显示题头图和标题
		// - 其他: 显示块内容摘要
		useEffect(() => {
			if (!isCollapsed || !shape.props.blockId) return;

			let cancelled = false;

			const loadForMain = async () => {
				try {
					const info = await api.getDocInfo(shape.props.blockId);
					if (cancelled) return;
					const ial = info?.ial || {};
					const titleImg = ial['title-img'];
					const title = ial.title || info?.name || '未命名文档';
					const parsed = parseTitleImg(titleImg);
					setCollapsedDocInfo({
						title,
						titleImg,
						titleImgSrc: parsed.src,
						titleImgBackground: parsed.backgroundImage,
						titleImgColor: parsed.backgroundColor,
						titleImgHasUrl: parsed.hasUrl,
					});
				} catch (e) {
					if (cancelled) return;
					setCollapsedDocInfo({ title: '未命名文档' });
				}
			};

			const loadForNormal = async () => {
				try {
					const res = await api.getBlockByID(shape.props.blockId);
					if (cancelled) return;
					if (res && res.content) {
						const plainText = res.content
							.replace(/\[🔗\]\([^)]+\)/g, '')
							.replace(/^#+\s+/gm, '')
							.replace(/\{:[^}]+\}/g, '')
							.trim();
						const preview = plainText
						setCollapsedText(preview || '空块');
					} else {
						setCollapsedText('空块');
					}
				} catch {
					if (cancelled) return;
					setCollapsedText('加载失败');
				}
			};

			if (isMainCard) {
				loadForMain();
			} else {
				loadForNormal();
			}

			return () => { cancelled = true; };
		}, [isCollapsed, shape.props.blockId, isMainCard]);



		// register with global shape load manager (drives visibility + load admission)
		// 注意：依赖只放 shape.id，编辑态切换通过 isEditingStateRef 读取，避免每次编辑翻转都 unregister/register，
		// 否则 shapeLoadManager 的悲观重置会让入场状态短暂回落到 blocked，导致退出编辑时闪一下。
		useEffect(() => {
			shapeLoadManager.attachEditor(this.editor as any)
			const unregister = shapeLoadManager.register(
				shape.id,
				this.editor as any,
				() => ({ editing: isEditingStateRef.current }),
				(allowed, meta) => {
					const distance = Number.isFinite(meta.distance) ? Math.max(0, meta.distance) : 1_000_000
					const centerPriority = Math.min(100, Math.floor(distance / 160))
					// The load manager already measures distance from the viewport center.
					// Reuse that score so static preview construction follows the same order.
					staticPreviewPriorityRef.current = meta.inViewport ? centerPriority : 1_000 + centerPriority
					staticPreviewLoadRef.current?.setPriority(staticPreviewPriorityRef.current)
					setCanLoad(allowed)
					setInPreloadZone(meta.inPreloadZone)
				}
			)
			return unregister
		}, [shape.id])

		// 预热环预热：尚未获得准入的 Card 提前把 getDoc 结果写入缓存（不挂 DOM），
		// 用户平移进入准入环时命中缓存即可立即上屏
		useEffect(() => {
			if (isEditingState || isCollapsed) return
			if (isMainCard || effectiveRenderMode !== 'static-dom') return
			if (!isViewportCullingEnabled || !blockId) return
			if (canLoad) return
			if (!inPreloadZone) return
			warmCardStaticPreview(blockId, staticPreviewBlockLimit)
		}, [isEditingState, isCollapsed, isMainCard, effectiveRenderMode, isViewportCullingEnabled, blockId, canLoad, inPreloadZone, staticPreviewBlockLimit])

		// 移除轻量预览逻辑，统一使用 Protyle 渲染

		// 字体大小变更时，如果处于编辑且存在 Protyle，则更新其样式
		useEffect(() => {
			if (protyleRef.current?.protyle?.wysiwyg?.element) {
				protyleRef.current.protyle.wysiwyg.element.style.fontSize = `${shape.props.fontSize || 16}px`;
			} else if (containerRef.current) {
				const wys = containerRef.current.querySelector(".protyle-wysiwyg");
				if (wys) (wys as HTMLElement).style.fontSize = `${shape.props.fontSize || 16}px`;
			}
		}, [shape.props.fontSize]);
		// NOTE: previously we experimented with creating a Siyuan block immediately on shape creation
		// (isNewlyCreated === true). That led to behavior where a block would be created before the
		// user actually edited the shape. To maintain the original UX and keep parity with
		// `single-block` shapes, we intentionally do NOT create blocks at shape creation time.
		// Block creation continues to occur during mount/edit workflows (e.g. mountProtyle) as before.
		// 非编辑态下做一次存在性检查，使用批量检查机制
		useEffect(() => {
			const container = containerRef.current;
			const currentBlockId = container?.getAttribute('blockid') || blockId;
			if (!blockId && currentBlockId) {
				this.editor.updateShape({
					id: shape.id,
					type: shape.type,
					props: { ...shape.props, blockId: currentBlockId }
				});
			}
			if (currentBlockId && !isEditingState) {
				// Native tldraw culling may mount a Card before the admission
				// callback has run. Defer the existence check until this Card is
				// actually eligible for the viewport; otherwise a large offscreen
				// board creates a second request wave before visible content loads.
				if (renderAdmission !== 'allowed') return;
				if (shape.props.isNewlyCreated) {
					this.editor.updateShape({
						id: shape.id,
						type: shape.type,
						props: { ...shape.props, isNewlyCreated: false }
					});
				} else {
					// 使用批量检查机制
					let cancelled = false;
					scheduleBlockCheck(currentBlockId, shape.id).then((exists) => {
						if (cancelled) return;
						if (exists) {
							setHasMissingLinkedBlock(false);
							return;
						}
						enterMissingLinkedBlockState();
					});
					return () => { cancelled = true; };
				}
			}
		}, [blockId, editor, enterMissingLinkedBlockState, isEditingState, renderAdmission, shape.id, shape.props, shape.type, shape.props.refreshNonce]);
		// Protyle 生命周期管理主 Effect
		// 注意：对于 live-protyle 模式，编辑状态切换不应触发重建
		useEffect(() => {
			const renderTaskId = `render-card-content-${shape.id}`
			const richRenderAbortController = new AbortController()
			richRenderAbortRef.current?.abort()
			richRenderAbortRef.current = richRenderAbortController
			// 检测是否为手动刷新（通过 refreshNonce 变更触发）
			const manualRefreshTriggered = refreshNonceRef.current !== shape.props.refreshNonce;
			const shouldForceReloadLiveProtyle =
				effectiveRenderMode === 'live-protyle' &&
				manualRefreshTriggered;
			// 更新引用以记录最新的 nonce
			refreshNonceRef.current = shape.props.refreshNonce;

			// 检测刚从编辑态退出：在宽限期内不降级/不销毁，避免相机动画与准入重算造成的闪动
			const wasEditing = prevIsEditingRef.current && !isEditingState;
			prevIsEditingRef.current = isEditingState;
			if (wasEditing) {
				exitEditGraceUntilRef.current = Date.now() + 600;
				setExitEditGrace(true);
				if (exitEditGraceTimerRef.current) window.clearTimeout(exitEditGraceTimerRef.current);
				exitEditGraceTimerRef.current = window.setTimeout(() => {
					exitEditGraceUntilRef.current = 0;
					setExitEditGrace(false);
				}, 600);
			}
			const inExitGrace = Date.now() < exitEditGraceUntilRef.current;

			// 折叠状态下不渲染 Protyle
			if (isCollapsed && !isEditingState) {
				destroyRuntimeResources();
				return;
			}
			if (isSmallCard && !inExitGrace) {
				destroyRuntimeResources();
				return;
			}

			const shouldRender = renderAdmission === 'allowed';
			if (!shouldRender) {
				// live-protyle 模式仅在实例存在时隐藏而非销毁，等待准入恢复后复用，避免闪动
				if (effectiveRenderMode === 'live-protyle' && protyleRef.current) {
					setProtyleHostVisible(false);
				} else {
					destroyRuntimeResources();
				}
				return;
			}

			if (shouldForceReloadLiveProtyle) {
				destroyRuntimeResources();
			}

			if (!containerRef.current || !window.siyuan?.ws?.app) return;
			// effectiveRenderMode 已通过 useMemo 计算

			// 等待 Protyle 完成首次内容渲染（尽量接近编辑态样式）
			// const waitForProtyleRendered = async (pt: Protyle, timeout = 800) => {
			// 	const ce = pt.protyle?.contentElement as HTMLElement | undefined;
			// 	if (!ce) return;
			// 	if (ce.childElementCount > 0) {
			// 		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
			// 		return;
			// 	}
			// 	await new Promise<void>((resolve) => {
			// 		let done = false;
			// 		const finish = () => {
			// 			if (done) return; done = true; resolve();
			// 		};
			// 		const obs = new MutationObserver(() => {
			// 			if (ce.childElementCount > 0) {
			// 				obs.disconnect();
			// 				requestAnimationFrame(() => requestAnimationFrame(finish));
			// 			}
			// 		});
			// 		obs.observe(ce, { childList: true, subtree: true });
			// 		setTimeout(() => { try { obs.disconnect(); } catch { } finish(); }, timeout);
			// 	});
			// };

			const mountProtyle = async (priority: number): Promise<string | null> => {
				if (cancelled) return null;
				let currentBlockId: string | null = containerRef.current?.getAttribute('blockid') || shape.props.blockId || null;
				if (!currentBlockId) {
					const editorElement = containerRef.current?.closest('.tldraw__editor');
					const tldrawId = editorElement?.getAttribute('data-tldraw-id');
					if (!settingdata["tl-draw-create-note-id"] && !tldrawId) {
						showMessage('配置不完整,请检查设置');
						return null;
					}
					try {
						currentBlockId = await runExclusiveBlockCreation(shape.id as string, async () => {
							const idid = await api.generateSiyuanID() as string;
							const link = buildTldrawLink(tldrawId, idid);
							const defaultBlockType = getDefaultCardBlockType();
							const initialTitle = defaultBlockType === 'heading'
								? String(settingdata["tldraw-custom-card-title"] || "${timestamp}")
									.replace(/\$\{timestamp\}/g, () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
								: '';
							const content = buildDefaultCardBlockMarkdown(defaultBlockType, initialTitle, idid, link)
							const redata = await api.appendBlock("markdown", content, tldrawId!);
							const newBlockId = redata[0].doOperations[0].id as string;

							if (defaultBlockType === 'heading' && isEditingState && !shape.props.blockId && !containerRef.current?.getAttribute('blockid') && settingdata["tldraw-prompt-card-title"] && !userTitlePromptedRef.current) {
								userTitlePromptedRef.current = true;
								try {
									const input = await inputDialogSync({
										title: '输入卡片标题',
										placeholder: '请输入标题',
										width: '520px',
										confirmOnEnter: true,
									});
									const userTitle = input?.replace(/[\r\n]+/g, ' ').trim() || '';
									if (userTitle) {
										// updateBlock 会整体替换块内容，因此必须重新附带 Card 的 IAL。
										await api.updateBlock('markdown', buildDefaultCardBlockMarkdown(defaultBlockType, userTitle, idid, link), newBlockId);
									}
								} catch (err) {
									// 标题更新失败不应影响已创建块与 Card 的绑定。
									console.log('更新卡片标题失败，继续使用默认标题', err);
								}
							}
							return newBlockId;
						});
					} catch (err) {
						console.error('创建块失败', err);
					}
					if (cancelled) return null;
				}

				if (!currentBlockId) {
					showMessage('未找到块');
					return null;
				}

				if (cancelled) return null;
				containerRef.current?.setAttribute('blockid', currentBlockId);
				if (cancelled) return null;

				loadHandleRef.current?.cancel();
				const handle = enqueueProtyleLoad(shape.id, priority, async (signal) => {
					if (cancelled || signal.aborted) return;
					const currentContainer = containerRef.current;
					if (!currentContainer) return;
					// 静态预览保留到 Protyle 就绪后再移除（见下方），避免进入编辑时白屏闪动；
					// 这里只清理旧的 Protyle 宿主。
					if (protyleHostRef.current && protyleHostRef.current.parentElement === currentContainer) {
						try {
							protyleHostRef.current.parentElement.removeChild(protyleHostRef.current);
						} catch {
							// ignore
						}
					}
					if (signal.aborted || cancelled) return;
					const host = document.createElement('div');
					host.className = 'card-protyle-host';
					host.style.width = '100%';
					host.style.height = '100%';
					host.style.overflow = 'hidden';
					protyleHostRef.current = host;
					let resolveReady: (() => void) | null = null;
					const readyPromise = new Promise<void>((resolve) => (resolveReady = resolve));
					// 防止 Protyle 无法正常触发 `after` 导致永远等待，增加超时与异常保护
					let readyTimeoutId: number | null = null;
					const READY_TIMEOUT_MS = 1000;
					const timeoutPromise = new Promise<void>((resolve) => {
						readyTimeoutId = window.setTimeout(resolve, READY_TIMEOUT_MS);
					});
					const readyWithTimeout = Promise.race([readyPromise, timeoutPromise]);
					let protyleInstance: Protyle | null = null;
					try {
						// 对于 live-protyle 模式，始终创建可编辑的 Protyle（后续通过 enable/disable 控制）
						const shouldFocus = isEditingState && effectiveRenderMode === 'live-protyle';
						const actions = ['cb-get-all', ...(shouldFocus ? ['cb-get-focus'] : [])] as TProtyleAction[]
						protyleInstance = new Protyle(window.siyuan.ws.app, host, {
							blockId: currentBlockId,
							rootId: currentBlockId,
							render: {
								background: (shape.props.isMain && tldrawHeaderImage),
								breadcrumb: false,
								gutter: true,
								title: shape.props.isMain,
								breadcrumbDocName: shape.props.isMain,
							},
							action: actions,
							mode: "wysiwyg",
							after: (protyle: Protyle) => {
								protyle.protyle.wysiwyg.preventKeyup = true;
								resolveReady && resolveReady();
							},
							handleEmptyContent: () => {
								enterMissingLinkedBlockState();
							},
							click: {
								/** 点击末尾是否阻止插入新块 */
								preventInsetEmptyBlock: true,
							}
						});
					} catch (err) {
						console.error('Protyle 构造失败', err);
						if (host.parentElement) {
							try { host.parentElement.removeChild(host); } catch { }
						}
						return;
					}
					if (signal.aborted || cancelled) {
						safeDestroyProtyle(protyleInstance)
						return;
					}
					protyleRef.current = protyleInstance;
					currentContainer.appendChild(host);
					if (protyleInstance.protyle?.wysiwyg?.element) {
						protyleInstance.protyle.wysiwyg.element.style.fontSize = `${fontSize}px`;
					}
					// 等待 Protyle 就绪，但带超时保护，避免长时间阻塞加载队列
					await readyWithTimeout.catch(() => { });
					if (readyTimeoutId) {
						clearTimeout(readyTimeoutId);
						readyTimeoutId = null;
					}
					if (signal.aborted || cancelled) {
						safeDestroyProtyle(protyleInstance)
						if (protyleHostRef.current === host && host.parentElement) {
							host.parentElement.removeChild(host);
						}
						if (protyleRef.current === protyleInstance) {
							protyleRef.current = null;
						}
						return;
					}
					// Protyle 已完成首次渲染：此时再移除静态预览，进入编辑无白屏闪动
					removeStaticPreview()
				});
				loadHandleRef.current = handle;
				try {
					await handle.finished;
				} catch (err) {
					console.error('加载 Protyle 失败', err);
				} finally {
					if (loadHandleRef.current === handle) {
						loadHandleRef.current = null;
					}
				}
				return currentBlockId;
			};

			// 统一的静态预览挂载入口：移除旧预览、应用样式、窗口化、写缓存、调度富渲染。
			// 缓存命中与现场获取两条路径共用，保证虚拟化/缓存行为一致。
			const mountPreviewHtml = async (
				source: HTMLElement | string,
				blockId: string,
				options: { previewText: string; alreadyRendered?: boolean },
			) => {
				const container = containerRef.current
				if (cancelled || !container) return
				removeStaticPreview()

				// 清理 Protyle host 与实例（静态模式接管显示）
				if (protyleHostRef.current?.parentElement === container) {
					try { container.removeChild(protyleHostRef.current); } catch { }
				}
				try { safeDestroyProtyle(protyleRef.current); } catch { }
				protyleRef.current = null;
				protyleHostRef.current = null;

				// 缓存命中的 HTML 自带上一次的包装层（protyle-wysiwyg）：直接复用该元素，
				// 避免"挂载→写缓存→再命中"层层嵌套；多根 HTML（虚拟化 flush 快照）走
				// innerHTML 重新包装。
				let wrapper: HTMLElement
				if (typeof source === 'string') {
					const temp = document.createElement('div')
					temp.innerHTML = source
					const root = temp.firstElementChild
					if (root instanceof HTMLElement && root.classList.contains('protyle-wysiwyg') && !root.nextElementSibling) {
						wrapper = root
					} else {
						wrapper = document.createElement('div')
						wrapper.innerHTML = source
					}
				} else {
					wrapper = source
				}
				wrapper.className = 'protyle-wysiwyg protyle-wysiwyg--attr'
				wrapper.style.width = '100%'
				wrapper.style.height = '100%'
				wrapper.style.overflow = 'auto'
				wrapper.style.fontSize = `${fontSize}px`

				// 静态预览会先挂载，再按实际 Card 可见高度窗口化正文顶层块。
				configureStaticPreviewMedia(wrapper)
				// Decode protyle-html before deciding whether the DOM can be windowed:
				// an embedded query may otherwise be hidden inside data-content.
				try { convertProtyleHtmlToDom(wrapper) } catch (error) { console.warn('convertProtyleHtmlToDom failed', error) }
				wrapper.dataset.cardPreviewBlockId = blockId
				wrapper.dataset.cardPreviewBlockLimit = String(staticPreviewBlockLimit)
				wrapper.dataset.cardPreviewText = options.previewText
				// 复用的元素可能带着上一次挂载的渲染标记：按本次语义重置
				if (options.alreadyRendered) wrapper.dataset.cardRichRendered = '1'
				else delete wrapper.dataset.cardRichRendered
				delete wrapper.dataset.cardVirtualized
				staticPreviewRef.current = wrapper
				installStaticPreviewLinkHandlers(wrapper)
				container.appendChild(wrapper)

				// 虚拟化会替换容器内容，完整文档 HTML 必须在此之前快照
				const fullHtml = wrapper.outerHTML
				const finishRender = () => { wrapper.dataset.cardRichRendered = '1' }

				let createdVirtualizer: CardContentVirtualizer | null = null
				createdVirtualizer = CardContentVirtualizer.create(wrapper, {
					isPinned: (element) =>
						element.classList.contains('protyle-top') || element.classList.contains('protyle-title'),
					// 原生媒体和嵌入查询的加载/替换状态绑定在 DOM 实例上。窗口化会
					// 重建 outerHTML，因此含这些节点的预览保留完整 DOM。
					shouldSkipVirtualization: (content) => content.some(containsNonVirtualizableMedia),
					onMount: async (mountedContainer, generation) => {
						mountedContainer.querySelectorAll('img').forEach((img) => {
							if (!img.getAttribute('loading')) img.setAttribute('loading', 'lazy')
						})
						configureStaticPreviewMedia(mountedContainer)
						if (options.alreadyRendered) return
						// 窗口内全部块都已渲染过时跳过重复的富内容渲染（滚动回看零重复开销）
						const mountedBlocks = Array.from(mountedContainer.querySelectorAll<HTMLElement>('[data-card-virtual-index]'))
						if (mountedBlocks.length > 0 && mountedBlocks.every((el) => el.dataset.cardRichRendered === '1')) return
						await renderAllContentIdle(mountedContainer, staticPreviewPriorityRef.current, renderTaskId, true, richRenderAbortController.signal)
						// renderAllContentIdle 会把"取消"吞掉并正常 resolve；effect 重跑取消时
						// 绝不能把半成品渲染回写为"已渲染"
						if (cancelled) return
						// 同 ID 渲染任务 latest-wins：滚动换窗后旧调用会随新窗口 resolve，
						// 代际不一致说明当前窗口已易主，快照交给新窗口自己的 onMount
						if (createdVirtualizer?.getWindowGeneration() !== generation) return
						createdVirtualizer.snapshotRenderedWindow()
					},
				})
				cardContentVirtualizerRef.current = createdVirtualizer

				if (createdVirtualizer) {
					// 虚拟化预览：富渲染由 onMount 按窗口调度，快捷路径据此跳过整容器补渲染
					wrapper.dataset.cardVirtualized = '1'
					// 虚拟化预览以完整文档 HTML 入缓存；窗口渲染完成后销毁前升级为已渲染版本。
					// alreadyRendered 命中时 HTML 本身已渲染，保留标记避免降级导致下次重复渲染
					cacheStaticPreview(blockId, fullHtml, staticPreviewBlockLimit, options.previewText, options.alreadyRendered === true)
					return
				}

				wrapper.querySelectorAll('img').forEach((img) => {
					if (!img.getAttribute('loading')) img.setAttribute('loading', 'lazy')
				})
				if (options.alreadyRendered) {
					finishRender()
					return
				}
				// Do not keep the static-load queue occupied while formulas,
				// embeds and attribute views are enhanced. The lightweight DOM
				// is already usable at this point; rich rendering is cancellable
				// background work tied to this viewport admission.
				void renderAllContentIdle(
					wrapper,
					staticPreviewPriorityRef.current,
					renderTaskId,
					true,
					richRenderAbortController.signal,
				).then(() => {
					if (!cancelled) {
						finishRender()
						cacheStaticPreview(blockId, wrapper.outerHTML, staticPreviewBlockLimit, options.previewText, true)
					}
				}).catch((error) => {
					if (!isIdleRenderCancelledError(error)) console.warn('卡片静态内容增强失败:', error)
				})
				// 先缓存原始 DOM，让下一张相同 Card 可以立即复用；富内容完成后会再写入增强后的版本
				cacheStaticPreview(blockId, fullHtml, staticPreviewBlockLimit, options.previewText)
			}

			// 从 API 获取静态预览 - 用于文档块(isMain)的静态渲染
			const useStaticPreviewFromGetDoc = async (
				targetBlockId: string,
				forceRefresh = false,
				signal?: AbortSignal,
			) => {
				if (cancelled || signal?.aborted || !containerRef.current) return;

				// 快捷路径：同一文档的预览已在挂载（准入抖动/字号变化），只同步字号不重建 DOM。
				// 字号变化曾会因缓存键含 fontSize 而触发整页重新请求，静态 DOM 内容其实与字号无关。
				const mountedPreview = staticPreviewRef.current
				if (!forceRefresh && mountedPreview?.parentElement === containerRef.current && mountedPreview.dataset.cardPreviewBlockId === targetBlockId) {
					const mountedLimit = Number(mountedPreview.dataset.cardPreviewBlockLimit || 0)
					if (mountedLimit >= staticPreviewBlockLimit) {
						mountedPreview.style.fontSize = `${fontSize}px`
						// 非虚拟化预览：富渲染未完成（可能被上一轮 cleanup 打断）时补跑一次；
						// 虚拟化预览的窗口渲染由 onMount 的逐块标记自行调度，这里不重复触发
						if (mountedPreview.dataset.cardVirtualized !== '1' && mountedPreview.dataset.cardRichRendered !== '1') {
							void renderAllContentIdle(
								mountedPreview,
								staticPreviewPriorityRef.current,
								renderTaskId,
								true,
								richRenderAbortController.signal,
							).then(() => {
								if (!cancelled) mountedPreview.dataset.cardRichRendered = '1'
							}).catch((error) => {
								if (!isIdleRenderCancelledError(error)) console.warn('卡片缓存预览增强失败:', error)
							})
						}
						return
					}
				}

				// 检查缓存（如果非强制刷新）：命中时直接复用完整 HTML，无需重新解析
				if (!forceRefresh) {
					const cached = getCachedPreview(targetBlockId, staticPreviewBlockLimit)
					if (cached) {
						persistPreviewText(cached.previewText)
						await mountPreviewHtml(cached.html, targetBlockId, { previewText: cached.previewText, alreadyRendered: cached.rendered === true })
						return
					}
				}

				// 使用 getDoc API 获取 DOM 内容
				// 主文档标题元数据与正文请求互不依赖，提前发起元数据请求，
				// 避免正文返回后再额外等待一个网络往返。
				const docInfoPromise: Promise<api.IResGetDocInfo | null> = isMainCard
					? api.getDocInfo(targetBlockId, { signal }).catch((err) => {
						if (signal?.aborted) return null
						console.error('获取文档信息失败:', err)
						return null
					})
					: Promise.resolve(null)
				let domContent: string | null = null;
				try {
					const res = await api.getDoc(targetBlockId, {
						size: staticPreviewBlockLimit,
						signal,
					});
					if (res && res.content) {
						domContent = res.content;
					}
				} catch (err) {
					if (signal?.aborted) return;
					console.error('获取文档 DOM 内容失败:', err);
				}

				if (cancelled || signal?.aborted || !domContent) return;

				const docInfo = await docInfoPromise;
				if (cancelled || signal?.aborted || !containerRef.current) return;

				// 创建预览容器
				const previewWrapper = document.createElement('div');
				previewWrapper.innerHTML = domContent;

				// 如果是 isMain 形状，添加题头图和标题
				if (isMainCard && docInfo) {
					const ial = docInfo.ial || {};
					const titleImg = ial['title-img'];
					const title = ial.title || docInfo.name || '未命名文档';

					// 创建顶部区域容器
					const topContainer = document.createElement('div');
					topContainer.className = 'protyle-top';

					// 添加题头图
					if (titleImg && tldrawHeaderImage) {
						const bgContainer = document.createElement('div');
						bgContainer.className = 'protyle-background protyle-background--enable';
						bgContainer.setAttribute('data-node-id', targetBlockId);

						const bgImg = document.createElement('div');
						bgImg.className = 'protyle-background__img';

						// 处理 title-img 的背景图片兼容
						let bgStyle = titleImg;
						let imgSrc = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
						const urlMatch = titleImg.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/);
						if (urlMatch) {
							const imgPath = urlMatch[1];
							// 构建静态资源 URL
							const assetUrl = `${imgPath}`;
							imgSrc = assetUrl;
							// 移除 background-image 部分，只保留其他样式（如 background-color）
							bgStyle = titleImg.replace(/background-image:\s*url\(["']?[^"')]+["']?\);?/g, '').trim();
							// 移除末尾分号
							if (bgStyle.endsWith(';')) bgStyle = bgStyle.slice(0, -1);
						}

						bgImg.innerHTML = `<img src="${imgSrc}" style="${bgStyle}">`;

						const bgIa = document.createElement('div');
						bgIa.className = 'protyle-background__ia';
						bgIa.style.marginLeft = '24px';
						bgIa.style.marginRight = '16px';

						bgContainer.appendChild(bgImg);
						bgContainer.appendChild(bgIa);
						topContainer.appendChild(bgContainer);
					}

					// 添加标题
					const titleContainer = document.createElement('div');
					titleContainer.className = 'protyle-title protyle-wysiwyg--attr';
					titleContainer.setAttribute('data-node-id', targetBlockId);
					titleContainer.setAttribute('data-render', 'true');
					titleContainer.style.margin = '16px 16px 0px 24px';

					const iconSpan = document.createElement('span');
					iconSpan.className = 'protyle-title__icon';
					iconSpan.innerHTML = '<svg><use xlink:href="#iconFile"></use></svg>';

					const titleInput = document.createElement('div');
					titleInput.contentEditable = 'false';
					titleInput.spellcheck = false;
					titleInput.className = 'protyle-title__input';
					titleInput.style.outline = 'none';
					titleInput.textContent = title;

					const attrDiv = document.createElement('div');
					attrDiv.className = 'protyle-attr';

					// 添加书签（如果有）
					const bookmark = ial.bookmark;
					if (bookmark) {
						const bookmarkDiv = document.createElement('div');
						bookmarkDiv.className = 'protyle-attr--bookmark';
						bookmarkDiv.textContent = bookmark;
						attrDiv.appendChild(bookmarkDiv);
					}

					titleContainer.appendChild(iconSpan);
					titleContainer.appendChild(titleInput);
					titleContainer.appendChild(attrDiv);
					topContainer.appendChild(titleContainer);

					// 将 topContainer 插入到内容最前面
					if (previewWrapper.firstChild) {
						previewWrapper.insertBefore(topContainer, previewWrapper.firstChild);
					} else {
						previewWrapper.appendChild(topContainer);
					}
				}

				// 预览文本提取一次完成：随缓存存储，命中时无需再解析完整 HTML
				const previewText = getLightweightPreviewTextFromElement(previewWrapper)
				persistPreviewText(previewText)
				await mountPreviewHtml(previewWrapper, targetBlockId, { previewText })
			};

			let cancelled = false;
			const loadStaticPreview = async (targetBlockId: string, forceRefresh: boolean) => {
				staticPreviewLoadRef.current?.cancel()
				const handle = enqueueStaticPreviewLoad(
					`static-card-preview-${shape.id}`,
					staticPreviewPriorityRef.current,
					async (signal) => {
						if (cancelled || signal.aborted) return
						await useStaticPreviewFromGetDoc(targetBlockId, forceRefresh, signal)
					},
				)
				staticPreviewLoadRef.current = handle
				try {
					await handle.finished
				} finally {
					if (staticPreviewLoadRef.current === handle) {
						staticPreviewLoadRef.current = null
					}
				}
			}

			(async () => {
				if (isEditingState) {
					// 进入编辑：复用已有 Protyle 时直接换掉静态预览；挂载新 Protyle 时
					// 静态预览保留到就绪后再移除（见 mountProtyle），避免白屏闪动
					if (!protyleRef.current) {
						const createdBlockId = await mountProtyle(0);
						if (cancelled) return;
						if (createdBlockId && shape.props.blockId !== createdBlockId) {
							this.editor.updateShape({
								id: shape.id,
								type: shape.type,
								props: { ...shape.props, blockId: createdBlockId }
							});
						}
					} else {
						removeStaticPreview()
					}
					if (protyleHostRef.current && containerRef.current && protyleHostRef.current.parentElement !== containerRef.current) {
						containerRef.current.appendChild(protyleHostRef.current);
					}
					// A live Protyle may have been retained but hidden while it was
					// outside the load budget. Editing must always make that host visible.
					setProtyleHostVisible(true);
					removeStaticPreviewLinkHandlers()
					try { protyleRef.current?.enable(); } catch { }
				} else {
					// 非编辑
					if (effectiveRenderMode === 'static-dom') {
						const id = containerRef.current?.getAttribute('blockid') || blockId;
						if (!id) return;
						if (isMainCard) {
							await loadStaticPreview(id, wasEditing || manualRefreshTriggered);
							if (cancelled) return;
						} else {
							// 普通块：使用 getDoc API 直接获取静态 DOM
							if (protyleRef.current) {
								if (protyleHostRef.current?.parentElement) {
									removeStaticPreviewLinkHandlers()
									protyleHostRef.current.parentElement.removeChild(protyleHostRef.current);
								}
								try { safeDestroyProtyle(protyleRef.current); } catch { }
								protyleRef.current = null;
								protyleHostRef.current = null;
							}
							// 如果是手动刷新，则强制 bypass 缓存并通过 API 重新获取 DOM
							await loadStaticPreview(id, manualRefreshTriggered || wasEditing);
							if (cancelled) return;
						}
					} else {
						// live-protyle 模式：保留 Protyle 实例，仅切换 enable/disable 状态
						if (!protyleRef.current) {
							// 首次加载或实例不存在时创建
							await mountProtyle(1);
							if (cancelled) return;
						}
						// 移除可能存在的静态预览
						removeStaticPreview()
						// 确保 Protyle host 已挂载
						if (protyleHostRef.current && containerRef.current && protyleHostRef.current.parentElement !== containerRef.current) {
							containerRef.current.appendChild(protyleHostRef.current);
						}
						setProtyleHostVisible(true);
						// 禁用交互但保留实例
						if (protyleHostRef.current) {
							removeStaticPreviewLinkHandlers()
							installStaticPreviewLinkHandlers(protyleHostRef.current)
						}
						try { protyleRef.current?.disable(); } catch { }
						persistPreviewText(getLightweightPreviewTextFromElement(protyleHostRef.current))
						// live-protyle 模式下实例在编辑时一直保留，内容已是最新，无需再 reload（reload 反而会造成闪动）
					}
				}
			})().catch((error) => {
				if (!isIdleRenderCancelledError(error)) {
					console.warn('卡片静态内容渲染失败:', error)
				}
			})

			// 组件卸载/依赖变更清理
			return () => {
				cancelled = true;
				richRenderAbortController.abort();
				if (richRenderAbortRef.current === richRenderAbortController) {
					richRenderAbortRef.current = null
				}
				staticPreviewLoadRef.current?.cancel()
				staticPreviewLoadRef.current = null
				cancelIdleRender(renderTaskId);
				// live-protyle 不在编辑切换/临时不通不过准入时销毁资源，仅折叠或真正卸载时销毁
				if (isCollapsed || (effectiveRenderMode !== 'live-protyle' && !shouldRender)) {
					destroyRuntimeResources();
				}
			};
		}, [destroyRuntimeResources, removeStaticPreview, isEditingState, renderAdmission, shape.id, blockId, shape.props.refreshNonce, isCollapsed, effectiveRenderMode, fontSize, isSmallCard, exitEditGrace, persistPreviewText]);

		// 真正卸载时（切换到其它白板 / 删除卡片）销毁 Protyle，避免 live 模式下实例被保留后泄漏
		useEffect(() => {
			return () => {
				destroyCardContentVirtualizer()
				if (exitEditGraceTimerRef.current) {
					window.clearTimeout(exitEditGraceTimerRef.current);
					exitEditGraceTimerRef.current = null;
				}
				exitEditGraceUntilRef.current = 0;
				if (protyleRef.current) {
					safeDestroyProtyle(protyleRef.current);
					protyleRef.current = null;
				}
				if (protyleHostRef.current?.parentElement) {
					try { protyleHostRef.current.parentElement.removeChild(protyleHostRef.current); } catch { }
				}
				protyleHostRef.current = null;
			};
		}, [destroyCardContentVirtualizer, shape.id]);

		const handlePointerEvent = (e: React.PointerEvent) => {
			if (isEditingState) {
				e.stopPropagation(); // 在编辑模式下阻止事件冒泡
			}
		};

		return (
			<HTMLContainer
				style={{
					display: 'flex',
					flexDirection: 'column',
					backgroundColor: theme[shape.props.color].semi,
					// color: theme[shape.props.color].solid,
					// 只有在非编辑状态时才禁用指针事件
					position: 'relative',
					isolation: 'isolate',
					// Enable pointer events at the outer container so hover works and
					// ports can be revealed even when not editing. The inner content
					// will still block interactions unless in edit mode.
					pointerEvents: 'auto',
					width: '100%',
					height: '100%',
					overflow: 'visible', // 改为 visible 以显示端口
					boxShadow: cardOuterShadow
						? `${cardOuterShadow}, ${cardInnerEdgeShadow}`
						: cardInnerEdgeShadow,
					cursor: isEditingState ? 'text' : 'default',
					padding: 0,
					border: settingdata["showCardBorder"] ? `3px solid ${theme[shape.props.color].solid}` : 'none', // 添加颜色边框
					borderRadius: '10px', // 增加圆角
				}}
				// onDoubleClick={handleDoubleClick}
				onPointerDown={handlePointerEvent}
				onPointerMove={handlePointerEvent}
				onPointerUp={handlePointerEvent}
			>
				{/* 静态内容交互屏蔽样式已迁移至 custom-tldraw.css（避免每个卡片实例重复一份 <style>） */}
				<div
					ref={containerRef}
					blockid={shape.props.blockId}
					style={{
						width: '100%',
						height: '100%',
						overflow: 'auto', // 内容区域可滚动
						pointerEvents: isEditingState || (!isMainCard && isCollapsed) ? 'all' : 'none',
						touchAction: isEditingState || (!isMainCard && isCollapsed) ? 'auto' : 'none',
						contain: 'strict',
						padding: `${cardInnerGap}px`,
						boxSizing: 'border-box',
					}}
				>
					{/* 折叠状态 */}
					{isCollapsed && !isEditingState && (
						isMainCard ? (
							<div
								className="card-shape-collapsed-content"
								style={{
									width: '100%',
									height: '100%',
									display: 'flex',
									flexDirection: 'column',
									alignItems: 'flex-start',
									justifyContent: 'flex-start',
									gap: '12px',
									padding: '12px',
									boxSizing: 'border-box',
									color: theme[shape.props.color].solid,
									overflow: 'hidden',
									opacity: 1,
									transform: 'translateY(0)'
								}}
							>
								{tldrawHeaderImage && (
									<div
										style={{
											width: '100%',
											height: '80%',
											minHeight: '120px',
											borderRadius: '12px',
											overflow: 'hidden',
											background: collapsedDocInfo?.titleImgBackground || collapsedDocInfo?.titleImgColor || headerGradientFallback,
											display: 'flex',
											alignItems: 'center',
											justifyContent: 'center',
										}}
									>
										{collapsedDocInfo?.titleImgHasUrl ? (
											<img
												src={collapsedDocInfo.titleImgSrc}
												style={{ width: '100%', height: '100%', objectFit: 'cover' }}
												alt={collapsedDocInfo.title || '文档'}
											/>
										) : null}
									</div>
								)}
								<div style={{
									width: '100%',
									display: 'flex',
									alignItems: 'center',
									gap: '8px',
									fontSize: `${Math.min(shape.props.w / 8, 28)}px`,
									fontWeight: 600,
									wordBreak: 'break-all',
								}}>
									<span style={{ display: 'flex', alignItems: 'center' }}>
										<svg width="20" height="20" style={{ marginRight: '6px' }}>
											<use xlinkHref="#iconFile"></use>
										</svg>
										{collapsedDocInfo?.title || '加载中...'}
									</span>
								</div>
							</div>
						) : (
							<div
								className="card-shape-collapsed-content"
								style={{
									width: '100%',
									height: '100%',
									display: 'flex',
									alignItems: 'center',
									justifyContent: collapsedTextAlign === 'right' ? 'flex-end' : collapsedTextAlign === 'center' ? 'center' : 'flex-start',
									padding: '10px 14px',
									boxSizing: 'border-box',
									gap: collapsedTextAlign === 'center' ? '0px' : '10px',
									position: 'relative',
									opacity: 1,
									transform: 'translateY(0)'
								}}>
								{/* 折叠图标 — 点击展开 */}
								<svg
									className="card-shape-collapsed-toggle-icon"
									width={Math.round(collapsedTextSize * 0.85)}
									height={Math.round(collapsedTextSize * 0.85)}
									viewBox="0 0 24 24"
									fill="none"
									stroke={theme[shape.props.color].solid}
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									style={{
										flexShrink: 0,
										cursor: 'pointer',
										...(collapsedTextAlign === 'center'
											? { position: 'absolute', left: '14px', zIndex: 1 }
											: {}),
									}}
									onClick={handleUncollapse}
									onPointerDown={(e) => e.stopPropagation()}
								>
									<title>点击展开</title>
									<polyline points="4 14 10 14 10 20"></polyline>
									<polyline points="20 10 14 10 14 4"></polyline>
									<line x1="14" y1="10" x2="21" y2="3"></line>
									<line x1="3" y1="21" x2="10" y2="14"></line>
								</svg>
								{/* 内容摘要文字 */}
								<span data-card-collapsed-text style={{
									flex: 1,
									minWidth: 0,
									fontSize: `${collapsedTextSize}px`,
									fontWeight: 500,
									color: theme[shape.props.color].solid,
									wordBreak: 'break-word',
									overflowWrap: 'anywhere',
									lineHeight: collapsedTextLineHeight,
									opacity: 0.85,
									textAlign: collapsedTextAlign as any,
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									display: '-webkit-box',
									WebkitBoxOrient: 'vertical',
									WebkitLineClamp: collapsedTextLineClamp,
									maxHeight: `${collapsedTextLineClamp * collapsedTextSize * collapsedTextLineHeight}px`,
								}}>
									{collapsedText}
								</span>
							</div>
						)
					)}
					{shape.props.isNewlyCreated && !shape.props.blockId && !isEditingState && !shouldUseLightweightPreview && (
						<div style={{
							width: '100%',
							height: '100%',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							fontSize: `${Math.min(shape.props.fontSize || 16, 20)}px`,
							padding: '16px',
							color: theme[shape.props.color].solid,
							opacity: 0.6,
							textAlign: 'center',
							userSelect: 'none',
						}}>
							双击编辑以创建笔记块
						</div>
					)}
					{/* 低缩放和限流状态共用同一套轻量预览。 */}
					{shouldUseLightweightPreview && (
						<div className="card-lightweight-preview" style={{
							width: '100%',
							height: '100%',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '2px 4px',
							boxSizing: 'border-box',
							fontSize: `${lowDetailFontSize}px`,
							fontWeight: 500,
							color: theme[shape.props.color].solid,
							textAlign: 'center',
						}}>
							<span style={{
								display: '-webkit-box',
								WebkitBoxOrient: 'vertical',
								WebkitLineClamp: 2,
								overflow: 'hidden',
								lineHeight: 1.1,
								wordBreak: 'break-word',
							}}>
								{shape.props.previewText || (shape.props.blockId ? '卡片' : '双击编辑')}
							</span>
						</div>
					)}
				</div>
				{!isEditingState && hasMissingLinkedBlock && (
					<MissingBlockOverlay
						textColor={theme[shape.props.color].solid}
						fontSize={fontSize}
						onRefresh={handleRefreshMissingLinkedBlock}
						onDelete={handleDeleteMissingLinkedBlock}
					/>
				)}
				{/* 端口覆盖层 - 用于贝塞尔连接器 */}
				<PortsOverlay shapeId={shape.id} />
			</HTMLContainer >
		)
	}

	// [7]
	indicator(shape: ICardShape) {
		return <rect width={shape.props.w} height={shape.props.h} />
	}

	// [8]
	override onResize(shape: ICardShape, info: TLResizeInfo<ICardShape>) {
		return resizeBox(shape, info)
	}

	override onResizeStart(shape: ICardShape) {
		beginBranchResize(this.editor, shape.id)
	}

	override onResizeEnd(_initialShape: ICardShape, currentShape: ICardShape) {
		endBranchResize(this.editor, currentShape.id)
	}

	override onResizeCancel(_initialShape: ICardShape, currentShape: ICardShape) {
		endBranchResize(this.editor, currentShape.id)
	}

	override onTranslateStart(shape: ICardShape) {
		draggingBranchCardIds.add(shape.id as string)
		beginBranchAttachmentDrag(this.editor, shape)
		setBranchInteractionHint(getBranchInteractionHintForShape(this.editor, shape))
	}

	override onTranslateEnd(_initial: ICardShape, currentShape: ICardShape) {
		draggingBranchCardIds.delete(currentShape.id as string)
		clearBranchInteractionHint(currentShape.id as string)
		updateBranchAttachmentAfterDrag(this.editor, currentShape)
	}

	override toSvg(shape: ICardShape, ctx: SvgExportContext): ReactElement | null {
		return exportCardShapeToSvg(shape, ctx, this.editor.getContainer())
	}

}
/* 
A utility class for the card shape. This is where you define the shape's behavior, 
how it renders (its component and indicator), and how it handles different events.

[1]
A validation schema for the shape's props (optional)
Check out card-shape-props.ts for more info.

[2]
Migrations for upgrading shapes (optional)
Check out card-shape-migrations.ts for more info.

[3]
Letting the editor know if the shape's aspect ratio is locked, and whether it 
can be resized or bound to other shapes. 

[4]
The default props the shape will be rendered with when click-creating one.

[5]
We use this to calculate the shape's geometry for hit-testing, bindings and
doing other geometric calculations. 

[6]
Render method — the React component that will be rendered for the shape. It takes the 
shape as an argument. HTMLContainer is just a div that's being used to wrap our text 
and button. We can get the shape's bounds using our own getGeometry method.
	
- [a] Check it out! We can do normal React stuff here like using setState.
   Annoying: eslint sometimes thinks this is a class component, but it's not.

- [b] You need to stop the pointer down event on buttons, otherwise the editor will
	   think you're trying to select drag the shape.

[7]
Indicator — used when hovering over a shape or when it's selected; must return only SVG elements here

[8]
Resize handler — called when the shape is resized. Sometimes you'll want to do some 
custom logic here, but for our purposes, this is fine.
*/
