<script lang="ts">
    import { createEventDispatcher } from 'svelte';

    export type WhiteboardMenuAction = 'board' | 'doc' | 'refresh' | 'backup' | 'delete';

    // 位置为面板内坐标（面板根 position: relative，本组件 position: absolute）
    export let x: number;
    export let y: number;
    export let docId: string | undefined = undefined;

    const dispatch = createEventDispatcher<{ action: WhiteboardMenuAction }>();
</script>

<div
    class="whiteboard-context-menu"
    role="menu"
    aria-label="白板菜单"
    tabindex="0"
    style={`left:${x}px;top:${y}px;`}
    on:click|stopPropagation
    on:keydown|stopPropagation>
    <button type="button" role="menuitem" on:click={() => dispatch('action', 'board')}>
        <svg class="menu-ico"><use xlink:href="#iconSTWhiteboard"></use></svg>打开白板
    </button>
    <button type="button" role="menuitem" on:click={() => dispatch('action', 'doc')} disabled={!docId}>
        <svg class="menu-ico"><use xlink:href="#iconLink"></use></svg>跳转文档
    </button>
    <button type="button" role="menuitem" on:click={() => dispatch('action', 'refresh')}>
        <svg class="menu-ico"><use xlink:href="#iconRefresh"></use></svg>刷新预览
    </button>
    <button type="button" role="menuitem" on:click={() => dispatch('action', 'backup')}>
        <svg class="menu-ico"><use xlink:href="#iconDatabaseBackup"></use></svg>备份
    </button>
    <div class="menu-divider"></div>
    <button type="button" role="menuitem" class="danger" on:click={() => dispatch('action', 'delete')}>
        <svg class="menu-ico"><use xlink:href="#iconTrashcan"></use></svg>删除
    </button>
</div>

<style>
.whiteboard-context-menu {
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

.whiteboard-context-menu button {
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
.whiteboard-context-menu button:hover {
    background: var(--b3-list-hover);
}
.whiteboard-context-menu button.danger {
    color: var(--b3-theme-error);
}
.whiteboard-context-menu button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.menu-ico {
    width: 14px;
    height: 14px;
    fill: currentColor;
    opacity: 0.75;
    flex-shrink: 0;
}

.menu-divider {
    height: 1px;
    background: var(--b3-border-color);
    margin: 4px 6px;
}

@media (prefers-color-scheme: dark) {
    .whiteboard-context-menu {
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    }
}
</style>
