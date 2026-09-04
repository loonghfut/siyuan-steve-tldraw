<script lang="ts">
    /**
     * 统一的白板列表项渲染器：card / list / compact 三种视图共用同一组件，
     * dock 卡片面板与高级管理面板复用。取代此前 dock 内联 3 视图 + 管理器内联
     * list/compact + whiteboard-card.svelte 的重复实现。
     */
    import { createEventDispatcher } from 'svelte';
    import type { Writable } from 'svelte/store';
    import type { WhiteboardEntry } from '../utils/whiteboard-utils';
    import { formatTime, formatRelativeTime, MISSING_BLOCK_LABEL } from '../utils/whiteboard-utils';
    import type { PreviewState } from './whiteboard-list-controller';
    import WhiteboardPreview from './WhiteboardPreview.svelte';

    export let entry: WhiteboardEntry;
    export let mode: 'card' | 'list' | 'compact' = 'card';
    export let previewStore: Writable<PreviewState>;
    /** 是否处于选中态（多选） */
    export let selected = false;
    /** 是否显示多选框与标签编辑入口（管理器为 true，dock 为 false） */
    export let selectable = false;
    /** 控制器提供的预览懒加载 action */
    export let observePreview: (
        node: HTMLElement,
        info: { id: string; path: string },
    ) => { update(info: { id: string; path: string }): void; destroy(): void };

    const MAX_TAGS = 3;

    const dispatch = createEventDispatcher<{
        open: { entry: WhiteboardEntry };
        opendoc: { entry: WhiteboardEntry };
        contextmenu: { entry: WhiteboardEntry; originalEvent: MouseEvent };
        select: { entry: WhiteboardEntry; checked: boolean; shiftKey: boolean };
        edittags: { entry: WhiteboardEntry };
    }>();

    $: previewInfo = { id: entry.id, path: entry.path };
    $: timeText = formatRelativeTime(entry.updatedAt) || formatTime(entry.updatedAt);
    $: fullTime = formatTime(entry.updatedAt);

    function openBoard() { dispatch('open', { entry }); }
    function openDoc() { if (entry.docId) dispatch('opendoc', { entry }); }
    function editTags() { dispatch('edittags', { entry }); }

    function onContextMenu(event: MouseEvent) {
        event.preventDefault();
        dispatch('contextmenu', { entry, originalEvent: event });
    }
    function onSelectChange(event: Event) {
        event.stopPropagation();
        const target = event.currentTarget as HTMLInputElement;
        dispatch('select', { entry, checked: target.checked, shiftKey: (event as MouseEvent).shiftKey });
    }
    function onKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openBoard();
        }
    }
</script>

{#if mode === 'card'}
    <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
    <article class="wb-card" class:invalid={!entry.exists} class:selected
        role="button" tabindex="0" aria-label={entry.title}
        on:click={openBoard} on:contextmenu={onContextMenu} on:keydown={onKeydown}>
        {#if selectable}
            <label class="wb-card__select" aria-label="选择白板" on:click|stopPropagation on:keydown|stopPropagation>
                <input type="checkbox" checked={selected} on:change={onSelectChange} />
            </label>
            <button type="button" class="wb-card__edittags" title="编辑标签" on:click|stopPropagation={editTags}>
                <svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
            </button>
        {/if}
        <div class="wb-card__preview" use:observePreview={previewInfo}>
            <WhiteboardPreview {previewStore} variant="card" />
            <div class="wb-card__overlay"></div>
        </div>
        <div class="wb-card__info">
            <div class="wb-card__title">
                <button type="button" class="wb-card__titlelink" title={entry.title}
                    disabled={!entry.docId} on:click|stopPropagation={openDoc}>{entry.title}</button>
                {#if !entry.exists}<span class="wb-badge">{MISSING_BLOCK_LABEL}</span>{/if}
            </div>
            {#if entry.tags.length > 0}
                <div class="wb-card__tags">
                    {#each entry.tags.slice(0, MAX_TAGS) as tag, i (i)}
                        <span class="wb-tag" title={'#' + tag}>#{tag}</span>
                    {/each}
                    {#if entry.tags.length > MAX_TAGS}
                        <span class="wb-tag-more">+{entry.tags.length - MAX_TAGS}</span>
                    {/if}
                </div>
            {/if}
            {#if entry.updatedAt}
                <div class="wb-card__meta" title={fullTime}>
                    <svg class="wb-tiny"><use xlink:href="#iconClock"></use></svg>
                    <span>{timeText}</span>
                </div>
            {/if}
        </div>
    </article>
{:else if mode === 'list'}
    <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
    <div class="wb-row" class:selected role="button" tabindex="0"
        title={entry.title + (fullTime !== '-' ? '\n' + fullTime : '')}
        on:click={openBoard} on:contextmenu={onContextMenu} on:keydown={onKeydown}>
        {#if selectable}
            <label class="wb-row__select" on:click|stopPropagation on:keydown|stopPropagation>
                <input type="checkbox" checked={selected} on:change={onSelectChange} />
            </label>
        {/if}
        <div class="wb-row__thumb" use:observePreview={previewInfo}>
            <WhiteboardPreview {previewStore} variant="thumb" />
        </div>
        <div class="wb-row__main">
            <div class="wb-row__title">
                <span class="wb-row__text">{entry.title}</span>
                {#if !entry.exists}<span class="wb-badge">{MISSING_BLOCK_LABEL}</span>{/if}
            </div>
            <div class="wb-row__sub">
                {#if entry.updatedAt}<span class="wb-row__time">{timeText}</span>{/if}
                {#if entry.tags.length > 0}
                    <span class="wb-row__tags">{entry.tags.slice(0, MAX_TAGS).map(t => '#' + t).join('　')}</span>
                {/if}
            </div>
        </div>
    </div>
{:else}
    <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
    <div class="wb-compact" class:selected role="button" tabindex="0"
        title={entry.title + '\n' + entry.id + (fullTime !== '-' ? '\n' + fullTime : '')}
        on:click={openBoard} on:contextmenu={onContextMenu} on:keydown={onKeydown}>
        {#if selectable}
            <label class="wb-row__select" on:click|stopPropagation on:keydown|stopPropagation>
                <input type="checkbox" checked={selected} on:change={onSelectChange} />
            </label>
        {/if}
        <span class="wb-dot" class:miss={!entry.exists}></span>
        <span class="wb-compact__title">{entry.title}</span>
        {#if entry.updatedAt}<span class="wb-compact__time">{timeText}</span>{/if}
    </div>
{/if}

<style>
/* ================= 通用徽章 ================= */
.wb-badge {
    display: inline-flex;
    align-items: center;
    font-size: 9px;
    line-height: 1;
    padding: 2.5px 5px;
    border-radius: 4px;
    font-weight: 500;
    flex-shrink: 0;
    background: var(--b3-theme-error-background, rgba(255, 0, 0, 0.08));
    color: var(--b3-theme-error);
}

/* ================= 卡片视图 ================= */
.wb-card {
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
.wb-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.1);
    border-color: var(--b3-theme-primary-light);
}
.wb-card:active { transform: translateY(0) scale(0.99); }
.wb-card:focus-visible { box-shadow: 0 0 0 2px var(--b3-theme-primary); }
.wb-card.invalid { opacity: 0.72; }
.wb-card.selected {
    border-color: var(--b3-theme-primary);
    box-shadow: 0 0 0 1px var(--b3-theme-primary), 0 6px 16px rgba(61, 142, 255, 0.16);
}

.wb-card__preview {
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
.wb-card__overlay {
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
.wb-card__overlay::after {
    content: "打开白板";
    font-size: 11px;
    line-height: 1;
    color: #fff;
    padding: 5px 11px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.45);
    transform: translateY(4px);
    transition: transform 0.18s ease;
}
.wb-card:hover .wb-card__overlay { opacity: 1; }
.wb-card:hover .wb-card__overlay::after { transform: translateY(0); }

.wb-card__select {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 2;
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-border-color);
    border-radius: 6px;
    padding: 3px;
    display: inline-flex;
    align-items: center;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    cursor: pointer;
}
.wb-card__select input {
    width: 15px;
    height: 15px;
    cursor: pointer;
    accent-color: var(--b3-theme-primary);
}
.wb-card__edittags {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 2;
    border: 1px solid var(--b3-border-color);
    background: var(--b3-theme-surface);
    color: var(--b3-theme-on-surface-light);
    border-radius: 6px;
    padding: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    opacity: 0;
    transition: opacity 0.15s ease, color 0.15s ease;
}
.wb-card:hover .wb-card__edittags,
.wb-card:focus-within .wb-card__edittags { opacity: 1; }
.wb-card__edittags:hover { color: var(--b3-theme-primary); }

.wb-card__info {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 7px 9px 9px;
}
.wb-card__title {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
}
.wb-card__titlelink {
    border: none;
    background: transparent;
    padding: 0;
    font: inherit;
    font-weight: 600;
    font-size: 12.5px;
    line-height: 1.35;
    color: inherit;
    text-align: left;
    cursor: pointer;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.wb-card__titlelink:hover:not(:disabled) { color: var(--b3-theme-primary); }
.wb-card__titlelink:disabled { cursor: default; }
.wb-card__tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
}
.wb-tag {
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
.wb-tag-more {
    font-size: 10px;
    line-height: 1;
    padding: 3px 0;
    color: var(--b3-theme-on-surface);
    opacity: 0.55;
}
.wb-card__meta {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--b3-theme-on-surface);
    opacity: 0.6;
    min-width: 0;
}
.wb-tiny { width: 10px; height: 10px; fill: currentColor; flex-shrink: 0; }

/* ================= 列表视图 ================= */
.wb-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px;
    border-radius: 8px;
    cursor: pointer;
    outline: none;
    transition: background-color 0.12s ease, box-shadow 0.12s ease;
}
.wb-row:hover { background: var(--b3-list-hover); }
.wb-row:focus-visible { box-shadow: 0 0 0 2px var(--b3-theme-primary); }
.wb-row.selected { background: var(--b3-theme-primary-lightest); }

.wb-row__select {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    cursor: pointer;
}
.wb-row__select input {
    width: 14px;
    height: 14px;
    cursor: pointer;
    accent-color: var(--b3-theme-primary);
}
.wb-row__thumb {
    width: 68px;
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
.wb-row__main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.wb-row__title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wb-row__text {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 12.5px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.wb-row__sub {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10.5px;
    color: var(--b3-theme-on-surface);
    opacity: 0.65;
    min-width: 0;
}
.wb-row__time { flex-shrink: 0; white-space: nowrap; }
.wb-row__tags { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ================= 紧凑视图 ================= */
.wb-compact {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
    outline: none;
    transition: background-color 0.12s ease, box-shadow 0.12s ease;
}
.wb-compact:hover { background: var(--b3-list-hover); }
.wb-compact:focus-visible { box-shadow: 0 0 0 2px var(--b3-theme-primary); }
.wb-compact.selected { background: var(--b3-theme-primary-lightest); }
.wb-compact .wb-row__select input { width: 13px; height: 13px; }
.wb-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--b3-theme-primary);
    opacity: 0.7;
}
.wb-dot.miss { background: var(--b3-theme-error); opacity: 0.6; }
.wb-compact__title {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.wb-compact__time {
    font-size: 10px;
    color: var(--b3-theme-on-surface);
    opacity: 0.5;
    flex-shrink: 0;
    white-space: nowrap;
}

/* ================= 深色模式 ================= */
@media (prefers-color-scheme: dark) {
    .wb-card { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
    .wb-card:hover { box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45); }
}
</style>
