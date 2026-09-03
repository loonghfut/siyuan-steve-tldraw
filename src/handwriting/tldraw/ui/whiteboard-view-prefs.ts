/**
 * 白板面板（dock 卡片列表 / 高级管理 Tab）共享的视图偏好。
 * 视图模式与排序键在两个面板间实时同步，并持久化到 localStorage。
 */
import { writable } from 'svelte/store';

export type WhiteboardViewMode = 'card' | 'list' | 'compact';

const VIEW_MODE_STORAGE_KEY = 'sttools-whiteboard-view-mode';
const SORT_KEY_STORAGE_KEY = 'sttools-whiteboard-sort-key';

export const WHITEBOARD_VIEW_MODES: WhiteboardViewMode[] = ['card', 'list', 'compact'];

/** 各面板共用的排序项（mtime 按各自面板的"最近活动时间"语义解释） */
export const COMMON_SORT_OPTIONS: { key: string; label: string }[] = [
    { key: 'mtime-desc', label: '最近更新' },
    { key: 'mtime-asc', label: '最早更新' },
    { key: 'title', label: '按标题' },
    { key: 'id', label: '按块 ID' },
    { key: 'exists', label: '按存在状态' },
];

/** 高级管理面板在公共项之外追加的排序项 */
export const MANAGER_EXTRA_SORT_OPTIONS: { key: string; label: string }[] = [
    { key: 'blkCreated-desc', label: '按创建时间（新→旧）' },
    { key: 'blkCreated-asc', label: '按创建时间（旧→新）' },
];

/** 高级管理面板完整的排序项 */
export const MANAGER_SORT_OPTIONS: { key: string; label: string }[] = [
    ...COMMON_SORT_OPTIONS,
    ...MANAGER_EXTRA_SORT_OPTIONS,
];

const ALL_SORT_KEYS = new Set(MANAGER_SORT_OPTIONS.map(o => o.key));

function loadStored(key: string, valid: (v: string) => boolean): string | null {
    try {
        const v = localStorage.getItem(key);
        if (v && valid(v)) return v;
    } catch { /* ignore */ }
    return null;
}

function loadStoredViewMode(): WhiteboardViewMode {
    const v = loadStored(VIEW_MODE_STORAGE_KEY, v => (WHITEBOARD_VIEW_MODES as string[]).includes(v));
    return (v as WhiteboardViewMode) || 'card';
}

// 视图模式：所有面板共享同一份状态
export const whiteboardViewMode = writable<WhiteboardViewMode>(loadStoredViewMode());

// 排序键：所有面板共享同一份状态
export const whiteboardSortKey = writable<string>(
    loadStored(SORT_KEY_STORAGE_KEY, v => ALL_SORT_KEYS.has(v)) || 'mtime-desc'
);

// 模块级单例订阅负责持久化，生命周期与页面一致，无需显式清理
whiteboardViewMode.subscribe(v => {
    try { localStorage.setItem(VIEW_MODE_STORAGE_KEY, v); } catch { /* ignore */ }
});

whiteboardSortKey.subscribe(v => {
    try { localStorage.setItem(SORT_KEY_STORAGE_KEY, v); } catch { /* ignore */ }
});
