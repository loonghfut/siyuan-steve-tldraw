/**
 * UI Overrides 主入口
 * 重新导出所有模块
 */

// 类型定义（包含 TLEventMap 扩展）
export * from './types'

// UI Overrides 对象
export { uiOverrides } from './overrides'

// TL Components 配置（buildComponents 按 UI 显隐设置动态构建）
export { buildComponents } from './components'

// UI 显隐配置（工具栏工具与各功能按钮）
export {
    DEFAULT_TOOLBAR_TOOL_IDS,
    CUSTOM_TOOLBAR_TOOLS_BEFORE,
    CUSTOM_TOOLBAR_TOOLS_AFTER,
    ALL_TOOLBAR_TOOL_IDS,
    TOOL_LABELS,
    MAIN_MENU_MORE_KEYS,
    ALL_UI_VISIBILITY_KEYS,
    UI_VISIBILITY_LABELS,
    toolSettingKey,
    uiSettingKey,
    isTldrawToolVisible,
    isTldrawUiVisible,
} from './ui-visibility'

// UI 显隐预设方案
export {
    UI_PRESETS_SETTING_KEY,
    BUILTIN_UI_PRESETS,
    defaultPresetsConfig,
    snapshotVisibility,
    applyPresetToSettings,
    presetMatchesSnapshot,
    generatePresetId,
    createPresetFromSnapshot,
    updatePresetFromSnapshot,
    duplicatePreset,
    normalizePresetsConfig,
} from './ui-presets'
export type {
    TldrawUiPreset,
    TldrawUiPresetsConfig,
    VisibilitySnapshot,
} from './ui-presets'

// 面板状态管理
export {
    toggleShapeLibrary,
    useShapeLibraryOpen,
    toggleDocOutline,
    setDocOutlineDocId,
    useDocOutlineOpen,
    useDocOutlineDocId,
    toggleChildDocs,
    useChildDocsOpen,
} from './panel-state'
