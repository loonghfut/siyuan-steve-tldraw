import React from 'react'

interface MissingBlockOverlayProps {
	/** 主题色 solid 值，用于文字颜色 */
	textColor: string
	fontSize: number
	/** SingleBlock 透明背景时使用更淡的遮罩 */
	transparent?: boolean
	/** SingleBlock 使用更紧凑的布局 */
	compact?: boolean
	onRefresh: (event: React.PointerEvent | React.MouseEvent) => void
	onDelete: (event: React.PointerEvent | React.MouseEvent) => void
}

function stopEvent(event: React.PointerEvent | React.MouseEvent) {
	event.preventDefault()
	event.stopPropagation()
}

/**
 * "找不到绑定块" 的遮罩浮层。Card 与 SingleBlock 此前各自维护一份
 * 几乎相同的 JSX，统一收敛到这里，仅保留尺寸/遮罩上的少量差异。
 */
export function MissingBlockOverlay({ textColor, fontSize, transparent, compact, onRefresh, onDelete }: MissingBlockOverlayProps) {
	return (
		<div
			onPointerDown={stopEvent}
			onClick={stopEvent}
			style={{
				position: 'absolute',
				inset: '0',
				zIndex: 20,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: compact ? '12px' : '16px',
				background: transparent ? 'rgba(127, 127, 127, 0.08)' : 'rgba(127, 127, 127, 0.14)',
				backdropFilter: 'blur(2px)',
				pointerEvents: 'auto',
			}}
		>
			<div
				style={{
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					gap: compact ? '10px' : '12px',
					maxWidth: '100%',
					padding: compact ? '14px 16px' : '16px 18px',
					borderRadius: '12px',
					background: 'var(--b3-theme-background, #fff)',
					border: '1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12))',
					boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
					color: textColor,
					textAlign: 'center',
				}}
			>
				<div style={{ fontSize: `${Math.min(fontSize, compact ? 14 : 16)}px`, fontWeight: 500 }}>
					找不到绑定块
				</div>
				<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
					<button
						type="button"
						onPointerDown={stopEvent}
						onClick={onRefresh}
						style={{
							padding: '6px 12px',
							borderRadius: '8px',
							border: '1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12))',
							background: 'transparent',
							color: 'inherit',
							cursor: 'pointer',
						}}
					>
						刷新
					</button>
					<button
						type="button"
						onPointerDown={stopEvent}
						onClick={onDelete}
						style={{
							padding: '6px 12px',
							borderRadius: '8px',
							border: '1px solid var(--b3-card-error-color, #d23f31)',
							background: 'var(--b3-card-error-background, rgba(210, 63, 49, 0.12))',
							color: 'var(--b3-card-error-color, #d23f31)',
							cursor: 'pointer',
						}}
					>
						删除
					</button>
				</div>
			</div>
		</div>
	)
}
