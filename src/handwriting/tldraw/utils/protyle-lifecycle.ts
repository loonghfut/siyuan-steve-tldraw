import type { Protyle } from 'siyuan'

const DESTROYED_MARK = '__st_destroyed__'

/**
 * 防重复销毁 Protyle：为每个实例设置已销毁标记，吞掉销毁期的异常。
 * Card 与 SingleBlock 此前各自维护一份相同实现。
 */
export function safeDestroyProtyle(pt: Protyle | null | undefined) {
	if (!pt) return
	const anyPt = pt as any
	if (anyPt[DESTROYED_MARK]) return
	try {
		pt.destroy()
	} catch {
		// ignore
	}
	anyPt[DESTROYED_MARK] = true
}
