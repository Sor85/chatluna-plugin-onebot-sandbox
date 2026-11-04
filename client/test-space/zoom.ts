import { spring } from 'animejs'

/*
 * 进出空间仿 iOS 打开与关闭 App：
 * - 进入：刚挂载的工作区从卡片里的缩略画面弹簧放大就位，垫在背后的总览（app.tsx 的 `launch`）以卡片为中心推近淡出；
 * - 退回：刚离开的空间对应的整张卡片从工作区位置缩回网格位，卡片里的缩略画面始终与工作区画面重合，其余卡片错落浮现。
 *
 * 动画一律交给 WAAPI（Element.animate），transform 与 opacity 在合成线程上运行：新页面挂载时主线程会被渲染
 * 占满几帧，用 JS 逐帧写样式恰好在这几帧掉帧。圆角不能合成，单独拆成一条动画，免得把同一元素的 transform
 * 也拖回主线程。
 */
const SURFACE = springTiming(400, 0.17)
const BACKDROP = springTiming(340, 0)
const CARD_IN = springTiming(300, 0.25)
const CARD_STAGGER = 24
/** 工作区铺满时总览推近的倍数，对应 iOS 主屏幕在 App 打开时的推近。 */
const BACKDROP_SCALE = 1.08
const CARD_RADIUS = 18
const ZOOMING_CLASS = 'sandbox-workspace-zooming'
/** 动画期间隐藏卡片缩略图的标记；用属性而不是类名，React 重渲染卡片时不会把它冲掉。 */
const HIDDEN_ATTRIBUTE = 'data-zoom-hidden'
const THUMBNAIL_IMAGE = '.sandbox-space-thumbnail-live, .sandbox-space-thumbnail-preview'

/**
 * 弹簧曲线转成 CSS `linear()`。anime.js 的 `spring` 按 SwiftUI 的感知时长换算刚度与阻尼，完全静止要到
 * 感知时长的近两倍；最后那段位移不到 1%，在 1.5 倍处截断并补到终点，早些解除变换、恢复交互。
 */
function springTiming(duration: number, bounce: number): KeyframeAnimationOptions {
  const curve = spring({ duration, bounce })
  const total = Math.min(curve.settlingDuration, Math.round(duration * 1.5))
  const ratio = total / curve.settlingDuration
  const samples = 64
  const points = Array.from({ length: samples + 1 }, (_, index) => index === samples ? 1 : Math.round(curve.ease(index / samples * ratio) * 1e4) / 1e4)
  return { duration: total, easing: `linear(${points.join(', ')})` }
}

interface Motion {
  animations: Animation[]
  cleanup(): void
}

let activeMotion: Motion | undefined

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function captureZoomRect(element: Element | null | undefined): DOMRect | undefined {
  if (prefersReducedMotion()) return
  const rect = element?.getBoundingClientRect()
  return rect && rect.width > 0 && rect.height > 0 ? rect : undefined
}

/**
 * 卡片里缩略画面实际占的矩形（缩略图按 contain 缩放居中，四周可能留白），画面在这一端与缩略图严丝合缝。
 * 新建的空间还没有缩略图，退回整张卡片。
 */
export function captureCardZoomRect(card: Element | null | undefined): DOMRect | undefined {
  return captureZoomRect(card?.querySelector(THUMBNAIL_IMAGE) ?? card)
}

// 连续触发时先把上一组动画收尾，避免两组 transform 同时驱动同一元素。
function finishActiveMotion() {
  const motion = activeMotion
  activeMotion = undefined
  if (!motion) return
  for (const animation of motion.animations) animation.cancel()
  motion.cleanup()
}

/** 让进行中的进出动画立即就位，供需要读取静止画面的调用方（离开空间前克隆工作区）使用。 */
export function settleZoom() {
  finishActiveMotion()
}

/**
 * 元素自带 transform 过渡时，动画结束、内联样式复位那一刻会被过渡再补间一次，动画期间整体禁用，收尾时恢复。
 */
function holdStyles(element: HTMLElement, styles: Partial<Record<'transformOrigin' | 'overflow' | 'zIndex', string>>) {
  Object.assign(element.style, { transition: 'none', ...styles })
  return () => {
    for (const key of ['transition', ...Object.keys(styles)]) element.style.removeProperty(key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`))
  }
}

/** 一组动画全部播完后收尾；中途被下一组顶替时由 `finishActiveMotion` 收尾。 */
function play(animations: Animation[], cleanup: () => void): Motion {
  const motion: Motion = { animations, cleanup }
  activeMotion = motion
  void Promise.all(animations.map((animation) => animation.finished)).then(() => {
    if (activeMotion !== motion) return
    activeMotion = undefined
    cleanup()
  }, () => {})
  return motion
}

/**
 * 从 `from` 等比缩放到元素原位的 transform 起点（transform-origin 为左上角）：`anchor` 是元素内要与 `from` 重合的
 * 区域，缺省为元素自身；宽高比不一致时（快照渲染的缩略图）按宽度等比缩放并纵向居中。
 */
function transformFrom(from: DOMRect, box: DOMRect, anchor: DOMRect = box) {
  const scale = from.width / anchor.width
  const x = from.left - box.left - (anchor.left - box.left) * scale
  const y = from.top + (from.height - anchor.height * scale) / 2 - box.top - (anchor.top - box.top) * scale
  return { scale, transform: `translate(${x}px, ${y}px) scale(${scale})` }
}

const IDENTITY = 'translate(0px, 0px) scale(1)'

/** 进入空间：刚挂载的工作区从卡片缩略画面放大就位，垫在背后的总览推近淡出，结束后调用 `onDone` 卸下它。 */
export function zoomWorkspaceFromRect(workspace: HTMLElement, thumb: DOMRect, backdrop?: HTMLElement | null, card?: HTMLElement | null, onDone?: () => void) {
  finishActiveMotion()
  const full = workspace.getBoundingClientRect()
  if (prefersReducedMotion() || !full.width || !full.height) {
    onDone?.()
    return
  }
  const surface = workspace
  const { scale, transform } = transformFrom(thumb, full)
  // 缩放期间在根节点标记状态，供需要回避变换中坐标的覆盖层（如挂在 body 上的弹层）据此隐藏。
  document.documentElement.classList.add(ZOOMING_CLASS)
  // 工作区平时不裁剪（聊天列要延伸到页头背后），缩放期间按圆角裁剪成卡片形状。
  const releases = [holdStyles(surface, { transformOrigin: '0 0', overflow: 'hidden' })]
  const animations = [
    surface.animate({ transform: [transform, IDENTITY] }, SURFACE),
    // 圆角按起始缩放比预放大，首帧在屏幕上与卡片圆角一致。
    surface.animate({ borderRadius: [`${CARD_RADIUS / scale}px`, '0px'] }, SURFACE),
  ]
  if (backdrop) {
    const box = backdrop.getBoundingClientRect()
    releases.push(holdStyles(backdrop, { transformOrigin: `${thumb.left + thumb.width / 2 - box.left}px ${thumb.top + thumb.height / 2 - box.top}px` }))
    // 播完保持隐藏，等调用方卸下总览。
    animations.push(backdrop.animate({
      transform: ['scale(1)', `scale(${BACKDROP_SCALE})`],
      opacity: [1, 0],
    }, { ...BACKDROP, fill: 'forwards' }))
  }
  if (card) {
    card.setAttribute(HIDDEN_ATTRIBUTE, '')
    releases.push(() => card.removeAttribute(HIDDEN_ATTRIBUTE))
  }
  play(animations, () => {
    for (const release of releases) release()
    document.documentElement.classList.remove(ZOOMING_CLASS)
    onDone?.()
  })
}

/**
 * 退回总览：`exit.card` 是刚离开的空间对应的卡片，整张卡片从工作区位置缩回网格位，卡片里的缩略画面始终与
 * 工作区画面重合；其余卡片错落浮现。缺少起点（从其他标签页进入总览）时只做错落浮现。
 *
 * 返回取消函数：本次动画还在播时立即收尾并返回 true。开发环境的 StrictMode 会把挂载时的 layout effect
 * 卸载再重跑一遍，调用方据此把起点放回去，重跑时照常缩回，而不是只剩错落浮现。
 */
export function zoomOverviewIn(overview: HTMLElement, exit?: { card: HTMLElement | null, rect: DOMRect }): () => boolean {
  finishActiveMotion()
  if (prefersReducedMotion()) return () => false
  const releases: Array<() => void> = []
  const animations: Animation[] = []
  const card = exit?.card

  if (card && exit) {
    // 放开总览裁剪并抬高层级，卡片才能越过总览边界覆盖整个工作区再缩回网格位；视口外的卡片也照常渲染。
    overview.classList.add('is-zooming')
    releases.push(() => overview.classList.remove('is-zooming'))
    const box = card.getBoundingClientRect()
    const image = card.querySelector(THUMBNAIL_IMAGE)?.getBoundingClientRect()
    const { transform } = transformFrom(exit.rect, box, image?.width ? image : box)
    releases.push(holdStyles(card, { transformOrigin: '0 0', zIndex: '30' }))
    animations.push(
      card.animate({ transform: [transform, IDENTITY] }, SURFACE),
      // 缩略画面与工作区重合时卡片铺满工作区，那一端不带圆角。
      card.animate({ borderRadius: ['0px', `${CARD_RADIUS}px`] }, SURFACE),
    )
  }

  const others = [...overview.querySelectorAll<HTMLElement>('.sandbox-space-card')].filter((element) => element !== card)
  for (const [index, element] of others.entries()) {
    releases.push(holdStyles(element, {}))
    animations.push(element.animate({
      transform: ['translateY(16px)', 'translateY(0px)'],
      opacity: [0, 1],
    }, { ...CARD_IN, delay: index * CARD_STAGGER, fill: 'backwards' }))
  }

  if (!animations.length) return () => false
  const motion = play(animations, () => {
    for (const release of releases) release()
  })
  return () => {
    if (activeMotion !== motion) return false
    finishActiveMotion()
    return true
  }
}
