import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from '@tldraw/tldraw'

const versions = createShapePropsMigrationIds('single-block', {
	addRefreshNonce: 1,
    addAllowBinding: 2,
    addLightweightPreviewText: 3,
	addHeightBackfilled: 4,
})

export const singleBlockShapeMigrations = createShapePropsMigrationSequence({
	sequence: [
		{
			id: versions.addRefreshNonce,
			up(props) {
				props.refreshNonce = props.refreshNonce ?? Date.now()
			},
			down(props) {
				delete props.refreshNonce
			},
		},
		{
			id: versions.addAllowBinding,
			up(props) {
				props.allowBinding = props.allowBinding ?? true
			},
			down(props) {
				delete props.allowBinding
			},
		},
		{
			id: versions.addLightweightPreviewText,
			up(props) {
				props.previewText = props.previewText ?? ''
			},
			down(props) {
				delete props.previewText
			},
		},
		{
			id: versions.addHeightBackfilled,
			up(props) {
				// 存量形状未回填过高度：首次挂载时做一次性测高写回，
				// 回填完成后置为 true，此后高度完全手动调整
				props.heightBackfilled = props.heightBackfilled ?? false
			},
			down(props) {
				delete props.heightBackfilled
			},
		},
	],
})
