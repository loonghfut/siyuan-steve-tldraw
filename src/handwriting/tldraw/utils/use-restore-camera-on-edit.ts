import { useEffect, useRef } from 'react'
import type { Editor, TLShapeId } from '@tldraw/tldraw'
import { settingdata } from '@/index'

/**
 * 进入编辑时聚焦并选中形状，退出编辑后恢复之前的视角。
 * Card 与 SingleBlock 此前各自维护一份几乎相同的实现。
 */
export function useRestoreCameraOnEdit(editor: Editor, isEditing: boolean, shapeId: TLShapeId, debugLabel: string) {
	const prevCameraRef = useRef<any | null>(null)
	const hadFocusedRef = useRef(false)

	useEffect(() => {
		// 延迟执行，确保编辑状态完全建立
		const timer = setTimeout(() => {
			const enabled = settingdata['restore-camera-on-edit'] === true
			// 如果该功能被禁用，则不进行任何聚焦/恢复动作；并清理可能残留的状态
			if (!enabled) {
				if (!isEditing) {
					hadFocusedRef.current = false
					prevCameraRef.current = null
				}
				return
			}
			if (isEditing) {
				console.debug(`聚焦到${debugLabel}:`, shapeId)
				// 进入编辑：仅在第一次进入时保存当前相机
				if (!hadFocusedRef.current) {
					try {
						prevCameraRef.current = editor.getCamera()
					} catch (e) {
						prevCameraRef.current = null
					}
					hadFocusedRef.current = true
				}
				// 刚刚进入编辑模式，选中并聚焦到形状
				editor.select(shapeId)
				editor.zoomToSelection({ animation: { duration: 300 } })
			} else {
				// 退出编辑：如果之前保存过相机，则恢复视角
				if (hadFocusedRef.current && prevCameraRef.current) {
					try {
						editor.setCamera(prevCameraRef.current, { animation: { duration: 300 } })
					} catch (e) {
						// ignore
					}
				}
				// 清理保存的相机状态
				hadFocusedRef.current = false
				prevCameraRef.current = null
			}
		}, 50) // 50ms 延迟确保状态同步完成
		return () => clearTimeout(timer)
	}, [editor, isEditing, shapeId, debugLabel])
}
