/**
 * Card / SingleBlock 绑定块的懒创建。
 *
 * 这段逻辑原先内联在各自 ShapeUtil 的 Protyle 挂载流程里，只有“进入编辑态”才能触发。
 * 移动端双击改为抽屉弹窗编辑后，需要在不进入编辑态的前提下先把块建出来，
 * 否则会先闪现内联编辑器并弹出软键盘，因此抽到这里共享。
 *
 * 创建仍走 runExclusiveBlockCreation：形状内的挂载流程与外部调用（移动端抽屉）
 * 并发触发时共享同一次创建，不会重复建块。
 */
import { showMessage } from 'siyuan'
import * as api from '@/api/api'
import { settingdata } from '@/index'
import { inputDialogSync } from '@/libs/dialog'
import { buildTldrawLink } from './link-builder'
import { markBlockExisting } from './block-existence'
import { runExclusiveBlockCreation } from './pending-creation'

export type DefaultCardBlockType = 'heading' | 'blockquote'

export function getDefaultCardBlockType(): DefaultCardBlockType {
	return settingdata['tldraw-card-default-block-type'] === 'blockquote' ? 'blockquote' : 'heading'
}

export function buildDefaultCardBlockMarkdown(
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

/** 从形状内的任意元素反查所属画板的根块 ID（新建块的父块） */
export function resolveTldrawRootId(hostElement: Element | null): string | null {
	return hostElement?.closest('.tldraw__editor')?.getAttribute('data-tldraw-id') || null
}

/**
 * 画板根 ID 缺失时的兜底校验。tl-draw-create-note-id 只是历史遗留的“允许创建”开关，
 * 实际父块始终取画板根 ID，两者都缺才无法创建。
 */
function checkCreatable(tldrawId: string | null): boolean {
	if (!settingdata['tl-draw-create-note-id'] && !tldrawId) {
		showMessage('配置不完整,请检查设置')
		return false
	}
	return true
}

export interface CardBlockCreationOptions {
	/**
	 * 是否允许弹出标题输入框。仅内联编辑流程开启；移动端抽屉流程不需要，
	 * 用户可以直接在抽屉里改标题，避免叠加两个弹窗。
	 */
	promptTitle?: boolean
}

/**
 * 为 Card 形状创建绑定的思源块，返回新块 ID。
 * 失败返回 null，并已向用户提示原因（配置不完整 / 未找到块）。
 */
export async function createCardLinkedBlock(
	tldrawId: string | null,
	shapeId: string,
	options: CardBlockCreationOptions = {},
): Promise<string | null> {
	if (!checkCreatable(tldrawId)) return null

	try {
		return await runExclusiveBlockCreation(shapeId, async () => {
			const idid = await api.generateSiyuanID() as string
			const link = buildTldrawLink(tldrawId!, idid)
			const defaultBlockType = getDefaultCardBlockType()
			const initialTitle = defaultBlockType === 'heading'
				? String(settingdata['tldraw-custom-card-title'] || '${timestamp}')
					.replace(/\$\{timestamp\}/g, () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
				: ''
			const content = buildDefaultCardBlockMarkdown(defaultBlockType, initialTitle, idid, link)
			const redata = await api.appendBlock('markdown', content, tldrawId!)
			const newBlockId = redata[0].doOperations[0].id as string
			// appendBlock 返回时内核 blocks 表可能还没提交（util.SQLFlushInterval=3s），
			// 先登记为存在，避免形状的存在性检查误报“找不到绑定块”
			markBlockExisting(newBlockId)

			if (defaultBlockType === 'heading' && options.promptTitle && settingdata['tldraw-prompt-card-title']) {
				try {
					const input = await inputDialogSync({
						title: '输入卡片标题',
						placeholder: '请输入标题',
						width: '520px',
						confirmOnEnter: true,
					})
					const userTitle = input?.replace(/[\r\n]+/g, ' ').trim() || ''
					if (userTitle) {
						// updateBlock 会整体替换块内容，因此必须重新附带 Card 的 IAL。
						await api.updateBlock('markdown', buildDefaultCardBlockMarkdown(defaultBlockType, userTitle, idid, link), newBlockId)
					}
				} catch (err) {
					// 标题更新失败不应影响已创建块与 Card 的绑定。
					console.log('更新卡片标题失败，继续使用默认标题', err)
				}
			}
			return newBlockId
		})
	} catch (err) {
		console.error('创建块失败', err)
		showMessage('未找到块')
		return null
	}
}

/**
 * 为 SingleBlock 形状创建绑定的思源块，返回新块 ID。
 * 失败返回 null，并已向用户提示原因（配置不完整 / 未找到块）。
 */
export async function createSingleBlockLinkedBlock(
	tldrawId: string | null,
	shapeId: string,
): Promise<string | null> {
	if (!checkCreatable(tldrawId)) return null

	try {
		return await runExclusiveBlockCreation(shapeId, async () => {
			const idid = (await api.generateSiyuanID()) as string
			const link = buildTldrawLink(tldrawId!, idid)
			// 将链接保存到自定义属性中
			const redata = await api.appendBlock(
				'markdown',
				`\n{: id="${idid}" custom-st-tldraw-single="1" custom-tldraw-link="${link}" }\n\n`,
				tldrawId!,
			)
			const newBlockId = redata[0].doOperations[0].id as string
			// 同 Card：先登记为存在，规避内核 SQL 索引的提交延迟
			markBlockExisting(newBlockId)
			return newBlockId
		})
	} catch (err) {
		console.error('创建块失败', err)
		showMessage('未找到块')
		return null
	}
}
