<script lang="ts">
    /**
     * 白板缩略图预览渲染器（卡片大图 / 列表小图共用）。
     * 订阅某个白板独立的预览 store，实现局部更新——预览加载不会触发整个列表重排/重渲染。
     */
    import type { Writable } from 'svelte/store';
    import type { PreviewState } from './whiteboard-list-controller';
    import { SHAPE_FILL, SHAPE_FILL_SOLID, SHAPE_STROKE, BORDER_STROKE, SHAPE_RX } from '../utils/whiteboard-utils';

    /** 该白板独立的预览状态 store */
    export let previewStore: Writable<PreviewState>;
    /** card: 卡片大图（含文字占位与边框）；thumb: 列表小图（图形占位） */
    export let variant: 'card' | 'thumb' = 'card';

    $: state = $previewStore;
</script>

{#if state.error}
    {#if variant === 'card'}
        <div class="pv-text pv-error">{state.error}</div>
    {:else}
        <div class="pv-thumb-block pv-fail"></div>
    {/if}
{:else if state.loading}
    {#if variant === 'card'}
        <div class="pv-text pv-loading">生成预览…</div>
    {:else}
        <div class="pv-thumb-block pv-pending"></div>
    {/if}
{:else if !state.loaded}
    {#if variant === 'card'}
        <div class="pv-text pv-loading">等待加载…</div>
    {:else}
        <div class="pv-thumb-block pv-pending"></div>
    {/if}
{:else if state.empty}
    {#if variant === 'card'}
        <div class="pv-text pv-blank">空白画板</div>
    {:else}
        <div class="pv-thumb-block pv-blank-block"></div>
    {/if}
{:else}
    <svg viewBox="0 0 300 200" class="pv-svg" preserveAspectRatio="xMidYMid meet">
        {#each state.prims ?? [] as prim, i (i)}
            {#if prim.kind === 'rect'}
                <rect x={prim.x} y={prim.y} width={prim.w} height={prim.h}
                    rx={SHAPE_RX} ry={SHAPE_RX}
                    fill={prim.filled ? SHAPE_FILL_SOLID : SHAPE_FILL}
                    stroke={SHAPE_STROKE} stroke-width="1" />
            {:else}
                <path d={prim.d}
                    fill={prim.filled ? SHAPE_FILL_SOLID : 'none'}
                    stroke={SHAPE_STROKE} stroke-width={prim.strokeWidth}
                    stroke-linecap="round" stroke-linejoin="round" />
            {/if}
        {/each}
        {#if variant === 'card'}
            <rect x="1" y="1" width="298" height="198" fill="none" stroke={BORDER_STROKE} />
        {/if}
    </svg>
{/if}

<style>
.pv-svg {
    width: 100%;
    height: 100%;
    display: block;
    user-select: none;
}

/* 卡片大图占位 */
.pv-text {
    font-size: 11px;
    color: var(--b3-theme-on-surface);
    opacity: 0.5;
    padding: 0 6px;
    text-align: center;
}
.pv-loading { animation: pvFadePulse 1.8s infinite; }
.pv-error {
    color: var(--b3-theme-error);
    opacity: 0.7;
    animation: none;
}

/* 列表小图占位 */
.pv-thumb-block {
    width: 58%;
    height: 58%;
    border-radius: 4px;
}
.pv-pending {
    width: 60%;
    height: 60%;
    background: var(--b3-list-hover);
    animation: pvFadePulse 1.8s infinite;
}
.pv-blank-block,
.pv-fail {
    border: 1px dashed var(--b3-border-color);
}
.pv-fail {
    border-color: var(--b3-theme-error);
    opacity: 0.5;
}

@keyframes pvFadePulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 0.7; }
}
</style>
