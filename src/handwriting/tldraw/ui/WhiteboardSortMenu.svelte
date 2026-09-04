<script lang="ts">
    /**
     * 统一的排序下拉菜单：取代 dock 的自定义菜单与管理器的 <select>。
     * 选项来自 WHITEBOARD_SORT_OPTIONS，写入两面板共享的 whiteboardSortKey。
     * 菜单相对自身按钮定位（wrapper position: relative），无需面板坐标换算。
     */
    import { whiteboardSortKey, WHITEBOARD_SORT_OPTIONS } from './whiteboard-view-prefs';

    let open = false;
    let rootEl: HTMLDivElement;

    $: currentLabel = (WHITEBOARD_SORT_OPTIONS.find(o => o.key === $whiteboardSortKey) || WHITEBOARD_SORT_OPTIONS[0]).label;

    function toggle() { open = !open; }
    function choose(key: string) {
        whiteboardSortKey.set(key);
        open = false;
    }
    function onWindowClick(event: MouseEvent) {
        if (!open) return;
        const target = event.target as HTMLElement;
        if (rootEl && target && rootEl.contains(target)) return;
        open = false;
    }
    function onWindowKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') open = false;
    }
</script>

<svelte:window on:click={onWindowClick} on:keydown={onWindowKeydown} />

<div class="wb-sort" bind:this={rootEl}>
    <button type="button" class="wb-sort__btn" class:active={open}
        aria-label="排序方式" aria-expanded={open} aria-haspopup="menu"
        on:click|stopPropagation={toggle}>
        <svg class="wb-sort__ico"><use xlink:href="#iconSort"></use></svg>
        <span class="wb-sort__label">{currentLabel}</span>
        <svg class="wb-sort__caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5" /></svg>
    </button>
    {#if open}
        <div class="wb-sort__menu" role="menu" aria-label="排序方式">
            {#each WHITEBOARD_SORT_OPTIONS as opt (opt.key)}
                <button type="button" role="menuitem" class:selected={opt.key === $whiteboardSortKey}
                    on:click|stopPropagation={() => choose(opt.key)}>
                    <span class="wb-sort__opt">{opt.label}</span>
                    {#if opt.key === $whiteboardSortKey}
                        <svg class="wb-sort__check"><use xlink:href="#iconCheck"></use></svg>
                    {/if}
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
.wb-sort { position: relative; flex-shrink: 0; }

.wb-sort__btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 24px;
    padding: 0 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--b3-theme-on-background);
    cursor: pointer;
    opacity: 0.62;
    transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
    max-width: 100%;
}
.wb-sort__btn:hover { background: var(--b3-list-hover); opacity: 1; }
.wb-sort__btn.active {
    color: var(--b3-theme-primary);
    opacity: 1;
    background: var(--b3-theme-primary-lightest);
}
.wb-sort__ico { width: 14px; height: 14px; fill: currentColor; flex-shrink: 0; }
.wb-sort__label {
    font-size: 11px;
    max-width: 72px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.wb-sort__caret { width: 9px; height: 9px; fill: none; stroke: currentColor; flex-shrink: 0; }

.wb-sort__menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 30;
    min-width: 168px;
    max-height: 260px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-border-color);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
}
.wb-sort__menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: none;
    cursor: pointer;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 12.5px;
    text-align: left;
    color: var(--b3-theme-on-background);
    transition: background-color 0.1s ease;
}
.wb-sort__menu button:hover { background: var(--b3-list-hover); }
.wb-sort__menu button.selected {
    color: var(--b3-theme-primary);
    background: var(--b3-theme-primary-lightest);
    font-weight: 500;
}
.wb-sort__opt { flex: 1; white-space: nowrap; }
.wb-sort__check { width: 14px; height: 14px; fill: currentColor; flex-shrink: 0; }

/* dock 宽度较窄时隐藏文字标签（依赖面板根的 container-type: inline-size） */
@container (max-width: 300px) {
    .wb-sort__label { display: none; }
}

@media (prefers-color-scheme: dark) {
    .wb-sort__menu { box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5); }
}
</style>
