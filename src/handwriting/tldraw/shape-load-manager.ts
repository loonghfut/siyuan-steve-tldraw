/*
Global ShapeLoadManager
Supports multiple tldraw instances, each shape registers with its own editor.
Limits the number of simultaneously 'active / heavy' loaded shapes (mounting Protyle etc.)
Prioritization rules (sorted ascending by score):
 1. Editing shapes always allowed (score forced to -Infinity)
 2. In-viewport shapes before admission-ring shapes before the rest
 3. Distance to viewport center (nearer first)
Full-content admission covers the viewport plus an expanded ring
(ADMISSION_RING_FRACTION); shapes beyond it fall back to the lightweight
preview after a grace period. Admission only kicks in when the whiteboard has
enough Card / SingleBlock shapes (tldraw-viewport-culling-count-threshold);
smaller boards load everything.
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
import { isViewportCullingActive } from './utils/low-detail'

interface ShapeLoadMeta {
  editing: boolean
}

interface ComputedMeta {
  /** 严格视口内（用于排序与渲染优先级）。 */
  inViewport: boolean
  /** 预热环内（准入环之外、再外扩一圈）：触发 getDoc 缓存预热，不参与准入。 */
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
  // IO 是否已回报过首次交集状态。首个回调到来前不允许"整板放行"（见 recompute），
  // 防止后台标签页在挂载到 IO 首次回调之间的短暂窗口内被全量加载。
  private editorVisibilityConfirmed = new Map<Editor, boolean>()
  private recomputeTimer: ReturnType<typeof setTimeout> | null = null
  private immediateRecomputeQueued = false
  private lastRecomputeAt = 0
  // 准入环：视口外扩此比例的区域内的形状保持完整内容（不进入轻量预览），
  // 与视口内形状一起按距离参与配额。平移不超出该环时不会看到轻量 → 完整
  // 内容的加载过程。按视口比例而非固定世界距离计算，避免缩放时环面积失衡。
  private readonly ADMISSION_RING_FRACTION = 2
  // 预热环：准入环之外再外扩一圈。只把 getDoc 结果提前写入预览缓存（不挂
  // DOM），用户继续平移使形状进入准入环时命中缓存即可立即上屏。
  private readonly WARM_RING_FRACTION = 3
  // 预热环按几何范围可能覆盖大量形状（远景缩小后再乘以面积放大）。为保持克制，
  // 只把距视口中心最近的前若干个环内形状标记为 inPreloadZone（触发缓存预热），
  // 其余等下一轮重算按距离依次补上。
  private readonly WARM_RING_MAX_SHAPES = 48
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
  // 授予节奏：交互结束/初次打开时可见形状可能一次多到几十个，若一次性全部
  // 授予，静态预览队列会并发解析多份完整文档 HTML，造成明显的整帧卡顿。
  // 每轮重算最多新增一批准入，剩余的由短定时器接续，按距离优先级分批上屏。
  private readonly MAX_NEW_GRANTS_PER_RECOMPUTE = 8
  private readonly GRANT_BATCH_CONTINUATION_MS = 120
  private grantBatchTimer: ReturnType<typeof setTimeout> | null = null

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
    if (typeof IntersectionObserver === 'undefined') {
      // 无法观察时退回"可见"语义，避免可见编辑器永远拿不到整板放行
      this.editorVisibilityConfirmed.set(editor, true)
      return
    }
    try {
      const container = editor.getContainer()
      if (!container) {
        this.editorVisibilityConfirmed.set(editor, true)
        return
      }
      this.editorVisibilityConfirmed.set(editor, false)
      const observer = new IntersectionObserver((entries) => {
        const visible = entries.some((entry) => entry.isIntersecting)
        const isFirstCallback = this.editorVisibilityConfirmed.get(editor) !== true
        this.editorVisibilityConfirmed.set(editor, true)
        if (!isFirstCallback && this.editorVisibility.get(editor) === visible) return
        this.editorVisibility.set(editor, visible)
        // 可见性翻转（含首次回报）影响准入结果，立即重算
        this.queueRecompute(true)
      }, { threshold: 0 })
      observer.observe(container)
      this.editorObservers.set(editor, observer)
    } catch {
      // 容器尚未挂载等场景下忽略；保持默认可见
      this.editorVisibilityConfirmed.set(editor, true)
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
        // 交互（平移/缩放）中新注册的形状本来就拿不到准入，meta 刷新交给
        // 交互节奏与结算重算。快速平移时新形状不断注册，若每次都触发全量
        // 重算（O(注册数) 几何计算），会与平移帧争抢主线程。
        if (!isInteracting()) this.queueRecompute(true)
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
    this.editorVisibilityConfirmed.delete(editor)
  }

  private stop() {
    if (this.recomputeTimer !== null) {
      clearTimeout(this.recomputeTimer)
      this.recomputeTimer = null
    }
    // grantsDeferred 故意不重置：交互可能仍在进行（如切走标签页后全部注销），
    // 标记应跟随交互状态而非形状数量，由 notifyViewportSettled / 兜底检查归位。
    this.cancelDeferredGrantRecheck()
    if (this.grantBatchTimer !== null) {
      clearTimeout(this.grantBatchTimer)
      this.grantBatchTimer = null
    }
    for (const timer of this.admissionBlockTimers.values()) clearTimeout(timer)
    this.admissionBlockTimers.clear()
    for (const unsubscribe of this.editorUnsubscribers.values()) unsubscribe()
    this.editorUnsubscribers.clear()
    for (const observer of this.editorObservers.values()) observer.disconnect()
    this.editorObservers.clear()
    this.editorVisibility.clear()
    this.editorVisibilityConfirmed.clear()
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

    const sortable: Array<{
      id: string
      score: number
      editing: boolean
      cullingActive: boolean
      bulkReady: boolean
      inAdmissionZone: boolean
      meta: ComputedMeta
    }> = []
    // 每个编辑器的准入上下文按轮缓存：
    // - cullingActive：含数量门槛判定（isViewportCullingActive）；
    // - bulkReady：编辑器可见且 IO 已回报过首次状态，才允许"整板放行"，
    //   防止后台标签页在挂载到 IO 首次回调之间的窗口内被全量加载。
    const editorAdmissionContext = new Map<Editor, { cullingActive: boolean; bulkReady: boolean }>()
    // 预载环候选：仅统计"环内但视口外"的形状，用于按距离截取预热名单
    const warmRingCandidates = new Map<Editor, Array<{ meta: ComputedMeta }>>()

    for (const s of this.shapes.values()) {
      let provided: ShapeLoadMeta = { editing: false }
      try { provided = s.metaProvider() } catch { /* ignore */ }

      const editorVisible = this.editorVisibility.get(s.editor) ?? true
      let admissionContext = editorAdmissionContext.get(s.editor)
      if (!admissionContext) {
        let cullingActive = true
        try {
          cullingActive = isViewportCullingActive(s.editor)
        } catch {
          // 计数异常时按"启用裁剪"处理，走常规视口准入，避免异常导致全量放行
        }
        const editorConfirmed = this.editorVisibilityConfirmed.get(s.editor) ?? true
        admissionContext = { cullingActive, bulkReady: editorVisible && editorConfirmed }
        editorAdmissionContext.set(s.editor, admissionContext)
      }

      // compute visibility & distance using the shape's own editor
      let distance = Infinity
      let inViewport = false
      let inAdmissionZone = false
      let inPreloadZone = false
      try {
        if (editorVisible) {
          const vp = s.editor?.getViewportPageBounds()
          const b = s.editor?.getShapePageBounds(s.id)
          if (vp && b) {
            const intersects = (r: { minX: number; minY: number; maxX: number; maxY: number }) =>
              r.minX < b.maxX && r.maxX > b.minX && r.minY < b.maxY && r.maxY > b.minY
            const expands = (fraction: number) => ({
              minX: vp.minX - vp.width * fraction,
              minY: vp.minY - vp.height * fraction,
              maxX: vp.maxX + vp.width * fraction,
              maxY: vp.maxY + vp.height * fraction,
            })
            inViewport = intersects(vp)
            // 准入环：环内保持完整内容（参与配额）
            inAdmissionZone = intersects(expands(this.ADMISSION_RING_FRACTION))
            // 预热环：准入环之外的部分才值得预热（已准入的形状会直接挂载）
            inPreloadZone = intersects(expands(this.WARM_RING_FRACTION)) && !inAdmissionZone
            const cx = vp.midX, cy = vp.midY
            const sx = (b.minX + b.maxX) / 2, sy = (b.minY + b.maxY) / 2
            distance = Math.hypot(cx - sx, cy - sy)
          }
        }
      } catch { /* ignore */ }

      const cmeta: ComputedMeta = { inViewport, inPreloadZone, distance }
      const item = {
        id: s.id,
        editing: provided.editing,
        cullingActive: admissionContext.cullingActive,
        bulkReady: admissionContext.bulkReady,
        inAdmissionZone,
        meta: cmeta,
        score: 0,
      }
      if (provided.editing) {
        item.score = -Infinity
      } else {
        item.score = distance
        if (!inViewport) item.score += 1000000
        // 预热环限流候选：预热环已排除准入环，只需裁剪生效即收集
        if (admissionContext.cullingActive && inPreloadZone) {
          let ring = warmRingCandidates.get(s.editor)
          if (!ring) {
            ring = []
            warmRingCandidates.set(s.editor, ring)
          }
          ring.push({ meta: cmeta })
        }
      }
      sortable.push(item)
    }

    // 预载环限流：环内形状超过上限时，只保留距视口中心最近的若干个，
    // 其余本轮不标记 inPreloadZone（不触发预热），由后续重算按距离补齐。
    for (const ring of warmRingCandidates.values()) {
      if (ring.length <= this.WARM_RING_MAX_SHAPES) continue
      ring.sort((a, b) => a.meta.distance - b.meta.distance)
      for (let index = this.WARM_RING_MAX_SHAPES; index < ring.length; index++) {
        ring[index].meta.inPreloadZone = false
      }
    }

    sortable.sort((a, b) => a.score - b.score)

    const allowedSet = new Set<string>()

    // 统计当前需要保留的形状数量（不包括编辑中的）
    let allowedCount = 0

    // 第一步：编辑中的形状始终允许（不计入配额）
    for (const item of sortable) {
      if (item.editing) {
        allowedSet.add(item.id)
      }
    }

    // 第二步：准入环（视口 + 外扩环）内按距离分配配额，排序已保证视口内
    // 形状优先于环内形状。两层各自计数：视口内消耗 maxActive，环内其余形状
    // 消耗独立的环配额（同为 maxActive）——正常密度的画板在准入环内不会出现
    // 轻量预览，远景高密度时由配额兜底。未达到裁剪数量门槛的编辑器不参与
    // 配额（整板放行，见 bulkReady 分支）。
    let ringAllowedCount = 0
    for (const item of sortable) {
      if (item.editing) continue
      if (item.meta.inViewport) {
        if (item.cullingActive && allowedCount >= maxActive) continue
        allowedSet.add(item.id)
        if (item.cullingActive) allowedCount++
      } else if (item.inAdmissionZone && item.cullingActive) {
        if (ringAllowedCount >= maxActive) continue
        allowedSet.add(item.id)
        ringAllowedCount++
      } else if (!item.cullingActive && item.bulkReady) {
        allowedSet.add(item.id)
      }
    }

    // Shapes in the preload ring are tracked through `inPreloadZone`, but do
    // not receive full-content admission. Their persisted previewText remains
    // visible without allowing off-screen document fetches to consume slots.

    const computedById = new Map(sortable.map((item) => [item.id, item.meta]))
    const editingIds = new Set(sortable.filter((item) => item.editing).map((item) => item.id))

    // Notify changes
    let newGrants = 0
    let grantBudgetExhausted = false
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
        const isEditingShape = editingIds.has(s.id)
        if (s.lastAllowed || !this.grantsDeferred || isEditingShape) {
          if (!s.lastAllowed && !isEditingShape && newGrants >= this.MAX_NEW_GRANTS_PER_RECOMPUTE) {
            grantBudgetExhausted = true
          } else {
            newAllowed = true
            if (!s.lastAllowed && !isEditingShape) newGrants++
          }
        } else {
          this.scheduleDeferredGrantRecheck()
        }
      } else if (s.lastAllowed && !this.admissionBlockTimers.has(s.id)) {
        this.scheduleAdmissionRevoke(s)
      }

      const allowedChanged = newAllowed !== s.lastAllowed
      s.lastAllowed = newAllowed
      s.lastComputed = computed
      if (allowedChanged || metaChanged) {
        try { s.onChange(newAllowed, computed) } catch { /* ignore */ }
      }
    }

    if (grantBudgetExhausted && this.grantBatchTimer === null) {
      this.grantBatchTimer = setTimeout(() => {
        this.grantBatchTimer = null
        this.queueRecompute(true)
      }, this.GRANT_BATCH_CONTINUATION_MS)
    }
  }

  /**
   * 准入滞回的撤销侧：失去准入延迟 ADMISSION_GRACE_MS 再通知。若宽限期到点时
   * 用户仍在平移/缩放，则顺延到交互结束后再执行——这些形状此刻不可见，保持
   * 挂载没有任何每帧成本，而交互中集中销毁 DOM 会与平移帧争抢主线程。
   */
  private scheduleAdmissionRevoke(shape: RegisteredShape) {
    const timer = setTimeout(() => {
      this.admissionBlockTimers.delete(shape.id)
      if (isInteracting()) {
        this.scheduleAdmissionRevoke(shape)
        return
      }
      shape.lastAllowed = false
      try { shape.onChange(false, shape.lastComputed) } catch { /* ignore */ }
    }, this.ADMISSION_GRACE_MS)
    this.admissionBlockTimers.set(shape.id, timer)
  }
}

export const shapeLoadManager = new ShapeLoadManager()
