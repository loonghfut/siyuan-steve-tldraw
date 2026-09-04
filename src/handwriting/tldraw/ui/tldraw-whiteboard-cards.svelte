<script lang="ts">
    /**
     * 白板卡片面板（dock 侧栏）——薄壳。
     * 数据加载/过滤/排序/预览/增删改全部委托给 WhiteboardListController，
     * 渲染委托给共享组件（WhiteboardListItem / SortMenu / ViewSwitcher / States / ContextMenu）。
     */
    import { onMount, onDestroy } from 'svelte';
    import { Plugin, showMessage, openTab } from 'siyuan';
    import { WhiteboardListController } from './whiteboard-list-controller';
    import { whiteboardViewMode } from './whiteboard-view-prefs';
    import { pointerMenuPosition } from '../utils/whiteboard-utils';
    import type { WhiteboardEntry } from '../utils/whiteboard-utils';
    import WhiteboardListItem from './WhiteboardListItem.svelte';
    import WhiteboardSortMenu from './WhiteboardSortMenu.svelte';
    import WhiteboardViewSwitcher from './WhiteboardViewSwitcher.svelte';
    import WhiteboardStates from './WhiteboardStates.svelte';
    import WhiteboardContextMenu from './WhiteboardContextMenu.svelte';

    export let plugin: Plugin;

    const controller = new WhiteboardListController({ plugin, mode: 'dock', selectable: false });
    const { rendered, visible, entries, loading, hasMore, onlyValid } = controller;
    // 别名绑定实例方法，便于在模板中作为 action / handler 使用（保留 this）
    const observePreview = controller.observePreview;
    const observeSentinel = controller.observeSentinel;
    const loadMore = controller.loadMore;

    // ========== 搜索（本地输入 + 防抖写入 controller.query） ==========
    let searchInput = '';
    let showSearch = false;
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
    function toggleSearch() {
        showSearch = !showSearch;
        if (showSearch) setTimeout(() => searchInputEl?.focus(), 10);
    }
    function focusSearch() {
        showSearch = true;
        setTimeout(() => searchInputEl?.focus(), 10);
    }

    // ========== 滚动容器 / 面板根 ==========
    let scrollEl: HTMLDivElement;
    let rootEl: HTMLDivElement;
    $: if (scrollEl) controller.attachScrollRoot(scrollEl);
    // 滚动兜底：接近底部时加载下一批（补充 IntersectionObserver，兼容一批内容不足以触发 IO 的情况）
    function handleScroll() {
        if (!scrollEl || !$hasMore) return;
        if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 200) loadMore();
    }

    // ========== 右键菜单 ==========
    let contextMenu = { visible: false, x: 0, y: 0, entry: null as WhiteboardEntry | null };
    function openContextMenu(event: MouseEvent, entry: WhiteboardEntry) {
        const { x, y } = pointerMenuPosition(rootEl, event, 180, 230);
        contextMenu = { visible: true, x, y, entry };
    }
    function closeContextMenu() {
        contextMenu = { visible: false, x: 0, y: 0, entry: null };
    }
    function handleMenuAction(action: string) {
        const entry = contextMenu.entry;
        closeContextMenu();
        if (!entry) return;
        switch (action) {
            case 'board': controller.openBoard(entry); break;
            case 'doc': controller.openDoc(entry); break;
            case 'refresh': controller.refresh(entry); break;
            case 'backup': controller.backup([entry]); break;
            case 'delete': controller.remove([entry]); break;
        }
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
        // "/" 或 Ctrl+F 聚焦搜索
        if (!isTypingTarget(event.target) && (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f'))) {
            event.preventDefault();
            focusSearch();
        }
    }

    // ========== 打开高级管理 Tab ==========
    async function openManagerTab() {
        try {
            await openTab({
                app: plugin.app,
                custom: {
                    id: plugin.name + 'steveTool-whiteboard-manager',
                    title: '白板高级管理',
                    icon: 'iconSettings',
                    data: { text: 'steveTool-whiteboard-manager' },
                },
            });
        } catch (e) {
            console.error('打开白板管理 Tab 失败:', e);
            showMessage('打开白板管理失败', 3000, 'error');
        }
    }

    onMount(() => { controller.load(); });
    onDestroy(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        controller.dispose();
    });
</script>

<svelte:window on:click={onWindowClick} on:keydown={onWindowKeydown} />

<div class="wb-dock" bind:this={rootEl}>
    <!-- 顶部工具栏 -->
    <div class="wb-toolbar">
        <div class="wb-toolbar__row">
            <div class="wb-logo">
                <svg class="wb-logo__icon"><use xlink:href="#iconSTWhiteboard"></use></svg>
                <span class="wb-logo__text">白板卡片</span>
            </div>
            <span class="wb-count" title="匹配 / 总数">{$visible.length}/{$entries.length}</span>
            {#if $loading}<span class="wb-hint">读取中…</span>{/if}
            <span class="wb-spacer"></span>
            {#if showSearch}
                <div class="wb-search">
                    <input class="b3-text-field wb-search__input" placeholder="搜索 ID / 标题 / 标签…"
                        bind:this={searchInputEl} bind:value={searchInput} on:input={onSearchInput}
                        on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); clearSearch(); showSearch = false; } }} />
                    {#if searchInput}
                        <button type="button" class="wb-search__clear" aria-label="清除搜索" on:click={clearSearch}>
                            <svg><use xlink:href="#iconClose"></use></svg>
                        </button>
                    {/if}
                </div>
            {/if}
            <button type="button" class="wb-btn" class:active={showSearch || !!searchInput}
                aria-label="搜索" aria-expanded={showSearch} on:click={toggleSearch}>
                <svg><use xlink:href="#iconSearch"></use></svg>
            </button>
            <button type="button" class="wb-btn" aria-label="刷新" on:click={() => controller.load()}>
                <svg><use xlink:href="#iconRefresh"></use></svg>
            </button>
            <button type="button" class="wb-btn" aria-label="打开高级管理" on:click={openManagerTab}>
                <svg><use xlink:href="#iconSettings"></use></svg>
            </button>
        </div>
        <div class="wb-toolbar__row wb-toolbar__sub">
            <WhiteboardViewSwitcher />
            <span class="wb-spacer"></span>
            <WhiteboardSortMenu />
            <button type="button" class="wb-btn" class:active={$onlyValid}
                aria-label={$onlyValid ? '当前仅显示存在的块，点击显示全部' : '当前显示全部，点击仅显示存在的块'}
                on:click={() => onlyValid.set(!$onlyValid)}>
                <svg><use xlink:href={"#iconEye" + ($onlyValid ? 'off' : '')}></use></svg>
            </button>
        </div>
    </div>

    <!-- 内容区 -->
    {#if $loading}
        <div class="wb-scroll">
            <WhiteboardStates variant="skeleton" viewMode={$whiteboardViewMode} />
        </div>
    {:else if $visible.length === 0}
        <WhiteboardStates variant="empty" title="暂无匹配白板" hint="试试调整搜索或筛选条件，或点击上方刷新" />
    {:else}
        <div class="wb-scroll" bind:this={scrollEl} on:scroll={handleScroll}>
            <div class="wb-list"
                class:grid={$whiteboardViewMode === 'card'}
                class:rows={$whiteboardViewMode === 'list'}
                class:compact={$whiteboardViewMode === 'compact'}>
                {#each $rendered as entry (entry.path)}
                    <WhiteboardListItem
                        {entry}
                        mode={$whiteboardViewMode}
                        previewStore={controller.previewStore(entry.id)}
                        {observePreview}
                        on:open={(e) => controller.openBoard(e.detail.entry)}
                        on:opendoc={(e) => controller.openDoc(e.detail.entry)}
                        on:contextmenu={(e) => openContextMenu(e.detail.originalEvent, e.detail.entry)}
                    />
                {/each}
            </div>

            {#if $hasMore}
                <div class="wb-sentinel" use:observeSentinel>
                    <span class="wb-loadmore" role="button" tabindex="0" aria-label="加载更多"
                        on:click={loadMore}
                        on:keydown={(e) => { if (e.key === 'Enter') loadMore(); }}>
                        加载更多（{$rendered.length}/{$visible.length}）
                    </span>
                </div>
            {:else if $rendered.length > 0}
                <div class="wb-sentinel wb-sentinel--done">已全部加载 · 共 {$rendered.length} 个</div>
            {/if}
        </div>
    {/if}

    {#if contextMenu.visible && contextMenu.entry}
        <WhiteboardContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            docId={contextMenu.entry.docId}
            on:action={(e) => handleMenuAction(e.detail)}
        />
    {/if}
</div>

<style>
/* ================= 布局骨架 ================= */
.wb-dock {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--b3-theme-background);
    color: var(--b3-theme-on-background);
    overflow: hidden;
    position: relative;
    container-type: inline-size;
}

.wb-toolbar {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 8px 5px;
    border-bottom: 1px solid var(--b3-border-color);
    user-select: none;
}
.wb-toolbar__row {
    display: flex;
    align-items: center;
    gap: 3px;
    min-height: 25px;
}
.wb-toolbar__sub { gap: 5px; }
.wb-spacer { flex: 1; }

.wb-logo {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    min-width: 0;
}
.wb-logo__icon { width: 17px; height: 17px; fill: var(--b3-theme-primary); opacity: 0.9; flex-shrink: 0; }
.wb-logo__text { white-space: nowrap; }

.wb-count {
    font-size: 10px;
    line-height: 1;
    padding: 3px 7px;
    border-radius: 999px;
    background: var(--b3-theme-primary-lightest);
    color: var(--b3-theme-primary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
.wb-hint {
    font-size: 0.66rem;
    color: var(--b3-theme-on-surface);
    opacity: 0.55;
    white-space: nowrap;
}

.wb-btn {
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
.wb-btn:hover { background: var(--b3-list-hover); opacity: 1; }
.wb-btn.active {
    color: var(--b3-theme-primary);
    opacity: 1;
    background: var(--b3-theme-primary-lightest);
}
.wb-btn svg { width: 14px; height: 14px; fill: currentColor; }

/* 搜索框（常驻、可清除） */
.wb-search { position: relative; display: flex; align-items: center; }
.wb-search__input {
    height: 24px;
    font-size: 12px;
    padding: 0 22px 0 8px;
    border-radius: 6px;
    min-width: 96px;
    max-width: 170px;
    width: 100%;
}
.wb-search__clear {
    position: absolute;
    right: 3px;
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

/* ================= 滚动容器 ================= */
.wb-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px 8px 12px;
}
.wb-scroll::-webkit-scrollbar { width: 6px; }
.wb-scroll::-webkit-scrollbar-track { background: transparent; }
.wb-scroll::-webkit-scrollbar-thumb { background: var(--b3-border-color); border-radius: 3px; }
.wb-scroll::-webkit-scrollbar-thumb:hover { background: var(--b3-list-hover); }

.wb-list.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(150px, 42%, 300px), 1fr));
    gap: 8px;
    align-items: start;
}
.wb-list.rows { display: flex; flex-direction: column; gap: 2px; }
.wb-list.compact { display: flex; flex-direction: column; gap: 0; }

/* ================= 触底哨兵 ================= */
.wb-sentinel {
    text-align: center;
    padding: 10px 0 4px;
    font-size: 10.5px;
    color: var(--b3-theme-on-surface);
    opacity: 0.55;
}
.wb-sentinel--done { opacity: 0.4; }
.wb-loadmore {
    cursor: pointer;
    display: inline-block;
    padding: 3px 12px;
    border-radius: 999px;
    border: 1px dashed var(--b3-border-color);
    transition: all 0.15s ease;
}
.wb-loadmore:hover {
    color: var(--b3-theme-primary);
    border-color: var(--b3-theme-primary-light);
    background: var(--b3-theme-primary-lightest);
}

/* ================= 容器自适应（dock 宽度变化） ================= */
@container (max-width: 280px) {
    .wb-logo__text { display: none; }
    .wb-search__input { min-width: 80px; }
}
</style>
