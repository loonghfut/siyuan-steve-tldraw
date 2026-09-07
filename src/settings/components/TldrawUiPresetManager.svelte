<script lang="ts">
  /**
   * 画板 UI 显隐预设方案管理器（唯一入口）
   *
   * 列表模式：展示所有方案，支持应用/编辑/复制/重命名/删除。
   * 编辑模式：内嵌全部工具栏 + 界面按钮复选框，新建或修改方案后保存并应用。
   * 数据：value = TldrawUiPresetsConfig { list, activeId }
   * 应用方案时通过 extraUpdates 一次性写入所有 tldraw-tool-* / tldraw-ui-* 开关。
   */
  import { createEventDispatcher } from 'svelte';
  import { showMessage, confirm as syConfirm } from 'siyuan';
  import {
    ALL_TOOLBAR_TOOL_IDS,
    ALL_UI_VISIBILITY_KEYS,
    TOOL_LABELS,
    UI_VISIBILITY_LABELS,
  } from '@/handwriting/tldraw/ui-overrides/ui-visibility';
  import {
    normalizePresetsConfig,
    applyPresetToSettings,
    presetMatchesSnapshot,
    snapshotVisibility,
    generatePresetId,
    duplicatePreset,
    type TldrawUiPreset,
    type TldrawUiPresetsConfig,
  } from '@/handwriting/tldraw/ui-overrides/ui-presets';
  import { settingdata } from '@/index';

  export let group: string;
  export let key: string;
  export let value: unknown;

  const dispatch = createEventDispatcher();

  // ==================== 派生状态 ====================

  $: config = normalizePresetsConfig(value);
  $: presets = config.list;
  $: activeId = config.activeId;
  $: activePreset = presets.find((p) => p.id === activeId) ?? null;
  $: currentSnapshot = (config, snapshotVisibility(settingdata as Record<string, any>));
  $: isDirty = activePreset ? !presetMatchesSnapshot(activePreset, currentSnapshot) : false;

  function presetSummary(p: TldrawUiPreset): string {
    const toolCount = ALL_TOOLBAR_TOOL_IDS.filter((id) => p.tools[id] !== false).length;
    const uiCount = ALL_UI_VISIBILITY_KEYS.filter((k) => p.ui[k] !== false).length;
    return `工具 ${toolCount}/${ALL_TOOLBAR_TOOL_IDS.length} · 按钮 ${uiCount}/${ALL_UI_VISIBILITY_KEYS.length}`;
  }

  // ==================== 持久化 ====================

  function emit(nextConfig: TldrawUiPresetsConfig, extraUpdates?: Record<string, any>) {
    value = nextConfig;
    dispatch('changed', { group, key, value: nextConfig, extraUpdates });
  }

  // ==================== 列表操作 ====================

  function applyPreset(preset: TldrawUiPreset) {
    const tmp: Record<string, any> = {};
    const updates = applyPresetToSettings(preset, tmp);
    emit({ list: presets, activeId: preset.id }, updates);
    showMessage(`已应用方案「${preset.name}」，重新打开白板后生效`, 3000, 'info');
  }

  function deletePreset(preset: TldrawUiPreset) {
    if (preset.builtin) { showMessage('内置方案不可删除', 2500, 'warning'); return; }
    syConfirm('删除方案', `确定删除方案「${preset.name}」吗？此操作不可撤销。`, () => {
      const list = presets.filter((p) => p.id !== preset.id);
      emit({ list, activeId: activeId === preset.id ? null : activeId });
      showMessage(`方案「${preset.name}」已删除`, 2500, 'info');
    });
  }

  function duplicatePresetAction(preset: TldrawUiPreset) {
    const copy = duplicatePreset(preset, presets);
    emit({ list: [...presets, copy], activeId });
    showMessage(`已复制为「${copy.name}」`, 2500, 'info');
  }

  function renamePreset(preset: TldrawUiPreset) {
    if (preset.builtin) { showMessage('内置方案不可重命名，请先复制为自定义方案', 2500, 'warning'); return; }
    const name = window.prompt('重命名方案', preset.name);
    if (name === null || !name.trim()) return;
    const list = presets.map((p) => p.id === preset.id ? { ...p, name: name.trim(), updatedAt: Date.now() } : p);
    emit({ list, activeId });
  }

  function deactivate() {
    emit({ list: presets, activeId: null });
  }

  // ==================== 编辑模式 ====================

  type EditorMode = 'create' | 'edit';
  let editorOpen = false;
  let editorMode: EditorMode = 'create';
  let editorId = '';           // 编辑目标 id（edit 模式）
  let editorName = '';
  let editorTools: Record<string, boolean> = {};
  let editorUi: Record<string, boolean> = {};

  /** 打开编辑器：新建（默认全显示） */
  function openCreate() {
    editorMode = 'create';
    editorId = '';
    editorName = '';
    editorTools = Object.fromEntries(ALL_TOOLBAR_TOOL_IDS.map(id => [id, true]));
    editorUi = Object.fromEntries(ALL_UI_VISIBILITY_KEYS.map(k => [k, true]));
    editorOpen = true;
  }

  /** 打开编辑器：编辑已有方案 */
  function openEdit(preset: TldrawUiPreset) {
    editorMode = 'edit';
    editorId = preset.id;
    editorName = preset.name;
    editorTools = Object.fromEntries(ALL_TOOLBAR_TOOL_IDS.map(id => [id, preset.tools[id] !== false]));
    editorUi = Object.fromEntries(ALL_UI_VISIBILITY_KEYS.map(k => [k, preset.ui[k] !== false]));
    editorOpen = true;
  }

  function closeEditor() {
    editorOpen = false;
  }

  function editorSetAllTools(v: boolean) {
    editorTools = Object.fromEntries(ALL_TOOLBAR_TOOL_IDS.map(id => [id, v]));
  }
  function editorSetAllUi(v: boolean) {
    editorUi = Object.fromEntries(ALL_UI_VISIBILITY_KEYS.map(k => [k, v]));
  }

  /** 保存编辑器内容并应用 */
  function editorSave() {
    const name = editorName.trim() || '未命名方案';
    const now = Date.now();
    let list: TldrawUiPreset[];
    let savedId: string;

    if (editorMode === 'edit' && editorId) {
      savedId = editorId;
      list = presets.map(p => p.id === editorId
        ? { ...p, name, tools: { ...editorTools }, ui: { ...editorUi }, updatedAt: now }
        : p);
    } else {
      savedId = generatePresetId();
      list = [...presets, {
        id: savedId, name,
        tools: { ...editorTools }, ui: { ...editorUi },
        builtin: false, createdAt: now, updatedAt: now,
      }];
    }

    // 应用：写入所有显隐开关
    const preset: TldrawUiPreset = { id: savedId, name, tools: editorTools, ui: editorUi, createdAt: now, updatedAt: now };
    const tmp: Record<string, any> = {};
    const updates = applyPresetToSettings(preset, tmp);
    emit({ list, activeId: savedId }, updates);
    editorOpen = false;
    showMessage(`方案「${name}」已保存并应用，重新打开白板后生效`, 3000, 'info');
  }

  /** 仅保存不应用 */
  function editorSaveOnly() {
    const name = editorName.trim() || '未命名方案';
    const now = Date.now();
    let list: TldrawUiPreset[];

    if (editorMode === 'edit' && editorId) {
      list = presets.map(p => p.id === editorId
        ? { ...p, name, tools: { ...editorTools }, ui: { ...editorUi }, updatedAt: now }
        : p);
    } else {
      list = [...presets, {
        id: generatePresetId(), name,
        tools: { ...editorTools }, ui: { ...editorUi },
        builtin: false, createdAt: now, updatedAt: now,
      }];
    }
    emit({ list, activeId });
    editorOpen = false;
    showMessage(`方案「${name}」已保存`, 2500, 'info');
  }

  // ==================== 详情展开 ====================

  let expandedId: string | null = null;
  function toggleExpand(id: string) { expandedId = expandedId === id ? null : id; }

  function hiddenTools(p: TldrawUiPreset): string[] {
    return ALL_TOOLBAR_TOOL_IDS.filter(id => p.tools[id] === false).map(id => TOOL_LABELS[id] ?? id);
  }
  function hiddenUi(p: TldrawUiPreset): string[] {
    return ALL_UI_VISIBILITY_KEYS.filter(k => p.ui[k] === false).map(k => UI_VISIBILITY_LABELS[k] ?? k);
  }
</script>

<div class="ui-preset-manager">
  {#if editorOpen}
    <!-- ==================== 编辑模式 ==================== -->
    <div class="editor-panel">
      <div class="editor-header">
        <span class="editor-title">{editorMode === 'create' ? '新建方案' : '编辑方案'}</span>
        <span class="fn__space"></span>
        <button class="b3-button b3-button--text b3-button--small" type="button" on:click={closeEditor}>✕ 取消</button>
      </div>

      <div class="editor-name-row">
        <label class="editor-name-label" for="preset-name-input">方案名称</label>
        <input
          id="preset-name-input"
          class="b3-text-field editor-name-input"
          type="text"
          placeholder="输入方案名称…"
          bind:value={editorName}
          maxlength="30"
        />
      </div>

      <div class="editor-body">
        <!-- 工具栏工具 -->
        <section class="editor-section">
          <div class="editor-section__header">
            <span class="editor-section__title">工具栏工具</span>
            <span class="editor-section__count">
              {ALL_TOOLBAR_TOOL_IDS.filter(id => editorTools[id]).length}/{ALL_TOOLBAR_TOOL_IDS.length}
            </span>
            <span class="fn__space"></span>
            <button class="b3-button b3-button--text b3-button--small" type="button" on:click={() => editorSetAllTools(true)}>全选</button>
            <button class="b3-button b3-button--text b3-button--small" type="button" on:click={() => editorSetAllTools(false)}>全不选</button>
          </div>
          <div class="editor-grid">
            {#each ALL_TOOLBAR_TOOL_IDS as id (id)}
              <label class="editor-check">
                <input type="checkbox" bind:checked={editorTools[id]} />
                <span>{TOOL_LABELS[id] ?? id}</span>
              </label>
            {/each}
          </div>
        </section>

        <!-- 界面按钮 -->
        <section class="editor-section">
          <div class="editor-section__header">
            <span class="editor-section__title">界面按钮 / 区域</span>
            <span class="editor-section__count">
              {ALL_UI_VISIBILITY_KEYS.filter(k => editorUi[k]).length}/{ALL_UI_VISIBILITY_KEYS.length}
            </span>
            <span class="fn__space"></span>
            <button class="b3-button b3-button--text b3-button--small" type="button" on:click={() => editorSetAllUi(true)}>全选</button>
            <button class="b3-button b3-button--text b3-button--small" type="button" on:click={() => editorSetAllUi(false)}>全不选</button>
          </div>
          <div class="editor-grid">
            {#each ALL_UI_VISIBILITY_KEYS as k (k)}
              <label class="editor-check">
                <input type="checkbox" bind:checked={editorUi[k]} />
                <span>{UI_VISIBILITY_LABELS[k] ?? k}</span>
              </label>
            {/each}
          </div>
        </section>
      </div>

      <div class="editor-footer">
        <button class="b3-button b3-button--outline b3-button--small" type="button" on:click={editorSaveOnly}>仅保存</button>
        <button class="b3-button b3-button--small" type="button" on:click={editorSave}>保存并应用</button>
      </div>
    </div>
  {:else}
    <!-- ==================== 列表模式 ==================== -->
    <div class="preset-toolbar">
      <div class="preset-toolbar__info">
        {#if activePreset}
          <span class="preset-active-badge">当前方案：{activePreset.name}</span>
          {#if isDirty}<span class="preset-dirty-badge" title="当前显隐设置与方案不一致">已修改</span>{/if}
        {:else}
          <span class="preset-active-badge preset-active-badge--none">自定义（未绑定方案）</span>
        {/if}
      </div>
      <span class="fn__space"></span>
      <button class="b3-button b3-button--small" type="button" on:click={openCreate}>＋ 新建方案</button>
      {#if activePreset}
        <button class="b3-button b3-button--text b3-button--small" type="button" on:click={deactivate}>取消绑定</button>
      {/if}
    </div>

    <div class="preset-list">
      {#each presets as preset (preset.id)}
        <div class="preset-item" class:preset-item--active={preset.id === activeId}>
          <div class="preset-item__header">
            <button class="preset-item__expand" type="button" title={expandedId === preset.id ? '收起' : '详情'} on:click={() => toggleExpand(preset.id)}>
              {expandedId === preset.id ? '▾' : '▸'}
            </button>
            <span class="preset-item__name">
              {preset.name}
              {#if preset.builtin}<span class="preset-builtin-tag">内置</span>{/if}
            </span>
            <span class="preset-item__summary">{presetSummary(preset)}</span>
            <span class="fn__space"></span>
            <div class="preset-item__actions">
              {#if preset.id !== activeId}
                <button class="b3-button b3-button--small" type="button" on:click={() => applyPreset(preset)}>应用</button>
              {:else}
                <span class="preset-applied-mark">✓ 已应用</span>
              {/if}
              <button class="b3-button b3-button--text b3-button--small" type="button" on:click={() => openEdit(preset)}>编辑</button>
              <button class="b3-button b3-button--text b3-button--small" type="button" on:click={() => duplicatePresetAction(preset)}>复制</button>
              <button class="b3-button b3-button--text b3-button--small" type="button" on:click={() => renamePreset(preset)}>重命名</button>
              <button class="b3-button b3-button--text b3-button--small preset-danger" type="button" on:click={() => deletePreset(preset)}>删除</button>
            </div>
          </div>
          {#if expandedId === preset.id}
            <div class="preset-item__detail">
              <div class="preset-detail-section">
                <span class="preset-detail-label">隐藏的工具（{hiddenTools(preset).length}）：</span>
                <span class="preset-detail-value">{hiddenTools(preset).length === 0 ? '无（全部显示）' : hiddenTools(preset).join('、')}</span>
              </div>
              <div class="preset-detail-section">
                <span class="preset-detail-label">隐藏的按钮（{hiddenUi(preset).length}）：</span>
                <span class="preset-detail-value">{hiddenUi(preset).length === 0 ? '无（全部显示）' : hiddenUi(preset).join('、')}</span>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <p class="preset-hint">
      提示：应用方案后需重新打开白板才能看到界面变化。点击「编辑」可修改方案的显隐配置，点击「＋ 新建方案」可从零创建自定义方案。
    </p>
  {/if}
</div>

<style>
  .ui-preset-manager { display: flex; flex-direction: column; gap: 10px; width: 100%; }

  /* ===== 列表模式 ===== */
  .preset-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 0; }
  .preset-toolbar__info { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .preset-active-badge { font-weight: 600; color: var(--b3-theme-primary); font-size: 13px; }
  .preset-active-badge--none { color: var(--b3-theme-on-surface-light); font-weight: 400; }
  .preset-dirty-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 4px; font-size: 11px; color: #fff; background: var(--b3-theme-warning, #e6a23c); }
  .preset-list { display: flex; flex-direction: column; gap: 6px; }
  .preset-item { border: 1px solid var(--b3-border-color); border-radius: 6px; background: var(--b3-theme-surface); overflow: hidden; transition: border-color .15s; }
  .preset-item--active { border-color: var(--b3-theme-primary); box-shadow: 0 0 0 1px var(--b3-theme-primary) inset; }
  .preset-item__header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; min-height: 38px; }
  .preset-item__expand { background: none; border: none; cursor: pointer; color: var(--b3-theme-on-surface-light); font-size: 12px; padding: 2px 4px; border-radius: 3px; flex-shrink: 0; }
  .preset-item__expand:hover { background: var(--b3-list-hover); }
  .preset-item__name { font-weight: 600; color: var(--b3-theme-on-surface); font-size: 13px; white-space: nowrap; display: flex; align-items: center; gap: 5px; }
  .preset-builtin-tag { display: inline-flex; align-items: center; height: 16px; padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 400; color: var(--b3-theme-on-surface-light); background: var(--b3-list-hover); }
  .preset-item__summary { color: var(--b3-theme-on-surface-light); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .preset-item__actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .preset-applied-mark { color: var(--b3-theme-success, #67c23a); font-size: 12px; font-weight: 600; white-space: nowrap; padding: 0 4px; }
  .preset-danger { color: var(--b3-theme-error, #f56c6c) !important; }
  .preset-item__detail { padding: 8px 12px 10px 32px; border-top: 1px solid var(--b3-border-color); background: var(--b3-theme-background); display: flex; flex-direction: column; gap: 6px; }
  .preset-detail-section { font-size: 12px; line-height: 1.5; }
  .preset-detail-label { color: var(--b3-theme-on-surface-light); font-weight: 600; }
  .preset-detail-value { color: var(--b3-theme-on-surface); }
  .preset-hint { color: var(--b3-theme-on-surface-light); font-size: 11px; line-height: 1.5; margin: 4px 0 0; padding: 6px 8px; background: var(--b3-list-hover); border-radius: 4px; }

  /* ===== 编辑模式 ===== */
  .editor-panel { border: 1px solid var(--b3-theme-primary); border-radius: 8px; background: var(--b3-theme-surface); display: flex; flex-direction: column; overflow: hidden; }
  .editor-header { display: flex; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--b3-border-color); background: var(--b3-theme-background); }
  .editor-title { font-weight: 700; font-size: 14px; color: var(--b3-theme-on-surface); }
  .editor-name-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--b3-border-color); }
  .editor-name-label { font-size: 13px; font-weight: 600; color: var(--b3-theme-on-surface); white-space: nowrap; }
  .editor-name-input { flex: 1; }
  .editor-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 14px; }
  .editor-section { border: 1px solid var(--b3-border-color); border-radius: 6px; overflow: hidden; }
  .editor-section__header { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: var(--b3-theme-background); border-bottom: 1px solid var(--b3-border-color); }
  .editor-section__title { font-weight: 600; font-size: 13px; color: var(--b3-theme-primary); }
  .editor-section__count { font-size: 11px; color: var(--b3-theme-on-surface-light); }
  .editor-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 4px 10px; padding: 8px 10px; }
  .editor-check { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--b3-theme-on-surface); cursor: pointer; padding: 2px 0; }
  .editor-check input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--b3-theme-primary); cursor: pointer; flex-shrink: 0; }
  .editor-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--b3-border-color); background: var(--b3-theme-background); }

  .b3-button--small { padding: 2px 8px; min-height: 24px; font-size: 12px; }
</style>
