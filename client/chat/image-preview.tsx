import * as React from 'react'
import { createPortal } from 'react-dom'
import { XIcon } from 'lucide-react'
import { Button } from '@chatluna/ui-kit'
import { useT } from '../i18n'

const MIN_SCALE = 1
const MAX_SCALE = 8
const ZOOM_FACTOR = 1.2

/** 大图预览：滚轮以指针为锚点缩放（1–8 倍），放大后可拖动平移，Esc 或点背景关闭。 */
export function ImagePreview({ url, onClose }: { url: string, onClose(): void }) {
  const t = useT()
  const image = React.useRef<HTMLImageElement>(null)
  const [scale, setScale] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const drag = React.useRef<{ id: number, x: number, y: number, ox: number, oy: number, moved: boolean } | undefined>(undefined)
  const suppressClick = React.useRef(0)

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const clampOffset = (next: { x: number, y: number }, nextScale: number) => {
    const element = image.current
    if (!element) return next
    const limitX = Math.max((element.offsetWidth * nextScale - window.innerWidth) / 2, 0)
    const limitY = Math.max((element.offsetHeight * nextScale - window.innerHeight) / 2, 0)
    return { x: Math.min(Math.max(next.x, -limitX), limitX), y: Math.min(Math.max(next.y, -limitY), limitY) }
  }

  const onWheel = (event: React.WheelEvent) => {
    if (!event.deltaY) return
    const target = Math.min(Math.max(scale * (event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR), MIN_SCALE), MAX_SCALE)
    if (target === scale) return
    const ratio = target / scale
    const dx = event.clientX - window.innerWidth / 2
    const dy = event.clientY - window.innerHeight / 2
    setScale(target)
    setOffset(clampOffset({ x: dx - (dx - offset.x) * ratio, y: dy - (dy - offset.y) * ratio }, target))
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('sandbox.media.preview')}
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-black/80 text-sm leading-6 animate-in fade-in-0"
      onWheel={onWheel}
      onClick={(event) => {
        if (performance.now() < suppressClick.current) return
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <img
        ref={image}
        src={url}
        alt=""
        draggable={false}
        className="max-h-[90vh] max-w-[90vw] select-none object-contain transition-transform duration-75"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        onPointerDown={(event) => {
          if (event.button !== 0 || scale <= MIN_SCALE) return
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y, moved: false }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const state = drag.current
          if (!state || state.id !== event.pointerId) return
          const dx = event.clientX - state.x
          const dy = event.clientY - state.y
          if (!state.moved && Math.hypot(dx, dy) < 3) return
          state.moved = true
          setOffset(clampOffset({ x: state.ox + dx, y: state.oy + dy }, scale))
        }}
        onPointerUp={(event) => {
          if (drag.current?.moved) suppressClick.current = performance.now() + 250
          drag.current = undefined
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
      />
      <span className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white tabular-nums">{Math.round(scale * 100)}%</span>
      <Button variant="ghost" size="icon" className="absolute top-4 right-4 text-white hover:bg-white/15 hover:text-white" aria-label={t('sandbox.common.close')} onClick={onClose}>
        <XIcon />
      </Button>
    </div>,
    document.body,
  )
}
