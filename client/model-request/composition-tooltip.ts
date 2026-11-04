/**
 * 请求组成图的分段浮层：落点几何与悬停意图。
 *
 * 分段浮层原先是每条分段各挂一个 Tooltip 组件。实测一条 18 次请求的会话有 1,206 条分段，
 * 每次重新取回轨迹要让这 1,206 个组件全部重渲染，点击展开一条请求的界面延迟里有 233 ms
 * 花在这上面，而服务端往返只占 45 ms。整条轨道共用一个浮层之后，分段退回普通按钮，
 * 落点与悬停时序改由本 module 负责，因此仍然可以在没有浏览器的测试里被完整驱动。
 */

export interface CompositionTooltipRect {
  left: number
  top: number
  width: number
  height: number
}

export interface CompositionTooltipPosition {
  left: number
  top: number
}

/** 浮层与分段之间的距离，以及浮层不得贴到容器边缘的留白。 */
const TOOLTIP_GAP = 8
const TOOLTIP_EDGE_PADDING = 6

/**
 * 浮层相对轨道容器的落点。
 *
 * 坐标必须落在容器自己的坐标系里：轨道视口横向可滚动、纵向裁切，浮层挂在视口内会被裁掉，
 * 挂在容器上又不能直接用视口坐标。横向居中对齐分段并夹在容器内，纵向钉在分段上方。
 *
 * `clip` 是会裁掉浮层的那个祖先（轨迹表头声明了 `overflow: clip`）。顶端顶到它的上边缘时
 * 浮层改为压在分段上方一点而不是继续往上飘——飘出去的部分会被整齐地切掉，看起来像浮层缺了一半。
 */
export function resolveCompositionTooltipPosition(input: {
  bar: CompositionTooltipRect
  shell: CompositionTooltipRect
  clip: CompositionTooltipRect
  tooltip: { width: number, height: number }
}): CompositionTooltipPosition {
  const center = input.bar.left + input.bar.width / 2 - input.shell.left
  const half = input.tooltip.width / 2
  const maxCenter = Math.max(input.shell.width - half - TOOLTIP_EDGE_PADDING, half + TOOLTIP_EDGE_PADDING)
  // top 是浮层的下边缘：浮层自身按 translateY(-100%) 向上摆。
  const preferred = input.bar.top - input.shell.top - TOOLTIP_GAP
  const lowest = input.clip.top - input.shell.top + input.tooltip.height + TOOLTIP_EDGE_PADDING
  return {
    left: Math.min(Math.max(center, half + TOOLTIP_EDGE_PADDING), maxCenter),
    top: Math.max(preferred, lowest),
  }
}

export interface CompositionHoverIntentOptions {
  /** 首次悬停到浮层出现的等待时间，与原先每段各自的 Tooltip 延迟一致。 */
  delayMs?: number
  schedule?: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>
  cancel?: (id: ReturnType<typeof setTimeout>) => void
}

/**
 * 悬停意图：首次悬停等一拍再开，开着的时候在分段之间移动立刻换目标。
 *
 * 「已经开着就立刻换」是共用浮层必须自己实现的一条：每段各自计时的话，在同一条轨道上
 * 横向滑动会一路重新等待，读起来像浮层跟不上指针。
 */
export function createCompositionHoverIntent(options: CompositionHoverIntentOptions = {}) {
  const delayMs = options.delayMs ?? 500
  const schedule = options.schedule ?? ((handler, timeout) => setTimeout(handler, timeout))
  const cancel = options.cancel ?? ((id) => clearTimeout(id))
  let timer: ReturnType<typeof setTimeout> | undefined
  let open = false

  function clear() {
    if (timer !== undefined) cancel(timer)
    timer = undefined
  }

  /** 请求显示某条分段。已经开着时同拍生效，否则等一拍。 */
  function enter(show: () => void) {
    clear()
    if (open) {
      show()
      return
    }
    timer = schedule(() => {
      timer = undefined
      open = true
      show()
    }, delayMs)
  }

  /** 离开分段：等待中的那一次作废，已经开着的立刻关掉。 */
  function leave(hide: () => void) {
    clear()
    if (!open) return
    open = false
    hide()
  }

  function isOpen() {
    return open
  }

  return { enter, leave, isOpen, dispose: clear }
}
