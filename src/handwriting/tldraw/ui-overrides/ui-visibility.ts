/**
 * 画板 UI 显隐配置
 * 集中定义工具栏工具与各功能 UI 按钮的设置 key、显示清单与可见性判断。
 * 设置 key 缺省（旧配置未写入）时一律视为显示，保持向后兼容。
 */
import { settingdata } from '@/index'

/**
 * 默认工具栏工具清单，顺序与 tldraw DefaultToolbarContent 一致。
 * CustomToolbar 用本清单替代 DefaultToolbarContent，实现逐工具显隐控制。
 */
export const DEFAULT_TOOLBAR_TOOL_IDS: readonly string[] = [
    'select', 'hand', 'draw', 'eraser', 'arrow', 'text', 'note', 'asset',
    'rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'oval', 'rhombus',
    'star', 'cloud', 'heart', 'x-box', 'check-box',
    'arrow-left', 'arrow-up', 'arrow-down', 'arrow-right',
    'line', 'highlight', 'laser', 'frame',
]

/** 插件自定义工具（渲染在默认工具之前，与 CustomToolbar 布局一致） */
export const CUSTOM_TOOLBAR_TOOLS_BEFORE: readonly string[] = ['card', 'single-block', 'slide']

/** 插件自定义工具（渲染在默认工具之后） */
export const CUSTOM_TOOLBAR_TOOLS_AFTER: readonly string[] = ['js-shape', 'branch']

/** 工具栏工具的完整清单（设置面板按此生成勾选项） */
export const ALL_TOOLBAR_TOOL_IDS: readonly string[] = [
    ...CUSTOM_TOOLBAR_TOOLS_BEFORE,
    ...DEFAULT_TOOLBAR_TOOL_IDS,
    ...CUSTOM_TOOLBAR_TOOLS_AFTER,
]

/** 工具项的设置面板显示名 */
export const TOOL_LABELS: Record<string, string> = {
    'card': 'Card 卡片',
    'single-block': '单块',
    'slide': 'Slide 幻灯片',
    'js-shape': 'JS 块',
    'branch': 'Branch 分支',
    'select': '选择',
    'hand': '抓手',
    'draw': '画笔',
    'eraser': '橡皮擦',
    'arrow': '箭头',
    'text': '文本',
    'note': '便签',
    'asset': '插入图片/媒体',
    'rectangle': '矩形',
    'ellipse': '椭圆',
    'triangle': '三角形',
    'diamond': '菱形',
    'hexagon': '六边形',
    'oval': '圆角矩形',
    'rhombus': '斜菱形',
    'star': '星形',
    'cloud': '云形',
    'heart': '心形',
    'x-box': '叉选框',
    'check-box': '勾选框',
    'arrow-left': '左箭头图形',
    'arrow-up': '上箭头图形',
    'arrow-down': '下箭头图形',
    'arrow-right': '右箭头图形',
    'line': '直线',
    'highlight': '荧光笔',
    'laser': '激光笔',
    'frame': '框架',
}

const TOOL_KEY_PREFIX = 'tldraw-tool-'
const UI_KEY_PREFIX = 'tldraw-ui-'

/** 工具显隐设置 key：tldraw-tool-<工具id> */
export function toolSettingKey(toolId: string): string {
    return `${TOOL_KEY_PREFIX}${toolId}`
}

/** UI 按钮/区域显隐设置 key：tldraw-ui-<标识> */
export function uiSettingKey(suffix: string): string {
    return `${UI_KEY_PREFIX}${suffix}`
}

function getSetting(key: string): any {
    return (settingdata as Record<string, any> | undefined)?.[key]
}

/** 工具栏工具是否可见 */
export function isTldrawToolVisible(toolId: string): boolean {
    return getSetting(toolSettingKey(toolId)) !== false
}

/** UI 按钮/区域是否可见 */
export function isTldrawUiVisible(suffix: string): boolean {
    return getSetting(uiSettingKey(suffix)) !== false
}

/** 主菜单"更多"子菜单内全部按钮的显隐 key（全部隐藏时整个子菜单不渲染） */
export const MAIN_MENU_MORE_KEYS: readonly string[] = [
    'backup', 'rollback', 'import', 'export', 'prune-assets',
]

/**
 * 全部 UI 按钮/区域的显隐 key 后缀清单。
 * 设置面板与预设方案均按此清单生成/遍历勾选项。
 * 新增 UI 显隐项时同步更新此数组与 UI_VISIBILITY_LABELS。
 */
export const ALL_UI_VISIBILITY_KEYS: readonly string[] = [
    'style-panel', 'main-menu', 'page-menu', 'navigation-panel', 'help-menu',
    'quick-actions', 'slides-panel', 'tool-lock',
    'undo-redo', 'delete-duplicate', 'open-doc', 'copy-link', 'refresh-cards',
    'shape-library', 'doc-outline', 'child-docs', 'search-text', 'restore-camera',
    'backup', 'rollback', 'import', 'export', 'prune-assets',
]

/** UI 按钮/区域的中文显示名（预设方案管理器与设置面板共用） */
export const UI_VISIBILITY_LABELS: Record<string, string> = {
    'style-panel': '样式面板',
    'main-menu': '主菜单',
    'page-menu': '页面菜单',
    'navigation-panel': '导航缩放面板',
    'help-menu': '帮助菜单',
    'quick-actions': '快捷操作区',
    'slides-panel': '幻灯片面板',
    'tool-lock': '锁定工具按钮',
    'undo-redo': '撤销 / 重做',
    'delete-duplicate': '删除 / 复制',
    'open-doc': '打开文档',
    'copy-link': '复制白板链接',
    'refresh-cards': '刷新所有卡片',
    'shape-library': '素材库',
    'doc-outline': '文档大纲',
    'child-docs': '子文档',
    'search-text': '搜索文本',
    'restore-camera': '编辑时聚焦开关',
    'backup': '备份数据',
    'rollback': '回滚数据',
    'import': '导入备份数据',
    'export': '导出数据',
    'prune-assets': '清理未使用资源',
}
