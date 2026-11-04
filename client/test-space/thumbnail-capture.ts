export interface WorkspaceThumbnailCapture {
  element: HTMLElement
  width: number
  height: number
  scrollOffsets: Array<{ index: number, left: number, top: number }>
}

export function isWorkspaceThumbnailView(view: string | null | undefined) {
  return view === 'messages' || view === 'contacts'
}

export function captureWorkspaceThumbnail(root: HTMLElement): WorkspaceThumbnailCapture {
  const rect = root.getBoundingClientRect()
  const nodes = [root, ...root.querySelectorAll<HTMLElement>('*')]
  const scrollOffsets = nodes.flatMap((node, index) => node.scrollLeft || node.scrollTop
    ? [{ index, left: node.scrollLeft, top: node.scrollTop }]
    : [])
  const element = root.cloneNode(true) as HTMLElement
  copyCanvasPixels(root, element)
  // 缩略图只保留工作区画面；被控覆盖层的 scrim、点阵、WebGL 跑马灯和任务栏会挡住真实页面。
  stripAgentObserveOverlay(element)

  return {
    element,
    width: rect.width,
    height: rect.height,
    scrollOffsets,
  }
}

export function instantiateWorkspaceThumbnail(capture: WorkspaceThumbnailCapture) {
  const element = capture.element.cloneNode(true) as HTMLElement
  copyCanvasPixels(capture.element, element)
  const nodes = [element, ...element.querySelectorAll<HTMLElement>('*')]
  for (const node of nodes) node.removeAttribute('id')
  element.inert = true
  element.setAttribute('aria-hidden', 'true')
  element.classList.add('webqq-space-thumbnail-live-workspace')
  return element
}

function copyCanvasPixels(sourceRoot: HTMLElement, targetRoot: HTMLElement) {
  const sourceCanvases = [...sourceRoot.querySelectorAll('canvas')].filter((node) => !node.closest('.webqq-agent-observe'))
  const targetCanvases = [...targetRoot.querySelectorAll('canvas')].filter((node) => !node.closest('.webqq-agent-observe'))
  for (const [index, source] of sourceCanvases.entries()) {
    const target = targetCanvases[index]
    if (!target) continue
    target.width = source.width
    target.height = source.height
    // cloneNode 不复制 Canvas 的像素缓冲；转成位图后再写入，才能保留工作区里真正需要展示的画布。
    target.getContext('2d')?.drawImage(source, 0, 0)
  }
}

function stripAgentObserveOverlay(root: HTMLElement) {
  for (const node of root.querySelectorAll('.webqq-agent-observe')) node.remove()
}

export function restoreWorkspaceThumbnailScroll(capture: WorkspaceThumbnailCapture, element: HTMLElement) {
  const nodes = [element, ...element.querySelectorAll<HTMLElement>('*')]
  for (const { index, left, top } of capture.scrollOffsets) {
    const node = nodes[index]
    if (!node) continue
    node.scrollLeft = left
    node.scrollTop = top
  }
}
