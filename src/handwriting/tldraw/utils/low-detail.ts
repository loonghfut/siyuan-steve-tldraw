import { computed, EditorAtom } from '@tldraw/tldraw'
import type { Editor } from '@tldraw/tldraw'
import { settingdata } from '@/index'

const DEFAULT_LOW_DETAIL_THRESHOLD = 48
const MAX_LOW_DETAIL_THRESHOLD = 500
const DEFAULT_LOW_DETAIL_COUNT_THRESHOLD = 10
const MAX_LOW_DETAIL_COUNT_THRESHOLD = 500

/**
 * The persisted key predates SingleBlock support. Keep it stable so existing
 * user preferences continue to apply to both Card and SingleBlock shapes.
 */
export function getShapeLowDetailThreshold(): number {
	const configuredThreshold = Number(settingdata['tldraw-card-low-detail-threshold'])
	if (!Number.isFinite(configuredThreshold)) return DEFAULT_LOW_DETAIL_THRESHOLD
	return Math.min(MAX_LOW_DETAIL_THRESHOLD, Math.max(0, configuredThreshold))
}

/** Number of Card / SingleBlock shapes visible before low-detail rendering is enabled. */
export function getShapeLowDetailCountThreshold(): number {
	const configuredThreshold = Number(settingdata['tldraw-card-low-detail-count-threshold'])
	if (!Number.isFinite(configuredThreshold)) return DEFAULT_LOW_DETAIL_COUNT_THRESHOLD
	return Math.min(MAX_LOW_DETAIL_COUNT_THRESHOLD, Math.max(0, configuredThreshold))
}

// 视野裁剪数量门槛：白板内 Card / 单块总数达到该值后才启用"仅加载视野内形状"。
// 数量少的白板直接加载全部内容，避免平移时出现轻量 → 完整内容的加载过程。
const DEFAULT_CULLING_COUNT_THRESHOLD = 30

export function getViewportCullingCountThreshold(): number {
	const configuredThreshold = Number(settingdata['tldraw-viewport-culling-count-threshold'])
	if (!Number.isFinite(configuredThreshold)) return DEFAULT_CULLING_COUNT_THRESHOLD
	return Math.max(0, configuredThreshold)
}

// getRenderingShapes() is relatively expensive for large documents. Keep one
// reactive, cached count per Editor so every Card / SingleBlock component
// observes the same derived value instead of reducing the rendering list.
const VisibleCardAndSingleBlockCount = new EditorAtom('visible card and single-block count', (editor) =>
	computed('visible card and single-block count', () => {
		return editor.getRenderingShapes().reduce((count, { shape }) => {
			return count + (shape.type === 'card' || shape.type === 'single-block' ? 1 : 0)
		}, 0)
	}),
)

/** Count the Card / SingleBlock shapes tldraw currently intends to render in the viewport. */
export function getVisibleCardAndSingleBlockCount(editor: Editor): number {
	return VisibleCardAndSingleBlockCount.get(editor).get()
}

// 与上面的可见计数同理：全页计数也做成每个 Editor 一份的响应式缓存，
// getCurrentPageShapes() 的结果由 tldraw 的 computed 系统追踪，仅在形状增删时重算。
const TotalCardAndSingleBlockCount = new EditorAtom('total card and single-block count', (editor) =>
	computed('total card and single-block count', () => {
		return editor.getCurrentPageShapes().reduce((count, shape) => {
			return count + (shape.type === 'card' || shape.type === 'single-block' ? 1 : 0)
		}, 0)
	}),
)

/** Count all Card / SingleBlock shapes on the current page, regardless of visibility. */
export function getTotalCardAndSingleBlockCount(editor: Editor): number {
	return TotalCardAndSingleBlockCount.get(editor).get()
}

/** 视野裁剪的总开关是否生效（含数量门槛：总数未达门槛时裁剪不启用）。 */
export function isViewportCullingActive(editor: Editor): boolean {
	if (settingdata['tldraw-viewport-culling'] === false) return false
	const countThreshold = getViewportCullingCountThreshold()
	if (countThreshold <= 0) return true
	return getTotalCardAndSingleBlockCount(editor) >= countThreshold
}

/** Keep lightweight-preview text close to 20 screen pixels where the shape allows it. */
export function getShapeLowDetailFontSize(minDimension: number, efficientZoom: number): number {
	const safeDimension = Math.max(0, minDimension)
	const safeZoom = Math.max(0.01, efficientZoom)
	const availableFontSize = Math.max(12, safeDimension * 0.42)
	return Math.round(Math.min(availableFontSize, 20 / safeZoom))
}

export interface ShapeRenderPolicyInput {
	isEditing: boolean
	isViewportCullingEnabled: boolean
	canLoad: boolean
	isSmallShape: boolean
	isCollapsed?: boolean
	inExitGrace?: boolean
}

export interface ShapeRenderPolicy {
	renderAdmission: 'allowed' | 'blocked'
	shouldUseStaticPreview: boolean
	shouldUseLightweightPreview: boolean
}

/**
 * Shared render policy for Card / SingleBlock shapes.
 * Centralizes the decision tree so viewport culling, low-detail preview,
 * and static-vs-live rendering stay aligned across both shape types.
 */
export function getShapeRenderPolicy({
	isEditing,
	isViewportCullingEnabled,
	canLoad,
	isSmallShape,
	isCollapsed = false,
	inExitGrace = false,
}: ShapeRenderPolicyInput): ShapeRenderPolicy {
	// 准入完全跟随管理器的 canLoad：管理器已把"视口 + 准入环"内的形状按配额
	// 放行、对后台标签页保持拦截。组件不得再叠加 isInViewport 判断，否则
	// 准入环内已放行（canLoad=true）但严格视口外的形状会被误拦截回轻量预览。
	const admissionAllowed = isEditing || canLoad
	const renderAdmission = admissionAllowed
		? 'allowed'
		: 'blocked'

	const shouldUseStaticPreview = !isEditing && !isCollapsed && renderAdmission === 'allowed'
	const shouldUseLightweightPreview = !isEditing && !isCollapsed && (isSmallShape || (isViewportCullingEnabled && renderAdmission === 'blocked')) && !inExitGrace

	return {
		renderAdmission,
		shouldUseStaticPreview,
		shouldUseLightweightPreview,
	}
}
