/**
 * 画板 UI 显隐预设方案
 *
 * 一个「方案」= 工具栏工具 + 界面按钮的显隐快照。
 * 用户可以：保存当前配置为新方案、切换方案、更新/重命名/删除/复制方案。
 * 方案列表与当前激活方案 id 持久化在插件设置 `tldraw-ui-presets` 中。
 *
 * 内置方案不可删除/重命名，但可以被「更新」覆盖（覆盖后变为自定义方案）。
 */
import { getFrontend } from 'siyuan'
import {
    ALL_TOOLBAR_TOOL_IDS,
    ALL_UI_VISIBILITY_KEYS,
    toolSettingKey,
    uiSettingKey,
} from './ui-visibility'

// ==================== 类型 ====================

/** 单个 UI 显隐预设方案 */
export interface TldrawUiPreset {
    /** 唯一标识（内置方案使用 `builtin-` 前缀） */
    id: string
    /** 用户可见名称 */
    name: string
    /** 工具栏工具显隐：key = toolId，value = 是否显示；缺省视为 true */
    tools: Record<string, boolean>
    /** 界面按钮/区域显隐：key = suffix，value = 是否显示；缺省视为 true */
    ui: Record<string, boolean>
    /** 是否为内置方案（内置方案不可删除/重命名） */
    builtin?: boolean
    /** 创建时间戳（ms） */
    createdAt: number
    /** 最后更新时间戳（ms） */
    updatedAt: number
}

/** 平台标识：桌面端 / 移动端 */
export type UiPresetPlatform = 'desktop' | 'mobile'

/** `tldraw-ui-presets` 设置项的完整结构 */
export interface TldrawUiPresetsConfig {
    list: TldrawUiPreset[]
    /** 各平台各自激活的方案 id；null 表示该平台为「自定义」（未绑定方案） */
    active: Record<UiPresetPlatform, string | null>
}

/** 显隐快照：工具 + UI 按钮的当前布尔值集合 */
export interface VisibilitySnapshot {
    tools: Record<string, boolean>
    ui: Record<string, boolean>
}

// ==================== 设置 key ====================

export const UI_PRESETS_SETTING_KEY = 'tldraw-ui-presets'

// ==================== 内置方案 ====================

function makePreset(
    id: string,
    name: string,
    tools: Record<string, boolean>,
    ui: Record<string, boolean>,
): TldrawUiPreset {
    const now = Date.now()
    return { id, name, tools, ui, builtin: true, createdAt: now, updatedAt: now }
}

/** 全部显示 */
function allTrue(keys: readonly string[]): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    for (const k of keys) out[k] = true
    return out
}

/** 内置：完整界面（所有工具与按钮均显示） */
const BUILTIN_FULL = makePreset(
    'builtin-full',
    '完整界面',
    allTrue(ALL_TOOLBAR_TOOL_IDS),
    allTrue(ALL_UI_VISIBILITY_KEYS),
)

/** 内置：极简模式（仅保留核心绘制工具，隐藏所有面板与辅助按钮） */
const BUILTIN_MINIMAL = makePreset(
    'builtin-minimal',
    '极简模式',
    {
        select: true, hand: true, draw: true, eraser: true, text: true,
        arrow: true, rectangle: true, ellipse: true, line: true, frame: true,
        // 其余工具全部隐藏
        ...Object.fromEntries(
            ALL_TOOLBAR_TOOL_IDS
                .filter(id => !['select', 'hand', 'draw', 'eraser', 'text', 'arrow', 'rectangle', 'ellipse', 'line', 'frame'].includes(id))
                .map(id => [id, false]),
        ),
    },
    {
        // 仅保留主菜单（否则无法退出/访问基本功能）
        'main-menu': true,
        ...Object.fromEntries(
            ALL_UI_VISIBILITY_KEYS
                .filter(k => k !== 'main-menu')
                .map(k => [k, false]),
        ),
    },
)

/** 内置：专注绘图（保留绘图相关工具，隐藏文档/卡片/幻灯片等业务 UI） */
const BUILTIN_DRAWING = makePreset(
    'builtin-drawing',
    '专注绘图',
    {
        select: true, hand: true, draw: true, eraser: true, arrow: true,
        text: true, note: true, line: true, highlight: true, laser: true,
        rectangle: true, ellipse: true, triangle: true, diamond: true,
        frame: true, asset: true,
        ...Object.fromEntries(
            ALL_TOOLBAR_TOOL_IDS
                .filter(id => !['select', 'hand', 'draw', 'eraser', 'arrow', 'text', 'note', 'line', 'highlight', 'laser', 'rectangle', 'ellipse', 'triangle', 'diamond', 'frame', 'asset'].includes(id))
                .map(id => [id, false]),
        ),
    },
    {
        'style-panel': true,
        'main-menu': true,
        'navigation-panel': true,
        'undo-redo': true,
        'delete-duplicate': true,
        'quick-actions': true,
        ...Object.fromEntries(
            ALL_UI_VISIBILITY_KEYS
                .filter(k => !['style-panel', 'main-menu', 'navigation-panel', 'undo-redo', 'delete-duplicate', 'quick-actions'].includes(k))
                .map(k => [k, false]),
        ),
    },
)

/** 全部内置方案（按展示顺序） */
export const BUILTIN_UI_PRESETS: readonly TldrawUiPreset[] = [
    BUILTIN_FULL,
    BUILTIN_MINIMAL,
    BUILTIN_DRAWING,
]

/** 默认设置值：内置方案 + 各平台均无激活方案 */
export function defaultPresetsConfig(): TldrawUiPresetsConfig {
    return {
        list: BUILTIN_UI_PRESETS.map(p => ({ ...p, tools: { ...p.tools }, ui: { ...p.ui } })),
        active: { desktop: null, mobile: null },
    }
}

// ==================== 快照与应用 ====================

/**
 * 从设置对象中读取当前所有 UI 显隐开关，生成快照。
 * 缺省（key 不存在）视为 true，与 `isTldrawToolVisible` / `isTldrawUiVisible` 语义一致。
 */
export function snapshotVisibility(settings: Record<string, any>): VisibilitySnapshot {
    const tools: Record<string, boolean> = {}
    for (const id of ALL_TOOLBAR_TOOL_IDS) {
        tools[id] = settings[toolSettingKey(id)] !== false
    }
    const ui: Record<string, boolean> = {}
    for (const suffix of ALL_UI_VISIBILITY_KEYS) {
        ui[suffix] = settings[uiSettingKey(suffix)] !== false
    }
    return { tools, ui }
}

/**
 * 将方案的显隐配置写入设置对象（原地修改）。
 * 返回被修改的 key→value 映射，供调用方做批量持久化。
 */
export function applyPresetToSettings(
    preset: TldrawUiPreset,
    settings: Record<string, any>,
): Record<string, any> {
    const updates: Record<string, any> = {}
    for (const id of ALL_TOOLBAR_TOOL_IDS) {
        const key = toolSettingKey(id)
        const v = preset.tools[id] !== false
        settings[key] = v
        updates[key] = v
    }
    for (const suffix of ALL_UI_VISIBILITY_KEYS) {
        const key = uiSettingKey(suffix)
        const v = preset.ui[suffix] !== false
        settings[key] = v
        updates[key] = v
    }
    return updates
}

/** 判断方案与快照是否完全一致（用于「已修改」标记） */
export function presetMatchesSnapshot(preset: TldrawUiPreset, snapshot: VisibilitySnapshot): boolean {
    for (const id of ALL_TOOLBAR_TOOL_IDS) {
        const pv = preset.tools[id] !== false
        const sv = snapshot.tools[id] !== false
        if (pv !== sv) return false
    }
    for (const suffix of ALL_UI_VISIBILITY_KEYS) {
        const pv = preset.ui[suffix] !== false
        const sv = snapshot.ui[suffix] !== false
        if (pv !== sv) return false
    }
    return true
}

// ==================== 方案 CRUD 工具 ====================

let _idCounter = 0

/** 生成唯一方案 id */
export function generatePresetId(): string {
    _idCounter += 1
    return `preset-${Date.now().toString(36)}-${_idCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 从快照创建新方案 */
export function createPresetFromSnapshot(
    name: string,
    snapshot: VisibilitySnapshot,
): TldrawUiPreset {
    const now = Date.now()
    return {
        id: generatePresetId(),
        name: name.trim() || '未命名方案',
        tools: { ...snapshot.tools },
        ui: { ...snapshot.ui },
        builtin: false,
        createdAt: now,
        updatedAt: now,
    }
}

/** 用快照更新已有方案（保留 id/name/builtin/createdAt） */
export function updatePresetFromSnapshot(
    preset: TldrawUiPreset,
    snapshot: VisibilitySnapshot,
): TldrawUiPreset {
    return {
        ...preset,
        tools: { ...snapshot.tools },
        ui: { ...snapshot.ui },
        updatedAt: Date.now(),
    }
}

/** 复制方案（新 id、新名称后缀） */
export function duplicatePreset(preset: TldrawUiPreset, list: TldrawUiPreset[]): TldrawUiPreset {
    const now = Date.now()
    let name = `${preset.name} 副本`
    let n = 2
    while (list.some(p => p.name === name)) {
        name = `${preset.name} 副本 ${n}`
        n += 1
    }
    return {
        ...preset,
        id: generatePresetId(),
        name,
        tools: { ...preset.tools },
        ui: { ...preset.ui },
        builtin: false,
        createdAt: now,
        updatedAt: now,
    }
}

/** 安全解析设置值，容错处理旧数据/损坏数据 */
export function normalizePresetsConfig(raw: unknown): TldrawUiPresetsConfig {
    if (!raw || typeof raw !== 'object') return defaultPresetsConfig()
    const obj = raw as Record<string, any>
    const list: TldrawUiPreset[] = Array.isArray(obj.list)
        ? obj.list
            .filter((p: any) => p && typeof p === 'object' && typeof p.id === 'string')
            .map((p: any) => ({
                id: String(p.id),
                name: typeof p.name === 'string' ? p.name : '未命名方案',
                tools: p.tools && typeof p.tools === 'object' ? { ...p.tools } : {},
                ui: p.ui && typeof p.ui === 'object' ? { ...p.ui } : {},
                builtin: p.builtin === true,
                createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
                updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
            }))
        : BUILTIN_UI_PRESETS.map(p => ({ ...p, tools: { ...p.tools }, ui: { ...p.ui } }))

    // 确保内置方案始终存在（用户可能误删了存储中的内置项）
    for (const bp of BUILTIN_UI_PRESETS) {
        if (!list.some(p => p.id === bp.id)) {
            list.unshift({ ...bp, tools: { ...bp.tools }, ui: { ...bp.ui } })
        }
    }

    // 兼容旧版全局 activeId：迁移为两个平台共用同一方案
    let active: Record<UiPresetPlatform, string | null>
    if (obj.active && typeof obj.active === 'object') {
        const pick = (v: any): string | null =>
            typeof v === 'string' && list.some(p => p.id === v) ? v : null
        active = { desktop: pick(obj.active.desktop), mobile: pick(obj.active.mobile) }
    } else {
        const legacy = typeof obj.activeId === 'string' && list.some(p => p.id === obj.activeId)
            ? obj.activeId
            : null
        active = { desktop: legacy, mobile: legacy }
    }

    return { list, active }
}

// ==================== 平台检测与启动应用 ====================

/**
 * 检测当前运行平台。
 * 依赖 siyuan getFrontend()；在无法获取时默认 desktop。
 */
export function getCurrentPlatform(): UiPresetPlatform {
    try {
        const f = getFrontend()
        return f === 'mobile' || f === 'browser-mobile' ? 'mobile' : 'desktop'
    } catch {
        return 'desktop'
    }
}

/** 获取指定平台当前激活的方案（未绑定返回 null） */
export function getActivePreset(
    config: TldrawUiPresetsConfig,
    platform: UiPresetPlatform,
): TldrawUiPreset | null {
    const id = config.active?.[platform] ?? null
    if (!id) return null
    return config.list.find(p => p.id === id) ?? null
}

/**
 * 启动时将当前平台激活方案的显隐配置应用到设置对象（原地修改，不持久化）。
 * 使各设备在加载插件后即按本平台方案渲染 UI，无需手动点击「应用」。
 * 返回是否实际应用了某个方案。
 */
export function applyActivePresetOnStartup(settings: Record<string, any>): boolean {
    if (!settings || typeof settings !== 'object') return false
    const config = normalizePresetsConfig(settings[UI_PRESETS_SETTING_KEY])
    const platform = getCurrentPlatform()
    const preset = getActivePreset(config, platform)
    if (!preset) return false
    applyPresetToSettings(preset, settings)
    return true
}
