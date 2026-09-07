/**
 * 快捷操作面板组件
 * 各按钮的显隐由 ui-visibility 设置控制
 */
import React from 'react'
import {
    DefaultQuickActions,
    TldrawUiMenuActionItem,
    TldrawUiMenuItem,
    useCanRedo,
    useCanUndo,
    useEditor,
    useUnlockedSelectedShapesCount,
    useValue,
} from '@tldraw/tldraw'
import { showMessage } from 'siyuan'
import { openSiYuanDoc } from '../../utils/mobile-open'
import { settingdata } from '@/index'
import { buildTldrawLink } from '../../utils/link-builder'
import { resetShapeLibraryPanelPosition } from '../../shapelibrary/shape-library-manager'
import { resetDocOutlinePanelPosition } from '../../doc-outline/doc-outline-manager'
import { resetChildDocsPanelPosition } from '../../doc-outline/child-docs-manager'
import { resetSearchPanelPosition } from '../../search/search-panel-manager'
import { toggleShapeLibrary, toggleDocOutline, toggleChildDocs, toggleSearchPanel } from '../panel-state'
import { isCardLikeShape, CardLikeShape } from '../types'
import { isTldrawUiVisible } from '../ui-visibility'

/** 删除/复制按钮组：disabled 逻辑与 tldraw DefaultQuickActionsContent 一致 */
const DeleteDuplicateGroup: React.FC = () => {
    const editor = useEditor()
    const oneSelected = useUnlockedSelectedShapesCount(1)
    const isInSelectState = useValue('is in select state', () => editor.isIn('select'), [editor])
    const selectDependentActionsEnabled = oneSelected && isInSelectState
    return (
        <>
            <TldrawUiMenuActionItem actionId="delete" disabled={!selectDependentActionsEnabled} />
            <TldrawUiMenuActionItem actionId="duplicate" disabled={!selectDependentActionsEnabled} />
        </>
    )
}

export const CustomQuickActions: React.FC = () => {
    const editor = useEditor()
    const canUndo = useCanUndo()
    const canRedo = useCanRedo()
    const container = editor.getContainer()
    const editorElement = container?.closest('.tldraw__editor')
    const rootId = editorElement?.getAttribute('data-tldraw-id')
    const title = editorElement?.getAttribute('data-tldraw-title')
    const [restoreOnEdit, setRestoreOnEdit] = React.useState<boolean>(() => {
        return settingdata['restore-camera-on-edit'] === true
    })

    const toggleRestoreOnEdit = React.useCallback(() => {
        const next = !restoreOnEdit
        setRestoreOnEdit(next)
        try {
            settingdata['restore-camera-on-edit'] = next
        } catch (err) {
            console.warn('设置保存失败', err)
        }
        showMessage(next ? '编辑时聚焦并恢复视角：已启用' : '编辑时聚焦并恢复视角：已禁用')
    }, [restoreOnEdit])

    return (
        <DefaultQuickActions>
            {isTldrawUiVisible('undo-redo') && (
                <>
                    <TldrawUiMenuActionItem actionId="undo" disabled={!canUndo} />
                    <TldrawUiMenuActionItem actionId="redo" disabled={!canRedo} />
                </>
            )}
            {isTldrawUiVisible('delete-duplicate') && <DeleteDuplicateGroup />}
            {isTldrawUiVisible('open-doc') && (
                <div>
                    <TldrawUiMenuItem id="heading" icon="external-link" label="打开文档" onSelect={() => {
                        // 移动端 openTab 为空操作，openSiYuanDoc 内部改走 openMobileFileById
                        openSiYuanDoc(window.siyuan.ws.app, rootId)
                    }} />
                </div>
            )}
            {isTldrawUiVisible('copy-link') && (
                <div>
                    <TldrawUiMenuItem id="external-link" icon="heading" label="复制白板链接" onSelect={() => {
                        let url: string
                        if (settingdata['copyLinkTitle']) {
                            url = `[画板:${title}](${buildTldrawLink(rootId)})`
                        } else {
                            url = buildTldrawLink(rootId)
                        }
                        navigator.clipboard.writeText(url).then(() => {
                            showMessage('链接已复制到剪贴板!')
                        }).catch(err => {
                            console.error('无法复制链接: ', err)
                        })
                    }} />
                </div>
            )}
            {isTldrawUiVisible('refresh-cards') && (
                <div>
                    <TldrawUiMenuItem
                        id="refresh-all-cards"
                        icon="arrow-cycle"
                        label="刷新所有卡片"
                        onSelect={() => {
                            const shapes = editor.getCurrentPageShapes().filter(isCardLikeShape) as CardLikeShape[]
                            if (shapes.length === 0) {
                                showMessage('当前画布无卡片')
                                return
                            }
                            const nonce = Date.now()
                            editor.run(() => {
                                for (const s of shapes) {
                                    editor.updateShape({
                                        id: s.id,
                                        type: 'card',
                                        props: { ...s.props, refreshNonce: nonce },
                                    })
                                }
                            })
                            showMessage(`已刷新 ${shapes.length} 张卡片`)
                        }}
                    />
                </div>
            )}
            {isTldrawUiVisible('shape-library') && (
                <div>
                    <div
                        onMouseDown={(e: any) => {
                            if (e?.detail === 2) {
                                try { e.stopPropagation(); e.preventDefault() } catch (err) { }
                                resetShapeLibraryPanelPosition()
                            }
                        }}
                    >
                        <TldrawUiMenuItem
                            id="shape-library"
                            icon="bookmark"
                            label="素材库"
                            onSelect={() => { toggleShapeLibrary() }}
                        />
                    </div>
                </div>
            )}
            {isTldrawUiVisible('doc-outline') && (
                <div>
                    <div
                        onMouseDown={(e: any) => {
                            if (e?.detail === 2) {
                                try { e.stopPropagation(); e.preventDefault() } catch (err) { }
                                resetDocOutlinePanelPosition()
                            }
                        }}
                    >
                        <TldrawUiMenuItem
                            id="doc-outline"
                            icon="text-align-left"
                            label="文档大纲"
                            onSelect={() => { toggleDocOutline() }}
                        />
                    </div>
                </div>
            )}
            {isTldrawUiVisible('child-docs') && (
                <div>
                    <div
                        onMouseDown={(e: any) => {
                            if (e?.detail === 2) {
                                try { e.stopPropagation(); e.preventDefault() } catch (err) { }
                                resetChildDocsPanelPosition()
                            }
                        }}
                    >
                        <TldrawUiMenuItem
                            id="child-docs"
                            icon="tool-note"
                            label="子文档"
                            onSelect={() => { toggleChildDocs() }}
                        />
                    </div>
                </div>
            )}
            {isTldrawUiVisible('search-text') && (
                <div>
                    <div
                        onMouseDown={(e: any) => {
                            if (e?.detail === 2) {
                                try { e.stopPropagation(); e.preventDefault() } catch (err) { }
                                resetSearchPanelPosition()
                            }
                        }}
                    >
                        <TldrawUiMenuItem
                            id="search-text"
                            icon="zoom-in"
                            label="搜索文本"
                            onSelect={() => { toggleSearchPanel() }}
                        />
                    </div>
                </div>
            )}
            {isTldrawUiVisible('restore-camera') && (
                <div
                    style={
                        restoreOnEdit
                            ? {
                                  borderRadius: 6,
                                  backgroundColor: 'var(--tl-color-hint)',
                                  display: 'inline-block',
                              }
                            : undefined
                    }
                    data-selected={restoreOnEdit ? 'true' : 'false'}
                >
                    <TldrawUiMenuItem
                        id="toggle-restore-camera"
                        icon="group"
                        label={restoreOnEdit ? '编辑时聚焦（已启用）' : '编辑时聚焦（已禁用）'}
                        isSelected={restoreOnEdit}
                        onSelect={() => { toggleRestoreOnEdit() }}
                    />
                </div>
            )}
        </DefaultQuickActions>
    )
}
