/**
 * 白板卡片与管理器共享工具函数和类型
 * 统一了在多个组件间重复的 extractDrawingId、parseSyTimestamp、computeBounds、projectShape、formatTime 等
 */

// ==================== 类型定义 ====================

/** 形状预览数据 */
export interface PreviewShape {
    id?: string;
    type?: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

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
    shapes: PreviewShape[];
    /** 预览 SVG 的投影结果，在加载文件时预计算 */
    previewRects?: ProjectedRect[];
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
        shapes: [],
        previewRects: undefined,
        previewError: undefined,
    };
}

/** computeBounds 返回的包围盒 */
export interface BoundsResult {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
}

/** projectShape 返回的投影矩形 */
export interface ProjectedRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

// ==================== SVG 渲染常量 ====================

export const SVG_VIEWBOX = { w: 300, h: 200 } as const;
export const SVG_PAD = 6;
export const SHAPE_FILL = 'rgba(61,142,255,0.08)';
export const SHAPE_STROKE = 'rgba(61,142,255,0.35)';
export const BORDER_STROKE = 'rgba(0,0,0,0.06)';
export const SHAPE_RX = 3;

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
 * 计算形状数组的包围盒
 * 形状使用中心坐标 (中心 x/y + 宽度/高度)
 */
export function computeBounds(shapes: PreviewShape[]): BoundsResult {
    if (!shapes || shapes.length === 0) {
        return { minX: 0, minY: 0, maxX: 300, maxY: 200, width: 300, height: 200 };
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const s of shapes) {
        const left = (typeof s.x === 'number' ? s.x : 0) - (s.w || 0) / 2;
        const top = (typeof s.y === 'number' ? s.y : 0) - (s.h || 0) / 2;
        minX = Math.min(minX, left);
        minY = Math.min(minY, top);
        maxX = Math.max(maxX, left + (s.w || 0));
        maxY = Math.max(maxY, top + (s.h || 0));
    }
    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
        return { minX: 0, minY: 0, maxX: 300, maxY: 200, width: 300, height: 200 };
    }
    const width = Math.max(maxX - minX, 1);
    const height = Math.max(maxY - minY, 1);
    return { minX, minY, maxX, maxY, width, height };
}

/**
 * 将单个形状投影到 SVG viewBox 坐标系
 * 需要外部预先计算 bounds、scale 和 pad（由调用方通过 Svelte {@const} 计算）
 *
 * @param shape - 要投影的形状
 * @param bounds - 所有形状的包围盒
 * @param scale - 统一缩放比例
 * @param pad - 边距 (px)
 * @param defaultW - 形状默认宽度 (默认 100)
 * @param defaultH - 形状默认高度 (默认 60)
 */
export function projectShape(
    shape: PreviewShape,
    bounds: BoundsResult,
    scale: number,
    pad: number,
    defaultW: number = 100,
    defaultH: number = 60,
): ProjectedRect {
    const cx = shape.x || 0;
    const cy = shape.y || 0;
    const w = shape.w || defaultW;
    const h = shape.h || defaultH;
    const left = cx - w / 2;
    const top = cy - h / 2;
    return {
        x: (left - bounds.minX) * scale + pad,
        y: (top - bounds.minY) * scale + pad,
        w: Math.max(w * scale, 1),
        h: Math.max(h * scale, 1),
    };
}

/**
 * 批量将形状投影到 SVG viewBox 中
 * 返回投影后的矩形数组，可直接在 Svelte 模板中使用
 *
 * @param shapes - 所有形状的数组
 * @param viewW - 视图宽度
 * @param viewH - 视图高度
 * @param pad - 内边距
 */
export function projectAllShapes(
    shapes: PreviewShape[],
    viewW: number,
    viewH: number,
    pad: number,
    defaultW: number = 100,
    defaultH: number = 60,
): ProjectedRect[] {
    if (!shapes || shapes.length === 0) return [];
    const bounds = computeBounds(shapes);
    const scale = Math.min(
        (viewW - pad * 2) / bounds.width,
        (viewH - pad * 2) / bounds.height,
    );
    return shapes.map(s => projectShape(s, bounds, scale, pad, defaultW, defaultH));
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
