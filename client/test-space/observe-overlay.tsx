import * as React from 'react'
import { Button } from '@chatluna/ui-kit'
import { useT } from '../i18n'
import { mountAgentOverlayEffect } from '../workspace/agent-overlay-effect'
import { AgentCursor } from './agent-visuals'

/**
 * ego lite 被控空间覆盖层的 Web 复刻：scrim + 点阵纹理 + WebGL 边缘光 + agent 光标 + 顶部任务栏。
 * WebGL 不可用时只保留 scrim 与点阵。覆盖层本身不拦截指针，只有任务栏可点。
 */
export function AgentObserveOverlay({ spaceName, busy, style, onTakeOver, onTerminate }: {
  spaceName: string
  busy: boolean
  /** 根节点上的 CSS 变量：强调色与页头高度（任务栏在页头那一条里居中）。 */
  style?: React.CSSProperties
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
    <div className="sandbox-agent-observe" style={style} aria-live="polite">
      <div className="sandbox-agent-observe-dots" aria-hidden="true" />
      <canvas ref={canvas} className="sandbox-agent-observe-canvas" aria-hidden="true" />
      <AgentCursor />
      {/* 空间名已显示在页头的空间标签上，任务栏只留状态与操作，名称作为工具条的无障碍名称。 */}
      <div role="toolbar" aria-label={spaceName} className="sandbox-agent-taskbar sandbox-glass bg-popover text-popover-foreground shadow-popup ring-1 ring-border">
        <span className="sandbox-agent-pulse-dot" aria-hidden="true" />
        <span className="sandbox-agent-taskbar-status">{t('sandbox.spaces.taskbar.subtitle')}</span>
        <span className="sandbox-agent-taskbar-divider" aria-hidden="true" />
        <Button size="sm" className="rounded-full" disabled={busy} onClick={onTakeOver}>{t('sandbox.spaces.taskbar.takeOver')}</Button>
        <Button size="sm" variant="ghost" className="rounded-full text-destructive" disabled={busy} onClick={onTerminate}>{t('sandbox.spaces.taskbar.terminate')}</Button>
      </div>
    </div>
  )
}
