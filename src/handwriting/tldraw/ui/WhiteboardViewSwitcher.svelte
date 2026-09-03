<script lang="ts">
    import { whiteboardViewMode } from './whiteboard-view-prefs';
    import type { WhiteboardViewMode } from './whiteboard-view-prefs';

    function setMode(mode: WhiteboardViewMode) {
        whiteboardViewMode.set(mode);
    }
</script>

<div class="view-switcher" role="group" aria-label="视图切换">
    <button type="button" class="view-btn b3-tooltips b3-tooltips__w" class:selected={$whiteboardViewMode === 'card'}
        aria-label="卡片视图" aria-pressed={$whiteboardViewMode === 'card'}
        on:click={() => setMode('card')}
        on:keydown={(e) => { if (e.key === 'Enter') setMode('card'); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3.5" y="3.5" width="7.2" height="7.2" rx="1.6" />
            <rect x="13.3" y="3.5" width="7.2" height="7.2" rx="1.6" />
            <rect x="3.5" y="13.3" width="7.2" height="7.2" rx="1.6" />
            <rect x="13.3" y="13.3" width="7.2" height="7.2" rx="1.6" />
        </svg>
    </button>
    <button type="button" class="view-btn b3-tooltips b3-tooltips__w" class:selected={$whiteboardViewMode === 'list'}
        aria-label="列表视图" aria-pressed={$whiteboardViewMode === 'list'}
        on:click={() => setMode('list')}
        on:keydown={(e) => { if (e.key === 'Enter') setMode('list'); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3.5" y="4.5" width="6.5" height="5" rx="1.4" />
            <path d="M13.5 6.2H20.5M13.5 7.8H17.5" />
            <rect x="3.5" y="14.5" width="6.5" height="5" rx="1.4" />
            <path d="M13.5 16.2H20.5M13.5 17.8H17.5" />
        </svg>
    </button>
    <button type="button" class="view-btn b3-tooltips b3-tooltips__w" class:selected={$whiteboardViewMode === 'compact'}
        aria-label="紧凑视图" aria-pressed={$whiteboardViewMode === 'compact'}
        on:click={() => setMode('compact')}
        on:keydown={(e) => { if (e.key === 'Enter') setMode('compact'); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <path d="M4 6.5H20M4 12H20M4 17.5H20" />
        </svg>
    </button>
</div>

<style>
.view-switcher {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--b3-theme-background);
  border: 1px solid var(--b3-border-color);
  border-radius: 8px;
  flex-shrink: 0;
}
.view-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  width: 28px;
  height: 20px;
  padding: 0;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--b3-theme-on-background);
  opacity: 0.5;
  transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}
.view-btn:hover {
  opacity: 0.9;
  background: var(--b3-list-hover);
}
.view-btn.selected {
  opacity: 1;
  color: var(--b3-theme-primary);
  background: var(--b3-theme-primary-lightest);
}
.view-btn svg {
  width: 14px;
  height: 14px;
}
</style>
