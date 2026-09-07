import { Dialog, Protyle, showMessage, TProtyleAction } from 'siyuan'
import type { Editor, TLShapeId } from '@tldraw/tldraw'
import type { ICardShape } from './card-shape-types'
import type { ISingleBlockShape } from '../SingleBlockShape/single-block-shape-types'
import { isMobileFrontend } from '../utils/mobile-open'

/** 弹窗编辑支持的块形状：Card / 单块 */
type BlockLikeShape = ICardShape | ISingleBlockShape

function resolveBlockLikeShape(editor: Editor, shapeId: TLShapeId): BlockLikeShape | null {
	const shape = editor.getShape(shapeId)
	if (!shape) return null
	if (shape.type !== 'card' && shape.type !== 'single-block') return null
	const blockLike = shape as BlockLikeShape
	// 新建但尚未落块的形状走内联编辑的懒创建流程，这里不处理
	if (!blockLike.props.blockId) return null
	return blockLike
}

/**
 * 以弹窗打开块内容编辑器（Card / 单块通用）。
 * 桌面端为居中对话框；移动端为底部抽屉，避免画布内联编辑。
 * 关闭弹窗后通过 refreshNonce 刷新形状预览。
 * 返回 false 表示形状不支持弹窗编辑（无块 ID 的新建形状等），调用方可回退内联编辑。
 */
export function openBlockContentEditorDialog(editor: Editor, shapeId: TLShapeId): boolean {
	const shape = resolveBlockLikeShape(editor, shapeId)
	if (!shape) return false

	const isCard = shape.type === 'card'
	const isMain = isCard ? Boolean((shape as ICardShape).props.isMain) : false
	const isMobile = isMobileFrontend()

	let protyle: Protyle | null = null
	let cleanedUp = false

	const cleanup = () => {
		if (cleanedUp) return
		cleanedUp = true

		try {
			protyle?.destroy()
		} catch {
			// The dialog may close while Protyle is still initializing.
		}

		const latestShape = editor.getShape(shapeId)
		if (!latestShape || (latestShape.type !== 'card' && latestShape.type !== 'single-block')) return

		editor.updateShape({
			id: latestShape.id,
			type: latestShape.type,
			props: {
				...latestShape.props,
				refreshNonce: Date.now(),
			},
		})
	}

	const dialog = new Dialog({
		title: isCard ? '编辑卡片内容' : '编辑单块内容',
		content: '<div class="b3-dialog__content" style="height: 100%; padding: 0;"><div data-card-content-editor style="height: 100%;"></div></div>',
		width: isMobile ? '100%' : '860px',
		height: isMobile ? '78vh' : '70vh',
		destroyCallback: cleanup,
	})

	// 移动端改为底部抽屉样式（npm 类型声明未含 containerClassName，创建后补挂）
	if (isMobile) {
		const drawer = dialog.element.querySelector<HTMLElement>('.b3-dialog__container')
		drawer?.classList.add('st-block-editor-drawer')
		if (drawer) {
			// Dialog.destroy() 只去掉外层的 b3-dialog--open，190ms(Constants.TIMEOUT_DBLCLICK)
			// 之后才移除 DOM；遮罩点击、关闭图标、Esc、移动端返回键都走 destroy，
			// 这里包一层给抽屉补上向下收起的过渡动画。
			const destroyDialog = dialog.destroy.bind(dialog)
			dialog.destroy = (options?: Parameters<typeof destroyDialog>[0]) => {
				drawer.classList.add('st-block-editor-drawer--closing')
				destroyDialog(options)
			}
		}
	}

	const host = dialog.element.querySelector<HTMLElement>('[data-card-content-editor]')
	if (!host) {
		showMessage('无法打开内容编辑器', 3000, 'error')
		dialog.destroy()
		return false
	}

	try {
		protyle = new Protyle(window.siyuan.ws.app, host, {
			blockId: shape.props.blockId,
			rootId: shape.props.blockId,
			mode: 'wysiwyg',
			action: ['cb-get-all', 'cb-get-focus'] as TProtyleAction[],
			render: {
				breadcrumb: false,
				gutter: true,
				title: isMain,
				breadcrumbDocName: isMain,
			},
			click: {
				/** 点击末尾是否阻止插入新块 */
				preventInsetEmptyBlock: true,
			}
		})
	} catch (error) {
		console.error('打开内容编辑器失败', error)
		showMessage('打开内容编辑器失败', 3000, 'error')
		dialog.destroy()
		return false
	}

	return true
}
