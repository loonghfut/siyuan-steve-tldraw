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

// ==================== 连接线（箭头 / 贝塞尔连接器） ====================
// 绑定的连接线端点由 binding + 目标形状决定，props.start/end 仅在未绑定时有效（且可能已过期）。
// 预览无 editor，故用目标形状的页面包围盒近似端口/锚点位置。

/** 形状的页面包围盒 */
interface PageBounds { minX: number; minY: number; maxX: number; maxY: number; }
/** 按连接线 fromId 归组的 binding：{start,end} */
type BindingMap = Map<string, { start?: any; end?: any }>;

function clampNum(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

function anchorPoint(b: PageBounds, nx: number, ny: number): { x: number; y: number } {
    return { x: b.minX + nx * (b.maxX - b.minX), y: b.minY + ny * (b.maxY - b.minY) };
}

function centerPoint(b: PageBounds): { x: number; y: number } {
    return anchorPoint(b, 0.5, 0.5);
}

/** 把图元的范围并入包围盒 */
function expandBounds(bb: PageBounds, el: PreviewElement): void {
    if (el.kind === 'rect') {
        const x = el.x ?? 0, y = el.y ?? 0, w = el.w ?? 0, h = el.h ?? 0;
        if (x < bb.minX) bb.minX = x;
        if (y < bb.minY) bb.minY = y;
        if (x + w > bb.maxX) bb.maxX = x + w;
        if (y + h > bb.maxY) bb.maxY = y + h;
    } else if (el.points) {
        for (const p of el.points) {
            if (p.x < bb.minX) bb.minX = p.x;
            if (p.y < bb.minY) bb.minY = p.y;
            if (p.x > bb.maxX) bb.maxX = p.x;
            if (p.y > bb.maxY) bb.maxY = p.y;
        }
    }
}

/** 端口方向 → 归一化锚点（input=左/output=右/top=上/bottom=下，见 shape-ports） */
const PORT_ANCHOR: Record<string, [number, number]> = {
    input: [0, 0.5], left: [0, 0.5],
    output: [1, 0.5], right: [1, 0.5],
    top: [0.5, 0], bottom: [0.5, 1],
};

/** 提取端口方向：mind-map 端口形如 'nodeId:direction'，取最后一段 */
function portDirection(portId?: string | null): string | null {
    if (!portId) return null;
    if (portId.includes(':')) return portId.split(':').pop() || null;
    return portId;
}

/** auto 端口：按目标中心与对侧锚点的相对方位选边（对齐 resolveAutoPortId） */
function resolveAutoDir(targetCenter: { x: number; y: number }, opposite: { x: number; y: number }): string {
    const dx = opposite.x - targetCenter.x;
    const dy = opposite.y - targetCenter.y;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'output' : 'input';
    return dy >= 0 ? 'bottom' : 'top';
}

/** 未绑定端点：props 局部坐标经形状变换到页面空间 */
function localPropPoint(shape: any, m: Mat, terminal: 'start' | 'end'): { x: number; y: number } | null {
    const local = terminal === 'start' ? shape?.props?.start : shape?.props?.end;
    if (local && typeof local.x === 'number' && typeof local.y === 'number') {
        return applyPoint(m, local.x, local.y);
    }
    return null;
}

/** 箭头端点（页面空间）：绑定→目标包围盒锚点（precise 用 normalizedAnchor，否则中心）；未绑定→props */
function resolveArrowTerminal(
    shape: any, m: Mat, binding: any, shapeBounds: Map<string, PageBounds>, terminal: 'start' | 'end',
): { x: number; y: number } | null {
    if (binding && typeof binding.toId === 'string') {
        const b = shapeBounds.get(binding.toId);
        if (b) {
            const p = binding.props;
            let nx = 0.5, ny = 0.5;
            if (p?.isPrecise && p?.normalizedAnchor && typeof p.normalizedAnchor.x === 'number' && typeof p.normalizedAnchor.y === 'number') {
                nx = clampNum(p.normalizedAnchor.x, 0, 1);
                ny = clampNum(p.normalizedAnchor.y, 0, 1);
            }
            return anchorPoint(b, nx, ny);
        }
    }
    return localPropPoint(shape, m, terminal);
}

/** 箭头：两端解析为页面点后连成直线（忽略 bend/elbow 路由，缩略图级别足够） */
function buildArrowElementBound(
    shape: any, m: Mat, bindings: BindingMap, shapeBounds: Map<string, PageBounds>,
): PreviewElement[] {
    const b = bindings.get(shape.id) || {};
    const s = resolveArrowTerminal(shape, m, b.start, shapeBounds, 'start');
    const e = resolveArrowTerminal(shape, m, b.end, shapeBounds, 'end');
    if (!s || !e || (s.x === e.x && s.y === e.y)) return [];
    return [{ kind: 'stroke', points: [s, e], weight: strokeWeight(shape.props || {}), type: 'arrow' }];
}

/** 三次贝塞尔控制点（对齐 BezierConnectorShapeUtil.getConnectionControlPoints 的启发式） */
function connectionControlPoints(
    start: { x: number; y: number }, end: { x: number; y: number }, startDir: string | null, endDir: string | null,
): [{ x: number; y: number }, { x: number; y: number }] {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const isV = (d: string | null) => d === 'top' || d === 'bottom';
    const isH = (d: string | null) => d === 'input' || d === 'output' || d === 'left' || d === 'right';
    const offsetAlong = (fwd: number, cross: number) =>
        fwd >= 0 ? clampNum(fwd * 0.5 + Math.abs(cross) * 0.1, 40, 250) : clampNum(Math.abs(fwd) * 0.25 + 60, 60, 180);
    const computeCp = (point: { x: number; y: number }, horizontal: boolean, vertical: boolean, dir: string | null, towardX: number, towardY: number) => {
        if (horizontal) {
            const sign = (dir === 'input' || dir === 'left') ? -1 : 1;
            return { x: point.x + sign * offsetAlong(towardX * sign, towardY), y: point.y };
        }
        if (vertical) {
            const sign = dir === 'top' ? -1 : 1;
            return { x: point.x, y: point.y + sign * offsetAlong(towardY * sign, towardX) };
        }
        if (Math.abs(towardX) >= Math.abs(towardY)) {
            const sign = towardX >= 0 ? 1 : -1;
            return { x: point.x + sign * clampNum(Math.abs(towardX) * 0.5, 40, 250), y: point.y };
        }
        const sign = towardY >= 0 ? 1 : -1;
        return { x: point.x, y: point.y + sign * clampNum(Math.abs(towardY) * 0.5, 40, 250) };
    };
    return [
        computeCp(start, isH(startDir), isV(startDir), startDir, dx, dy),
        computeCp(end, isH(endDir), isV(endDir), endDir, -dx, -dy),
    ];
}

/** 采样三次贝塞尔为折线点 */
function sampleCubic(
    p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, n: number,
): { x: number; y: number }[] {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n, mt = 1 - t;
        const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
        pts.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
    }
    return pts;
}

/** 贝塞尔连接器：解析两端端口→控制点→采样为折线 */
function buildBezierElement(
    shape: any, m: Mat, bindings: BindingMap, shapeBounds: Map<string, PageBounds>,
): PreviewElement[] {
    const props = shape.props || {};
    const b = bindings.get(shape.id) || {};
    // 先求两端粗略点（绑定→目标中心；未绑定→props），用于 auto 端口换边判定
    const rough = (binding: any, terminal: 'start' | 'end'): { x: number; y: number } | null => {
        if (binding && typeof binding.toId === 'string') {
            const bb = shapeBounds.get(binding.toId);
            if (bb) return centerPoint(bb);
        }
        return localPropPoint(shape, m, terminal);
    };
    const roughStart = rough(b.start, 'start');
    const roughEnd = rough(b.end, 'end');

    const resolveTerminal = (
        binding: any, terminal: 'start' | 'end', opposite: { x: number; y: number } | null,
    ): { point: { x: number; y: number } | null; dir: string | null } => {
        if (binding && typeof binding.toId === 'string') {
            const bb = shapeBounds.get(binding.toId);
            if (bb) {
                const rawPort = binding.props?.portId;
                let dir = portDirection(rawPort);
                if (!dir || rawPort === 'auto') {
                    dir = opposite ? resolveAutoDir(centerPoint(bb), opposite) : 'output';
                }
                const anchor = PORT_ANCHOR[dir] || [0.5, 0.5];
                return { point: anchorPoint(bb, anchor[0], anchor[1]), dir };
            }
        }
        return { point: localPropPoint(shape, m, terminal), dir: null };
    };

    const S = resolveTerminal(b.start, 'start', roughEnd);
    const E = resolveTerminal(b.end, 'end', roughStart);
    if (!S.point || !E.point) return [];
    const [cp1, cp2] = connectionControlPoints(S.point, E.point, S.dir, E.dir);
    const pts = sampleCubic(S.point, cp1, cp2, E.point, 24);
    const weight = Number(props.strokeWidth) || 2;
    return [{ kind: 'stroke', points: simplifyPoints(pts), weight, type: 'bezier-connector' }];
}

/** 从 store 收集 binding 记录，按 fromId 归组为 {start,end} */
function collectBindings(store: Record<string, any>): BindingMap {
    const map: BindingMap = new Map();
    for (const rec of Object.values(store)) {
        if (!rec || typeof rec !== 'object' || rec.typeName !== 'binding') continue;
        const fromId = rec.fromId;
        const terminal = rec.props?.terminal;
        if (typeof fromId !== 'string' || (terminal !== 'start' && terminal !== 'end')) continue;
        let entry = map.get(fromId);
        if (!entry) { entry = {}; map.set(fromId, entry); }
        entry[terminal] = rec;
    }
    return map;
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

    const bindings = collectBindings(store);
    const resolve = buildTransformResolver(byId);

    const transformOf = (shape: any): Mat => {
        try {
            return resolve(shape);
        } catch {
            return shapeLocalMatrix(shape);
        }
    };

    // 连接线（箭头/贝塞尔）延后处理：其端点依赖其它形状的页面包围盒
    const CONNECTOR_TYPES = new Set(['arrow', 'bezier-connector']);
    const normalShapes: any[] = [];
    const connectors: any[] = [];
    for (const s of shapes) {
        if (CONNECTOR_TYPES.has(String(s?.type || ''))) connectors.push(s);
        else normalShapes.push(s);
    }

    const shapeBounds = new Map<string, PageBounds>();
    const elements: PreviewElement[] = [];
    // 为连接线预留名额，避免普通形状填满上限后连接线被截掉
    const shapeCap = Math.max(0, MAX_PREVIEW_ELEMENTS - connectors.length);

    for (const shape of normalShapes) {
        if (elements.length >= shapeCap) break;
        const m = transformOf(shape);
        const built = buildShapeElements(shape, m);
        if (!built.length) continue;
        // 记录该形状的页面包围盒，供连接线端点解析
        const id = typeof shape?.id === 'string' ? shape.id : undefined;
        if (id) {
            let bb = shapeBounds.get(id);
            if (!bb) {
                bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
                shapeBounds.set(id, bb);
            }
            for (const el of built) expandBounds(bb, el);
        }
        for (const el of built) {
            if (elements.length >= shapeCap) break;
            elements.push(el);
        }
    }

    for (const shape of connectors) {
        const m = transformOf(shape);
        const built = String(shape?.type) === 'arrow'
            ? buildArrowElementBound(shape, m, bindings, shapeBounds)
            : buildBezierElement(shape, m, bindings, shapeBounds);
        for (const el of built) elements.push(el);
    }

    return elements;
}
