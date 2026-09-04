/**
 * 白板列表共享控制器
 *
 * dock 卡片面板与高级管理面板此前各有约 700 行近乎重复的逻辑（加载/过滤/排序/
 * 分组/选择/预览/增删改），且数据模型分裂、排序语义不一致、管理器串行加载。
 * 本控制器把这些逻辑收敛为单一实现：
 *  - 并发抓取元数据（修复管理器 2N 次串行往返）
 *  - 元数据一次性加载 + 渲染分批（renderLimit）解耦"数据完整性"与"DOM 成本"
 *  - 预览状态独立于列表 store（局部更新，避免整表重排/重渲染）
 *  - 单个 IntersectionObserver 绑定面板滚动根（不再 document.querySelector）
 *  - 删除改为移入回收站（可恢复），标签编辑就地更新（不整表重载）
 *
 * Svelte 4：状态以 writable/derived store 暴露，面板解构后用 $store 订阅。
 */
import { writable, derived, get } from 'svelte/store';
import type { Writable, Readable } from 'svelte/store';
import { openTab, showMessage, confirm } from 'siyuan';
import type { Plugin } from 'siyuan';
import { api } from '@frostime/siyuan-plugin-kits';
import type { WhiteboardEntry, PreviewShape, ProjectedRect } from '../utils/whiteboard-utils';
import {
    createBaseEntry,
    resolveEntryTitle,
    computeUpdatedAt,
    computeCreatedAt,
    sortEntries,
    entryMatchesQuery,
    parseSyTimestamp,
    parseBlockTags,
    extractDrawingId,
    projectAllShapes,
    SVG_PAD,
} from '../utils/whiteboard-utils';
import { fetchWhiteboardShapes } from '../utils/whiteboard-preview';
import { whiteboardSortKey } from './whiteboard-view-prefs';
import { WhiteboardFileManager, WHITEBOARD_TRASH_DIR } from '../whiteboard-file-manager';
import { closeTab } from '../tldraw-instance-manager';
import { whiteboardFilesUpdated } from '../whiteboards.store';

/** 白板数据文件所在目录 */
const STORAGE_DIR = '/data/storage/petal/sttools/';
/** 首批渲染数量，同时也是每次"加载更多"的增量 */
const RENDER_BATCH = 40;
/** 元数据并发抓取的工作线程数 */
const META_CONCURRENCY = 8;

export type WhiteboardPanelMode = 'dock' | 'manager';

export interface ViewSection {
    key: string;
    name?: string;
    items: WhiteboardEntry[];
}

/** 单个白板的预览状态（与列表数据解耦，局部更新） */
export interface PreviewState {
    loading: boolean;
    loaded: boolean;
    shapes: PreviewShape[];
    rects?: ProjectedRect[];
    error?: string;
}

const EMPTY_PREVIEW: PreviewState = {
    loading: false,
    loaded: false,
    shapes: [],
    rects: undefined,
    error: undefined,
};

function buildSections(items: WhiteboardEntry[], groupByTag: boolean): ViewSection[] {
    if (!groupByTag) return [{ key: 'all', items }];
    const map = new Map<string, WhiteboardEntry[]>();
    for (const item of items) {
        if (item.tags.length === 0) {
            const bucket = map.get('未分组') || [];
            bucket.push(item);
            map.set('未分组', bucket);
        } else {
            for (const tag of item.tags) {
                const bucket = map.get(tag) || [];
                bucket.push(item);
                map.set(tag, bucket);
            }
        }
    }
    return Array.from(map.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, list]) => ({ key: 'tag:' + name, name, items: list }));
}

export class WhiteboardListController {
    readonly mode: WhiteboardPanelMode;
    readonly selectable: boolean;
    private plugin: Plugin;

    // ==================== 列表数据 ====================
    /** 全部条目（已并发抓取元数据、按当前 sortKey 由 visible 派生排序） */
    readonly entries: Writable<WhiteboardEntry[]> = writable([]);
    /** 初始加载（含元数据抓取）中 */
    readonly loading: Writable<boolean> = writable(true);

    // ==================== 过滤 / 分组状态 ====================
    readonly query: Writable<string> = writable('');
    readonly onlyValid: Writable<boolean> = writable(true);
    readonly tagFilter: Writable<string> = writable('');
    readonly groupByTag: Writable<boolean> = writable(false);
    /** 当前渲染上限（分批渲染，滚动递增） */
    readonly renderLimit: Writable<number> = writable(RENDER_BATCH);

    // ==================== 派生视图 ====================
    readonly visible: Readable<WhiteboardEntry[]>;
    /** visible 中当前应渲染的部分（受 renderLimit 限制，滚动递增） */
    readonly rendered: Readable<WhiteboardEntry[]>;
    readonly sections: Readable<ViewSection[]>;
    readonly hasMore: Readable<boolean>;
    readonly availableTags: Readable<string[]>;

    // ==================== 选择状态 ====================
    readonly selection: Writable<Set<string>> = writable(new Set());
    readonly selectedEntries: Readable<WhiteboardEntry[]>;
    readonly visibleSelectedCount: Readable<number>;
    private lastSelectedId: string | null = null;

    // ==================== 预览 ====================
    private previewStores = new Map<string, Writable<PreviewState>>();
    private previewLoading = new Set<string>();
    private observer?: IntersectionObserver;
    private sentinelObserver?: IntersectionObserver;
    private scrollRoot: HTMLElement | null = null;
    /** 已交给观察器的预览节点（滚动根就绪后需重建并重新观察） */
    private previewNodes = new Map<HTMLElement, { id: string; path: string }>();
    private sentinelNode: HTMLElement | null = null;

    private unsubs: Array<() => void> = [];

    constructor(options: { plugin: Plugin; mode: WhiteboardPanelMode; selectable?: boolean }) {
        this.plugin = options.plugin;
        this.mode = options.mode;
        this.selectable = !!options.selectable;

        this.visible = derived(
            [this.entries, this.query, this.onlyValid, this.tagFilter, whiteboardSortKey],
            ([entries, query, onlyValid, tagFilter, sortKey]: [WhiteboardEntry[], string, boolean, string, string]) => {
                let list = entries;
                if (onlyValid) list = list.filter(e => e.exists);
                if (tagFilter) list = list.filter(e => e.tags.includes(tagFilter));
                if (query.trim()) list = list.filter(e => entryMatchesQuery(e, query));
                return sortEntries(list, sortKey);
            }
        );

        this.rendered = derived(
            [this.visible, this.renderLimit],
            ([visible, limit]: [WhiteboardEntry[], number]) => visible.slice(0, limit)
        );

        this.sections = derived(
            [this.rendered, this.groupByTag],
            ([rendered, group]: [WhiteboardEntry[], boolean]) => buildSections(rendered, group)
        );

        this.hasMore = derived(
            [this.visible, this.renderLimit],
            ([visible, limit]: [WhiteboardEntry[], number]) => limit < visible.length
        );

        this.availableTags = derived(this.entries, (entries: WhiteboardEntry[]) => {
            const set = new Set<string>();
            for (const e of entries) for (const t of e.tags) set.add(t);
            return Array.from(set).sort((a, b) => a.localeCompare(b));
        });

        this.selectedEntries = derived(
            [this.entries, this.selection],
            ([entries, sel]: [WhiteboardEntry[], Set<string>]) => (sel.size ? entries.filter(e => sel.has(e.id)) : [])
        );

        this.visibleSelectedCount = derived(
            [this.visible, this.selection],
            ([visible, sel]: [WhiteboardEntry[], Set<string>]) => (sel.size ? visible.filter(e => sel.has(e.id)).length : 0)
        );

        // 过滤条件变化时重置渲染分批，新结果从小批开始按需增长
        this.unsubs.push(this.query.subscribe(() => this.renderLimit.set(RENDER_BATCH)));
        this.unsubs.push(this.onlyValid.subscribe(() => this.renderLimit.set(RENDER_BATCH)));
        this.unsubs.push(this.tagFilter.subscribe(() => this.renderLimit.set(RENDER_BATCH)));

        // 条目变化时清理已失效的选择
        this.unsubs.push(this.entries.subscribe(entries => {
            const sel = get(this.selection);
            if (sel.size === 0) return;
            const valid = new Set(entries.map(e => e.id));
            let changed = false;
            const next = new Set<string>();
            sel.forEach(id => { if (valid.has(id)) next.add(id); else changed = true; });
            if (changed) this.selection.set(next);
        }));

        // 跨面板同步：任一面板删除/刷新时，其它面板局部更新而非整表重载
        this.unsubs.push(whiteboardFilesUpdated.subscribe(evt => {
            if (!evt || !evt.timestamp) return; // 忽略初始值
            if (evt.action === 'delete') {
                this.entries.update(list => list.filter(e => {
                    if (evt.fileName && e.fileName === evt.fileName) return false;
                    if (evt.drawingId && e.id === evt.drawingId) return false;
                    return true;
                }));
            } else if (evt.action === 'refresh') {
                void this.load();
            }
        }));
    }

    // ==================== 加载 ====================
    async load(): Promise<void> {
        this.loading.set(true);
        try {
            const files = (await api.readDir(STORAGE_DIR)) as any[];
            const metas: WhiteboardEntry[] = files
                .filter(f => !f.isDir && typeof f.name === 'string' && f.name.startsWith('tldraw-data-') && f.name.endsWith('.json'))
                .map(f => createBaseEntry({
                    id: extractDrawingId(f.name),
                    fileName: f.name,
                    path: STORAGE_DIR + f.name,
                    fileMtime: parseSyTimestamp(f.mtime),
                }));
            // 并发抓取全部元数据（修复管理器串行 2N 往返）
            await this.fetchAllMetas(metas, META_CONCURRENCY);
            this.entries.set(metas);
            this.renderLimit.set(RENDER_BATCH);
        } catch (e) {
            console.error('加载白板列表失败:', e);
            showMessage('加载白板列表失败', 4000, 'error');
            this.entries.set([]);
        } finally {
            this.loading.set(false);
        }
    }

    private async fetchAllMetas(list: WhiteboardEntry[], concurrency: number): Promise<void> {
        let cursor = 0;
        const total = list.length;
        const workers: Promise<void>[] = [];
        const workerCount = Math.max(1, Math.min(concurrency, total));
        for (let w = 0; w < workerCount; w++) {
            workers.push((async () => {
                while (cursor < total) {
                    const idx = cursor++;
                    await this.fetchEntryMeta(list[idx]);
                }
            })());
        }
        await Promise.all(workers);
    }

    private async fetchEntryMeta(entry: WhiteboardEntry): Promise<void> {
        const id = entry.id;
        try {
            if (!id || id === '未知画板') {
                entry.exists = false;
                entry.title = 'ID 无法解析';
                return;
            }
            const blk = await api.getBlockByID(id);
            if (!blk) {
                entry.exists = false;
                entry.title = '无关联块';
                return;
            }
            entry.exists = true;
            entry.blkCreated = parseSyTimestamp(blk.created);
            entry.blkUpdated = parseSyTimestamp(blk.updated);
            entry.tags = parseBlockTags((blk as any).tag);
            entry.docId = blk.root_id || undefined;
            if (blk.root_id) {
                try {
                    const docBlk = await api.getBlockByID(blk.root_id);
                    if (docBlk) {
                        entry.title = resolveEntryTitle(docBlk as any);
                        entry.docCreated = parseSyTimestamp(docBlk.created);
                        entry.docUpdated = parseSyTimestamp(docBlk.updated);
                    }
                } catch { /* 文档信息缺失不影响主条目 */ }
            }
        } catch (e) {
            console.warn('抓取白板元数据失败:', entry.fileName, e);
            entry.exists = false;
        } finally {
            entry.updatedAt = computeUpdatedAt(entry);
            entry.createdAt = computeCreatedAt(entry);
        }
    }

    loadMore = (): void => {
        if (!get(this.hasMore)) return;
        this.renderLimit.update(n => n + RENDER_BATCH);
    };

    // ==================== 预览 ====================
    /** 取某白板独立的预览 store（供列表项组件订阅，局部更新） */
    previewStore(id: string): Writable<PreviewState> {
        let store = this.previewStores.get(id);
        if (!store) {
            store = writable<PreviewState>({ ...EMPTY_PREVIEW });
            this.previewStores.set(id, store);
        }
        return store;
    }

    loadPreview(id: string, path: string): void {
        if (this.previewLoading.has(id)) return;
        const store = this.previewStore(id);
        const state = get(store);
        if (state.loaded || state.loading) return;
        this.previewLoading.add(id);
        store.set({ ...state, loading: true });
        fetchWhiteboardShapes(path)
            .then(shapes => {
                const rects = projectAllShapes(shapes, 300, 200, SVG_PAD);
                store.set({ loading: false, loaded: true, shapes, rects, error: undefined });
            })
            .catch(err => {
                console.warn('缩略图加载失败:', err);
                store.set({ loading: false, loaded: true, shapes: [], rects: undefined, error: '预览失败' });
            })
            .finally(() => { this.previewLoading.delete(id); });
    }

    private resetPreview(id: string): void {
        const store = this.previewStores.get(id);
        if (store) store.set({ ...EMPTY_PREVIEW });
        this.previewLoading.delete(id);
    }

    /**
     * 面板绑定滚动容器：作为 IntersectionObserver 的 root（避免全局 querySelector）。
     * Svelte 中子元素的 action 先于父层响应式语句执行，因此观察器可能先以 root=null
     * 创建；此处变更 root 时重建观察器并重新观察所有已跟踪节点，保证不丢观察。
     */
    attachScrollRoot(el: HTMLElement | null): void {
        if (this.scrollRoot === el) return;
        this.scrollRoot = el;
        this.rebuildObservers();
    }

    private rebuildObservers(): void {
        if (this.observer) { try { this.observer.disconnect(); } catch { /* ignore */ } this.observer = undefined; }
        if (this.sentinelObserver) { try { this.sentinelObserver.disconnect(); } catch { /* ignore */ } this.sentinelObserver = undefined; }
        if (this.previewNodes.size > 0) {
            const observer = this.ensureObserver();
            this.previewNodes.forEach((info, node) => {
                (node as any).__wbPreview = info;
                try { observer.observe(node); } catch { /* ignore */ }
            });
        }
        if (this.sentinelNode) {
            const observer = this.ensureSentinelObserver();
            try { observer.observe(this.sentinelNode); } catch { /* ignore */ }
        }
    }

    private ensureObserver(): IntersectionObserver {
        if (this.observer) return this.observer;
        this.observer = new IntersectionObserver(ioEntries => {
            for (const e of ioEntries) {
                if (e.isIntersecting) {
                    const info = (e.target as any).__wbPreview as { id: string; path: string } | undefined;
                    if (info) this.loadPreview(info.id, info.path);
                    try { this.observer?.unobserve(e.target); } catch { /* ignore */ }
                }
            }
        }, { root: this.scrollRoot, rootMargin: '320px 0px 320px 0px', threshold: 0.05 });
        return this.observer;
    }

    private ensureSentinelObserver(): IntersectionObserver {
        if (this.sentinelObserver) return this.sentinelObserver;
        this.sentinelObserver = new IntersectionObserver(ioEntries => {
            for (const e of ioEntries) if (e.isIntersecting) this.loadMore();
        }, { root: this.scrollRoot, rootMargin: '400px 0px 400px 0px', threshold: 0.01 });
        return this.sentinelObserver;
    }

    /** Svelte action：把预览节点交给懒加载观察器 */
    observePreview = (node: HTMLElement, info: { id: string; path: string }) => {
        this.previewNodes.set(node, info);
        const observer = this.ensureObserver();
        (node as any).__wbPreview = info;
        try { observer.observe(node); } catch { /* ignore */ }
        return {
            update: (newInfo: { id: string; path: string }) => {
                this.previewNodes.set(node, newInfo);
                (node as any).__wbPreview = newInfo;
                try { this.ensureObserver().observe(node); } catch { /* ignore */ }
            },
            destroy: () => {
                this.previewNodes.delete(node);
                try { this.observer?.unobserve(node); } catch { /* ignore */ }
            },
        };
    };

    /** Svelte action：触底哨兵，进入视口即加载下一批 */
    observeSentinel = (node: HTMLElement) => {
        this.sentinelNode = node;
        const observer = this.ensureSentinelObserver();
        try { observer.observe(node); } catch { /* ignore */ }
        return {
            destroy: () => {
                if (this.sentinelNode === node) this.sentinelNode = null;
                try { this.sentinelObserver?.unobserve(node); } catch { /* ignore */ }
            },
        };
    };

    // ==================== 选择 ====================
    toggleSelect(entry: WhiteboardEntry, checked?: boolean, useRange = false): void {
        if (!this.selectable) return;
        const sel = new Set(get(this.selection));
        const shouldSelect = typeof checked === 'boolean' ? checked : !sel.has(entry.id);
        if (useRange && this.lastSelectedId) {
            const ids = get(this.visible).map(e => e.id);
            const start = ids.indexOf(this.lastSelectedId);
            const end = ids.indexOf(entry.id);
            if (start !== -1 && end !== -1) {
                const [lo, hi] = start <= end ? [start, end] : [end, start];
                for (let i = lo; i <= hi; i++) {
                    if (shouldSelect) sel.add(ids[i]);
                    else sel.delete(ids[i]);
                }
            }
        }
        if (shouldSelect) sel.add(entry.id);
        else sel.delete(entry.id);
        this.selection.set(sel);
        this.lastSelectedId = entry.id;
    }

    selectAllVisible(): void {
        const sel = new Set(get(this.selection));
        get(this.visible).forEach(e => sel.add(e.id));
        this.selection.set(sel);
    }

    clearSelection(): void {
        this.selection.set(new Set());
        this.lastSelectedId = null;
    }

    // ==================== 动作 ====================
    async openBoard(entry: WhiteboardEntry): Promise<void> {
        if (!entry.exists) {
            showMessage('该白板块不存在，无法打开', 3000, 'error');
            return;
        }
        try {
            await openTab({
                app: this.plugin.app,
                custom: {
                    id: this.plugin.name + 'steveTool-whiteboard',
                    title: entry.title,
                    icon: 'iconSTWhiteboard',
                    data: { text: 'steveTool-whiteboard' + entry.id, rootid: entry.id },
                },
            });
        } catch (e) {
            console.error('打开白板失败:', e);
            showMessage('打开白板失败', 3000, 'error');
        }
    }

    async openDoc(entry: WhiteboardEntry): Promise<void> {
        if (!entry.docId) {
            showMessage('未找到关联文档', 3000, 'info');
            return;
        }
        try {
            await openTab({
                app: this.plugin.app,
                doc: { id: entry.docId, action: ['cb-get-hl', 'cb-get-all'], zoomIn: false },
                keepCursor: false,
            });
        } catch (e) {
            console.error('打开文档失败:', e);
            showMessage('打开文档失败', 3000, 'error');
        }
    }

    async refresh(entry: WhiteboardEntry): Promise<void> {
        try {
            const target: WhiteboardEntry = { ...entry, tags: entry.tags.slice() };
            await this.fetchEntryMeta(target);
            this.entries.update(list => list.map(e => (e.id === target.id ? target : e)));
            this.resetPreview(target.id);
            this.loadPreview(target.id, target.path);
            showMessage('已刷新', 1500, 'info');
        } catch (e) {
            console.error('刷新白板失败:', e);
            showMessage('刷新失败', 2000, 'error');
        }
    }

    async backup(entries: WhiteboardEntry[]): Promise<void> {
        if (!entries.length) return;
        try {
            const results = await WhiteboardFileManager.batchBackupWhiteboards(
                entries.map(e => e.id),
                { reason: '手动备份', includeTimestamp: true }
            );
            const stats = WhiteboardFileManager.getOperationStats(results);
            if (stats.success > 0) {
                showMessage(`已备份 ${stats.success}/${entries.length} 个白板到 ${WHITEBOARD_TRASH_DIR}`, 3000, 'info');
            } else {
                showMessage('备份失败', 3000, 'error');
            }
        } catch (e) {
            console.error('备份失败:', e);
            showMessage('备份失败', 3000, 'error');
        }
    }

    /**
     * 删除 = 移入回收站（可在备份管理中恢复），替代此前的永久删除 + 2 秒补删 hack。
     * 先关闭对应页签，避免 tldraw 自动保存把文件写回。
     */
    remove(entries: WhiteboardEntry[], onDone?: () => void): void {
        if (!entries.length) return;
        const title = entries.length === 1
            ? `确定要将白板 "${entries[0].title}" 移入回收站吗？可在「备份管理」中恢复。`
            : `确定要将选中的 ${entries.length} 个白板移入回收站吗？可在「备份管理」中恢复。`;
        confirm(
            '移入回收站',
            title,
            async (dialog) => {
                let success = 0;
                for (const entry of entries) {
                    try {
                        closeTab(entry.id, 'user-delete');
                        const res = await WhiteboardFileManager.deleteWhiteboardFile(entry.id, {
                            reason: '删除',
                            includeTimestamp: true,
                        });
                        if (res.success) {
                            success++;
                            whiteboardFilesUpdated.set({
                                action: 'delete',
                                fileName: entry.fileName,
                                drawingId: entry.id,
                                timestamp: Date.now(),
                            });
                        } else {
                            console.error('移入回收站失败:', entry.fileName, res.error);
                        }
                    } catch (e) {
                        console.error('删除失败:', entry.fileName, e);
                    }
                }
                // 本地立即移除（订阅亦会处理，此处保证即时性）
                const ids = new Set(entries.map(e => e.id));
                this.entries.update(list => list.filter(e => !ids.has(e.id)));
                showMessage(`已移入回收站 ${success}/${entries.length} 个白板`, 3000, 'info');
                onDone?.();
                try { (dialog as any)?.close?.(); } catch { /* ignore */ }
            },
            (dialog) => { try { (dialog as any)?.close?.(); } catch { /* ignore */ } }
        );
    }

    async editTags(entry: WhiteboardEntry, tags: string[]): Promise<boolean> {
        try {
            await api.setBlockAttrs(entry.id, { tags: tags.join(',') });
            const next = tags.slice();
            this.entries.update(list => list.map(e => (e.id === entry.id ? { ...e, tags: next } : e)));
            showMessage('标签已保存', 2000, 'info');
            return true;
        } catch (e) {
            console.error('保存标签失败:', e);
            showMessage('保存标签失败', 3000, 'error');
            return false;
        }
    }

    async bulkAddTag(tag: string, entries: WhiteboardEntry[]): Promise<void> {
        if (!tag || !entries.length) return;
        const updates: Array<{ id: string; tags: string[] }> = [];
        try {
            for (const e of entries) {
                if (!e.tags.includes(tag)) {
                    const next = [...e.tags, tag];
                    await api.setBlockAttrs(e.id, { tags: next.join(',') });
                    updates.push({ id: e.id, tags: next });
                }
            }
            this.applyTagUpdates(updates);
            showMessage(`已为 ${updates.length} 个白板添加标签 "${tag}"`, 3000, 'info');
        } catch (e) {
            console.error('批量添加标签失败:', e);
            showMessage('批量添加标签失败', 3000, 'error');
        }
    }

    async bulkRemoveTag(tag: string, entries: WhiteboardEntry[]): Promise<void> {
        if (!tag || !entries.length) return;
        const updates: Array<{ id: string; tags: string[] }> = [];
        try {
            for (const e of entries) {
                if (e.tags.includes(tag)) {
                    const next = e.tags.filter(t => t !== tag);
                    await api.setBlockAttrs(e.id, { tags: next.join(',') });
                    updates.push({ id: e.id, tags: next });
                }
            }
            this.applyTagUpdates(updates);
            showMessage(`已从 ${updates.length} 个白板移除标签 "${tag}"`, 3000, 'info');
        } catch (e) {
            console.error('批量移除标签失败:', e);
            showMessage('批量移除标签失败', 3000, 'error');
        }
    }

    private applyTagUpdates(updates: Array<{ id: string; tags: string[] }>): void {
        if (!updates.length) return;
        const map = new Map(updates.map(u => [u.id, u.tags]));
        this.entries.update(list => list.map(e => (map.has(e.id) ? { ...e, tags: map.get(e.id)! } : e)));
    }

    // ==================== 生命周期 ====================
    dispose(): void {
        this.unsubs.forEach(u => { try { u(); } catch { /* ignore */ } });
        this.unsubs = [];
        if (this.observer) { try { this.observer.disconnect(); } catch { /* ignore */ } this.observer = undefined; }
        if (this.sentinelObserver) { try { this.sentinelObserver.disconnect(); } catch { /* ignore */ } this.sentinelObserver = undefined; }
        this.previewNodes.clear();
        this.sentinelNode = null;
        this.previewStores.clear();
        this.previewLoading.clear();
        this.scrollRoot = null;
    }
}
