/*
Global ShapeLoadManager
Supports multiple tldraw instances, each shape registers with its own editor.
Limits the number of simultaneously 'active / heavy' loaded shapes (mounting Protyle etc.)
Prioritization rules (sorted ascending by score):
 1. Editing shapes always allowed (score forced to -Infinity)
 2. In-viewport shapes before out-of-viewport
 3. Distance to viewport center (nearer first)
Optional: future extension for renderMode / collapsed state.

API:
  register(shapeId: string, editor: Editor, metaProvider: () => ShapeLoadMeta, onPermissionChange: (allowed: boolean, meta: ComputedMeta) => void): () => void
  isAllowed(shapeId: string): boolean
Configuration:
  maxActive from settingdata['tldraw-max-active-shapes'] or default 40
Internals:
  Recomputes from store changes, coalesced on a short timer. This avoids an
  always-on requestAnimationFrame loop while a whiteboard is idle.
  Each shape uses its own editor's viewport for visibility calculation.
*/

import { settingdata } from '@/index'
import type { Editor, TLShapeId } from '@tldraw/tldraw'
import { isInteracting } from './utils/idle-scheduler'

interface ShapeLoadMeta {
  editing: boolean
}

interface ComputedMeta {
  inViewport: boolean
  inPreloadZone: boolean
  distance: number
}

interface RegisteredShape {
  id: TLShapeId
  editor: Editor
  metaProvider: () => ShapeLoadMeta
  onChange: (allowed: boolean, meta: ComputedMeta) => void
  lastAllowed: boolean
  lastComputed: ComputedMeta
}

class ShapeLoadManager {
  private shapes: Map<TLShapeId, RegisteredShape> = new Map()
  // Permission snapshots survive one synchronous unregister/register effect
  // cycle, preventing a brief fallback to "blocked" during a re-registration.
  private snapshots: Map<TLShapeId, { lastAllowed: boolean; lastComputed: ComputedMeta }> = new Map()
  private editorUnsubscribers = new Map<Editor, () => void>()
  // 编辑器容器可见性：后台白板标签页（display:none）的形状不参与准入，
  // 避免不可见画布占用全局 maxActive 预算。
  private editorVisibility = new Map<Editor, boolean>()
  private editorObservers = new Map<Editor, IntersectionObserver>()
  private recomputeTimer: ReturnType<typeof setTimeout> | null = null
  private immediateRecomputeQueued = false
  private lastRecomputeAt = 0
  // Keep the preload ring proportional to the visible page bounds instead of
  // a fixed world-unit distance. Fixed world units become an enormous screen
  // area when zoomed in and starve actually visible cards of the load budget.
  private readonly PRELOAD_VIEWPORT_FRACTION = 0.35
  // Keep the established admission cadence while making it event-driven.
  // The difference is that an idle whiteboard no longer wakes every frame.
  private readonly IDLE_RECOMPUTE_INTERVAL_MS = 500
  private readonly INTERACTING_RECOMPUTE_INTERVAL_MS = 1000
  // 准入滞回：离开配额后延迟撤销通知，避免在 maxActive 边界/视口边缘抖动时
  // 反复销毁重建卡片 DOM。宽限期内预算可能短暂超限，换取稳定的显示。
  private readonly ADMISSION_GRACE_MS = 1500
  private admissionBlockTimers = new Map<TLShapeId, ReturnType<typeof setTimeout>>()
  // 准入授予避让：平移/缩放期间不向新形状授予准入（撤销照常），新出现的形状
  // 保持轻量预览，交互结束后一次性按距离优先级挂载。避免大文档的静态预览
  // 挂载（DOM 解析/序列化）与平移帧争抢主线程，也避免挂载完又被撤销的浪费。
  private grantsDeferred = false
  private readonly DEFERRED_GRANT_RECHECK_MS = 800
  private deferredGrantRecheckTimer: ReturnType<typeof setTimeout> | null = null

  attachEditor(editor: Editor) {
    if (this.editorUnsubscribers.has(editor)) return

    // Camera / instance records are session-scoped, while shape changes are
    // document-scoped. Listening to both through `all` keeps admission current
    // without polling every animation frame.
    const unsubscribe = editor.store.listen(
      () => this.queueRecompute(),
      { scope: 'all', source: 'all' }
    )
    this.editorUnsubscribers.set(editor, unsubscribe)
    this.watchEditorVisibility(editor)
  }

  private watchEditorVisibility(editor: Editor) {
    if (this.editorObservers.has(editor)) return
    // 默认视为可见；IntersectionObserver 的首个回调会校正隐藏标签页。
    this.editorVisibility.set(editor, true)
    if (typeof IntersectionObserver === 'undefined') return
    try {
      const container = editor.getContainer()
      if (!container) return
      const observer = new IntersectionObserver((entries) => {
        const visible = entries.some((entry) => entry.isIntersecting)
        if (this.editorVisibility.get(editor) === visible) return
        this.editorVisibility.set(editor, visible)
        // 可见性翻转影响准入结果，立即重算
        this.queueRecompute(true)
      }, { threshold: 0 })
      observer.observe(container)
      this.editorObservers.set(editor, observer)
    } catch {
      // 容器尚未挂载等场景下忽略；保持默认可见
    }
  }

  register(shapeId: TLShapeId, editor: Editor, metaProvider: () => ShapeLoadMeta, onPermissionChange: (allowed: boolean, meta: ComputedMeta) => void) {
    const existing = this.shapes.get(shapeId)
    if (existing) {
      const previousEditor = existing.editor
      existing.editor = editor
      existing.metaProvider = metaProvider
      existing.onChange = onPermissionChange
      this.attachEditor(editor)
      if (previousEditor !== editor) this.detachEditorIfUnused(previousEditor)
      this.queueRecompute()
      return () => this.unregister(shapeId, editor)
    }
    const snapshot = this.snapshots.get(shapeId)
    const entry: RegisteredShape = {
      id: shapeId,
      editor,
      metaProvider,
      onChange: onPermissionChange,
      lastAllowed: snapshot ? snapshot.lastAllowed : false,
      lastComputed: snapshot ? snapshot.lastComputed : { inViewport: false, inPreloadZone: false, distance: Infinity },
    }
    this.shapes.set(shapeId, entry)
    // A remounted component starts with its own local state. Always deliver the
    // cached permission, otherwise a no-op recompute would leave it blocked.
    onPermissionChange(entry.lastAllowed, entry.lastComputed)
    this.attachEditor(editor)
    if (!this.immediateRecomputeQueued) {
      this.immediateRecomputeQueued = true
      queueMicrotask(() => {
        this.immediateRecomputeQueued = false
        this.queueRecompute(true)
      })
    }
    return () => this.unregister(shapeId, editor)
  }

  unregister(shapeId: TLShapeId, editor: Editor) {
    const existing = this.shapes.get(shapeId)
    // A duplicate id from another Editor must not unregister the currently
    // registered shape. This also makes cleanup robust during tab teardown.
    if (existing && existing.editor !== editor) return
    if (existing) {
      this.snapshots.set(shapeId, { lastAllowed: existing.lastAllowed, lastComputed: existing.lastComputed })
    }
    this.shapes.delete(shapeId)
    const pendingBlockTimer = this.admissionBlockTimers.get(shapeId)
    if (pendingBlockTimer) {
      clearTimeout(pendingBlockTimer)
      this.admissionBlockTimers.delete(shapeId)
    }
    // Effect cleanups and their replacements run synchronously. Retain the
    // snapshot for that hand-off only; discard orphaned shape ids afterwards.
    queueMicrotask(() => {
      if (!this.shapes.has(shapeId)) this.snapshots.delete(shapeId)
    })
    this.detachEditorIfUnused(editor)
    if (this.shapes.size === 0) this.stop()
  }

  isAllowed(shapeId: TLShapeId) {
    return this.shapes.get(shapeId)?.lastAllowed ?? false
  }

  private detachEditorIfUnused(editor: Editor) {
    for (const shape of this.shapes.values()) {
      if (shape.editor === editor) return
    }
    const unsubscribe = this.editorUnsubscribers.get(editor)
    if (!unsubscribe) return
    unsubscribe()
    this.editorUnsubscribers.delete(editor)
    const observer = this.editorObservers.get(editor)
    if (observer) {
      observer.disconnect()
      this.editorObservers.delete(editor)
    }
    this.editorVisibility.delete(editor)
  }

  private stop() {
    if (this.recomputeTimer !== null) {
      clearTimeout(this.recomputeTimer)
      this.recomputeTimer = null
    }
    // grantsDeferred 故意不重置：交互可能仍在进行（如切走标签页后全部注销），
    // 标记应跟随交互状态而非形状数量，由 notifyViewportSettled / 兜底检查归位。
    this.cancelDeferredGrantRecheck()
    for (const timer of this.admissionBlockTimers.values()) clearTimeout(timer)
    this.admissionBlockTimers.clear()
    for (const unsubscribe of this.editorUnsubscribers.values()) unsubscribe()
    this.editorUnsubscribers.clear()
    for (const observer of this.editorObservers.values()) observer.disconnect()
    this.editorObservers.clear()
    this.editorVisibility.clear()
  }

  forceRecompute() {
    if (this.recomputeTimer !== null) {
      clearTimeout(this.recomputeTimer)
      this.recomputeTimer = null
    }
    this.recompute()
  }

  /**
   * Camera updates are intentionally coalesced while the user pans. Call this
   * when the interaction settles so newly visible shapes do not wait for the
   * normal idle/interacting recompute interval.
   */
  notifyViewportSettled() {
    this.setGrantsDeferred(false)
  }

  /**
   * 平移/缩放等画布交互进行中暂停授予新准入；撤销与可见性元数据照常更新。
   * 交互结束（notifyViewportSettled）后立即补一次重算，把推迟的授予按
   * 距离优先级一次性放出。
   */
  setGrantsDeferred(value: boolean) {
    if (this.grantsDeferred === value) return
    this.grantsDeferred = value
    if (!value) {
      this.cancelDeferredGrantRecheck()
      this.queueRecompute(true)
    }
  }

  private cancelDeferredGrantRecheck() {
    if (this.deferredGrantRecheckTimer !== null) {
      clearTimeout(this.deferredGrantRecheckTimer)
      this.deferredGrantRecheckTimer = null
    }
  }

  /**
   * 兜底：若交互结束事件因异常未送达（如 pointerup 被吞、窗口失焦路径遗漏），
   * 推迟的授予不能无限期挂起。交互仍在持续时只顺延检查，不触发重算。
   */
  private scheduleDeferredGrantRecheck() {
    if (this.deferredGrantRecheckTimer !== null) return
    this.deferredGrantRecheckTimer = setTimeout(() => {
      this.deferredGrantRecheckTimer = null
      if (isInteracting()) {
        this.scheduleDeferredGrantRecheck()
        return
      }
      this.grantsDeferred = false
      this.queueRecompute(true)
    }, this.DEFERRED_GRANT_RECHECK_MS)
  }

  private queueRecompute(immediate = false) {
    if (this.shapes.size === 0) return

    const now = performance.now()
    const interval = isInteracting()
      ? this.INTERACTING_RECOMPUTE_INTERVAL_MS
      : this.IDLE_RECOMPUTE_INTERVAL_MS
    const delay = immediate ? 0 : Math.max(0, this.lastRecomputeAt + interval - now)

    if (this.recomputeTimer !== null) {
      // Existing work already represents the latest editor state. An initial
      // registration is the one case that should preempt the normal cadence.
      if (!immediate) return
      clearTimeout(this.recomputeTimer)
    }

    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null
      if (this.shapes.size > 0) this.recompute()
    }, delay)
  }

  private recompute() {
    const now = performance.now()
    this.lastRecomputeAt = now

    const maxActive = Math.max(1, Number(settingdata['tldraw-max-active-shapes']) || 40)

    const sortable: Array<{ id: string; score: number; editing: boolean; meta: ComputedMeta }> = []
    for (const s of this.shapes.values()) {
      let provided: ShapeLoadMeta = { editing: false }
      try { provided = s.metaProvider() } catch { /* ignore */ }
      // compute visibility & distance using the shape's own editor
      let distance = Infinity
      let inViewport = false
      let inPreloadZone = false
      try {
        const editorVisible = this.editorVisibility.get(s.editor) ?? true
        if (editorVisible) {
          const vp = s.editor?.getViewportPageBounds()
          const b = s.editor?.getShapePageBounds(s.id)
          if (vp && b) {
            inViewport = vp.minX < b.maxX && vp.maxX > b.minX && vp.minY < b.maxY && vp.maxY > b.minY
            const marginX = vp.width * this.PRELOAD_VIEWPORT_FRACTION
            const marginY = vp.height * this.PRELOAD_VIEWPORT_FRACTION
            const expanded = {
              minX: vp.minX - marginX,
              minY: vp.minY - marginY,
              maxX: vp.maxX + marginX,
              maxY: vp.maxY + marginY,
            }
            inPreloadZone = expanded.minX < b.maxX && expanded.maxX > b.minX && expanded.minY < b.maxY && expanded.maxY > b.minY
            const cx = vp.midX, cy = vp.midY
            const sx = (b.minX + b.maxX) / 2, sy = (b.minY + b.maxY) / 2
            distance = Math.hypot(cx - sx, cy - sy)
          }
        }
      } catch { /* ignore */ }

      const cmeta: ComputedMeta = { inViewport, inPreloadZone, distance }
      if (provided.editing) {
        sortable.push({ id: s.id, score: -Infinity, editing: true, meta: cmeta })
      } else {
        let score = distance
        if (!inViewport) score += 1000000
        sortable.push({ id: s.id, score, editing: false, meta: cmeta })
      }
    }

    sortable.sort((a, b) => a.score - b.score)

    const allowedSet = new Set<string>()
    
    // 统计当前需要保留的形状数量（不包括编辑中的）
    let allowedCount = 0
    
    // 分离视口内和视口外的形状
    const inViewportItems = sortable.filter(item => !item.editing && item.meta.inViewport)
    
    // 第一步：编辑中的形状始终允许（不计入配额）
    for (const item of sortable) {
      if (item.editing) {
        allowedSet.add(item.id)
      }
    }
    
    // 第二步：优先加载视口内的形状（按距离排序，已排好序）
    for (const item of inViewportItems) {
      if (allowedCount < maxActive) {
        allowedSet.add(item.id)
        allowedCount++
      }
    }
    
    // Shapes in the preload ring are tracked through `inPreloadZone`, but do
    // not receive full-content admission. Their persisted previewText remains
    // visible without allowing off-screen document fetches to consume slots.

    const computedById = new Map(sortable.map((item) => [item.id, item.meta]))
    const editingIds = new Set(sortable.filter((item) => item.editing).map((item) => item.id))

    // Notify changes
    for (const s of this.shapes.values()) {
      const targetAllowed = allowedSet.has(s.id)
      const computed = computedById.get(s.id) || { inViewport: false, inPreloadZone: false, distance: Infinity }
      // Refresh ordering when the viewport center moved meaningfully, while
      // avoiding callbacks on every 500ms recompute during tiny camera motion.
      const distanceChanged = Number.isFinite(computed.distance) && Number.isFinite(s.lastComputed.distance)
        ? Math.abs(computed.distance - s.lastComputed.distance) >= 128
        : computed.distance !== s.lastComputed.distance
      const metaChanged = computed.inViewport !== s.lastComputed.inViewport ||
        computed.inPreloadZone !== s.lastComputed.inPreloadZone ||
        distanceChanged

      // 准入滞回：获得准入立即生效；失去准入延迟 ADMISSION_GRACE_MS 再通知，
      // 期间若重新获得准入则取消撤销。避免边界抖动造成 DOM 反复重建。
      let newAllowed = s.lastAllowed
      if (targetAllowed) {
        const pendingTimer = this.admissionBlockTimers.get(s.id)
        if (pendingTimer) {
          clearTimeout(pendingTimer)
          this.admissionBlockTimers.delete(s.id)
        }
        // 交互避让：平移/缩放进行中不授予"新"准入（撤销照常）。保持已有准入、
        // 编辑中的形状不受影响——编辑挂载不能等交互结束。
        if (s.lastAllowed || !this.grantsDeferred || editingIds.has(s.id)) {
          newAllowed = true
        } else {
          this.scheduleDeferredGrantRecheck()
        }
      } else if (s.lastAllowed && !this.admissionBlockTimers.has(s.id)) {
        const timer = setTimeout(() => {
          this.admissionBlockTimers.delete(s.id)
          s.lastAllowed = false
          try { s.onChange(false, s.lastComputed) } catch { /* ignore */ }
        }, this.ADMISSION_GRACE_MS)
        this.admissionBlockTimers.set(s.id, timer)
      }

      const allowedChanged = newAllowed !== s.lastAllowed
      s.lastAllowed = newAllowed
      s.lastComputed = computed
      if (allowedChanged || metaChanged) {
        try { s.onChange(newAllowed, computed) } catch { /* ignore */ }
      }
    }
  }
}

export const shapeLoadManager = new ShapeLoadManager()
