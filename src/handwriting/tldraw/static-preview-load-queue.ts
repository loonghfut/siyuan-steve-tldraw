import { ContentLoadQueue, type ContentLoadHandle, type ContentLoadRunner } from './protyle-load-queue'

// DOMParser / innerHTML for a full SiYuan document can be expensive. Keep this
// separate from interactive Protyle creation. Concurrent previews fetch and
// build for responsiveness, but concurrency is capped low on purpose: six
// parallel full-document DOM builds coalesce into one visibly long frame, so
// three keeps the burst small while the idle scheduler serializes the
// expensive follow-up rendering.
const staticPreviewLoadQueue = new ContentLoadQueue(3, { deferStart: true })

export function enqueueStaticPreviewLoad(
	key: string,
	priority: number,
	runner: ContentLoadRunner,
): ContentLoadHandle {
	return staticPreviewLoadQueue.enqueue(key, priority, runner)
}
