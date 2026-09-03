<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { showMessage, openTab, Plugin, confirm } from 'siyuan';
    import { api } from '@frostime/siyuan-plugin-kits';
    import { get } from 'svelte/store';
    import { whiteboardFilesUpdated } from '../whiteboards.store';
    import { closeTab } from '../tldraw-instance-manager';
    import { WhiteboardFileManager, WHITEBOARD_TRASH_DIR } from '../whiteboard-file-manager';
    import type { PreviewShape, ProjectedRect } from '../utils/whiteboard-utils';
    import { extractDrawingId, parseSyTimestamp, projectAllShapes, formatTime, formatRelativeTime, parseBlockTags, pointerMenuPosition, anchoredMenuPosition, SVG_PAD, SHAPE_FILL, SHAPE_STROKE, SHAPE_RX } from '../utils/whiteboard-utils';
    import { fetchWhiteboardShapes } from '../utils/whiteboard-preview';
    import { whiteboardViewMode, whiteboardSortKey, COMMON_SORT_OPTIONS } from './whiteboard-view-prefs';
    import WhiteboardViewSwitcher from './WhiteboardViewSwitcher.svelte';
    import WhiteboardContextMenu from './WhiteboardContextMenu.svelte';

    // 父层传入 plugin 以便打开白板
    export let plugin: Plugin;

    interface WhiteboardCard {
        id: string;          // 画板ID (块ID)
        fileName: string;    // 数据文件名
        path: string;        // 文件路径
        title: string;       // 关联文档标题或占位
        exists: boolean;     // 块是否存在
        mtime: number;       // 文件修改时间 (用于排序)
        loadingPreview: boolean; // 缩略图是否加载中
        previewLoaded: boolean;  // 缩略图是否已尝试加载完成（用于区分"未加载"与"空白画板"）
        shapes: PreviewShape[]; // 用于缩略图
        previewRects?: ProjectedRect[]; // 预计算的 SVG 矩形
        error?: string;      // 预览错误
        docId?: string;      // 关联文档ID
        tags?: string[];     // 标签列表
    }

    interface ContextMenuState {
        visible: boolean;
        x: number;
        y: number;
        card: WhiteboardCard | null;
    }

    interface SortMenuState {
        visible: boolean;
        x: number;
        y: number;
    }

    // ========== 排序：与其他白板面板共享的偏好 ==========
    const COMMON_SORT_KEYS = new Set(COMMON_SORT_OPTIONS.map(o => o.key));
    // Dock 只支持公共排序项；若共享偏好被高级管理面板设为扩展项（如按创建时间），此处回落到默认
    function resolveEffectiveSortKey(key: string): string {
        return COMMON_SORT_KEYS.has(key) ? key : 'mtime-desc';
    }
    $: effectiveSortKey = resolveEffectiveSortKey($whiteboardSortKey);
    $: currentSortOption = COMMON_SORT_OPTIONS.find(o => o.key === effectiveSortKey) || COMMON_SORT_OPTIONS[0];

    // ========== 列表状态 ==========
    let allCards: WhiteboardCard[] = [];
    let filteredCards: WhiteboardCard[] = [];
    let searchQuery: string = '';
    let showOnlyValid = true; // true: 仅显示存在的块 (默认开启)
    let showSearch = false; // 控制搜索框显示
    let loading = true;
    let searchInputRef: HTMLInputElement; // 搜索框引用
    // 动态增量加载相关状态
    interface DirEntry { name: string; isDir: boolean; mtime?: number }
    interface FileMeta extends DirEntry {
        id?: string;
        blkInfo?: any;
        docBlkInfo?: any;
        title?: string;
        exists?: boolean;
        mtimeNum?: number; // derived from blk.updated/created or doc
        docId?: string;    // 关联文档ID
        tags?: string[];   // 标签列表
    }
    let allFileEntries: FileMeta[] = []; // 全部文件条目列表（扩展的元数据）
    let nextIndex = 0; // 下一个批次的起始索引
    const BATCH_SIZE = 40; // 每批加载的卡片数量
    let loadingList = false; // 正在加载文件列表
    let loadingBatch = false; // 正在加载一批卡片
    let allLoaded = false; // 是否所有文件都已转换为卡片
    let autoLoadingAll = false; // 搜索时自动加载全部
    let sentinel: HTMLDivElement; // 触底哨兵元素
    let cardsScrollEl: HTMLDivElement; // 滚动容器引用（滚动检测 + 观察器 root）
    let prevSortKey = resolveEffectiveSortKey(get(whiteboardSortKey));
    let rootEl: HTMLDivElement; // 面板根元素：菜单定位基准（position: relative）

    let contextMenu: ContextMenuState = { visible: false, x: 0, y: 0, card: null };

    // 原逻辑拆成两阶段：读取文件列表 + 分批构造卡片
    async function loadWhiteboards() {
        resetState();
        loading = true;
        loadingList = true;
        try {
            const files: any[] = await api.readDir('/data/storage/petal/sttools/');
            allFileEntries = files.filter(f => !f.isDir && f.name.startsWith('tldraw-data-') && f.name.endsWith('.json')) as FileMeta[];
            // attach id parsed from filename
            allFileEntries = allFileEntries.map(f => ({ ...f, id: extractDrawingId(f.name) }));
            nextIndex = 0;
            if (allFileEntries.length === 0) {
                allCards = [];
                applyFilters();
                allLoaded = true;
                return;
            }
            // 预取所有文件的块元数据（用于排序顺序），有限并发
            await fetchAllMetas(8);
            // 根据当前排序规则对 allFileEntries 排序
            sortAllFileEntries();
            prevSortKey = effectiveSortKey;
            // 初始加载第一批（按排序后的顺序）
            await loadNextBatch();
        } catch (e) {
            console.error('加载白板列表失败:', e);
            showMessage('加载白板列表失败', 4000, 'error');
        } finally {
            loadingList = false;
            loading = false;
        }
    }

    // 并发抓取元数据（blkInfo/docBlkInfo）以便排序
    async function fetchAllMetas(concurrency = 6) {
        if (!allFileEntries || allFileEntries.length === 0) return;
        loadingList = true;
        let i = 0;
        const total = allFileEntries.length;
        const workers: Promise<void>[] = [];
        for (let w = 0; w < concurrency; w++) {
            workers.push((async () => {
                while (i < total) {
                    const idx = i++;
                    const f = allFileEntries[idx];
                    try {
                        const id = f.id;
                        f.exists = false;
                        f.title = '未知白板';
                        f.blkInfo = null;
                        f.docBlkInfo = null;
                        if (id && id !== '未知画板') {
                            try {
                                const blk = await api.getBlockByID(id);
                                if (blk) {
                                    f.exists = true;
                                    f.blkInfo = blk;
                                    f.docId = blk.root_id || undefined;
                                    f.tags = parseBlockTags(blk.tag);
                                    if (blk.root_id) {
                                        try {
                                            const docBlk = await api.getBlockByID(blk.root_id);
                                            if (docBlk) {
                                                f.docBlkInfo = docBlk;
                                                f.title = docBlk.content || f.title;
                                            }
                                        } catch { /* ignore */ }
                                    }
                                } else {
                                    f.exists = false;
                                    f.title = '无关联块';
                                }
                            } catch {
                                f.exists = false;
                                f.title = '无关联块';
                            }
                        } else {
                            f.title = 'ID无法解析';
                        }

                        // compute mtimeNum from blk/doc
                        let blkUpdated = f.blkInfo && typeof f.blkInfo.updated === 'string' ? parseSyTimestamp(f.blkInfo.updated) : 0;
                        let docUpdated = f.docBlkInfo && typeof f.docBlkInfo.updated === 'string' ? parseSyTimestamp(f.docBlkInfo.updated) : 0;
                        let blkCreated = f.blkInfo && typeof f.blkInfo.created === 'string' ? parseSyTimestamp(f.blkInfo.created) : 0;
                        let docCreated = f.docBlkInfo && typeof f.docBlkInfo.created === 'string' ? parseSyTimestamp(f.docBlkInfo.created) : 0;

                        if (blkUpdated > 0) f.mtimeNum = blkUpdated;
                        else if (docUpdated > 0) f.mtimeNum = docUpdated;
                        else if (blkCreated > 0) f.mtimeNum = blkCreated;
                        else if (docCreated > 0) f.mtimeNum = docCreated;
                        else f.mtimeNum = 0;
                    } catch (e) {
                        console.warn('fetch meta fail', f.name, e);
                        // continue
                    }
                }
            })());
        }
        await Promise.all(workers);
        loadingList = false;
    }

    function sortAllFileEntries() {
        if (!allFileEntries || allFileEntries.length === 0) return;
        const order = resolveEffectiveSortKey($whiteboardSortKey);
        allFileEntries.sort((a, b) => {
            switch (order) {
                case 'mtime-desc': return (b.mtimeNum || 0) - (a.mtimeNum || 0);
                case 'mtime-asc': return (a.mtimeNum || 0) - (b.mtimeNum || 0);
                case 'title': return (a.title || '').localeCompare(b.title || '');
                case 'id': return (a.id || '').localeCompare(b.id || '');
                case 'exists': return Number(b.exists ? 1 : 0) - Number(a.exists ? 1 : 0);
            }
            return 0;
        });
    }

    function resetState() {
        allCards = [];
        filteredCards = [];
        allFileEntries = [];
        nextIndex = 0;
        loadingList = false;
        loadingBatch = false;
        allLoaded = false;
        autoLoadingAll = false;
    }

    // 构造单个文件的卡片元数据（使用已预取的 metas，避免重复网络请求）
    function buildCardMeta(f: FileMeta): WhiteboardCard {
        // use precomputed fields if available
        const id = f.id || extractDrawingId(f.name);
        const exists = !!f.exists;
        const title = f.title || '未知白板';
        const mtimeNum = f.mtimeNum || 0;

        return {
            id,
            fileName: f.name,
            path: `/data/storage/petal/sttools/${f.name}`,
            title,
            exists,
            mtime: mtimeNum,
            loadingPreview: false,
            previewLoaded: false,
            shapes: [],
            docId: f.docId,
            tags: f.tags || [],
        } as WhiteboardCard;
    }

    async function loadNextBatch() {
        if (loadingBatch || allLoaded) return;
        loadingBatch = true;
        try {
            const slice = allFileEntries.slice(nextIndex, nextIndex + BATCH_SIZE);
            // buildCardMeta is synchronous now (uses pre-fetched meta)
            const metas = slice.map(buildCardMeta);
            allCards = [...allCards, ...metas];
            nextIndex += slice.length;
            if (nextIndex >= allFileEntries.length) {
                allLoaded = true;
            }
            applyFilters();
        } catch (e) {
            console.error('批次加载失败:', e);
            showMessage('批次加载失败', 3000, 'error');
        } finally {
            loadingBatch = false;
        }
    }

    // 当排序变化时，按照排序重排元数据并重置批次加载顺序
    $: if (allFileEntries.length > 0 && prevSortKey !== effectiveSortKey) {
        prevSortKey = effectiveSortKey;
        (async () => {
            sortAllFileEntries();
            // reset batch loading so subsequent batches follow new order
            allCards = [];
            filteredCards = [];
            nextIndex = 0;
            allLoaded = false;
            // load first batch under new order
            await loadNextBatch();
        })();
    }

    // 滚动检测作为 IntersectionObserver 的补充（某些嵌套滚动环境下 IO 可能不触发）
    function handleCardsScroll() {
        if (!cardsScrollEl || loadingBatch || allLoaded) return;
        const nearBottom = cardsScrollEl.scrollTop + cardsScrollEl.clientHeight >= cardsScrollEl.scrollHeight - 160; // 160px 预加载阈值
        if (nearBottom) loadNextBatch();
    }

    // 搜索时自动加载全部（避免未加载条目漏检）
    $: if (searchQuery.trim() && !allLoaded && !autoLoadingAll) {
        autoLoadingAll = true;
        // 递归批量加载直到全部完成
        (async () => {
            while (!allLoaded) {
                await loadNextBatch();
                // 小延迟避免 UI 卡顿
                await new Promise(r => setTimeout(r, 10));
            }
        })();
    }

    // 过滤逻辑
    function applyFilters() {
        let list = allCards;
        if (showOnlyValid) list = list.filter(c => c.exists);
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            list = list.filter(c => c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q) || c.fileName.toLowerCase().includes(q));
        }
        // 排序（直接读取共享 store 并归一化，避免响应式语句间读到过期的 effectiveSortKey）
        const order = resolveEffectiveSortKey($whiteboardSortKey);
        list = list.slice();
        switch (order) {
            case 'mtime-desc':
                list.sort((a, b) => b.mtime - a.mtime); break;
            case 'mtime-asc':
                list.sort((a, b) => a.mtime - b.mtime); break;
            case 'title':
                list.sort((a, b) => a.title.localeCompare(b.title)); break;
            case 'id':
                list.sort((a, b) => a.id.localeCompare(b.id)); break;
            case 'exists':
                list.sort((a, b) => Number(b.exists) - Number(a.exists)); break;
        }
        filteredCards = list;
    }

    $: { searchQuery; showOnlyValid; $whiteboardSortKey; applyFilters(); }

    // 切换搜索框显示
    function toggleSearch() {
        showSearch = !showSearch;
        // 切换到隐藏时不清空查询，保留筛选；用户可按 Esc 或使用清除按钮主动清空
        if (showSearch) {
            // 显示后聚焦输入框
            setTimeout(() => searchInputRef?.focus(), 10);
        }
    }

    // 搜索框失焦处理：失去焦点时自动隐藏（延迟以兼容点击其它控件）
    function handleSearchBlur() {
        setTimeout(() => {
            if (!searchQuery || !searchQuery.trim()) {
                searchQuery = '';
            }
            showSearch = false;
        }, 150);
    }

    // 打开白板 Tab
    async function openWhiteboard(card: WhiteboardCard) {
        if (!card.exists) {
            showMessage('该白板块不存在，无法打开', 3000, 'error');
            return;
        }
        try {
            await openTab({
                app: plugin.app,
                custom: {
                    id: plugin.name + 'steveTool-whiteboard',
                    title: card.title || '画板-' + card.id.substring(0, 8),
                    icon: 'iconSTWhiteboard',
                    data: { text: 'steveTool-whiteboard' + card.id, rootid: card.id }
                },
                // position: 'right'
            });
        } catch (e) {
            console.error('打开白板失败:', e);
            showMessage('打开白板失败', 3000, 'error');
        }
    }

    // ========== 右键菜单 ==========
    // 菜单以面板根元素为定位基准（position: absolute），坐标由工具函数换算并夹取在面板范围内
    function handleContextMenu(event: MouseEvent, card: WhiteboardCard) {
        event.preventDefault();
        const { x, y } = pointerMenuPosition(rootEl, event, 180, 210);
        contextMenu = { visible: true, x, y, card };
    }

    function closeContextMenu() {
        contextMenu = { visible: false, x: 0, y: 0, card: null };
    }

    // ========== 排序下拉菜单 ==========
    let sortBtnEl: HTMLButtonElement;
    let sortMenu: SortMenuState = { visible: false, x: 0, y: 0 };
    const SORT_MENU_WIDTH = 170;

    function toggleSortMenu() {
        if (sortMenu.visible) {
            closeSortMenu();
            return;
        }
        if (!sortBtnEl || !rootEl) return;
        const { x, y } = anchoredMenuPosition(rootEl, sortBtnEl, SORT_MENU_WIDTH, 190);
        sortMenu = { visible: true, x, y };
    }

    function closeSortMenu() {
        sortMenu = { visible: false, x: 0, y: 0 };
    }

    function setSortKey(key: string) {
        whiteboardSortKey.set(key);
        closeSortMenu();
    }

    function handleWindowClick(event: MouseEvent) {
        const target = event.target as HTMLElement;
        if (sortMenu.visible) {
            if (target && target.closest('.sort-menu, .sort-btn')) return;
            closeSortMenu();
        }
        if (contextMenu.visible) {
            if (target && target.closest('.whiteboard-context-menu')) return;
            closeContextMenu();
        }
    }

    function handleWindowKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            if (sortMenu.visible) closeSortMenu();
            if (contextMenu.visible) closeContextMenu();
        }
    }

    function handleWindowCtxMenu(event: MouseEvent) {
        if (!event.defaultPrevented && contextMenu.visible) {
            closeContextMenu();
        }
    }

    async function openDocument(card: WhiteboardCard) {
        if (!card.docId) {
            showMessage('未找到关联文档', 3000, 'info');
            return;
        }
        try {
            await openTab({
                app: plugin.app,
                doc: {
                    id: card.docId,
                    action: ['cb-get-hl', 'cb-get-all'],
                    zoomIn: false,
                },
                keepCursor: false,
            });
        } catch (e) {
            console.error('打开文档失败:', e);
            showMessage('打开文档失败', 3000, 'error');
        }
    }

    async function refreshCard(card: WhiteboardCard) {
        card.shapes = [];
        card.previewRects = [];
        card.error = undefined;
        card.loadingPreview = false;
        card.previewLoaded = false;
        allCards = allCards;
        filteredCards = [...filteredCards];
        await loadPreview(card);
        showMessage('预览已刷新', 1500, 'info');
    }

    async function backupCard(card: WhiteboardCard) {
        try {
            const results = await WhiteboardFileManager.batchBackupWhiteboards([card.id], {
                reason: '手动备份',
                includeTimestamp: true,
            });
            const stats = WhiteboardFileManager.getOperationStats(results);
            if (stats.success > 0) {
                showMessage(`已备份到 ${WHITEBOARD_TRASH_DIR}`, 3000, 'info');
            } else {
                showMessage('备份失败', 3000, 'error');
            }
        } catch (e) {
            console.error('备份失败:', e);
            showMessage('备份失败', 3000, 'error');
        }
    }

    function deleteCard(card: WhiteboardCard) {
        confirm(
            '删除确认',
            `确定要删除白板 "${card.title}" 的数据文件吗？此操作不可恢复！`,
            async (dialog) => {
                try {
                    closeTab(card.id, 'user-delete');
                    await api.removeFile(card.path);

                    whiteboardFilesUpdated.set({
                        action: 'delete',
                        fileName: card.fileName,
                        drawingId: card.id,
                        timestamp: Date.now(),
                    });

                    showMessage(`已删除: ${card.fileName}`, 3000, 'info');

                    setTimeout(async () => {
                        try {
                            await api.removeFile(card.path);
                        } catch (e) {
                            console.debug('延迟删除重试失败:', card.path, e);
                        }
                    }, 2000);
                } catch (error) {
                    console.error('删除失败:', error);
                    showMessage('删除失败', 3000, 'error');
                }
                try { dialog && (dialog as any).close && (dialog as any).close(); } catch { /* ignore */ }
            },
            (dialog) => {
                try { dialog && (dialog as any).close && (dialog as any).close(); } catch { /* ignore */ }
            }
        );
    }

    function handleMenuAction(action: 'board' | 'doc' | 'refresh' | 'backup' | 'delete') {
        const card = contextMenu.card;
        if (!card) return;
        switch (action) {
            case 'board':
                openWhiteboard(card).finally(() => closeContextMenu());
                break;
            case 'doc':
                openDocument(card).finally(() => closeContextMenu());
                break;
            case 'refresh':
                refreshCard(card).finally(() => closeContextMenu());
                break;
            case 'backup':
                backupCard(card).finally(() => closeContextMenu());
                break;
            case 'delete':
                deleteCard(card);
                closeContextMenu();
                break;
        }
    }

    // 解析文件生成缩略图数据
    async function loadPreview(card: WhiteboardCard) {
        if (card.loadingPreview || card.previewLoaded) return; // 已加载或正在加载
        card.loadingPreview = true;
        try {
            const shapes = await fetchWhiteboardShapes(card.path);
            card.shapes = shapes;
            card.previewRects = projectAllShapes(shapes, 300, 200, SVG_PAD);
        } catch (e) {
            console.warn('缩略图加载失败:', e);
            card.error = '缩略图失败';
        } finally {
            card.loadingPreview = false;
            card.previewLoaded = true;
            // 强制触发响应式更新
            allCards = allCards;
            filteredCards = [...filteredCards];
        }
    }

    // 懒加载缩略图：使用 IntersectionObserver
    let observer: IntersectionObserver;
    function setupObserver(node: HTMLElement, card: WhiteboardCard) {
        const root = cardsScrollEl ?? null;
        if (observer && observer.root !== root) {
            try { observer.disconnect(); } catch { /* ignore */ }
            observer = undefined as unknown as IntersectionObserver;
        }
        if (!observer) {
            // 增大 rootMargin 提前触发懒加载，降低滚动时空白缩略图的出现概率
            observer = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const targetCard = (entry.target as any).__card as WhiteboardCard;
                        if (targetCard) loadPreview(targetCard);
                        observer.unobserve(entry.target);
                    }
                }
            }, { root, rootMargin: '320px 0px 320px 0px', threshold: 0.05 });
        }
        (node as any).__card = card;
        // always try to observe even if previously observed — IntersectionObserver.observe is idempotent
        try { observer.observe(node); } catch { /* ignore */ }
        return {
            // update is called when the action parameter changes (e.g. card object updated/element reused)
            update(newCard: WhiteboardCard) {
                (node as any).__card = newCard;
                try { observer.observe(node); } catch { /* ignore */ }
            },
            destroy() {
                try { observer.unobserve(node); } catch { /* ignore */ }
            }
        };
    }

    onMount(() => { loadWhiteboards(); });

    // 触底哨兵观察器：滚动至底部自动加载下一批。
    // 通过显式引用 sentinel/cardsScrollEl 建立响应式依赖，仅在两者绑定后才创建观察器
    let batchObserver: IntersectionObserver;
    function setupBatchObserver() {
        const root = cardsScrollEl ?? null;
        if (batchObserver && batchObserver.root !== root) {
            try { batchObserver.disconnect(); } catch { /* ignore */ }
            batchObserver = undefined as unknown as IntersectionObserver;
        }
        if (!batchObserver) {
            batchObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        loadNextBatch();
                    }
                }
            }, { root, rootMargin: '200px 0px 200px 0px', threshold: 0.01 });
        }
        if (sentinel) {
            try { batchObserver.observe(sentinel); } catch { /* ignore */ }
        }
    }

    $: if (sentinel && cardsScrollEl) {
        setupBatchObserver();
    }

    // 订阅白板文件更新事件（用于删除后自动刷新）
    let unsubscribe: () => void;
    $: {
        if (!unsubscribe) {
            unsubscribe = whiteboardFilesUpdated.subscribe(({ action, fileName, drawingId }) => {
                if (action === 'delete') {
                    const matchByFileName = (card: WhiteboardCard) => (fileName ? card.fileName !== fileName : true);
                    const matchByDrawingId = (card: WhiteboardCard) => (drawingId ? card.id !== drawingId : true);

                    // 删除对应的卡片条目（按 fileName / drawingId 任一匹配）
                    allCards = allCards.filter(card => matchByFileName(card) && matchByDrawingId(card));
                    allFileEntries = allFileEntries.filter(f => {
                        if (fileName && f.name === fileName) return false;
                        if (drawingId && (f as any).id === drawingId) return false;
                        return true;
                    });

                    applyFilters();
                } else if (action === 'refresh') {
                    // 完全刷新
                    loadWhiteboards();
                }
            });
        }
    }

    // 清理订阅与观察器
    onDestroy(() => {
        if (unsubscribe) unsubscribe();
        try { observer && observer.disconnect(); } catch { /* ignore */ }
        try { batchObserver && batchObserver.disconnect(); } catch { /* ignore */ }
    });

    // 打开高级管理 Tab
    async function openManagerTab() {
        try {
            await openTab({
                app: plugin.app,
                custom: {
                    id: plugin.name + "steveTool-whiteboard-manager",
                    title: "白板高级管理",
                    icon: "iconSettings",
                    data: {
                        text: "steveTool-whiteboard-manager",
                    },
                },
            });
        } catch (e) {
            console.error('打开白板管理 Tab 失败:', e);
            showMessage('打开白板管理失败', 3000, 'error');
        }
    }
</script>

<svelte:window on:click={handleWindowClick} on:keydown={handleWindowKeydown} on:contextmenu={handleWindowCtxMenu} />

<div class="whiteboard-card-view" bind:this={rootEl}>
    <!-- 顶部工具栏 -->
    <div class="panel-toolbar">
        <div class="toolbar-row">
            <div class="panel-logo">
                <svg class="logo-icon"><use xlink:href="#iconSTWhiteboard"></use></svg>
                <span class="logo-text">白板卡片</span>
            </div>
            <span class="counter-chip" title="已加载卡片 / 数据文件总数">{filteredCards.length}/{allFileEntries.length || 0}</span>
            {#if loadingList}
                <span class="meta-loading">读取元数据…</span>
            {/if}
            <span class="flex-spacer"></span>
            {#if showSearch}
                <input class="b3-text-field search-input"
                    placeholder="搜索 ID / 标题 / 文件名…"
                    bind:value={searchQuery}
                    bind:this={searchInputRef}
                    on:blur={handleSearchBlur}
                    on:keydown={(e) => { if (e.key === 'Escape') { searchQuery = ''; showSearch = false; } }} />
            {/if}
            <button type="button" class="tool-btn b3-tooltips b3-tooltips__w" class:active={showSearch || !!searchQuery.trim()}
                aria-label="搜索" aria-expanded={showSearch}
                on:click={toggleSearch}
                on:keydown={(e) => { if (e.key === 'Enter') toggleSearch(); }}>
                <svg><use xlink:href="#iconSearch"></use></svg>
            </button>
            <button type="button" class="tool-btn b3-tooltips b3-tooltips__w"
                aria-label="刷新"
                on:click={loadWhiteboards}
                on:keydown={(e) => { if (e.key === 'Enter') loadWhiteboards(); }}>
                <svg><use xlink:href="#iconRefresh"></use></svg>
            </button>
            <button type="button" class="tool-btn b3-tooltips b3-tooltips__w"
                aria-label="打开高级管理"
                on:click={openManagerTab}
                on:keydown={(e) => { if (e.key === 'Enter') openManagerTab(); }}>
                <svg><use xlink:href="#iconSettings"></use></svg>
            </button>
        </div>
        <div class="toolbar-row sub-row">
            <WhiteboardViewSwitcher />
            <span class="flex-spacer"></span>
            <button type="button" class="tool-btn sort-btn b3-tooltips b3-tooltips__w" class:active={sortMenu.visible}
                bind:this={sortBtnEl}
                aria-label="排序方式" aria-expanded={sortMenu.visible}
                on:click={toggleSortMenu}
                on:keydown={(e) => { if (e.key === 'Enter') toggleSortMenu(); }}>
                <svg><use xlink:href="#iconSort"></use></svg>
                <span class="sort-label">{currentSortOption.label}</span>
                <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M7 10l5 5 5-5" />
                </svg>
            </button>
            <button type="button" class="tool-btn b3-tooltips b3-tooltips__w" class:active={showOnlyValid}
                aria-label={showOnlyValid ? '当前仅显示存在的块，点击显示全部' : '当前显示全部，点击仅显示存在的块'}
                on:click={() => showOnlyValid = !showOnlyValid}
                on:keydown={(e) => { if (e.key === 'Enter') showOnlyValid = !showOnlyValid; }}>
                <svg><use xlink:href="#iconEye{showOnlyValid ? 'off' : ''}"></use></svg>
            </button>
        </div>
    </div>

    <!-- 内容区 -->
    {#if loading}
        <div class="cards-scroll">
            {#if $whiteboardViewMode === 'card'}
                <div class="cards-grid">
                    {#each Array(6) as _, i (i)}
                        <div class="skel-card">
                            <div class="skel-thumb shimmer"></div>
                            <div class="skel-lines">
                                <div class="skel-line w60 shimmer"></div>
                                <div class="skel-line w40 shimmer"></div>
                            </div>
                        </div>
                    {/each}
                </div>
            {:else}
                <div class="rows">
                    {#each Array(10) as _, i (i)}
                        <div class="skel-row shimmer"></div>
                    {/each}
                </div>
            {/if}
        </div>
    {:else if filteredCards.length === 0}
        <div class="empty-state">
            <svg class="empty-icon"><use xlink:href="#iconSTWhiteboard"></use></svg>
            <div class="empty-title">暂无匹配白板</div>
            <div class="empty-hint">试试调整搜索或筛选条件，或点击上方刷新</div>
        </div>
    {:else}
        <div class="cards-scroll" bind:this={cardsScrollEl} on:scroll={handleCardsScroll}>
            {#if $whiteboardViewMode === 'card'}
                <!-- 卡片视图 -->
                <div class="cards-grid">
                    {#each filteredCards as card (card.path)}
                        <div class="card" role="button" tabindex="0"
                            on:click={() => openWhiteboard(card)}
                            on:contextmenu={(e) => handleContextMenu(e, card)}
                            on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWhiteboard(card); } }}>
                            <div class="preview-wrapper" use:setupObserver={card}>
                                {#if card.error}
                                    <div class="preview-error">{card.error}</div>
                                {:else if card.loadingPreview}
                                    <div class="preview-loading">生成缩略图…</div>
                                {:else if !card.previewLoaded}
                                    <div class="preview-loading">等待加载…</div>
                                {:else if card.shapes.length === 0}
                                    <div class="preview-blank">空白画板</div>
                                {:else}
                                    <svg viewBox="0 0 300 200" class="preview-svg" preserveAspectRatio="xMidYMid meet">
                                        {#each card.previewRects ?? [] as pos}
                                            <rect x={pos.x} y={pos.y} width={pos.w} height={pos.h} rx={SHAPE_RX} ry={SHAPE_RX} fill={SHAPE_FILL} stroke={SHAPE_STROKE} stroke-width="1" />
                                        {/each}
                                    </svg>
                                {/if}
                                <div class="preview-overlay"></div>
                            </div>
                            <div class="meta">
                                <div class="title-line">
                                    <span class="doc-title" title={card.title}>{card.title}</span>
                                    {#if !card.exists}
                                        <span class="badge badge-warn" title="白板数据文件没有关联到存在的块">无附属</span>
                                    {/if}
                                </div>
                                {#if card.tags && card.tags.length > 0}
                                    <div class="tags-line">
                                        {#each card.tags.slice(0, 2) as tag, ti (ti)}
                                            <span class="tag-chip" title={'#' + tag}>#{tag}</span>
                                        {/each}
                                        {#if card.tags.length > 2}
                                            <span class="tag-more">+{card.tags.length - 2}</span>
                                        {/if}
                                    </div>
                                {/if}
                                {#if card.mtime}
                                    <div class="mtime-line" title={formatTime(card.mtime)}>
                                        <svg class="tiny-icon"><use xlink:href="#iconClock"></use></svg>
                                        {formatRelativeTime(card.mtime) || formatTime(card.mtime)}
                                    </div>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            {:else if $whiteboardViewMode === 'list'}
                <!-- 列表视图 -->
                <div class="rows">
                    {#each filteredCards as card (card.path)}
                        <div class="list-row" role="button" tabindex="0"
                            title={card.title + (card.mtime ? '\n' + formatTime(card.mtime) : '')}
                            on:click={() => openWhiteboard(card)}
                            on:contextmenu={(e) => handleContextMenu(e, card)}
                            on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWhiteboard(card); } }}>
                            <div class="row-thumb" use:setupObserver={card}>
                                {#if card.error}
                                    <div class="thumb-fail"></div>
                                {:else if card.loadingPreview || !card.previewLoaded}
                                    <div class="thumb-pending"></div>
                                {:else if card.shapes.length === 0}
                                    <div class="thumb-blank"></div>
                                {:else}
                                    <svg viewBox="0 0 300 200" class="preview-svg" preserveAspectRatio="xMidYMid meet">
                                        {#each card.previewRects ?? [] as pos}
                                            <rect x={pos.x} y={pos.y} width={pos.w} height={pos.h} rx={SHAPE_RX} ry={SHAPE_RX} fill={SHAPE_FILL} stroke={SHAPE_STROKE} stroke-width="1" />
                                        {/each}
                                    </svg>
                                {/if}
                            </div>
                            <div class="row-main">
                                <div class="row-title">
                                    <span class="rt-text">{card.title}</span>
                                    {#if !card.exists}
                                        <span class="mini-warn">无附属</span>
                                    {/if}
                                </div>
                                <div class="row-sub">
                                    {#if card.mtime}
                                        <span class="rs-time">{formatRelativeTime(card.mtime) || formatTime(card.mtime)}</span>
                                    {/if}
                                    {#if card.tags && card.tags.length > 0}
                                        <span class="rs-tags">{card.tags.slice(0, 2).map(t => '#' + t).join('　')}</span>
                                    {/if}
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>
            {:else}
                <!-- 紧凑视图 -->
                <div class="rows compact">
                    {#each filteredCards as card (card.path)}
                        <div class="compact-row" role="button" tabindex="0"
                            title={card.title + '\n' + card.id + (card.mtime ? '\n' + formatTime(card.mtime) : '')}
                            on:click={() => openWhiteboard(card)}
                            on:contextmenu={(e) => handleContextMenu(e, card)}
                            on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWhiteboard(card); } }}>
                            <span class="status-dot" class:miss={!card.exists}></span>
                            <span class="cr-title">{card.title}</span>
                            {#if card.mtime}
                                <span class="cr-time">{formatRelativeTime(card.mtime)}</span>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}

            <!-- 触底哨兵，用于自动加载下一批 -->
            {#if !allLoaded}
                <div class="load-sentinel" bind:this={sentinel}>
                    {#if loadingBatch}
                        <span class="loading-batch">加载更多…</span>
                    {:else}
                        <span class="load-more-btn" role="button" tabindex="0" aria-label="手动加载更多"
                            on:click={loadNextBatch}
                            on:keydown={(e) => { if (e.key === 'Enter') loadNextBatch(); }}>
                            加载更多（{allCards.length}/{allFileEntries.length}）
                        </span>
                    {/if}
                </div>
            {:else if allCards.length > 0}
                <div class="load-sentinel done">已全部加载 · 共 {allCards.length} 个</div>
            {/if}
        </div>
    {/if}

    <!-- 排序下拉菜单 -->
    {#if sortMenu.visible}
        <div class="sort-menu" role="menu" aria-label="排序方式" tabindex="0"
            style={`left:${sortMenu.x}px;top:${sortMenu.y}px;width:${SORT_MENU_WIDTH}px;`}
            on:click={(event) => event.stopPropagation()}
            on:keydown={(event) => event.stopPropagation()}>
            {#each COMMON_SORT_OPTIONS as opt (opt.key)}
                <button type="button" role="menuitem" class:selected={opt.key === effectiveSortKey}
                    on:click={() => setSortKey(opt.key)}>
                    <span class="sm-label">{opt.label}</span>
                    {#if opt.key === effectiveSortKey}
                        <svg class="menu-ico check"><use xlink:href="#iconCheck"></use></svg>
                    {/if}
                </button>
            {/each}
        </div>
    {/if}

    {#if contextMenu.visible && contextMenu.card}
        <WhiteboardContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            docId={contextMenu.card.docId}
            on:action={(e) => handleMenuAction(e.detail)}
        />
    {/if}
</div>

<style>
/* ================= 布局骨架 ================= */
.whiteboard-card-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--b3-theme-background);
  color: var(--b3-theme-on-background);
  overflow: hidden;
  /* 菜单定位基准（内部浮层菜单均为 absolute） */
  position: relative;
  /* 使面板成为容器查询上下文，适配 dock 宽度变化 */
  container-type: inline-size;
}

.panel-toolbar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px 5px;
  border-bottom: 1px solid var(--b3-border-color);
  user-select: none;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 3px;
  min-height: 25px;
}
.toolbar-row.sub-row { gap: 5px; }

.flex-spacer { flex: 1; }

/* ================= 顶栏元素 ================= */
.panel-logo {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  min-width: 0;
}
.logo-icon {
  width: 17px;
  height: 17px;
  fill: var(--b3-theme-primary);
  opacity: 0.9;
  flex-shrink: 0;
}
.logo-text { white-space: nowrap; }

.counter-chip {
  font-size: 10px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--b3-theme-primary-lightest);
  color: var(--b3-theme-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.meta-loading {
  font-size: 0.66rem;
  color: var(--b3-theme-on-surface);
  opacity: 0.55;
  white-space: nowrap;
}

.tool-btn {
  border: none;
  background: transparent;
  color: var(--b3-theme-on-background);
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.62;
  transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
  flex-shrink: 0;
}
.tool-btn:hover {
  background: var(--b3-list-hover);
  opacity: 1;
}
.tool-btn.active {
  color: var(--b3-theme-primary);
  opacity: 1;
  background: var(--b3-theme-primary-lightest);
}
.tool-btn svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
}
.tool-btn .caret {
  width: 9px;
  height: 9px;
  fill: none;
  stroke: currentColor;
}

.search-input {
  height: 24px;
  font-size: 12px;
  padding: 0 8px;
  border-radius: 6px;
  min-width: 110px;
  max-width: 180px;
  transition: all 0.2s ease;
}

/* 排序按钮（带文字标签） */
.sort-btn {
  width: auto;
  padding: 0 6px;
  gap: 3px;
  min-width: 0;
}
.sort-label {
  font-size: 11px;
  max-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ================= 滚动容器 ================= */
.cards-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 8px 12px;
}
.cards-scroll::-webkit-scrollbar { width: 6px; }
.cards-scroll::-webkit-scrollbar-track { background: transparent; }
.cards-scroll::-webkit-scrollbar-thumb {
  background: var(--b3-border-color);
  border-radius: 3px;
}
.cards-scroll::-webkit-scrollbar-thumb:hover { background: var(--b3-list-hover); }

/* ================= 卡片视图 ================= */
.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(clamp(150px, 42%, 300px), 1fr));
  gap: 8px;
  align-items: start;
}

.card {
  display: flex;
  flex-direction: column;
  background: var(--b3-theme-surface);
  border: 1px solid var(--b3-border-color);
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  cursor: pointer;
  position: relative;
  outline: none;
  overflow: hidden;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.1);
  border-color: var(--b3-theme-primary-light);
}
.card:active {
  transform: translateY(0) scale(0.99);
}
.card:focus-visible {
  box-shadow: 0 0 0 2px var(--b3-theme-primary);
}

.preview-wrapper {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 2;
  background:
    linear-gradient(135deg, var(--b3-theme-primary-lightest), transparent 55%),
    var(--b3-theme-background);
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid var(--b3-border-color);
  overflow: hidden;
}
.preview-svg {
  width: 100%;
  height: 100%;
  display: block;
  user-select: none;
}
.preview-loading,
.preview-error,
.preview-blank {
  font-size: 11px;
  color: var(--b3-theme-on-surface);
  opacity: 0.5;
  padding: 0 6px;
  text-align: center;
}
.preview-loading { animation: fadePulse 1.8s infinite; }
.preview-error {
  color: var(--b3-theme-error);
  opacity: 0.7;
  animation: none;
}

/* 悬停打开提示层 */
.preview-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0) 55%);
  opacity: 0;
  transition: opacity 0.18s ease;
  pointer-events: none;
}
.preview-overlay::after {
  content: "打开白板";
  font-size: 11px;
  line-height: 1;
  color: #fff;
  padding: 5px 11px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  transform: translateY(4px);
  transition: transform 0.18s ease;
}
.card:hover .preview-overlay { opacity: 1; }
.card:hover .preview-overlay::after { transform: translateY(0); }

/* 卡片元数据 */
.meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px 8px;
}
.title-line {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.doc-title {
  font-weight: 600;
  font-size: 12px;
  line-height: 1.35;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tags-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.tag-chip {
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  background: var(--b3-theme-primary-lightest);
  color: var(--b3-theme-primary);
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-more {
  font-size: 10px;
  line-height: 1;
  padding: 3px 0;
  color: var(--b3-theme-on-surface);
  opacity: 0.55;
}
.mtime-line {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--b3-theme-on-surface);
  opacity: 0.55;
  min-width: 0;
}
.tiny-icon {
  width: 10px;
  height: 10px;
  fill: currentColor;
  flex-shrink: 0;
}

/* 徽章 */
.badge {
  display: inline-flex;
  align-items: center;
  font-size: 9px;
  line-height: 1;
  padding: 2.5px 5px;
  border-radius: 4px;
  font-weight: 500;
  background: var(--b3-border-color);
  color: var(--b3-theme-on-surface);
  flex-shrink: 0;
}
.badge-warn {
  background: var(--b3-theme-error-background, rgba(255, 0, 0, 0.08));
  color: var(--b3-theme-error);
}

/* ================= 列表视图 ================= */
.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.list-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 8px;
  cursor: pointer;
  outline: none;
  transition: background-color 0.12s ease;
}
.list-row:hover { background: var(--b3-list-hover); }
.list-row:focus-visible { box-shadow: 0 0 0 2px var(--b3-theme-primary); }

.row-thumb {
  width: 64px;
  aspect-ratio: 3 / 2;
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--b3-border-color);
  background: var(--b3-theme-background);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row-title {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.rt-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-warn {
  font-size: 9px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  background: var(--b3-theme-error-background, rgba(255, 0, 0, 0.08));
  color: var(--b3-theme-error);
  flex-shrink: 0;
}
.row-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--b3-theme-on-surface);
  opacity: 0.6;
  min-width: 0;
}
.rs-time { flex-shrink: 0; white-space: nowrap; }
.rs-tags {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 列表缩略图占位 */
.thumb-pending {
  width: 60%;
  height: 60%;
  border-radius: 4px;
  animation: fadePulse 1.8s infinite;
  background: var(--b3-list-hover);
}
.thumb-blank,
.thumb-fail {
  width: 55%;
  height: 55%;
  border-radius: 4px;
  border: 1px dashed var(--b3-border-color);
}
.thumb-fail { border-color: var(--b3-theme-error); opacity: 0.5; }

/* ================= 紧凑视图 ================= */
.rows.compact { gap: 0; }
.compact-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 6px;
  cursor: pointer;
  outline: none;
  transition: background-color 0.12s ease;
}
.compact-row:hover { background: var(--b3-list-hover); }
.compact-row:focus-visible { box-shadow: 0 0 0 2px var(--b3-theme-primary); }
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--b3-theme-primary);
  opacity: 0.7;
}
.status-dot.miss {
  background: var(--b3-theme-error);
  opacity: 0.6;
}
.cr-title {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cr-time {
  font-size: 9.5px;
  color: var(--b3-theme-on-surface);
  opacity: 0.5;
  flex-shrink: 0;
  white-space: nowrap;
}

/* ================= 空状态 ================= */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: var(--b3-theme-on-surface);
}
.empty-icon {
  width: 44px;
  height: 44px;
  fill: currentColor;
  opacity: 0.18;
}
.empty-title {
  font-size: 13px;
  font-weight: 500;
  opacity: 0.6;
}
.empty-hint {
  font-size: 11px;
  opacity: 0.4;
}

/* ================= 骨架屏 ================= */
.skel-card {
  border: 1px solid var(--b3-border-color);
  border-radius: 10px;
  overflow: hidden;
  background: var(--b3-theme-surface);
}
.skel-thumb { aspect-ratio: 3 / 2; }
.skel-lines {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.skel-line {
  height: 8px;
  border-radius: 4px;
}
.skel-line.w60 { width: 60%; }
.skel-line.w40 { width: 40%; }
.skel-row {
  height: 40px;
  border-radius: 8px;
}
.shimmer {
  background: linear-gradient(90deg, var(--b3-list-hover) 25%, var(--b3-theme-background) 45%, var(--b3-list-hover) 65%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite linear;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes fadePulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.7; }
}

/* ================= 触底哨兵 ================= */
.load-sentinel {
  text-align: center;
  padding: 10px 0 4px;
  font-size: 10.5px;
  color: var(--b3-theme-on-surface);
  opacity: 0.55;
}
.load-sentinel.done { opacity: 0.4; }
.loading-batch {
  display: inline-block;
  animation: fadePulse 1.8s infinite;
}
.load-more-btn {
  cursor: pointer;
  display: inline-block;
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px dashed var(--b3-border-color);
  transition: all 0.15s ease;
}
.load-more-btn:hover {
  color: var(--b3-theme-primary);
  border-color: var(--b3-theme-primary-light);
  background: var(--b3-theme-primary-lightest);
}

/* ================= 排序下拉菜单 ================= */
.sort-menu {
  position: absolute;
  z-index: 20;
  background: var(--b3-theme-surface);
  border: 1px solid var(--b3-border-color);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
  padding: 4px;
  min-width: 150px;
  overflow: hidden;
}

.sort-menu button {
  border: none;
  background: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  text-align: left;
  color: var(--b3-theme-on-background);
  transition: background-color 0.1s ease;
}
.sort-menu button:hover {
  background: var(--b3-list-hover);
}
.sort-menu button.selected {
  color: var(--b3-theme-primary);
  background: var(--b3-theme-primary-lightest);
  font-weight: 500;
}
.sm-label { flex: 1; }

.menu-ico {
  width: 14px;
  height: 14px;
  fill: currentColor;
  opacity: 1;
  flex-shrink: 0;
}

/* ================= 容器自适应（dock 宽度变化） ================= */
@container (max-width: 280px) {
  .sort-label { display: none; }
  .logo-text { display: none; }
  .search-input { min-width: 90px; }
}

/* ================= 深色模式 ================= */
@media (prefers-color-scheme: dark) {
  .card { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
  .card:hover { box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45); }
  .sort-menu {
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  }
}
</style>
