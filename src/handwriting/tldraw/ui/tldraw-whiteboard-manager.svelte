<script lang="ts">
    /**
     * 白板高级管理面板（Tab）——薄壳。
     * 与 dock 卡片面板共用 WhiteboardListController 与全部展示组件；
     * 本面板额外提供：标签过滤、按标签分组、多选与批量操作、标签编辑。
     */
    import { onMount, onDestroy } from 'svelte';
    import { Plugin } from 'siyuan';
    import { WhiteboardListController } from './whiteboard-list-controller';
    import { whiteboardViewMode } from './whiteboard-view-prefs';
    import { pointerMenuPosition } from '../utils/whiteboard-utils';
    import type { WhiteboardEntry } from '../utils/whiteboard-utils';
    import WhiteboardListItem from './WhiteboardListItem.svelte';
    import WhiteboardSortMenu from './WhiteboardSortMenu.svelte';
    import WhiteboardViewSwitcher from './WhiteboardViewSwitcher.svelte';
    import WhiteboardStates from './WhiteboardStates.svelte';
    import WhiteboardContextMenu from './WhiteboardContextMenu.svelte';
    import WhiteboardTagEditor from './WhiteboardTagEditor.svelte';

    export let plugin: Plugin;

    const controller = new WhiteboardListController({ plugin, mode: 'manager', selectable: true });
    const {
        sections, rendered, visible, entries, loading, hasMore,
        onlyValid, groupByTag, tagFilter, availableTags,
        selection, selectedEntries, visibleSelectedCount,
    } = controller;
    const observePreview = controller.observePreview;
    const observeSentinel = controller.observeSentinel;
    const loadMore = controller.loadMore;

    // ========== 搜索（本地输入 + 防抖） ==========
    let searchInput = '';
    let searchInputEl: HTMLInputElement;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    function onSearchInput() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => controller.query.set(searchInput), 180);
    }
    function clearSearch() {
        searchInput = '';
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        controller.query.set('');
    }

    // ========== 滚动容器 / 面板根 ==========
    let scrollEl: HTMLDivElement;
    let rootEl: HTMLDivElement;
    $: if (scrollEl) controller.attachScrollRoot(scrollEl);
    // 滚动兜底：接近底部时加载下一批（补充 IntersectionObserver）
    function handleScroll() {
        if (!scrollEl || !$hasMore) return;
        if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 240) loadMore();
    }

    // ========== 标签编辑 ==========
    let editingEntry: WhiteboardEntry | null = null;
    function startEditTags(entry: WhiteboardEntry) { editingEntry = entry; }
    async function saveTags(tags: string[]): Promise<boolean> {
        if (!editingEntry) return false;
        return controller.editTags(editingEntry, tags);
    }

    // ========== 右键菜单 ==========
    let contextMenu = { visible: false, x: 0, y: 0, entry: null as WhiteboardEntry | null };
    function openContextMenu(event: MouseEvent, entry: WhiteboardEntry) {
        const { x, y } = pointerMenuPosition(rootEl, event, 180, 250);
        contextMenu = { visible: true, x, y, entry };
    }
    function closeContextMenu() { contextMenu = { visible: false, x: 0, y: 0, entry: null }; }
    function handleMenuAction(action: string) {
        const entry = contextMenu.entry;
        closeContextMenu();
        if (!entry) return;
        switch (action) {
            case 'board': controller.openBoard(entry); break;
            case 'doc': controller.openDoc(entry); break;
            case 'refresh': controller.refresh(entry); break;
            case 'backup': controller.backup([entry]); break;
            case 'edittags': startEditTags(entry); break;
            case 'delete': controller.remove([entry]); break;
        }
    }

    // ========== 批量操作 ==========
    function bulkBackup() { controller.backup($selectedEntries); }
    function bulkDelete() { controller.remove($selectedEntries, () => controller.clearSelection()); }
    function onBulkAddTag(event: Event) {
        const sel = event.currentTarget as HTMLSelectElement;
        if (sel.value) { controller.bulkAddTag(sel.value, $selectedEntries); sel.value = ''; }
    }
    function onBulkRemoveTag(event: Event) {
        const sel = event.currentTarget as HTMLSelectElement;
        if (sel.value) { controller.bulkRemoveTag(sel.value, $selectedEntries); sel.value = ''; }
    }

    function isTypingTarget(el: EventTarget | null): boolean {
        const node = el as HTMLElement | null;
        const tag = node?.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || !!node?.isContentEditable;
    }
    function onWindowClick(event: MouseEvent) {
        if (!contextMenu.visible) return;
        const target = event.target as HTMLElement;
        if (target && target.closest('.whiteboard-context-menu')) return;
        closeContextMenu();
    }
    function onWindowKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && contextMenu.visible) {
            closeContextMenu();
            return;
        }
        if (!isTypingTarget(event.target) && !editingEntry &&
            (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f'))) {
            event.preventDefault();
            searchInputEl?.focus();
        }
    }

    onMount(() => { controller.load(); });
    onDestroy(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        controller.dispose();
    });
</script>

<svelte:window on:click={onWindowClick} on:keydown={onWindowKeydown} />

<div class="wb-manager" bind:this={rootEl}>
    <!-- 工具栏 -->
    <div class="wb-toolbar">
        <div class="wb-logo">
            <svg class="wb-logo__icon"><use xlink:href="#iconSettings"></use></svg>
            <span>白板高级管理</span>
        </div>
        <span class="wb-count" title="匹配 / 总数">{$visible.length}/{$entries.length}</span>

        <div class="wb-search">
            <input class="b3-text-field wb-search__input" type="text" placeholder="搜索标题 / ID / 标签…"
                bind:this={searchInputEl} bind:value={searchInput} on:input={onSearchInput}
                on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); clearSearch(); } }} />
            {#if searchInput}
                <button type="button" class="wb-search__clear" aria-label="清除搜索" on:click={clearSearch}>
                    <svg><use xlink:href="#iconClose"></use></svg>
                </button>
            {/if}
        </div>

        <WhiteboardSortMenu />

        {#if $availableTags.length > 0}
            <select class="b3-select wb-select" bind:value={$tagFilter} aria-label="按标签筛选">
                <option value="">全部标签</option>
                {#each $availableTags as tag (tag)}
                    <option value={tag}>{tag}</option>
                {/each}
            </select>
        {/if}

        <WhiteboardViewSwitcher />

        <button type="button" class="wb-btn" class:active={$groupByTag} aria-pressed={$groupByTag}
            title={$groupByTag ? '按标签分组（已开启）' : '按标签分组'}
            on:click={() => groupByTag.set(!$groupByTag)}>
            <svg><use xlink:href="#iconList"></use></svg>
        </button>
        <button type="button" class="wb-btn" class:active={$onlyValid} aria-pressed={$onlyValid}
            title={$onlyValid ? '仅显示有效（点击显示全部）' : '显示全部（点击仅显示有效）'}
            on:click={() => onlyValid.set(!$onlyValid)}>
            <svg><use xlink:href={"#iconEye" + ($onlyValid ? 'off' : '')}></use></svg>
        </button>
        <button type="button" class="wb-btn" aria-label="刷新" on:click={() => controller.load()}>
            <svg><use xlink:href="#iconRefresh"></use></svg>
        </button>
    </div>

    <!-- 选择操作条 -->
    {#if $selectedEntries.length > 0}
        <div class="wb-selection">
            <span class="wb-selection__count" title={`当前视图选中 ${$visibleSelectedCount}/${$visible.length}`}>
                已选 {$selectedEntries.length}
            </span>
            <button type="button" class="b3-button" on:click={() => controller.selectAllVisible()}
                disabled={$visible.length === 0 || $visibleSelectedCount === $visible.length}>全选</button>
            <button type="button" class="b3-button" on:click={() => controller.clearSelection()}>清空</button>
            <button type="button" class="b3-button" on:click={bulkBackup}>备份选中</button>
            <button type="button" class="b3-button wb-danger" on:click={bulkDelete}>移入回收站</button>
            {#if $availableTags.length > 0}
                <span class="wb-spacer"></span>
                <select class="b3-select wb-select" on:change={onBulkAddTag} aria-label="批量添加标签">
                    <option value="">+ 添加标签</option>
                    {#each $availableTags as tag (tag)}<option value={tag}>{tag}</option>{/each}
                </select>
                <select class="b3-select wb-select" on:change={onBulkRemoveTag} aria-label="批量移除标签">
                    <option value="">− 移除标签</option>
                    {#each $availableTags as tag (tag)}<option value={tag}>{tag}</option>{/each}
                </select>
            {/if}
        </div>
    {/if}

    <!-- 内容区 -->
    {#if $loading}
        <div class="wb-scroll">
            <WhiteboardStates variant="skeleton" viewMode={$whiteboardViewMode} />
        </div>
    {:else if $visible.length === 0}
        <WhiteboardStates variant="empty" title="暂无匹配白板" hint="试试调整搜索、标签或筛选条件，或点击刷新" />
    {:else}
        <div class="wb-scroll" bind:this={scrollEl} on:scroll={handleScroll}>
            {#each $sections as sec (sec.key)}
                <section class="wb-group" class:plain={!sec.name}>
                    {#if sec.name}
                        <header class="wb-group__header">
                            <span class="wb-group__name">{sec.name}</span>
                            <span class="wb-group__count">{sec.items.length}</span>
                        </header>
                    {/if}
                    <div class="wb-list"
                        class:grid={$whiteboardViewMode === 'card'}
                        class:rows={$whiteboardViewMode === 'list'}
                        class:compact={$whiteboardViewMode === 'compact'}>
                        {#each sec.items as entry (sec.key + ':' + entry.id)}
                            <WhiteboardListItem
                                {entry}
                                mode={$whiteboardViewMode}
                                previewStore={controller.previewStore(entry.id)}
                                {observePreview}
                                selectable={true}
                                selected={$selection.has(entry.id)}
                                on:open={(e) => controller.openBoard(e.detail.entry)}
                                on:opendoc={(e) => controller.openDoc(e.detail.entry)}
                                on:edittags={(e) => startEditTags(e.detail.entry)}
                                on:select={(e) => controller.toggleSelect(e.detail.entry, e.detail.checked, e.detail.shiftKey)}
                                on:contextmenu={(e) => openContextMenu(e.detail.originalEvent, e.detail.entry)}
                            />
                        {/each}
                    </div>
                </section>
            {/each}

            {#if $hasMore}
                <div class="wb-sentinel" use:observeSentinel>
                    <span class="wb-loadmore" role="button" tabindex="0" aria-label="加载更多"
                        on:click={loadMore}
                        on:keydown={(e) => { if (e.key === 'Enter') loadMore(); }}>
                        加载更多（{$rendered.length}/{$visible.length}）
                    </span>
                </div>
            {:else if $visible.length > 0}
                <div class="wb-sentinel wb-sentinel--done">已全部加载 · 共 {$visible.length} 个</div>
            {/if}
        </div>
    {/if}

    {#if editingEntry}
        <WhiteboardTagEditor
            entry={editingEntry}
            availableTags={$availableTags}
            onSave={saveTags}
            onClose={() => (editingEntry = null)}
        />
    {/if}

    {#if contextMenu.visible && contextMenu.entry}
        <WhiteboardContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            docId={contextMenu.entry.docId}
            allowEditTags={true}
            on:action={(e) => handleMenuAction(e.detail)}
        />
    {/if}
</div>

<style>
.wb-manager {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--b3-theme-background);
    color: var(--b3-theme-on-background);
    position: relative;
    overflow: hidden;
}

/* ================= 工具栏 ================= */
.wb-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px;
    background: var(--b3-theme-surface);
    border-bottom: 1px solid var(--b3-border-color);
    flex-shrink: 0;
    position: relative;
    z-index: 3;
}
.wb-logo {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
}
.wb-logo__icon { width: 18px; height: 18px; fill: var(--b3-theme-primary); }
.wb-count {
    font-size: 11px;
    line-height: 1;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--b3-theme-primary-lightest);
    color: var(--b3-theme-primary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
.wb-spacer { flex: 1; }

.wb-search { position: relative; display: flex; align-items: center; }
.wb-search__input {
    width: 220px;
    max-width: 32vw;
    height: 26px;
    font-size: 12px;
    padding: 0 24px 0 8px;
    border-radius: 6px;
}
.wb-search__clear {
    position: absolute;
    right: 4px;
    border: none;
    background: transparent;
    cursor: pointer;
    width: 16px;
    height: 16px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--b3-theme-on-surface);
    opacity: 0.6;
    border-radius: 4px;
}
.wb-search__clear:hover { opacity: 1; background: var(--b3-list-hover); }
.wb-search__clear svg { width: 10px; height: 10px; fill: currentColor; }

.wb-select { font-size: 12px; height: 26px; padding: 0 8px; }

.wb-btn {
    border: none;
    background: transparent;
    color: var(--b3-theme-on-background);
    width: 26px;
    height: 26px;
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
.wb-btn:hover { background: var(--b3-list-hover); opacity: 1; }
.wb-btn.active {
    color: var(--b3-theme-primary);
    opacity: 1;
    background: var(--b3-theme-primary-lightest);
}
.wb-btn svg { width: 15px; height: 15px; fill: currentColor; }

/* ================= 选择操作条 ================= */
.wb-selection {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 12px;
    background: var(--b3-theme-primary-lightest);
    border-bottom: 1px solid var(--b3-border-color);
    flex-shrink: 0;
    position: relative;
    z-index: 2;
}
.wb-selection__count {
    font-size: 12px;
    font-weight: 500;
    color: var(--b3-theme-primary);
    padding: 3px 8px;
    border-radius: 8px;
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-border-color);
}
.wb-selection .b3-button { padding: 4px 10px; font-size: 12px; }
.wb-selection .wb-danger { color: var(--b3-theme-error); border-color: var(--b3-theme-error); }

/* ================= 滚动容器 ================= */
.wb-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px 24px;
}
.wb-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.wb-scroll::-webkit-scrollbar-thumb { background: var(--b3-border-color); border-radius: 4px; }
.wb-scroll::-webkit-scrollbar-thumb:hover { background: var(--b3-list-hover); }

.wb-group { margin-bottom: 24px; }
.wb-group.plain { margin-bottom: 0; }
.wb-group__header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
}
.wb-group__name { font-weight: 600; font-size: 13px; }
.wb-group__count { font-size: 12px; color: var(--b3-theme-on-surface-light); }

.wb-list.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
    align-items: start;
}
.wb-list.rows { display: flex; flex-direction: column; gap: 2px; }
.wb-list.compact { display: flex; flex-direction: column; gap: 0; }

/* ================= 触底哨兵 ================= */
.wb-sentinel {
    text-align: center;
    padding: 14px 0 4px;
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.55;
}
.wb-sentinel--done { opacity: 0.4; }
.wb-loadmore {
    cursor: pointer;
    display: inline-block;
    padding: 4px 14px;
    border-radius: 999px;
    border: 1px dashed var(--b3-border-color);
    transition: all 0.15s ease;
}
.wb-loadmore:hover {
    color: var(--b3-theme-primary);
    border-color: var(--b3-theme-primary-light);
    background: var(--b3-theme-primary-lightest);
}

/* ================= 响应式 ================= */
@media (max-width: 900px) {
    .wb-search__input { width: 160px; }
    .wb-list.grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
}
</style>
