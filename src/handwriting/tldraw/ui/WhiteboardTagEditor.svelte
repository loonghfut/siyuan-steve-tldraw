<script lang="ts">
    /**
     * 标签编辑弹窗（从管理器抽取为共享组件）。
     * 相比原实现补充：Esc 关闭、自动聚焦、焦点陷阱、建议项键盘上下导航（修复 U3）。
     */
    import { onMount } from 'svelte';
    import type { WhiteboardEntry } from '../utils/whiteboard-utils';

    export let entry: WhiteboardEntry;
    export let availableTags: string[] = [];
    /** 保存回调：返回 true 表示成功（由父层调用 controller.editTags） */
    export let onSave: (tags: string[]) => Promise<boolean>;
    export let onClose: () => void;

    let editingTags: string[] = entry.tags.slice();
    let inputQuery = '';
    let showSuggestions = false;
    let saving = false;
    let highlight = -1;

    let inputEl: HTMLInputElement;
    let modalEl: HTMLDivElement;

    onMount(() => {
        // 自动聚焦输入框
        setTimeout(() => inputEl?.focus(), 0);
    });

    $: suggestions = availableTags.filter(t =>
        !editingTags.includes(t) &&
        (!inputQuery.trim() || t.toLowerCase().includes(inputQuery.trim().toLowerCase()))
    );
    $: creatable = !!inputQuery.trim() &&
        !editingTags.includes(inputQuery.trim()) &&
        !suggestions.includes(inputQuery.trim());
    // 键盘导航的扁平菜单项：已有建议 + 可创建项
    $: menuItems = creatable ? [...suggestions, inputQuery.trim()] : suggestions;

    function addTag(tag: string) {
        const t = tag.trim();
        if (t && !editingTags.includes(t)) editingTags = [...editingTags, t];
        inputQuery = '';
        highlight = -1;
    }
    function removeTag(tag: string) {
        editingTags = editingTags.filter(t => t !== tag);
    }

    function moveHighlight(delta: number) {
        if (!menuItems.length) { highlight = -1; return; }
        if (highlight < 0) highlight = delta > 0 ? 0 : menuItems.length - 1;
        else highlight = (highlight + delta + menuItems.length) % menuItems.length;
    }

    function onInputKeydown(event: KeyboardEvent) {
        if (event.key === 'ArrowDown' && showSuggestions) {
            event.preventDefault();
            moveHighlight(1);
        } else if (event.key === 'ArrowUp' && showSuggestions) {
            event.preventDefault();
            moveHighlight(-1);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (showSuggestions && highlight >= 0 && highlight < menuItems.length) {
                addTag(menuItems[highlight]);
            } else if (inputQuery.trim()) {
                addTag(inputQuery.trim());
            }
        } else if (event.key === 'Backspace' && !inputQuery && editingTags.length) {
            removeTag(editingTags[editingTags.length - 1]);
        }
    }

    // 焦点陷阱：Tab 在弹窗内循环
    function trapFocus(event: KeyboardEvent) {
        if (event.key !== 'Tab' || !modalEl) return;
        const focusables = modalEl.querySelectorAll<HTMLElement>(
            'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function onWindowKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            if (showSuggestions) { showSuggestions = false; highlight = -1; }
            else onClose();
        }
    }

    async function submit() {
        if (saving) return;
        saving = true;
        try {
            const ok = await onSave(editingTags.slice());
            if (ok) onClose();
        } finally {
            saving = false;
        }
    }
</script>

<svelte:window on:keydown={onWindowKeydown} />

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="wb-tag-overlay" on:click={onClose} role="dialog" aria-modal="true" aria-label="编辑标签">
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="wb-tag-modal" bind:this={modalEl} on:click|stopPropagation on:keydown={trapFocus} role="document">
        <header class="wb-tag-header">
            <div class="wb-tag-heading">
                <h3>编辑标签</h3>
                <span class="wb-tag-subtitle" title={entry.title}>{entry.title}</span>
            </div>
            <button type="button" class="wb-tag-close" aria-label="关闭" on:click={onClose}>
                <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
        </header>

        <div class="wb-tag-body">
            <div class="wb-tag-current">
                {#if editingTags.length === 0}
                    <span class="wb-tag-empty">暂无标签</span>
                {:else}
                    {#each editingTags as tag (tag)}
                        <span class="wb-tag-pill">
                            {tag}
                            <button type="button" class="wb-tag-remove" aria-label={'移除 ' + tag} on:click={() => removeTag(tag)}>×</button>
                        </span>
                    {/each}
                {/if}
            </div>

            <div class="wb-tag-addrow">
                <input class="b3-text-field" type="text" bind:this={inputEl}
                    placeholder="输入或选择标签，回车添加…"
                    bind:value={inputQuery}
                    on:input={() => { showSuggestions = true; highlight = -1; }}
                    on:focus={() => { showSuggestions = true; }}
                    on:keydown={onInputKeydown} />
                <button type="button" class="b3-button" on:click={() => addTag(inputQuery)} disabled={!inputQuery.trim()}>
                    添加
                </button>
            </div>

            {#if showSuggestions}
                <ul class="wb-tag-suggestions">
                    {#each suggestions as tag, i (tag)}
                        <li>
                            <button type="button" class:active={i === highlight}
                                on:mouseenter={() => highlight = i}
                                on:click={() => addTag(tag)}>{tag}</button>
                        </li>
                    {/each}
                    {#if creatable}
                        <li>
                            <button type="button" class:active={highlight === menuItems.length - 1}
                                on:mouseenter={() => highlight = menuItems.length - 1}
                                on:click={() => addTag(inputQuery.trim())}>
                                创建 “{inputQuery.trim()}”
                            </button>
                        </li>
                    {/if}
                    {#if menuItems.length === 0}
                        <li class="wb-tag-noresult">无匹配标签，输入后回车可创建</li>
                    {/if}
                </ul>
            {/if}
        </div>

        <footer class="wb-tag-footer">
            <button type="button" class="b3-button" on:click={onClose} disabled={saving}>取消</button>
            <button type="button" class="b3-button b3-button--primary" on:click={submit} disabled={saving}>
                {saving ? '保存中…' : '保存'}
            </button>
        </footer>
    </div>
</div>

<style>
.wb-tag-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
}
.wb-tag-modal {
    background: var(--b3-theme-surface);
    border: 1px solid var(--b3-border-color);
    border-radius: 12px;
    box-shadow: 0 24px 48px rgba(0, 0, 0, 0.2);
    width: 90%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
}
.wb-tag-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--b3-border-color);
}
.wb-tag-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
.wb-tag-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wb-tag-subtitle {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
}
.wb-tag-close {
    border: none;
    background: transparent;
    color: var(--b3-theme-on-surface);
    padding: 4px;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
}
.wb-tag-close:hover { background: var(--b3-list-hover); }

.wb-tag-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.wb-tag-current {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 34px;
    padding: 8px;
    background: var(--b3-theme-background);
    border-radius: 8px;
}
.wb-tag-empty { font-size: 12px; color: var(--b3-theme-on-surface-light); opacity: 0.7; align-self: center; }
.wb-tag-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: rgba(61, 142, 255, 0.12);
    color: var(--b3-theme-primary);
    padding: 3px 6px 3px 10px;
    border-radius: 999px;
    font-size: 12px;
}
.wb-tag-remove {
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    border-radius: 50%;
    opacity: 0.7;
}
.wb-tag-remove:hover { opacity: 1; }

.wb-tag-addrow { display: flex; gap: 8px; }
.wb-tag-addrow input { flex: 1; }

.wb-tag-suggestions {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    border: 1px solid var(--b3-border-color);
    border-radius: 8px;
    background: var(--b3-theme-surface);
    max-height: 180px;
    overflow-y: auto;
}
.wb-tag-suggestions li { margin: 0; }
.wb-tag-suggestions button {
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    font-size: 13px;
    cursor: pointer;
    color: var(--b3-theme-on-background);
}
.wb-tag-suggestions button:hover,
.wb-tag-suggestions button.active { background: var(--b3-list-hover); }
.wb-tag-noresult { padding: 8px 12px; color: var(--b3-theme-on-surface-light); font-size: 12px; }

.wb-tag-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 16px;
    border-top: 1px solid var(--b3-border-color);
}
</style>
