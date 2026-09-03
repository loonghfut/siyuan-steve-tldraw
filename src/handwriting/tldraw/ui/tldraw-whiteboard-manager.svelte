<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import { showMessage, openTab, Plugin, confirm } from 'siyuan';
    import { api } from '@frostime/siyuan-plugin-kits';
    import { whiteboardFilesUpdated } from '../whiteboards.store';
    import { WhiteboardFileManager, WHITEBOARD_TRASH_DIR } from '../whiteboard-file-manager';
    import { closeTab } from '../tldraw-instance-manager';
    import WhiteboardCard from './whiteboard-card.svelte';
    import WhiteboardViewSwitcher from './WhiteboardViewSwitcher.svelte';
    import WhiteboardContextMenu from './WhiteboardContextMenu.svelte';
    import type { WhiteboardItem } from '../utils/whiteboard-utils';
    import { extractDrawingId, parseSyTimestamp, projectAllShapes, formatTime, formatRelativeTime, parseBlockTags, latestWhiteboardUpdate, pointerMenuPosition, SVG_PAD, SHAPE_FILL, SHAPE_STROKE, SHAPE_RX } from '../utils/whiteboard-utils';
    import { fetchWhiteboardShapes } from '../utils/whiteboard-preview';
    import { whiteboardViewMode, whiteboardSortKey, MANAGER_SORT_OPTIONS } from './whiteboard-view-prefs';

    export let plugin: Plugin;

    interface ViewSection {
        key: string;
        name?: string;
        items: WhiteboardItem[];
    }

    interface ContextMenuState {
        visible: boolean;
        x: number;
        y: number;
        item: WhiteboardItem | null;
    }



    let allItems: WhiteboardItem[] = [];
    let filteredItems: WhiteboardItem[] = [];
    let viewSections: ViewSection[] = [];
    let searchQuery = '';
    let showOnlyValid = true;
    let loading = true;
    let groupByTag = false;

    let availableTags: string[] = [];
    let selectedTagFilter = '';

    let contextMenu: ContextMenuState = { visible: false, x: 0, y: 0, item: null };
    let rootEl: HTMLDivElement; // 面板根元素：右键菜单定位基准（position: relative）

    let selectedIds: Set<string> = new Set();
    let selectedItems: WhiteboardItem[] = [];
    let visibleSelectedCount = 0;
    let lastSelectedId: string | null = null;

    let observer: IntersectionObserver;
    let unsubscribe: () => void;

    function pruneSelection() {
        const validIds = new Set(allItems.map(item => item.id));
        let changed = false;
        selectedIds.forEach(id => {
            if (!validIds.has(id)) {
                selectedIds.delete(id);
                changed = true;
            }
        });
        if (changed) {
            selectedIds = new Set(selectedIds);
        }
    }

    // ==================== 标签编辑 ====================
    let editingTagItem: WhiteboardItem | null = null;
    let editingTags: string[] = [];
    let tagInputQuery = '';
    let showTagSuggestions = false;
    let savingTags = false;

    function startEditTags(item: WhiteboardItem) {
        editingTagItem = item;
        editingTags = item.tags.slice();
        tagInputQuery = '';
        showTagSuggestions = false;
    }

    function closeTagEditor() {
        editingTagItem = null;
        editingTags = [];
        tagInputQuery = '';
        showTagSuggestions = false;
    }

    function getTagSuggestions(): string[] {
        const query = tagInputQuery.trim().toLowerCase();
        if (!query) {
            return availableTags.filter(t => !editingTags.includes(t));
        }
        return availableTags.filter(t =>
            !editingTags.includes(t) && t.toLowerCase().includes(query)
        );
    }

    function addTag(tag: string) {
        if (tag && !editingTags.includes(tag)) {
            editingTags = [...editingTags, tag];
        }
        tagInputQuery = '';
        showTagSuggestions = false;
    }

    function removeTag(tag: string) {
        editingTags = editingTags.filter(t => t !== tag);
    }

    function handleTagInputKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter' && tagInputQuery.trim()) {
            const tag = tagInputQuery.trim();
            if (!editingTags.includes(tag)) {
                addTag(tag);
            }
        } else if (event.key === 'Escape') {
            showTagSuggestions = false;
        }
    }

    async function saveTags() {
        if (!editingTagItem || savingTags) return;
        savingTags = true;

        try {
            const newTagsValue = editingTags.join(',');
            await api.setBlockAttrs(editingTagItem.id, { tags: newTagsValue });

            // Update local state - 单个条目刷新
            const itemId = editingTagItem.id;
            const idx = allItems.findIndex(i => i.id === itemId);
            if (idx !== -1) {
                allItems[idx] = { ...allItems[idx], tags: editingTags.slice() };
                allItems = allItems;
                collectAvailableTags();
                // 触发响应式更新
                filteredItems = filteredItems;
                buildViewSections();
            }

            showMessage('标签已保存', 2000, 'info');

            // 延迟刷新单个条目以确保数据已同步到数据库
            setTimeout(async () => {
                const itemToRefresh = allItems.find(i => i.id === itemId);
                if (itemToRefresh) {
                    await refreshItem(itemToRefresh);
                }
            }, 500);

            closeTagEditor();
        } catch (e) {
            console.error('保存标签失败:', e);
            showMessage('保存标签失败', 3000, 'error');
        } finally {
            savingTags = false;
        }
    }

    async function handleBulkAddTag(tag: string) {
        if (!tag || selectedItems.length === 0) return;
        try {
            for (const item of selectedItems) {
                if (!item.tags.includes(tag)) {
                    const newTags = [...item.tags, tag];
                    const newTagsValue = newTags.join(',');
                    await api.setBlockAttrs(item.id, { tags: newTagsValue });
                }
            }
            showMessage(`已为 ${selectedItems.length} 个白板添加标签 "${tag}"`, 3000, 'info');
            await loadWhiteboards();
        } catch (e) {
            console.error('批量添加标签失败:', e);
            showMessage('批量添加标签失败', 3000, 'error');
        }
    }

    async function handleBulkRemoveTag(tag: string) {
        if (!tag || selectedItems.length === 0) return;
        try {
            for (const item of selectedItems) {
                if (item.tags.includes(tag)) {
                    const newTags = item.tags.filter(t => t !== tag);
                    const newTagsValue = newTags.join(',');
                    await api.setBlockAttrs(item.id, { tags: newTagsValue });
                }
            }
            showMessage(`已从 ${selectedItems.length} 个白板移除标签 "${tag}"`, 3000, 'info');
            await loadWhiteboards();
        } catch (e) {
            console.error('批量移除标签失败:', e);
            showMessage('批量移除标签失败', 3000, 'error');
        }
    }

    $: {
        searchQuery;
        showOnlyValid;
        $whiteboardSortKey;
        selectedTagFilter;
        applyFilters();
    }
    $: {
        filteredItems;
        groupByTag;
        buildViewSections();
    }
    $: {
        pruneSelection();
        selectedItems = allItems.filter(item => selectedIds.has(item.id));
        visibleSelectedCount = filteredItems.filter(item => selectedIds.has(item.id)).length;
    }

    onMount(() => {
        loadWhiteboards();
    });

    onDestroy(() => {
        if (unsubscribe) unsubscribe();
        if (observer) {
            observer.disconnect();
        }
    });

    async function loadWhiteboards() {
        loading = true;
        allItems = [];
        try {
            const files: any[] = await api.readDir('/data/storage/petal/sttools/');
            const whiteboardFiles = files.filter(f => !f.isDir && f.name.startsWith('tldraw-data-') && f.name.endsWith('.json'));

            const items: WhiteboardItem[] = [];
            for (const file of whiteboardFiles) {
                const id = extractDrawingId(file.name);
                const item: WhiteboardItem = {
                    id,
                    fileName: file.name,
                    path: `/data/storage/petal/sttools/${file.name}`,
                    title: '未知白板',
                    exists: false,
                    blkCreated: 0,
                    blkUpdated: 0,
                    docCreated: 0,
                    docUpdated: 0,
                    docId: undefined,
                    mtime: parseSyTimestamp(file.mtime),
                    tags: [],
                    loadingPreview: false,
                    previewLoaded: false,
                    shapes: [],
                    previewError: undefined,
                };

                try {
                    const blk = await api.getBlockByID(id);
                    if (blk) {
                        item.exists = true;
                        item.blkCreated = parseSyTimestamp(blk.created);
                        item.blkUpdated = parseSyTimestamp(blk.updated);
                        item.tags = parseBlockTags(blk.tag);
                        item.docId = blk.root_id || undefined;

                        if (blk.root_id) {
                            const docBlk = await api.getBlockByID(blk.root_id);
                            if (docBlk) {
                                item.title = docBlk.fcontent || docBlk.content || '未命名文档';
                                item.docCreated = parseSyTimestamp(docBlk.created);
                                item.docUpdated = parseSyTimestamp(docBlk.updated);
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`获取白板 ${id} 元数据失败:`, e);
                }

                items.push(item);
            }

            allItems = items;
            pruneSelection();
            collectAvailableTags();
            applyFilters();
        } catch (e) {
            console.error('加载白板列表失败:', e);
            showMessage('加载白板列表失败', 4000, 'error');
        } finally {
            loading = false;
        }
    }

    function collectAvailableTags() {
        const tagSet = new Set<string>();
        allItems.forEach(item => item.tags.forEach(tag => tagSet.add(tag)));
        availableTags = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
    }

    function applyFilters() {
        let list = allItems.slice();

        if (showOnlyValid) {
            list = list.filter(item => item.exists);
        }

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            list = list.filter(item =>
                item.id.toLowerCase().includes(q) ||
                item.title.toLowerCase().includes(q) ||
                item.fileName.toLowerCase().includes(q) ||
                item.tags.some(tag => tag.toLowerCase().includes(q))
            );
        }

        if (selectedTagFilter) {
            list = list.filter(item => item.tags.includes(selectedTagFilter));
        }

        switch ($whiteboardSortKey) {
            case 'mtime-desc':
            case 'blkUpdated-desc':
                list.sort((a, b) => b.blkUpdated - a.blkUpdated);
                break;
            case 'mtime-asc':
            case 'blkUpdated-asc':
                list.sort((a, b) => a.blkUpdated - b.blkUpdated);
                break;
            case 'blkCreated-desc':
                list.sort((a, b) => b.blkCreated - a.blkCreated);
                break;
            case 'blkCreated-asc':
                list.sort((a, b) => a.blkCreated - b.blkCreated);
                break;
            case 'title':
                list.sort((a, b) => a.title.localeCompare(b.title));
                break;
            case 'id':
                list.sort((a, b) => a.id.localeCompare(b.id));
                break;
            case 'exists':
                list.sort((a, b) => Number(b.exists) - Number(a.exists));
                break;
        }

        filteredItems = list;
    }

    function buildViewSections() {
        if (groupByTag) {
            const tagMap = new Map<string, WhiteboardItem[]>();
            filteredItems.forEach(item => {
                if (item.tags.length === 0) {
                    const bucket = tagMap.get('未分组') || [];
                    bucket.push(item);
                    tagMap.set('未分组', bucket);
                } else {
                    item.tags.forEach(tag => {
                        const bucket = tagMap.get(tag) || [];
                        bucket.push(item);
                        tagMap.set(tag, bucket);
                    });
                }
            });
            viewSections = Array.from(tagMap.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([name, items]) => ({ key: 'tag:' + name, name, items }));
        } else {
            viewSections = [{ key: 'all', items: filteredItems.slice() }];
        }
    }

    async function openWhiteboard(item: WhiteboardItem) {
        if (!item.exists) {
            showMessage('该白板块不存在，无法打开', 3000, 'error');
            return;
        }
        try {
            await openTab({
                app: plugin.app,
                custom: {
                    id: plugin.name + 'steveTool-whiteboard',
                    title: item.title,
                    icon: 'iconSTWhiteboard',
                    data: {
                        text: 'steveTool-whiteboard' + item.id,
                        rootid: item.id,
                    },
                },
            });
        } catch (e) {
            console.error('打开白板失败:', e);
            showMessage('打开白板失败', 3000, 'error');
        }
    }

    async function openDocument(item: WhiteboardItem) {
        if (!item.docId) {
            showMessage('未找到关联文档', 3000, 'info');
            return;
        }
        try {
            await openTab({
                app: plugin.app,
                doc: {
                    id: item.docId,
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

    function toggleSelection(item: WhiteboardItem, checked?: boolean, useRange = false) {
        const next = new Set(selectedIds);
        const shouldSelect = typeof checked === 'boolean' ? checked : !next.has(item.id);

        if (useRange && lastSelectedId) {
            const ids = filteredItems.map(i => i.id);
            const start = ids.indexOf(lastSelectedId);
            const end = ids.indexOf(item.id);
            if (start !== -1 && end !== -1) {
                const [lo, hi] = start <= end ? [start, end] : [end, start];
                for (let i = lo; i <= hi; i++) {
                    if (shouldSelect) next.add(ids[i]);
                    else next.delete(ids[i]);
                }
            }
        }

        if (shouldSelect) next.add(item.id);
        else next.delete(item.id);

        selectedIds = next;
        lastSelectedId = item.id;
    }

    // 列表/紧凑视图中复选框的选择处理（支持 Shift 范围选择）
    function handleRowSelect(event: Event, item: WhiteboardItem) {
        event.stopPropagation();
        const target = event.currentTarget as HTMLInputElement;
        toggleSelection(item, target.checked, (event as MouseEvent).shiftKey);
    }

    function selectAllVisible() {
        const next = new Set(selectedIds);
        filteredItems.forEach(item => next.add(item.id));
        selectedIds = next;
    }

    function clearSelection() {
        selectedIds = new Set();
        lastSelectedId = null;
    }

    function handleBulkDeleteSelected() {
        if (selectedItems.length === 0) return;
        confirmDelete([...selectedItems], clearSelection);
    }

    function handleBulkBackupSelected() {
        if (selectedItems.length === 0) return;
        void backupItems([...selectedItems], clearSelection);
    }

    function confirmDelete(items: WhiteboardItem[], onCompleted?: () => void) {
        if (items.length === 0) return;
        confirm(
            '删除确认',
            `确定要删除 ${items.length} 个白板文件吗？此操作不可恢复！`,
            async (dialog) => {
                let successCount = 0;
                const deletedItems: WhiteboardItem[] = [];
                
                for (const item of items) {
                    try {
                        // 关闭此白板的页签（如果存在），这将自动触发销毁回调
                        closeTab(item.id, 'user-delete');

                        // 再删除白板文件
                        await api.removeFile(item.path);
                        successCount++;
                        deletedItems.push(item);
                        
                        // 通知其他组件白板已删除
                        whiteboardFilesUpdated.set({
                            action: 'delete',
                            fileName: item.fileName,
                            drawingId: item.id,
                            timestamp: Date.now(),
                        });
                    } catch (error) {
                        console.error(`删除 ${item.fileName} 失败:`, error);
                    }
                }

                // 为了应对 tldraw 的自动保存竞争问题，延迟 2 秒再尝试一次删除
                // 如果自动保存在同时写回文件，第二次删除会把它彻底移除
                if (deletedItems.length > 0) {
                    setTimeout(async () => {
                        for (const item of deletedItems) {
                            try {
                                await api.removeFile(item.path);
                                console.debug(`延迟删除成功: ${item.path}`);
                            } catch (e) {
                                // 如果第二次删除失败，记录日志但不打扰用户
                                console.debug('延迟删除重试失败（可能已被移除）:', item.path, e);
                            }
                        }
                    }, 2000);
                }

                showMessage(`成功删除 ${successCount}/${items.length} 个白板`, 3000, 'info');
                closeContextMenu();
                await loadWhiteboards();
                onCompleted?.();

                try {
                    dialog && (dialog as any).close && (dialog as any).close();
                } catch {}
            },
            (dialog) => {
                try {
                    dialog && (dialog as any).close && (dialog as any).close();
                } catch {}
            }
        );
    }

    // 批量删除已移除，保留单项删除（右键菜单）

    async function backupItems(items: WhiteboardItem[], onCompleted?: () => void) {
        if (items.length === 0) return;
        try {
            const whiteboardIds = items.map(item => item.id);
            const results = await WhiteboardFileManager.batchBackupWhiteboards(whiteboardIds, {
                reason: '手动备份',
                includeTimestamp: true,
            });

            const stats = WhiteboardFileManager.getOperationStats(results);
            if (stats.success > 0) {
                showMessage(
                    `成功备份 ${stats.success}/${items.length} 个白板到 ${WHITEBOARD_TRASH_DIR}`,
                    4000,
                    'info'
                );
            } else {
                showMessage('备份失败', 3000, 'error');
            }
        } catch (e) {
            console.error('备份失败:', e);
            showMessage('备份失败', 3000, 'error');
        }
        onCompleted?.();
    }

    // 批量备份已移除，保留单项备份（右键菜单）

    // 标签编辑、批量添加/移除与多选相关逻辑已移除

    // 右键菜单以面板根元素为定位基准（position: absolute），坐标由工具函数换算并夹取在面板范围内
    function handleContextMenu(event: MouseEvent, item: WhiteboardItem) {
        event.preventDefault();
        const { x, y } = pointerMenuPosition(rootEl, event, 180, 210);
        contextMenu = { visible: true, x, y, item };
    }

    function closeContextMenu() {
        contextMenu = { visible: false, x: 0, y: 0, item: null };
    }

    function handleWindowClick(event: MouseEvent) {
        if (!contextMenu.visible) return;
        const target = event.target as HTMLElement;
        if (target && target.closest('.whiteboard-context-menu')) return;
        closeContextMenu();
    }

    function handleWindowKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && contextMenu.visible) {
            closeContextMenu();
        }
    }

    function handleWindowContextMenu(event: MouseEvent) {
        if (!event.defaultPrevented && contextMenu.visible) {
            closeContextMenu();
        }
    }

    async function refreshItem(item: WhiteboardItem) {
        try {
            // 刷新白板元数据
            const blk = await api.getBlockByID(item.id);
            if (blk) {
                item.exists = true;
                item.blkCreated = parseSyTimestamp(blk.created);
                item.blkUpdated = parseSyTimestamp(blk.updated);
                item.tags = parseBlockTags(blk.tag);
                item.docId = blk.root_id || undefined;

                if (blk.root_id) {
                    const docBlk = await api.getBlockByID(blk.root_id);
                    if (docBlk) {
                        item.title = docBlk.fcontent || docBlk.content || '未命名文档';
                        item.docCreated = parseSyTimestamp(docBlk.created);
                        item.docUpdated = parseSyTimestamp(docBlk.updated);
                    }
                }
            } else {
                item.exists = false;
            }

            // 清除旧预览，触发重新加载
            item.shapes = [];
            item.previewRects = [];
            item.previewError = undefined;
            item.loadingPreview = false;
            item.previewLoaded = false;

            // 触发响应式更新
            const idx = allItems.findIndex(i => i.id === item.id);
            if (idx !== -1) {
                allItems[idx] = { ...item };
                allItems = allItems;
            }

            // 更新过滤列表中的对应项
            const filteredIdx = filteredItems.findIndex(i => i.id === item.id);
            if (filteredIdx !== -1) {
                filteredItems[filteredIdx] = { ...item };
                filteredItems = filteredItems;
            }

            // 重新收集标签并更新过滤列表和视图数据
            collectAvailableTags();
            applyFilters();
            buildViewSections();

            showMessage('已刷新', 1500, 'info');
        } catch (e) {
            console.error('刷新白板失败:', e);
            showMessage('刷新失败', 2000, 'error');
        }
    }

    function handleMenuAction(action: 'delete' | 'backup' | 'doc' | 'board' | 'refresh') {
        const item = contextMenu.item;
        if (!item) return;
        switch (action) {
            case 'delete':
                confirmDelete([item]);
                break;
            case 'backup':
                void backupItems([item]).finally(() => closeContextMenu());
                break;
            case 'doc':
                openDocument(item).finally(() => closeContextMenu());
                break;
            case 'board':
                openWhiteboard(item).finally(() => closeContextMenu());
                break;
            case 'refresh':
                refreshItem(item).finally(() => closeContextMenu());
                break;
        }
    }


    async function loadPreview(item: WhiteboardItem) {
        if (item.loadingPreview || item.shapes.length > 0 || item.previewError) return;
        item.loadingPreview = true;
        try {
            const shapes = await fetchWhiteboardShapes(item.path);
            item.shapes = shapes;
            item.previewRects = projectAllShapes(shapes, 300, 200, SVG_PAD);
        } catch (e) {
            console.warn('缩略图加载失败:', e);
            item.previewError = '预览失败';
        } finally {
            item.loadingPreview = false;
            item.previewLoaded = true;
            // trigger reactive updates for arrays used in template
            allItems = allItems;
            filteredItems = filteredItems;
            viewSections = viewSections;
            try { await tick(); } catch {}
        }
    }

    function setupObserver(node: HTMLElement, item: WhiteboardItem) {
        const rootEl = document.querySelector('.gallery-scroll') as Element | null;
        // If existing observer's root is different (e.g. after re-render/refresh), recreate it
        if (observer && observer.root !== (rootEl ?? null)) {
            try { observer.disconnect(); } catch {}
            observer = undefined as unknown as IntersectionObserver;
        }

        if (!observer) {
            observer = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const targetItem = (entry.target as any).__whiteboardItem as WhiteboardItem;
                        if (targetItem) {
                            loadPreview(targetItem);
                        }
                        try { observer.unobserve(entry.target); } catch {}
                    }
                });
            }, {
                root: rootEl ?? null,
                rootMargin: '320px 0px 320px 0px',
                threshold: 0.05,
            });
        }

        (node as any).__whiteboardItem = item;
        try { observer.observe(node); } catch {}

        return {
            update(newItem: WhiteboardItem) {
                (node as any).__whiteboardItem = newItem;
                try { observer.observe(node); } catch {}
            },
            destroy() {
                try { observer.unobserve(node); } catch {}
            },
        };
    }

    $: {
        if (!unsubscribe) {
            unsubscribe = whiteboardFilesUpdated.subscribe(({ action }) => {
                if (action === 'refresh' || action === 'delete') {
                    loadWhiteboards();
                }
            });
        }
    }
</script>

<svelte:window on:click={handleWindowClick} on:keydown={handleWindowKeydown} on:contextmenu={handleWindowContextMenu} />

<div class="whiteboard-manager">
    <div class="block__icons toolbar">
        <div class="block__logo">
            <svg class="block__logoicon"><use xlink:href="#iconSettings"></use></svg>
            白板高级管理
        </div>
        <span class="counter" title="已加载/总数">{filteredItems.length}/{allItems.length}</span>
        <span class="fn__flex-1"></span>

        <input
            class="b3-text-field search-input"
            type="text"
            placeholder="搜索标题、ID、标签..."
            bind:value={searchQuery} />
        <span class="fn__space"></span>

        <select class="b3-select select-sort" bind:value={$whiteboardSortKey}>
            {#each MANAGER_SORT_OPTIONS as opt (opt.key)}
                <option value={opt.key}>{opt.label}</option>
            {/each}
        </select>
        <span class="fn__space"></span>

        {#if availableTags.length > 0}
            <select class="b3-select select-tag" bind:value={selectedTagFilter}>
                <option value="">全部标签</option>
                {#each availableTags as tag}
                    <option value={tag}>{tag}</option>
                {/each}
            </select>
            <span class="fn__space"></span>
        {/if}

        <WhiteboardViewSwitcher />
        <span class="fn__space"></span>

        <button
            type="button"
            class="block__icon"
            class:block__icon--active={groupByTag}
            title={groupByTag ? '按标签分组 (已开启)' : '按标签分组'}
            aria-pressed={groupByTag}
            on:click={() => groupByTag = !groupByTag}>
            <svg><use xlink:href="#iconList"></use></svg>
        </button>
        <span class="fn__space"></span>

        <button
            type="button"
            class="block__icon"
            class:block__icon--active={showOnlyValid}
            title={showOnlyValid ? '显示全部' : '仅显示有效'}
            aria-pressed={showOnlyValid}
            on:click={() => showOnlyValid = !showOnlyValid}>
            <svg><use xlink:href={"#iconEye" + (showOnlyValid ? 'off' : '')}></use></svg>
        </button>
        <span class="fn__space"></span>
        <button
            type="button"
            class="block__icon"
            title="刷新"
            on:click={loadWhiteboards}>
            <svg><use xlink:href="#iconRefresh"></use></svg>
        </button>
    </div>
        {#if selectedItems.length > 0}
        <div class="selection-tools">
            <span class="selection-counter" title={`当前视图选中 ${visibleSelectedCount}/${filteredItems.length}`}>
                已选 {selectedItems.length}
            </span>
            <button type="button" class="b3-button" on:click={selectAllVisible} disabled={filteredItems.length === 0 || visibleSelectedCount === filteredItems.length}>
                全选
            </button>
            <button type="button" class="b3-button" on:click={clearSelection} disabled={selectedItems.length === 0}>
                清空
            </button>
            <button type="button" class="b3-button" on:click={handleBulkBackupSelected} disabled={selectedItems.length === 0}>
                备份选中
            </button>
            <button type="button" class="b3-button danger" on:click={handleBulkDeleteSelected} disabled={selectedItems.length === 0}>
                删除选中
            </button>
            {#if selectedItems.length > 0 && availableTags.length > 0}
                <span class="fn__space"></span>
                <select class="b3-select" style="font-size:12px" on:change={(e) => {
                    const sel = e.currentTarget;
                    if (sel.value) {
                        handleBulkAddTag(sel.value);
                        sel.value = '';
                    }
                }}>
                    <option value="">+ 添加标签</option>
                    {#each availableTags as tag}
                        <option value={tag}>{tag}</option>
                    {/each}
                </select>
                <select class="b3-select" style="font-size:12px" on:change={(e) => {
                    const sel = e.currentTarget;
                    if (sel.value) {
                        handleBulkRemoveTag(sel.value);
                        sel.value = '';
                    }
                }}>
                    <option value="">- 移除标签</option>
                    {#each availableTags as tag}
                        <option value={tag}>{tag}</option>
                    {/each}
                </select>
            {/if}
        </div>
        {/if}
    

    {#if loading}
        <div class="loading">加载中...</div>
    {:else if filteredItems.length === 0}
        <div class="empty">暂无匹配白板</div>
    {:else}
        <div class="gallery-scroll">
            {#each viewSections as sec (sec.key)}
                <section class="tag-group" class:plain={!sec.name}>
                    {#if sec.name}
                        <header class="tag-group__header">
                            <span class="tag-group__name">{sec.name}</span>
                            <span class="tag-group__count">{sec.items.length}</span>
                        </header>
                    {/if}

                    {#if $whiteboardViewMode === 'card'}
                        <!-- 卡片视图 -->
                        <div class="card-grid">
                            {#each sec.items as item (sec.key + ':' + item.id)}
                                <WhiteboardCard
                                    {item}
                                    {selectedIds}
                                    {setupObserver}
                                    on:contextmenu={(e) => handleContextMenu(e.detail.originalEvent, e.detail.item)}
                                    on:select={(e) => toggleSelection(e.detail.item, e.detail.checked, e.detail.shiftKey)}
                                    on:openboard={() => openWhiteboard(item)}
                                    on:opendoc={() => openDocument(item)}
                                    on:edittags={() => startEditTags(item)}
                                />
                            {/each}
                        </div>
                    {:else if $whiteboardViewMode === 'list'}
                        <!-- 列表视图 -->
                        <div class="rows">
                            {#each sec.items as item (sec.key + ':' + item.id)}
                                <div class="list-row" role="button" tabindex="0"
                                    class:selected={selectedIds.has(item.id)}
                                    title={item.title + (latestWhiteboardUpdate(item) ? '\n' + formatTime(latestWhiteboardUpdate(item)) : '')}
                                    on:click={() => openWhiteboard(item)}
                                    on:contextmenu={(e) => handleContextMenu(e, item)}
                                    on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWhiteboard(item); } }}>
                                    <label class="row-select" on:click|stopPropagation on:keydown|stopPropagation>
                                        <input type="checkbox" checked={selectedIds.has(item.id)}
                                            on:change={(e) => handleRowSelect(e, item)} />
                                    </label>
                                    <div class="row-thumb" use:setupObserver={item}>
                                        {#if item.previewError}
                                            <div class="thumb-fail"></div>
                                        {:else if item.loadingPreview || !item.previewLoaded}
                                            <div class="thumb-pending"></div>
                                        {:else if item.shapes.length === 0}
                                            <div class="thumb-blank"></div>
                                        {:else}
                                            <svg viewBox="0 0 300 200" class="preview-svg" preserveAspectRatio="xMidYMid meet">
                                                {#each item.previewRects ?? [] as pos}
                                                    <rect x={pos.x} y={pos.y} width={pos.w} height={pos.h} rx={SHAPE_RX} ry={SHAPE_RX} fill={SHAPE_FILL} stroke={SHAPE_STROKE} stroke-width="1" />
                                                {/each}
                                            </svg>
                                        {/if}
                                    </div>
                                    <div class="row-main">
                                        <div class="row-title">
                                            <span class="rt-text">{item.title}</span>
                                            {#if !item.exists}
                                                <span class="mini-warn">无效</span>
                                            {/if}
                                        </div>
                                        <div class="row-sub">
                                            <span class="rs-time">{formatRelativeTime(latestWhiteboardUpdate(item)) || formatTime(latestWhiteboardUpdate(item))}</span>
                                            {#if item.tags.length > 0}
                                                <span class="rs-tags">{item.tags.slice(0, 3).map(t => '#' + t).join('　')}</span>
                                            {/if}
                                        </div>
                                    </div>
                                </div>
                            {/each}
                        </div>
                    {:else}
                        <!-- 紧凑视图 -->
                        <div class="rows compact">
                            {#each sec.items as item (sec.key + ':' + item.id)}
                                <div class="compact-row" role="button" tabindex="0"
                                    class:selected={selectedIds.has(item.id)}
                                    title={item.title + '\n' + item.id + '\n' + formatTime(latestWhiteboardUpdate(item))}
                                    on:click={() => openWhiteboard(item)}
                                    on:contextmenu={(e) => handleContextMenu(e, item)}
                                    on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWhiteboard(item); } }}>
                                    <label class="row-select" on:click|stopPropagation on:keydown|stopPropagation>
                                        <input type="checkbox" checked={selectedIds.has(item.id)}
                                            on:change={(e) => handleRowSelect(e, item)} />
                                    </label>
                                    <span class="status-dot" class:miss={!item.exists}></span>
                                    <span class="cr-title">{item.title}</span>
                                    <span class="cr-time">{formatRelativeTime(latestWhiteboardUpdate(item))}</span>
                                </div>
                            {/each}
                        </div>
                    {/if}
                </section>
            {/each}
        </div>
    {/if}

    {#if editingTagItem}
        <div class="tag-editor-overlay" on:click={closeTagEditor} role="dialog" aria-label="编辑标签">
            <div class="tag-editor-modal" on:click|stopPropagation role="document">
                <header class="tag-editor-header">
                    <h3>编辑标签</h3>
                    <button type="button" class="close-btn" on:click={closeTagEditor}>
                        <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </header>
                <div class="tag-editor-body">
                    <div class="current-tags">
                        {#if editingTags.length === 0}
                            <span class="tag-empty">暂无标签</span>
                        {:else}
                            {#each editingTags as tag}
                                <span class="tag-pill removable" title="点击移除">
                                    {tag}
                                    <button type="button" class="remove-tag" on:click={() => removeTag(tag)}>×</button>
                                </span>
                            {/each}
                        {/if}
                    </div>
                    <div class="add-tag-row">
                        <input
                            class="b3-text-field"
                            type="text"
                            placeholder="输入或选择标签..."
                            bind:value={tagInputQuery}
                            on:input={() => showTagSuggestions = true}
                            on:keydown={handleTagInputKeydown} />
                        <button type="button" class="b3-button" on:click={() => tagInputQuery.trim() && addTag(tagInputQuery.trim())} disabled={!tagInputQuery.trim()}>
                            添加
                        </button>
                    </div>
                    {#if showTagSuggestions}
                        <ul class="tag-suggestions">
                            {#each getTagSuggestions() as tag}
                                <li>
                                    <button type="button" on:click={() => addTag(tag)}>{tag}</button>
                                </li>
                            {/each}
                            {#if tagInputQuery.trim() && !editingTags.includes(tagInputQuery.trim())}
                                <li>
                                    <button type="button" on:click={() => addTag(tagInputQuery.trim())}>
                                        创建 "{tagInputQuery.trim()}"
                                    </button>
                                </li>
                            {/if}
                            {#if getTagSuggestions().length === 0 && !tagInputQuery.trim()}
                                <li class="empty">无匹配标签</li>
                            {/if}
                        </ul>
                    {/if}
                </div>
                <footer class="tag-editor-footer">
                    <button type="button" class="b3-button" on:click={closeTagEditor}>取消</button>
                    <button type="button" class="b3-button b3-button--primary" on:click={saveTags} disabled={savingTags}>
                        {savingTags ? '保存中...' : '保存'}
                    </button>
                </footer>
            </div>
        </div>
    {/if}

    {#if contextMenu.visible && contextMenu.item}
        <WhiteboardContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            docId={contextMenu.item.docId}
            on:action={(e) => handleMenuAction(e.detail)}
        />
    {/if}
</div>

<style>
.whiteboard-manager {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--b3-theme-background);
    /* 右键菜单定位基准（菜单为 absolute） */
    position: relative;
}

.toolbar {
    display: flex;
    align-items: center;
    padding: 8px;
    background: var(--b3-theme-surface);
    border-bottom: 1px solid var(--b3-border-color);
    flex-shrink: 0;
    position: relative;
    z-index: 2;
}

.block__logo {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 14px;
    font-weight: 500;
}

.block__logoicon {
    width: 20px;
    height: 20px;
}

.counter {
    font-size: 12px;
    color: var(--b3-theme-on-surface);
    margin-left: 8px;
}

.search-input {
    width: 240px;
    max-width: 30%;
}

.select-sort,
.select-tag {
    font-size: 12px;
    padding: 4px 8px;
}

.selection-tools {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    position: relative;
    z-index: 1;
}

.selection-counter {
    font-size: 12px;
    color: var(--b3-theme-on-surface);
    padding: 4px 8px;
    border: 1px solid var(--b3-border-color);
    border-radius: 8px;
    background: var(--b3-theme-background);
}

.selection-tools .b3-button {
    padding: 4px 10px;
    font-size: 12px;
}

.selection-tools .b3-button.danger {
    color: var(--b3-theme-error);
    border-color: var(--b3-theme-error);
}


.gallery-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px 24px;
}

.card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
}

.tag-group {
    margin-bottom: 24px;
}

/* 非分组模式下的单一 section 不需要额外间距 */
.tag-group.plain {
    margin-bottom: 0;
}

.tag-group__header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
}

.tag-group__name {
    font-weight: 600;
}

.tag-group__count {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light);
}

/* ================= 列表视图 / 紧凑视图 ================= */
.rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.list-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 8px;
    cursor: pointer;
    outline: none;
    transition: background-color 0.12s ease, box-shadow 0.12s ease;
}
.list-row:hover {
    background: var(--b3-list-hover);
}
.list-row:focus-visible {
    box-shadow: 0 0 0 2px var(--b3-theme-primary);
}
.list-row.selected,
.compact-row.selected {
    background: var(--b3-theme-primary-lightest);
}

.row-select {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    cursor: pointer;
}
.row-select input {
    width: 14px;
    height: 14px;
    cursor: pointer;
    accent-color: var(--b3-theme-primary);
}

.row-thumb {
    width: 72px;
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
.preview-svg {
    width: 100%;
    height: 100%;
    display: block;
    user-select: none;
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
    gap: 6px;
    min-width: 0;
}
.rt-text {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.mini-warn {
    font-size: 10px;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 4px;
    background: var(--b3-theme-error);
    color: #fff;
    flex-shrink: 0;
}
.row-sub {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.65;
    min-width: 0;
}
.rs-time {
    flex-shrink: 0;
    white-space: nowrap;
}
.rs-tags {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* 缩略图占位 */
.thumb-pending {
    width: 60%;
    height: 60%;
    border-radius: 4px;
    animation: wbFadePulse 1.8s infinite;
    background: var(--b3-list-hover);
}
.thumb-blank,
.thumb-fail {
    width: 55%;
    height: 55%;
    border-radius: 4px;
    border: 1px dashed var(--b3-border-color);
}
.thumb-fail {
    border-color: var(--b3-theme-error);
    opacity: 0.5;
}

.rows.compact {
    gap: 0;
}
.compact-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
    outline: none;
    transition: background-color 0.12s ease, box-shadow 0.12s ease;
}
.compact-row:hover {
    background: var(--b3-list-hover);
}
.compact-row:focus-visible {
    box-shadow: 0 0 0 2px var(--b3-theme-primary);
}
.compact-row .row-select input {
    width: 13px;
    height: 13px;
}
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
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cr-time {
    font-size: 10.5px;
    color: var(--b3-theme-on-surface);
    opacity: 0.5;
    flex-shrink: 0;
    white-space: nowrap;
}

@keyframes wbFadePulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 0.7; }
}

.loading,
.empty {
    padding: 40px;
    text-align: center;
    color: var(--b3-theme-on-surface-light);
}

@media (max-width: 1200px) {
    .search-input {
        width: 180px;
    }
    .card-grid {
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    }
}

@media (max-width: 800px) {
    .toolbar {
        flex-wrap: wrap;
        gap: 8px;
    }
    .search-input {
        width: 100%;
        max-width: 100%;
    }
}

/* 标签编辑器弹窗 */
.tag-editor-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
}

.tag-editor-modal {
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-border-color);
    border-radius: 12px;
    box-shadow: 0 24px 48px rgba(0, 0, 0, 0.2);
    width: 90%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
}

.tag-editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--b3-border-color);
}

.tag-editor-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
}

.close-btn {
    border: none;
    background: transparent;
    color: var(--b3-theme-on-surface);
    padding: 4px;
    border-radius: 4px;
    cursor: pointer;
}

.close-btn:hover {
    background: var(--b3-list-hover);
}

.tag-editor-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.current-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 32px;
    padding: 8px;
    background: var(--b3-theme-background);
    border-radius: 8px;
}

.add-tag-row {
    display: flex;
    gap: 8px;
}

.add-tag-row input {
    flex: 1;
}

.tag-suggestions {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    border: 1px solid var(--b3-border-color);
    border-radius: 8px;
    background: var(--b3-theme-surface);
    max-height: 180px;
    overflow-y: auto;
}

.tag-suggestions li {
    margin: 0;
}

.tag-suggestions button {
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    font-size: 13px;
    cursor: pointer;
    color: var(--b3-theme-on-background);
}

.tag-suggestions button:hover {
    background: var(--b3-list-hover);
}

.tag-suggestions li.empty {
    padding: 8px 12px;
    color: var(--b3-theme-on-surface-light);
    font-size: 12px;
}

.tag-editor-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 16px;
    border-top: 1px solid var(--b3-border-color);
}
</style>
