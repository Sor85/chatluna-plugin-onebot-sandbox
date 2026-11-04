import * as React from 'react'
import { useT } from '../i18n'
import { mountAgentOverlayEffect } from '../workspace/agent-overlay-effect'
import { AgentControlIcon, AgentCursor } from './agent-visuals'

/**
 * ego lite 被控空间覆盖层的 Web 复刻：scrim + 点阵纹理 + WebGL 边缘光 + agent 光标 + 顶部任务栏。
 * WebGL 不可用时只保留 scrim 与点阵。覆盖层本身不拦截指针，只有任务栏可点。
 */
export function AgentObserveOverlay({ spaceName, busy, onTakeOver, onTerminate }: {
  spaceName: string
  busy: boolean
  onTakeOver(): void
  onTerminate(): void
}) {
  const t = useT()
  const canvas = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    if (!canvas.current) return
    return mountAgentOverlayEffect(canvas.current) ?? undefined
  }, [])

  return (
    <div className="sandbox-agent-observe" aria-live="polite">
      <div className="sandbox-agent-observe-dots" aria-hidden="true" />
      <canvas ref={canvas} className="sandbox-agent-observe-canvas" aria-hidden="true" />
      <AgentCursor />
      <div className="sandbox-agent-taskbar">
        <span className="sandbox-agent-taskbar-pause" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <rect x="7" y="5" width="3" height="14" rx="1.2" />
            <rect x="14" y="5" width="3" height="14" rx="1.2" />
          </svg>
        </span>
        <span className="sandbox-agent-taskbar-control-icon"><AgentControlIcon running /></span>
        <span className="sandbox-agent-taskbar-text">
          <strong className="sandbox-agent-taskbar-title">{spaceName}</strong>
          <span className="sandbox-agent-taskbar-subtitle">{t('sandbox.spaces.taskbar.subtitle')}</span>
        </span>
        <button type="button" className="sandbox-agent-taskbar-takeover" disabled={busy} onClick={onTakeOver}>{t('sandbox.spaces.taskbar.takeOver')}</button>
        <button type="button" className="sandbox-agent-taskbar-terminate" disabled={busy} onClick={onTerminate}>{t('sandbox.spaces.taskbar.terminate')}</button>
      </div>
    </div>
  )
}
