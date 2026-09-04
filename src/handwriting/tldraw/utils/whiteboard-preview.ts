/**
 * 白板缩略图数据加载：读取 tldraw 数据文件，按各形状类型重建真实几何，
 * 输出「页面绝对坐标」的预览图元（矩形 / 折线笔迹）。Dock 面板与高级管理面板共用。
 *
 * 关键点（对齐 tldraw 5.2.3 存储结构）：
 * - draw/highlight 笔迹几何存于 props.segments[].path（base64 delta 编码），用 b64Vecs.decodePoints 解码；
 *   点为形状局部坐标，需乘 scaleX/scaleY，再经形状页面变换换算为绝对坐标。
 * - line 的 props.points 是 dict<id,{x,y,index}>；arrow 用 props.start/props.end。
 * - text 只有 props.w（显式宽），高度按 richText 行数估算；note 默认 200×200 + growY。
 * - 形状 x/y 为左上角（非中心），且子形状坐标相对父级，需沿 parentId 链累积仿射变换（含 rotation）。
 * - 仅处理 typeName==='shape' 的记录，跳过 page/camera/instance/document/presence 等。
 */
import { api } from '@frostime/siyuan-plugin-kits';
import { b64Vecs } from '@tldraw/tldraw';
import {
    type PreviewElement,
    FONT_SIZES,
    STROKE_SIZES,
    BASE_FONT_PX,
    TEXT_LINE_HEIGHT,
    NOTE_BASE,
    MAX_PREVIEW_ELEMENTS,
    MAX_POINTS_PER_STROKE,
} from './whiteboard-utils';

// ==================== 2D 仿射变换 ====================

/** 仿射矩阵 {a,b,c,d,e,f}：x' = a*x + c*y + e；y' = b*x + d*y + f */
interface Mat { a: number; b: number; c: number; d: number; e: number; f: number; }

const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** 矩阵乘法：先应用 m2，再应用 m1 */
function multiply(m1: Mat, m2: Mat): Mat {
    return {
        a: m1.a * m2.a + m1.c * m2.b,
        b: m1.b * m2.a + m1.d * m2.b,
        c: m1.a * m2.c + m1.c * m2.d,
        d: m1.b * m2.c + m1.d * m2.d,
        e: m1.a * m2.e + m1.c * m2.f + m1.e,
        f: m1.b * m2.e + m1.d * m2.f + m1.f,
    };
}

function applyPoint(m: Mat, x: number, y: number): { x: number; y: number } {
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/** 形状自身的局部变换：translate(x,y) · rotate(rotation)（rotation=0 时退化为纯平移） */
function shapeLocalMatrix(shape: any): Mat {
    const x = Number(shape?.x) || 0;
    const y = Number(shape?.y) || 0;
    const r = Number(shape?.rotation) || 0;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return { a: cos, b: sin, c: -sin, d: cos, e: x, f: y };
}

/**
 * 构建「形状 → 页面绝对变换」的解析器：沿 parentId 链累积父级变换（带缓存与环保护）。
 * 父级为非形状（page 等）时视作单位矩阵（根）。
 */
function buildTransformResolver(byId: Map<string, any>) {
    const cache = new Map<string, Mat>();
    const visiting = new Set<string>();
    const resolve = (shape: any): Mat => {
        const id = typeof shape?.id === 'string' ? shape.id : undefined;
        if (id && cache.has(id)) return cache.get(id)!;
        const local = shapeLocalMatrix(shape);
        const parentId = shape?.parentId;
        let parentMat = IDENTITY;
        if (typeof parentId === 'string' && parentId !== id && !visiting.has(parentId)) {
            const parent = byId.get(parentId);
            if (parent && isShapeRecord(parent, parentId)) {
                if (id) visiting.add(id);
                parentMat = resolve(parent);
                if (id) visiting.delete(id);
            }
        }
        const m = multiply(parentMat, local);
        if (id) cache.set(id, m);
        return m;
    };
    return resolve;
}

// ==================== 记录判定与解析 ====================

function isShapeRecord(rec: any, key?: string): boolean {
    if (!rec || typeof rec !== 'object') return false;
    if (rec.typeName === 'shape') return true;
    const id = typeof rec.id === 'string' ? rec.id : (typeof key === 'string' ? key : '');
    return id.startsWith('shape:') && typeof rec.type === 'string';
}

function parseJson(raw: unknown): any {
    if (typeof raw === 'string') return JSON.parse(raw);
    if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw));
    if (ArrayBuffer.isView(raw)) {
        const view = raw as ArrayBufferView;
        return JSON.parse(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
    }
    return raw;
}

/** 从快照中取出 record 映射：兼容 {document:{store}} / {store} / {document:{shapes}} / {shapes} / 直接映射 */
function pickStore(json: any): Record<string, any> | undefined {
    if (!json || typeof json !== 'object') return undefined;
    const candidates = [json?.document?.store, json?.store, json?.document?.shapes, json?.shapes];
    for (const c of candidates) {
        if (c && typeof c === 'object') return c as Record<string, any>;
    }
    return json as Record<string, any>;
}

// ==================== richText 文本提取（无 editor 依赖） ====================

function collectNodeText(node: any): string {
    if (!node || typeof node !== 'object') return '';
    if (typeof node.text === 'string') return node.text;
    if (Array.isArray(node.content)) return node.content.map(collectNodeText).join('');
    return '';
}

/** 把 richText（ProseMirror doc）拆成「每个段落一行」的文本数组；回退到 legacy props.text */
function richTextToLines(richText: any, legacyText?: string): string[] {
    if (richText && Array.isArray(richText.content)) {
        const lines = richText.content.map((block: any) => collectNodeText(block));
        return lines.length ? lines : [''];
    }
    if (typeof legacyText === 'string' && legacyText) return legacyText.split('\n');
    return [''];
}

// ==================== 几何构建工具 ====================

/** 折线降采样：超过上限时均匀取点，并去除相邻重复点 */
function simplifyPoints(pts: { x: number; y: number }[]): { x: number; y: number }[] {
    let out = pts;
    if (pts.length > MAX_POINTS_PER_STROKE) {
        out = [];
        const step = (pts.length - 1) / (MAX_POINTS_PER_STROKE - 1);
        for (let i = 0; i < MAX_POINTS_PER_STROKE; i++) {
            const idx = Math.min(pts.length - 1, Math.round(i * step));
            out.push(pts[idx]);
        }
    }
    // 去除相邻完全重复点，减少 path 数据量
    const dedup: { x: number; y: number }[] = [];
    for (const p of out) {
        const last = dedup[dedup.length - 1];
        if (!last || last.x !== p.x || last.y !== p.y) dedup.push(p);
    }
    return dedup.length ? dedup : out;
}

/** 由局部盒 (0,0,w,h) 经变换后取轴对齐包围盒，生成 rect 图元 */
function rectFromLocalBox(m: Mat, w: number, h: number, filled: boolean, type: string): PreviewElement {
    const corners = [applyPoint(m, 0, 0), applyPoint(m, w, 0), applyPoint(m, 0, h), applyPoint(m, w, h)];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of corners) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return {
        kind: 'rect',
        x: minX,
        y: minY,
        w: Math.max(maxX - minX, 0),
        h: Math.max(maxY - minY, 0),
        filled,
        type,
    };
}

/** 由局部点序列经变换生成 stroke 图元 */
function strokeFromLocalPoints(
    m: Mat,
    localPts: { x: number; y: number }[],
    opts: { closed?: boolean; filled?: boolean; weight?: number; type: string },
): PreviewElement | null {
    if (!localPts.length) return null;
    const pts = localPts.map(p => applyPoint(m, p.x, p.y));
    return {
        kind: 'stroke',
        points: simplifyPoints(pts),
        closed: opts.closed,
        filled: opts.filled,
        weight: opts.weight,
        type: opts.type,
    };
}

function strokeWeight(props: any): number {
    const scale = Number(props?.scale ?? 1) || 1;
    return (STROKE_SIZES[props?.size] ?? STROKE_SIZES.m) * scale;
}

// ==================== 各形状类型 → 图元 ====================

/** draw / highlight：解码每个 segment 的 base64 路径为局部点，乘 scaleX/scaleY */
function buildDrawElements(shape: any, m: Mat): PreviewElement[] {
    const props = shape.props || {};
    const segments = Array.isArray(props.segments) ? props.segments : [];
    const sx = Number(props.scaleX ?? 1) || 1;
    const sy = Number(props.scaleY ?? 1) || 1;
    const weight = strokeWeight(props);
    const closed = !!props.isClosed;
    const filled = closed && !!props.fill && props.fill !== 'none';
    const out: PreviewElement[] = [];
    for (const seg of segments) {
        const path = typeof seg?.path === 'string' ? seg.path : '';
        if (!path) continue;
        let decoded: { x: number; y: number }[] = [];
        try {
            decoded = b64Vecs.decodePoints(path, seg?.dim === 2 ? 2 : 3);
        } catch {
            decoded = [];
        }
        if (!decoded.length) continue;
        const localPts = decoded.map(p => ({ x: (Number(p.x) || 0) * sx, y: (Number(p.y) || 0) * sy }));
        // 多段笔迹（抬笔）分别成条；仅单段时闭合/填充才有意义
        const single = segments.length === 1;
        const el = strokeFromLocalPoints(m, localPts, {
            closed: single && closed,
            filled: single && filled,
            weight,
            type: shape.type,
        });
        if (el) out.push(el);
    }
    return out;
}

/** line：props.points 为 dict，按 fractional index 排序取点 */
function buildLineElement(shape: any, m: Mat): PreviewElement | null {
    const props = shape.props || {};
    const dict = props.points;
    if (!dict || typeof dict !== 'object') return null;
    const arr = (Object.values(dict) as any[])
        .filter(p => p && typeof p.x === 'number' && typeof p.y === 'number')
        .sort((p, q) => String(p.index ?? '').localeCompare(String(q.index ?? '')));
    if (!arr.length) return null;
    return strokeFromLocalPoints(m, arr.map(p => ({ x: p.x, y: p.y })), { weight: strokeWeight(props), type: shape.type });
}

/** arrow：props.start / props.end 两点直线近似（忽略 bend） */
function buildArrowElement(shape: any, m: Mat): PreviewElement | null {
    const props = shape.props || {};
    const s = props.start;
    const e = props.end;
    const localPts: { x: number; y: number }[] = [];
    if (s && typeof s.x === 'number' && typeof s.y === 'number') localPts.push({ x: s.x, y: s.y });
    if (e && typeof e.x === 'number' && typeof e.y === 'number') localPts.push({ x: e.x, y: e.y });
    if (localPts.length < 2) return null;
    return strokeFromLocalPoints(m, localPts, { weight: strokeWeight(props), type: shape.type });
}

/** text：宽=props.w，高按 richText 行数（含按宽折行估算） */
function buildTextElement(shape: any, m: Mat): PreviewElement | null {
    const props = shape.props || {};
    const scale = Number(props.scale ?? 1) || 1;
    const w = (Number(props.w) || 0) * scale;
    if (w <= 0) return null;
    const fontSizePx = (FONT_SIZES[props.size] ?? FONT_SIZES.m) * BASE_FONT_PX;
    const avgCharW = fontSizePx * 0.55;
    const lines = richTextToLines(props.richText, props.text);
    let totalLines = 0;
    for (const ln of lines) {
        totalLines += Math.max(1, Math.ceil((ln.length * avgCharW) / Math.max(w, 1)));
    }
    if (totalLines < 1) totalLines = 1;
    const h = totalLines * fontSizePx * TEXT_LINE_HEIGHT * scale;
    return rectFromLocalBox(m, w, h, false, shape.type);
}

/** note：默认 200×200 + growY（便签为填充块） */
function buildNoteElement(shape: any, m: Mat): PreviewElement | null {
    const props = shape.props || {};
    const scale = Number(props.scale ?? 1) || 1;
    const growY = Number(props.growY) || 0;
    const w = NOTE_BASE * scale;
    const h = (NOTE_BASE + growY) * scale;
    return rectFromLocalBox(m, w, h, true, shape.type);
}

/** geo/image/video/embed/frame/bookmark 及自定义(card/single-block/branch/slide/...)：props.w/h */
function buildBoxElement(shape: any, m: Mat): PreviewElement | null {
    const props = shape.props || {};
    const scale = Number(props.scale ?? 1) || 1;
    const w = Number(props.w ?? props.width ?? 0) || 0;
    let h = Number(props.h ?? props.height ?? 0) || 0;
    if (w <= 0 || h <= 0) return null;
    const growY = Number(props.growY) || 0;
    h += growY;
    const type = String(shape.type || '');
    const mediaLike = type === 'image' || type === 'video' || type === 'embed';
    const filled = mediaLike || (!!props.fill && props.fill !== 'none');
    return rectFromLocalBox(m, w * scale, h * scale, filled, type);
}

/** 单个形状 → 图元数组（group 跳过自身，由子形状贡献几何） */
function buildShapeElements(shape: any, m: Mat): PreviewElement[] {
    const type = String(shape?.type || '');
    switch (type) {
        case 'draw':
        case 'highlight':
            return buildDrawElements(shape, m);
        case 'line': {
            const el = buildLineElement(shape, m);
            return el ? [el] : [];
        }
        case 'arrow': {
            const el = buildArrowElement(shape, m);
            return el ? [el] : [];
        }
        case 'text': {
            const el = buildTextElement(shape, m);
            return el ? [el] : [];
        }
        case 'note': {
            const el = buildNoteElement(shape, m);
            return el ? [el] : [];
        }
        case 'group':
            return [];
        default: {
            const box = buildBoxElement(shape, m);
            if (box) return [box];
            // 未知形状若含点集（如自定义连线），退回按 line 处理
            const asLine = buildLineElement(shape, m);
            return asLine ? [asLine] : [];
        }
    }
}

// ==================== 对外接口 ====================

/**
 * 读取并解析白板数据文件，重建为「页面绝对坐标」的预览图元列表。
 * 处理全部形状以获得正确包围盒，但元素总数受 MAX_PREVIEW_ELEMENTS 限制（每条笔迹点数亦受控）。
 */
export async function fetchWhiteboardElements(path: string): Promise<PreviewElement[]> {
    const raw = await api.getFile(path);
    const json = parseJson(raw);
    const store = pickStore(json);
    if (!store) return [];

    const byId = new Map<string, any>();
    const shapes: any[] = [];
    for (const [key, rec] of Object.entries(store)) {
        if (!isShapeRecord(rec, key)) continue;
        const id = typeof (rec as any).id === 'string' ? (rec as any).id : key;
        byId.set(id, rec);
        shapes.push(rec);
    }
    if (shapes.length === 0) return [];

    const resolve = buildTransformResolver(byId);
    const elements: PreviewElement[] = [];
    for (const shape of shapes) {
        if (elements.length >= MAX_PREVIEW_ELEMENTS) break;
        let m: Mat;
        try {
            m = resolve(shape);
        } catch {
            m = shapeLocalMatrix(shape);
        }
        const built = buildShapeElements(shape, m);
        for (const el of built) {
            if (elements.length >= MAX_PREVIEW_ELEMENTS) break;
            elements.push(el);
        }
    }
    return elements;
}
