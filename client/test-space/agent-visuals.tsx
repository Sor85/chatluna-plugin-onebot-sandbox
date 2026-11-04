import * as React from 'react'
import { cn } from '@chatluna/ui-kit'

/**
 * ego lite 的 agent 光标：每 5.2-9s 随机跳到一个新位置（模拟 agent 思考间隔），单次移动由 CSS
 * transition 完成；到位后播放 400ms 点击挤压，静止 200ms 后进入 loading 浮动。样式在 `spaces.css`。
 */
export function AgentCursor({ label = 'AI', size = 20 }: { label?: string, size?: number }) {
  const [position, setPosition] = React.useState({ top: '38%', left: '55%' })
  const [clicking, setClicking] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const timers = React.useRef<{ click?: ReturnType<typeof setTimeout>, loading?: ReturnType<typeof setTimeout> }>({})

  const clearActionTimers = React.useCallback(() => {
    clearTimeout(timers.current.click)
    clearTimeout(timers.current.loading)
  }, [])

  React.useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let jump: ReturnType<typeof setTimeout>
    const schedule = () => {
      jump = setTimeout(() => {
        clearActionTimers()
        setClicking(false)
        setLoading(false)
        setPosition({ top: `${22 + Math.random() * 52}%`, left: `${18 + Math.random() * 60}%` })
        schedule()
      }, 5200 + Math.random() * 3800)
    }
    timers.current.loading = setTimeout(() => setLoading(true), 200)
    schedule()
    return () => {
      clearTimeout(jump)
      clearActionTimers()
    }
  }, [clearActionTimers])

  const arrive = (event: React.TransitionEvent) => {
    // top 与 left 各触发一次 transitionend，只认其中一个避免动作链跑两遍。
    if (event.propertyName !== 'top') return
    clearActionTimers()
    setClicking(true)
    timers.current.click = setTimeout(() => {
      setClicking(false)
      timers.current.loading = setTimeout(() => setLoading(true), 200)
    }, 400)
  }

  return (
    <div
      className={cn('sandbox-agent-cursor', clicking && 'is-clicking', loading && 'is-loading')}
      style={position}
      aria-hidden="true"
      onTransitionEnd={arrive}
    >
      <span className="sandbox-agent-cursor-float">
        {/* ego lite 官方 agent 光标形状（viewBox 0 0 20 20，白描边）。 */}
        <svg viewBox="0 0 20 20" width={size} height={size} fill="none" aria-hidden="true">
          <path
            d="M6.465 15.647 4.511 4.813a1 1 0 0 1 1.366-1.102l9.698 4.007c.853.352.815 1.572-.058 1.87l-4.682 1.6a1 1 0 0 0-.588.534l-1.887 4.16c-.405.894-1.72.73-1.895-.235Z"
            fill="currentColor"
            stroke="#fff"
            strokeWidth="1.5"
          />
        </svg>
        <span className="sandbox-agent-cursor-label">{label}</span>
      </span>
    </div>
  )
}

// 白底挖掉放大后的光标；作为 CSS mask 作用在整层 SVG 上，才能裁到 CSS rotate 合成后的射线。
const RAY_MASK = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><defs><mask id="m" maskUnits="userSpaceOnUse"><rect x="-8" y="-8" width="36" height="36" fill="#fff"/><path d="M9.3 16.3 8.08 9.53a.63 .63 0 0 1 .85-.69L15 11.35a.63 .63 0 0 1-.03 1.18l-2.93 1a.63 .63 0 0 0-.37.34l-1.18 2.6a.63 .63 0 0 1-1.19-.17Z" transform="translate(1.6 1) translate(0 .35) translate(10.8 12.4) scale(1.28) translate(-10.8 -12.4)" fill="#000" stroke="#000" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="12.6" cy="16.9" rx="4.2" ry="3.4" fill="#000"/><ellipse cx="14.8" cy="14.6" rx="2.6" ry="2.4" fill="#000"/><circle cx="10.6" cy="17.8" r="2.8" fill="#000"/></mask></defs><rect x="-8" y="-8" width="36" height="36" fill="#fff" mask="url(#m)"/></svg>')}")`
const RAY_MASK_STYLE: React.CSSProperties = {
  maskImage: RAY_MASK,
  maskSize: '100% 100%',
  maskRepeat: 'no-repeat',
  WebkitMaskImage: RAY_MASK,
  WebkitMaskSize: '100% 100%',
  WebkitMaskRepeat: 'no-repeat',
}

/**
 * Agent 控制图标：光标静止，八向射线绕光标尖旋转；射线层用 CSS mask 挖掉光标轮廓，转到光标里消失、
 * 转出后再出现。运行态在图标外再套一圈双层反向光带，是被控覆盖层边缘光的圆形缩写。
 */
export function AgentControlIcon({ running, small }: { running?: boolean, small?: boolean }) {
  return (
    <span className={cn('sandbox-agent-control', running && 'is-running', small && 'is-small')} aria-hidden="true">
      <span className="sandbox-agent-control-orbit">
        <span className="sandbox-agent-control-orbit-band is-inner" />
        <span className="sandbox-agent-control-orbit-band is-outer" />
      </span>
      <svg
        className="sandbox-agent-control-icon sandbox-agent-control-rays-layer"
        style={RAY_MASK_STYLE}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <g transform="translate(1.6 1)">
          <g transform="translate(8.7 8.4)">
            <g className="sandbox-agent-control-icon-rays">
              <g transform="translate(-8.7 -8.4)">
                <path d="M8.4.9v2.5M3.33 3.33 5.1 5.1M1.2 8.4h2.5M3.33 13.47l1.77-1.77M13.47 3.33 11.7 5.1M13.1 8.4h2.5M8.4 15.9v-2.5M13.47 13.47 11.7 11.7" transform="translate(.3 0)" />
              </g>
            </g>
          </g>
        </g>
      </svg>
      <svg className="sandbox-agent-control-icon sandbox-agent-control-pointer" viewBox="0 0 20 20" fill="none">
        <g transform="translate(1.6 1)">
          <path d="M9.3 16.3 8.08 9.53a.63 .63 0 0 1 .85-.69L15 11.35a.63 .63 0 0 1-.03 1.18l-2.93 1a.63 .63 0 0 0-.37.34l-1.18 2.6a.63 .63 0 0 1-1.19-.17Z" transform="translate(0 .35)" fill="currentColor" stroke="none" />
        </g>
      </svg>
    </span>
  )
}
