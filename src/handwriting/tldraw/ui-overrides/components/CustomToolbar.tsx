/**
 * 自定义工具栏组件
 * 按 ui-visibility 设置过滤工具栏工具；默认工具的顺序与 tldraw DefaultToolbarContent 一致
 */
import React from 'react'
import {
    DefaultToolbar,
    TldrawUiMenuItem,
    useTools,
    useIsToolSelected,
} from '@tldraw/tldraw'
import { settingdata } from '@/index'
import {
    DEFAULT_TOOLBAR_TOOL_IDS,
    CUSTOM_TOOLBAR_TOOLS_BEFORE,
    CUSTOM_TOOLBAR_TOOLS_AFTER,
    isTldrawToolVisible,
} from '../ui-visibility'

/** 单个默认工具项：useIsToolSelected 等 hook 只能在子组件内无条件调用，由父级按设置决定是否挂载 */
const DefaultToolItem: React.FC<{ toolId: string }> = ({ toolId }) => {
    const tools = useTools()
    const tool = tools[toolId]
    const isSelected = useIsToolSelected(tool)
    if (!tool) return null
    return <TldrawUiMenuItem {...tool} isSelected={isSelected} />
}

export const CustomToolbar: React.FC<any> = (props) => {
    const tools = useTools()
    const isCardSelected = useIsToolSelected(tools['card'])
    const isSingleBlockSelected = useIsToolSelected(tools['single-block'])
    const isSlideSelected = useIsToolSelected(tools['slide'])
    const isJsShapeSelected = useIsToolSelected(tools['js-shape'])
    const isBranchSelected = useIsToolSelected(tools['branch'])
    const toolbarOrientation = (settingdata?.['tldraw-toolbar-orientation'] as 'vertical' | 'horizontal') || 'vertical'

    // 自定义工具的 isSelected hook 必须在顶层无条件调用，这里先算好再按设置挑选用到的项
    const customToolItems: Record<string, React.ReactNode> = {
        'card': tools['card'] ? <TldrawUiMenuItem {...tools['card']} isSelected={isCardSelected} /> : null,
        'single-block': tools['single-block'] ? <TldrawUiMenuItem {...tools['single-block']} isSelected={isSingleBlockSelected} /> : null,
        'slide': tools['slide'] ? <TldrawUiMenuItem {...tools['slide']} isSelected={isSlideSelected} /> : null,
        'js-shape': tools['js-shape'] ? <TldrawUiMenuItem {...tools['js-shape']} isSelected={isJsShapeSelected} /> : null,
        'branch': tools['branch'] ? <TldrawUiMenuItem {...tools['branch']} isSelected={isBranchSelected} /> : null,
    }

    const visibleCustomBefore = CUSTOM_TOOLBAR_TOOLS_BEFORE.filter((id) => isTldrawToolVisible(id))
    const visibleDefaults = DEFAULT_TOOLBAR_TOOL_IDS.filter((id) => isTldrawToolVisible(id))
    const visibleCustomAfter = CUSTOM_TOOLBAR_TOOLS_AFTER.filter((id) => isTldrawToolVisible(id))

    return (
        <DefaultToolbar {...props} orientation={toolbarOrientation}>
            {visibleCustomBefore.map((id) => (
                <React.Fragment key={id}>{customToolItems[id]}</React.Fragment>
            ))}
            {visibleDefaults.map((id) => (
                <DefaultToolItem key={id} toolId={id} />
            ))}
            {visibleCustomAfter.map((id) => (
                <React.Fragment key={id}>{customToolItems[id]}</React.Fragment>
            ))}
        </DefaultToolbar>
    )
}
