<script lang="ts">
    /**
     * 统一的加载骨架屏与空状态：两面板共用（修复此前 dock 有骨架屏、
     * 管理器只有"加载中..."文本的不一致）。
     */
    export let variant: 'skeleton' | 'empty' = 'empty';
    export let viewMode: 'card' | 'list' | 'compact' = 'card';
    export let title = '暂无匹配白板';
    export let hint = '试试调整搜索或筛选条件，或点击刷新';
</script>

{#if variant === 'skeleton'}
    {#if viewMode === 'card'}
        <div class="wb-skel-grid" aria-busy="true" aria-label="加载中">
            {#each Array(6) as _, i (i)}
                <div class="wb-skel-card">
                    <div class="wb-skel-thumb shimmer"></div>
                    <div class="wb-skel-lines">
                        <div class="wb-skel-line w60 shimmer"></div>
                        <div class="wb-skel-line w40 shimmer"></div>
                    </div>
                </div>
            {/each}
        </div>
    {:else}
        <div class="wb-skel-rows" aria-busy="true" aria-label="加载中">
            {#each Array(10) as _, i (i)}
                <div class="wb-skel-row shimmer"></div>
            {/each}
        </div>
    {/if}
{:else}
    <div class="wb-empty">
        <svg class="wb-empty__icon"><use xlink:href="#iconSTWhiteboard"></use></svg>
        <div class="wb-empty__title">{title}</div>
        <div class="wb-empty__hint">{hint}</div>
    </div>
{/if}

<style>
/* ================= 骨架屏 ================= */
.wb-skel-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(150px, 40%, 260px), 1fr));
    gap: 12px;
    align-items: start;
}
.wb-skel-card {
    border: 1px solid var(--b3-border-color);
    border-radius: 10px;
    overflow: hidden;
    background: var(--b3-theme-surface);
}
.wb-skel-thumb { aspect-ratio: 3 / 2; }
.wb-skel-lines {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.wb-skel-line { height: 8px; border-radius: 4px; }
.wb-skel-line.w60 { width: 60%; }
.wb-skel-line.w40 { width: 40%; }

.wb-skel-rows { display: flex; flex-direction: column; gap: 6px; }
.wb-skel-row { height: 44px; border-radius: 8px; }

.shimmer {
    background: linear-gradient(90deg, var(--b3-list-hover) 25%, var(--b3-theme-background) 45%, var(--b3-list-hover) 65%);
    background-size: 200% 100%;
    animation: wbShimmer 1.4s infinite linear;
}
@keyframes wbShimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
}

/* ================= 空状态 ================= */
.wb-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 40px 24px;
    text-align: center;
    color: var(--b3-theme-on-surface);
}
.wb-empty__icon { width: 44px; height: 44px; fill: currentColor; opacity: 0.18; }
.wb-empty__title { font-size: 13px; font-weight: 500; opacity: 0.6; }
.wb-empty__hint { font-size: 11px; opacity: 0.4; }
</style>
