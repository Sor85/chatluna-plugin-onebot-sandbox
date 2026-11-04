import * as React from 'react'
import { cn } from '@chatluna/ui-kit'
import './overlay-scrollbar.css'

/** 滑块最短长度，内容很长时仍点得中。 */
const MIN_THUMB = 24
/** 滚动停止后滑块保持可见的时长。 */
const IDLE_MS = 900

/**
 * 叠在滚动视口上的自绘纵向滚动条（`SCROLLBAR.md`：轨道透明、只画滑块、离边 1px、5→7px、16px 命中区）。
 *
 * 用于原生滚动条位置不对的视口：消息区的视口从两层毛玻璃表头后面开始，原生轨道也从顶端开始，
 * 滚到顶时滑块藏在表头后面。视口自己用 `scrollbar-width: none` 隐藏原生条，本组件画在视口的
 * 定位父容器里，轨道的上下边界由 `className` 决定。
 */
export function OverlayScrollbar({ target, className }: {
  target: React.RefObject<HTMLElement | null>
  className?: string
}) {
  const track = React.useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = React.useState({ top: 0, size: 0, visible: false })
  const [active, setActive] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const drag = React.useRef<{ id: number, y: number, scrollTop: number } | undefined>(undefined)
  const idle = React.useRef<ReturnType<typeof setTimeout>>(undefined)

  const measure = React.useCallback(() => {
    const element = target.current
    const rail = track.current
    if (!element || !rail) return
    const range = element.scrollHeight - element.clientHeight
    const length = rail.clientHeight
    if (range <= 1 || !length) return setMetrics((value) => value.visible ? { top: 0, size: 0, visible: false } : value)
    const size = Math.max(MIN_THUMB, length * element.clientHeight / element.scrollHeight)
    const top = (length - size) * element.scrollTop / range
    setMetrics({ top, size, visible: true })
  }, [target])

  React.useLayoutEffect(() => {
    const element = target.current
    if (!element) return
    measure()
    // 滚动或指针在视口里移动时显示滑块，停下后淡出。
    const wake = () => {
      setActive(true)
      clearTimeout(idle.current)
      idle.current = setTimeout(() => setActive(false), IDLE_MS)
    }
    const onScroll = () => {
      measure()
      wake()
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    element.addEventListener('pointermove', wake, { passive: true })
    const resize = new ResizeObserver(measure)
    resize.observe(element)
    if (track.current) resize.observe(track.current)
    for (const child of element.children) resize.observe(child)
    const mutation = new MutationObserver(() => {
      for (const child of element.children) resize.observe(child)
      measure()
    })
    mutation.observe(element, { childList: true, subtree: true })
    return () => {
      clearTimeout(idle.current)
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('pointermove', wake)
      resize.disconnect()
      mutation.disconnect()
    }
  }, [target, measure])

  const scrollPerPixel = () => {
    const element = target.current
    const rail = track.current
    if (!element || !rail) return 0
    const free = rail.clientHeight - metrics.size
    return free > 0 ? (element.scrollHeight - element.clientHeight) / free : 0
  }

  return (
    <div
      ref={track}
      aria-hidden
      className={cn('sandbox-overlay-scrollbar', metrics.visible && 'is-visible', (active || dragging) && 'is-active', dragging && 'is-dragging', className)}
      onPointerDown={(event) => {
        const element = target.current
        if (event.button !== 0 || !element || event.target !== event.currentTarget) return
        // 点轨道翻一页，方向取点击位置在滑块的哪一侧。
        const offset = event.clientY - event.currentTarget.getBoundingClientRect().top
        element.scrollBy({ top: (offset < metrics.top ? -1 : 1) * element.clientHeight * 0.9, behavior: 'smooth' })
      }}
    >
      <div
        className="sandbox-overlay-scrollbar-thumb"
        style={{ height: metrics.size, transform: `translateY(${metrics.top}px)` }}
        onPointerDown={(event) => {
          const element = target.current
          if (event.button !== 0 || !element) return
          event.preventDefault()
          drag.current = { id: event.pointerId, y: event.clientY, scrollTop: element.scrollTop }
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const state = drag.current
          const element = target.current
          if (!state || state.id !== event.pointerId || !element) return
          element.scrollTop = state.scrollTop + (event.clientY - state.y) * scrollPerPixel()
        }}
        onPointerUp={() => {
          drag.current = undefined
          setDragging(false)
        }}
        onPointerCancel={() => {
          drag.current = undefined
          setDragging(false)
        }}
      />
    </div>
  )
}
