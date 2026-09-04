/**
 * 白板卡片与管理器共享工具函数和类型
 * 统一了在多个组件间重复的 extractDrawingId、parseSyTimestamp、computeElementBounds、projectElements、formatTime 等
 */

// ==================== 类型定义 ====================

/** 预览图元的类别：矩形（框状形状）或折线（笔迹/连线） */
export type PreviewElementKind = 'rect' | 'stroke';

/**
 * 预览图元（页面绝对坐标）。
 * 由 tldraw 形状几何重建而来：框状形状用 x/y/w/h（左上角+宽高），
 * 笔迹/连线用 points 折线点序列。坐标均已换算到页面绝对空间（含父级平移与旋转）。
 */
export interface PreviewElement {
    kind: PreviewElementKind;
    /** rect: 左上角坐标与宽高（页面绝对坐标） */
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    /** stroke: 折线点序列（页面绝对坐标） */
    points?: { x: number; y: number }[];
    /** stroke: 是否闭合 */
    closed?: boolean;
    /** 是否填充（note / 闭合且填充的 draw / geo 等） */
    filled?: boolean;
    /** stroke: 相对描边粗细（页面单位），投影时按 scale 缩放 */
    weight?: number;
    /** 原始 tldraw 形状类型，便于调试与样式区分 */
    type?: string;
}

/** 投影到 SVG viewBox 后的图元，可直接在 Svelte 模板中渲染 */
export type ProjectedPrim =
    | { kind: 'rect'; x: number; y: number; w: number; h: number; filled?: boolean }
    | { kind: 'path'; d: string; filled?: boolean; closed?: boolean; strokeWidth: number };

/**
 * 统一的白板数据项：dock 卡片面板与高级管理面板共用同一模型。
 * 取代此前分裂的 WhiteboardItem 与两处 WhiteboardCard，消除字段/语义不一致。
 */
export interface WhiteboardEntry {
    id: string;
    fileName: string;
    path: string;
    title: string;
    exists: boolean;
    docId?: string;
    tags: string[];
    /** 块/文档时间戳（毫秒），缺失为 0 */
    blkCreated: number;
    blkUpdated: number;
    docCreated: number;
    docUpdated: number;
    /** 数据文件修改时间（毫秒） */
    fileMtime: number;
    /** 派生：最近活动时间 = blkUpdated||docUpdated||blkCreated||docCreated||fileMtime */
    updatedAt: number;
    /** 派生：创建时间 = blkCreated||docCreated||fileMtime */
    createdAt: number;
    /** 预览状态 */
    loadingPreview: boolean;
    /** 预览是否已尝试加载完成（用于区分"未加载"与"空白画板"） */
    previewLoaded: boolean;
    /** 重建出的预览图元（页面绝对坐标） */
    elements: PreviewElement[];
    /** 预览 SVG 的投影结果，在加载文件时预计算 */
    previewPrims?: ProjectedPrim[];
    previewError?: string;
}

/** 统一 UI 文案常量，避免两面板措辞不一致（此前 "无附属" vs "无效"） */
export const MISSING_BLOCK_LABEL = '无附属块';
export const UNTITLED_DOC_LABEL = '未命名文档';

/** 构造一个基础（未填充元数据）的白板条目 */
export function createBaseEntry(input: {
    id: string;
    fileName: string;
    path: string;
    fileMtime?: number;
}): WhiteboardEntry {
    const fileMtime = input.fileMtime || 0;
    return {
        id: input.id,
        fileName: input.fileName,
        path: input.path,
        title: UNTITLED_DOC_LABEL,
        exists: false,
        docId: undefined,
        tags: [],
        blkCreated: 0,
        blkUpdated: 0,
        docCreated: 0,
        docUpdated: 0,
        fileMtime,
        updatedAt: fileMtime,
        createdAt: fileMtime,
        loadingPreview: false,
        previewLoaded: false,
        elements: [],
        previewPrims: undefined,
        previewError: undefined,
    };
}

/** computeElementBounds 返回的包围盒 */
export interface BoundsResult {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
}

// ==================== SVG 渲染常量 ====================

export const SVG_VIEWBOX = { w: 300, h: 200 } as const;
export const SVG_PAD = 6;
export const SHAPE_FILL = 'rgba(61,142,255,0.08)';
export const SHAPE_FILL_SOLID = 'rgba(61,142,255,0.20)';
export const SHAPE_STROKE = 'rgba(61,142,255,0.35)';
export const BORDER_STROKE = 'rgba(0,0,0,0.06)';
export const SHAPE_RX = 3;

// ============ 预览几何常量（对齐 tldraw 5.2.3 默认值） ============

/** tldraw 字号样式 → 相对倍数（default-shape-constants FONT_SIZES） */
export const FONT_SIZES: Record<string, number> = { s: 1.125, m: 1.5, l: 2.25, xl: 2.75 };
/** tldraw 描边尺寸样式 → 相对倍数（STROKE_SIZES） */
export const STROKE_SIZES: Record<string, number> = { s: 1, m: 1.75, l: 2.5, xl: 5 };
/** 文本高度估算的基准字号（px） */
export const BASE_FONT_PX = 16;
/** 文本行高倍数 */
export const TEXT_LINE_HEIGHT = 1.35;
/** note 便签默认边长（NoteShapeUtil noteWidth/noteHeight 默认 200） */
export const NOTE_BASE = 200;
/** 预览元素总数上限，超出则截断（bounds 仍按全部计算） */
export const MAX_PREVIEW_ELEMENTS = 500;
/** 单条笔迹折线的最大点数，超出均匀降采样 */
export const MAX_POINTS_PER_STROKE = 64;

// ==================== 工具函数 ====================

/**
 * 从 tldraw 数据文件名中提取画板 ID
 * 支持主文件和备份文件格式
 *
 * 主文件: tldraw-data-YYYYMMDDHHmmss-xxxxxxx.json
 * 备份文件: tldraw-data-YYYYMMDDHHmmss-xxxxxxx-reason-timestamp.json
 */
export function extractDrawingId(filename: string): string {
    const prefix = 'tldraw-data-';
    const base = filename.endsWith('.json') ? filename.slice(0, -'.json'.length) : filename;
    if (!base.startsWith(prefix)) return '未知画板';

    // 优先匹配严格格式：14位时间戳 + '-' + id
    const strictMatch = base.match(/^tldraw-data-(\d{14}-[a-z0-9]+)(?:$|[-_])/i);
    if (strictMatch) return strictMatch[1];

    // 尝试剥离末尾时间戳（通常是毫秒级 10+ 位），再剥离 reason
    const tsMatch = base.match(/-(\d{10,})$/);
    if (tsMatch) {
        const withoutTs = base.slice(0, -tsMatch[0].length);
        const lastDash = withoutTs.lastIndexOf('-');
        let storageKey = withoutTs;
        if (lastDash > prefix.length) {
            storageKey = withoutTs.slice(0, lastDash);
        }
        if (storageKey.startsWith(prefix)) {
            const id = storageKey.slice(prefix.length);
            const leadMatch = id.match(/^(\d{14}-[a-z0-9]+)/i);
            if (leadMatch) return leadMatch[1];
            return id;
        }
        return withoutTs.slice(prefix.length);
    }

    // 无时间戳，直接取 prefix 后面的内容，优先返回符合严格格式的前缀
    const candidate = base.slice(prefix.length);
    const candMatch = candidate.match(/^(\d{14}-[a-z0-9]+)/i);
    if (candMatch) return candMatch[1];

    // 最终验证：如果提取结果不符合 ID 格式，返回未知
    const idPattern = /^\d{14}-\w{7}$/;
    if (idPattern.test(candidate)) return candidate;
    return '未知画板';
}

/**
 * 解析思源块时间戳为毫秒数
 * 支持格式: "20251103111739" (14位纯数字)、带分隔符的字符串、或直接的数字型毫秒时间戳
 */
export function parseSyTimestamp(value?: string | number | null): number {
    if (!value) return 0;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const digitsOnly = value.replace(/[^0-9]/g, '');
        if (digitsOnly.length >= 14) {
            const y = Number(digitsOnly.slice(0, 4));
            const m = Number(digitsOnly.slice(4, 6)) - 1;
            const d = Number(digitsOnly.slice(6, 8));
            const hh = Number(digitsOnly.slice(8, 10));
            const mm = Number(digitsOnly.slice(10, 12));
            const ss = Number(digitsOnly.slice(12, 14));
            return new Date(y, m, d, hh, mm, ss).getTime();
        }
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
    }
    return 0;
}

/**
 * 计算预览图元数组的包围盒（页面绝对坐标）。
 * rect 取左上/右下两角，stroke 取所有折线点；并按最大描边粗细外扩半宽，避免边缘笔迹被裁切。
 * 注意：tldraw 的 rect 使用左上角坐标（非中心），此处不再做 -w/2 偏移。
 */
export function computeElementBounds(elements: PreviewElement[]): BoundsResult {
    const fallback = { minX: 0, minY: 0, maxX: SVG_VIEWBOX.w, maxY: SVG_VIEWBOX.h, width: SVG_VIEWBOX.w, height: SVG_VIEWBOX.h };
    if (!elements || elements.length === 0) return fallback;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxWeight = 0;
    const acc = (x: number, y: number) => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    };
    for (const el of elements) {
        if (el.kind === 'rect') {
            const x = el.x ?? 0;
            const y = el.y ?? 0;
            const w = el.w ?? 0;
            const h = el.h ?? 0;
            acc(x, y);
            acc(x + w, y + h);
        } else if (el.points && el.points.length > 0) {
            for (const p of el.points) acc(p.x, p.y);
            if (typeof el.weight === 'number' && el.weight > maxWeight) maxWeight = el.weight;
        }
    }
    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return fallback;
    const pad = maxWeight / 2;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);
    return { minX, minY, maxX, maxY, width, height };
}

/**
 * 将预览图元批量投影到 SVG viewBox 坐标系。
 * rect → 投影矩形；stroke → 生成 `d="M..L.."` 路径（闭合追加 Z，单点补极小线段以显示圆点）。
 * 统一缩放比例 scale = min((viewW-2pad)/bounds.w, (viewH-2pad)/bounds.h)。
 *
 * @param elements - 页面绝对坐标的图元数组
 * @param viewW - 视图宽度
 * @param viewH - 视图高度
 * @param pad - 内边距
 */
export function projectElements(
    elements: PreviewElement[],
    viewW: number,
    viewH: number,
    pad: number,
): ProjectedPrim[] {
    if (!elements || elements.length === 0) return [];
    const bounds = computeElementBounds(elements);
    const scale = Math.min(
        (viewW - pad * 2) / bounds.width,
        (viewH - pad * 2) / bounds.height,
    );
    const tx = (x: number) => (x - bounds.minX) * scale + pad;
    const ty = (y: number) => (y - bounds.minY) * scale + pad;
    const prims: ProjectedPrim[] = [];
    const limit = Math.min(elements.length, MAX_PREVIEW_ELEMENTS);
    for (let i = 0; i < limit; i++) {
        const el = elements[i];
        if (el.kind === 'rect') {
            const x = el.x ?? 0;
            const y = el.y ?? 0;
            const w = el.w ?? 0;
            const h = el.h ?? 0;
            prims.push({
                kind: 'rect',
                x: tx(x),
                y: ty(y),
                w: Math.max(w * scale, 1),
                h: Math.max(h * scale, 1),
                filled: el.filled,
            });
        } else if (el.points && el.points.length > 0) {
            const pts = el.points;
            let d: string;
            if (pts.length === 1) {
                // 单点（点状笔迹）：补一段极小位移，配合 round linecap 显示为圆点
                const px = tx(pts[0].x);
                const py = ty(pts[0].y);
                d = `M${px.toFixed(2)} ${py.toFixed(2)}L${(px + 0.01).toFixed(2)} ${py.toFixed(2)}`;
            } else {
                d = `M${tx(pts[0].x).toFixed(2)} ${ty(pts[0].y).toFixed(2)}`;
                for (let j = 1; j < pts.length; j++) {
                    d += `L${tx(pts[j].x).toFixed(2)} ${ty(pts[j].y).toFixed(2)}`;
                }
                if (el.closed) d += 'Z';
            }
            const weight = (el.weight ?? 1) * scale;
            prims.push({
                kind: 'path',
                d,
                filled: el.filled,
                closed: el.closed,
                strokeWidth: Math.max(0.5, Math.min(weight, 3)),
            });
        }
    }
    return prims;
}

/**
 * 格式化时间戳为显示字符串
 * @param ms - 毫秒时间戳
 * @returns 格式化的时间字符串，无效时返回 '-'
 */
export function formatTime(ms: number | undefined): string {
    if (!ms || !Number.isFinite(ms) || ms <= 0) return '-';
    try {
        return new Date(ms).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '-';
    }
}

/**
 * 格式化时间戳为简短的相对时间（紧凑视图/列表视图使用）
 * @param ms - 毫秒时间戳
 * @returns 如 "刚刚"、"5 分钟前"、"3 天前"；超过一年回落到日期；无效时返回空串
 */
export function formatRelativeTime(ms: number | undefined): string {
    if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
    const diff = Date.now() - ms;
    if (diff < 60_000) return '刚刚';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 31) return `${days} 天前`;
    try {
        return new Date(ms).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    } catch {
        return '';
    }
}

/**
 * 统一标题解析：优先 fcontent（首行内容），其次 content，最后占位。
 * 修复此前 dock 用 content、管理器用 fcontent||content 导致同一白板标题不一致。
 */
export function resolveEntryTitle(docBlk?: { fcontent?: string; content?: string } | null): string {
    if (!docBlk) return UNTITLED_DOC_LABEL;
    return docBlk.fcontent || docBlk.content || UNTITLED_DOC_LABEL;
}

/** 派生"最近活动时间"：块更新 > 文档更新 > 块创建 > 文档创建 > 文件 mtime */
export function computeUpdatedAt(t: Partial<WhiteboardEntry>): number {
    return t.blkUpdated || t.docUpdated || t.blkCreated || t.docCreated || t.fileMtime || 0;
}

/** 派生"创建时间"：块创建 > 文档创建 > 文件 mtime */
export function computeCreatedAt(t: Partial<WhiteboardEntry>): number {
    return t.blkCreated || t.docCreated || t.fileMtime || 0;
}

/**
 * 唯一的排序实现：dock 与管理器共享同一 whiteboardSortKey，
 * 必须产生完全一致的顺序（修复此前两面板同键不同序）。
 */
export function sortEntries(list: WhiteboardEntry[], sortKey: string): WhiteboardEntry[] {
    const arr = list.slice();
    switch (sortKey) {
        case 'mtime-desc': arr.sort((a, b) => b.updatedAt - a.updatedAt); break;
        case 'mtime-asc': arr.sort((a, b) => a.updatedAt - b.updatedAt); break;
        case 'blkCreated-desc': arr.sort((a, b) => b.createdAt - a.createdAt); break;
        case 'blkCreated-asc': arr.sort((a, b) => a.createdAt - b.createdAt); break;
        case 'title': arr.sort((a, b) => a.title.localeCompare(b.title)); break;
        case 'id': arr.sort((a, b) => a.id.localeCompare(b.id)); break;
        case 'exists': arr.sort((a, b) => Number(b.exists) - Number(a.exists)); break;
    }
    return arr;
}

/** 搜索匹配：id / 标题 / 文件名 / 标签，任一命中即可（空查询视为全部命中） */
export function entryMatchesQuery(entry: WhiteboardEntry, rawQuery: string): boolean {
    const q = (rawQuery || '').trim().toLowerCase();
    if (!q) return true;
    return (
        entry.id.toLowerCase().includes(q) ||
        entry.title.toLowerCase().includes(q) ||
        entry.fileName.toLowerCase().includes(q) ||
        entry.tags.some(tag => tag.toLowerCase().includes(q))
    );
}

/**
 * 从块属性 tag 字段解析标签数组，形如 "#a##b#" → ["a", "b"]
 */
export function parseBlockTags(tag?: string | null): string[] {
    if (!tag) return [];
    return tag.match(/#([^#]+)#/g)?.map(t => t.replace(/#/g, '')) || [];
}

// ==================== 面板内浮层菜单定位 ====================

/** 浮层菜单位置，相对面板根元素的坐标 */
export interface MenuPosition {
    x: number;
    y: number;
}

/**
 * 计算跟随鼠标指针的菜单位置，并夹取在面板范围内。
 * 菜单必须以面板根元素为定位基准（菜单 position: absolute，根元素 position: relative）。
 */
export function pointerMenuPosition(
    panel: HTMLElement,
    event: MouseEvent,
    menuWidth: number,
    menuHeight: number
): MenuPosition {
    const rect = panel.getBoundingClientRect();
    const x = Math.max(4, Math.min(event.clientX - rect.left, rect.width - menuWidth - 4));
    const y = Math.max(4, Math.min(event.clientY - rect.top, rect.height - menuHeight - 4));
    return { x, y };
}

/**
 * 计算锚定在某个工具栏按钮（如排序按钮）下方、右对齐按钮的菜单位置。
 * 提供 menuHeight 时会把菜单底部夹取在面板范围内。
 */
export function anchoredMenuPosition(
    panel: HTMLElement,
    anchor: HTMLElement,
    menuWidth: number,
    menuHeight?: number
): MenuPosition {
    const rect = panel.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    let y = anchorRect.bottom - rect.top + 6;
    if (menuHeight && menuHeight > 0) {
        y = Math.max(4, Math.min(y, rect.height - menuHeight - 4));
    }
    return {
        x: Math.max(4, anchorRect.right - menuWidth - rect.left),
        y,
    };
}
