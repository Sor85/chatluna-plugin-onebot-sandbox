import { animate, cubicBezier, stagger } from 'animejs'

// iOS 面板同款缓动与时长，进入/退出共用同一条曲线保证往返观感一致。
const zoomEase = cubicBezier(0.32, 0.72, 0, 1)
const ZOOM_DURATION = 440
const CARD_RADIUS = 18
const ZOOMING_CLASS = 'sandbox-workspace-zooming'

let activeZoom: ReturnType<typeof animate> | undefined

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function captureZoomRect(element: Element | null | undefined): DOMRect | undefined {
  if (prefersReducedMotion()) return
  const rect = element?.getBoundingClientRect()
  return rect && rect.width > 0 && rect.height > 0 ? rect : undefined
}

// 连续触发时先把上一个动画推进到终态，避免两个 transform 同时驱动同一元素。
function finishActiveZoom() {
  activeZoom?.complete()
  activeZoom = undefined
}

function runZoom(element: HTMLElement, fromRect: DOMRect, radius: [string, string], onCleanup?: () => void) {
  finishActiveZoom()
  const targetRect = element.getBoundingClientRect()
  if (!targetRect.width || !targetRect.height) return
  const scale = fromRect.width / targetRect.width
  const x = fromRect.left - targetRect.left
  const y = fromRect.top - targetRect.top
  // 缩放期间在根节点标记状态，供需要回避变换中坐标的覆盖层（如挂在 body 上的弹层）据此隐藏。
  document.documentElement.classList.add(ZOOMING_CLASS)
  // 卡片自带 transition: transform 180ms（hover 上浮），会把 anime.js 每帧写入的 transform 再平滑一次，
  // 表现为初始帧从网格位飞向全屏再折返的大幅弹跳，动画期间必须整体禁用过渡。
  element.style.transition = 'none'
  element.style.transformOrigin = '0 0'
  element.style.willChange = 'transform, border-radius'
  // 工作区平时不裁剪（聊天列要延伸到页头背后），缩放期间按圆角裁剪成卡片形状。
  element.style.overflow = 'hidden'
  // 先写入初始帧，避免 anime.js 首个 tick 前闪现终态。
  element.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  element.style.borderRadius = radius[0]
  const cleanup = () => {
    element.style.transition = ''
    element.style.transform = ''
    element.style.transformOrigin = ''
    element.style.willChange = ''
    element.style.borderRadius = ''
    element.style.overflow = ''
    document.documentElement.classList.remove(ZOOMING_CLASS)
    onCleanup?.()
  }
  const animation = animate(element, {
    translateX: [x, 0],
    translateY: [y, 0],
    scale: [scale, 1],
    borderRadius: radius,
    duration: ZOOM_DURATION,
    ease: zoomEase,
    onComplete: () => {
      cleanup()
      if (activeZoom === animation) activeZoom = undefined
    },
  })
  activeZoom = animation
}

// 进入空间：整个工作区从卡片位置连续放大就位；卡片圆角按缩放比预放大，视觉上与卡片一致。
export function zoomWorkspaceFromRect(workspace: HTMLElement, fromRect: DOMRect) {
  if (prefersReducedMotion()) return
  const scale = fromRect.width / Math.max(1, workspace.getBoundingClientRect().width)
  runZoom(workspace, fromRect, [`${CARD_RADIUS / Math.max(scale, 0.01)}px`, '0px'])
}

// 退出空间：活动卡片从覆盖整个工作区缩回网格位；动画期间放开总览裁剪并抬高层级。
export function zoomCardFromRect(card: HTMLElement, overview: HTMLElement, fromRect: DOMRect) {
  if (prefersReducedMotion()) return
  card.style.zIndex = '30'
  overview.classList.add('is-zooming')
  runZoom(card, fromRect, ['0px', `${CARD_RADIUS}px`], () => {
    card.style.zIndex = ''
    overview.classList.remove('is-zooming')
  })
}

// 其余卡片错落浮现，形成 Mission Control 式铺开。
export function staggerCardsIn(cards: HTMLElement[]) {
  if (prefersReducedMotion() || !cards.length) return
  // 先写初始帧，避免动画首个 tick 前卡片以终态闪现；同时禁用卡片自带的 transform 过渡，防止逐帧动画被二次平滑。
  for (const cardElement of cards) {
    cardElement.style.transition = 'none'
    cardElement.style.opacity = '0'
    cardElement.style.transform = 'translateY(12px)'
  }
  animate(cards, {
    opacity: [0, 1],
    translateY: [12, 0],
    duration: 280,
    ease: 'out(3)',
    delay: stagger(30),
    onComplete: () => {
      // 清掉残留的内联 transform，否则会盖住卡片 hover 的上浮效果。
      for (const cardElement of cards) {
        cardElement.style.transition = ''
        cardElement.style.opacity = ''
        cardElement.style.transform = ''
      }
    },
  })
}
