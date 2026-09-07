/**
 * TLComponents 组件配置
 * 各 UI 区域（样式面板/主菜单/页面菜单/导航面板/帮助菜单/快捷操作/幻灯片面板）
 * 按 ui-visibility 设置决定挂载或置 null（tldraw 中 null 表示禁用该组件）。
 * 注意：tldraw 以 {...defaults, ...overrides} 合并，未指定的 key 才走默认组件，
 * 因此不要给不控制的槽位显式传 undefined。
 */
import type { TLComponents } from '@tldraw/tldraw'
import { SlidesPanel } from '../SlideShape/SlidesPanel'
import { CustomStylePanel } from './components/CustomStylePanel'
import { CustomQuickActions } from './components/CustomQuickActions'
import { CustomContextMenu } from './components/CustomContextMenu'
import { CustomMainMenu } from './components/CustomMainMenu'
import { CustomToolbar } from './components/CustomToolbar'
import { CustomKeyboardShortcutsDialog } from './components/CustomKeyboardShortcutsDialog'
import { InFrontOfCanvas } from './components/InFrontOfCanvas'
import { isTldrawUiVisible } from './ui-visibility'

export const buildComponents = (): TLComponents => {
    const components: TLComponents = {
        ContextMenu: CustomContextMenu,
        Toolbar: CustomToolbar,
        KeyboardShortcutsDialog: CustomKeyboardShortcutsDialog,
        InFrontOfTheCanvas: InFrontOfCanvas,
    }
    components.StylePanel = isTldrawUiVisible('style-panel') ? CustomStylePanel : null
    components.MainMenu = isTldrawUiVisible('main-menu') ? CustomMainMenu : null
    components.QuickActions = isTldrawUiVisible('quick-actions') ? CustomQuickActions : null
    components.HelperButtons = isTldrawUiVisible('slides-panel') ? SlidesPanel : null
    if (!isTldrawUiVisible('page-menu')) components.PageMenu = null
    if (!isTldrawUiVisible('navigation-panel')) components.NavigationPanel = null
    if (!isTldrawUiVisible('help-menu')) components.HelpMenu = null
    return components
}
