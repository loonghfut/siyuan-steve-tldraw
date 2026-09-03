/**
 * 白板缩略图数据加载：读取数据文件并解析形状列表。
 * Dock 面板与高级管理面板共用。
 */
import { api } from '@frostime/siyuan-plugin-kits';
import type { PreviewShape } from './whiteboard-utils';

// 最多采样的形状数量，避免超大画板拖慢缩略图生成
const MAX_SAMPLE_SHAPES = 120;
const FALLBACK_SHAPE_W = 100;
const FALLBACK_SHAPE_H = 60;

function normalizeShape(id: string, data: any): PreviewShape {
    const px = typeof data?.x === 'number' ? data.x : (data?.props?.x ?? 0);
    const py = typeof data?.y === 'number' ? data.y : (data?.props?.y ?? 0);
    const w = Number(data?.props?.w ?? data?.props?.width ?? data?.width ?? 0) || FALLBACK_SHAPE_W;
    const h = Number(data?.props?.h ?? data?.props?.height ?? data?.height ?? 0) || FALLBACK_SHAPE_H;
    return { id, type: data?.type || data?.typeName || 'shape', x: px, y: py, w, h };
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

function isShapeEntry(value: any): boolean {
    const vv: any = value;
    return !!(vv && (vv.type === 'shape' || vv.typeName === 'shape' || typeof vv.type === 'string'));
}

/**
 * 读取并解析白板数据文件，返回用于缩略图投影的形状列表（最多采样 120 个）。
 * 兼容 document.shapes 与 tldraw store 两种存储结构；都找不到时对整个文档深度探测。
 */
export async function fetchWhiteboardShapes(path: string): Promise<PreviewShape[]> {
    const raw = await api.getFile(path);
    const json = parseJson(raw);
    const doc = json?.document ?? json;

    let entries: Array<[string, any]> = [];
    if (doc?.shapes && typeof doc.shapes === 'object') {
        entries = Object.entries(doc.shapes);
    } else if (doc?.store && typeof doc.store === 'object') {
        entries = Object.entries(doc.store).filter(([k, v]) => {
            if (typeof k === 'string' && k.startsWith('shape:')) return true;
            return isShapeEntry(v);
        });
    }

    const shapes: PreviewShape[] = [];
    for (const [sid, s] of entries.slice(0, MAX_SAMPLE_SHAPES)) {
        shapes.push(normalizeShape(sid, s));
    }

    if (shapes.length === 0) {
        const fallback: Array<[string, any]> = [];
        const visit = (o: any) => {
            if (!o || typeof o !== 'object' || fallback.length >= MAX_SAMPLE_SHAPES) return;
            for (const [k, v] of Object.entries(o)) {
                if (fallback.length >= MAX_SAMPLE_SHAPES) break;
                const vv: any = v;
                if (!vv || typeof vv !== 'object') continue;
                // 识别含有尺寸或坐标的对象作为 shape 候选
                if ((vv.props && (vv.props.w || vv.props.width || vv.props.h || vv.props.height)) || vv.x || vv.y || vv.width || vv.height) {
                    fallback.push([k, vv]);
                } else {
                    visit(vv);
                }
            }
        };
        visit(doc);
        for (const [sid, s] of fallback) {
            shapes.push(normalizeShape(sid, s));
        }
    }

    return shapes;
}
