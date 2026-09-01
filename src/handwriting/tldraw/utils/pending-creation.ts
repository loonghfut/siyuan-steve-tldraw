/**
 * 按形状隔离的"只创建一次"守卫。
 * Card / SingleBlock 在首次进入编辑时会为形状创建思源块；多个并发触发
 * （快速双击、准入抖动）必须共享同一次创建流程，避免产生重复块。
 */

const pendingCreationPromises = new Map<string, Promise<string>>()

export function runExclusiveBlockCreation(shapeId: string, factory: () => Promise<string>): Promise<string> {
	const existing = pendingCreationPromises.get(shapeId)
	if (existing) return existing

	const creationPromise = factory()
	pendingCreationPromises.set(shapeId, creationPromise)
	return creationPromise.finally(() => {
		// 仅当映射仍指向本次创建时清理，避免误删后续新的创建流程
		if (pendingCreationPromises.get(shapeId) === creationPromise) {
			pendingCreationPromises.delete(shapeId)
		}
	})
}
