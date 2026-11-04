export interface FloatingPanelAnchor {
  x: number
  y: number
}

export interface FloatingPanelViewport {
  width: number
  height: number
}

const panelGap = 8
const viewportPadding = 12
let lastAnchor: FloatingPanelAnchor = { x: viewportPadding, y: viewportPadding }

export function getFloatingPanelRectAnchor(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): FloatingPanelAnchor {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

export function rememberFloatingPanelAnchor(event: MouseEvent): void {
  if (event.clientX || event.clientY) {
    lastAnchor = { x: event.clientX, y: event.clientY }
    return
  }
  // 键盘激活按钮产生的 click 坐标通常是 (0, 0)；改用控件中心，避免浮层跳到视口左上角。
  if (typeof Element === 'undefined' || !(event.target instanceof Element)) return
  const target = event.target.closest('button, [role="button"], a')
  if (!target) return
  lastAnchor = getFloatingPanelRectAnchor(target.getBoundingClientRect())
}

export function getFloatingPanelPosition(
  anchor: FloatingPanelAnchor,
  viewport: FloatingPanelViewport,
  panel: { width: number, height: number },
): FloatingPanelAnchor {
  const width = Math.min(panel.width, Math.max(0, viewport.width - viewportPadding * 2))
  const height = Math.min(panel.height, Math.max(0, viewport.height - viewportPadding * 2))
  return {
    x: Math.max(viewportPadding, Math.min(anchor.x + panelGap, viewport.width - width - viewportPadding)),
    y: Math.max(viewportPadding, Math.min(anchor.y + panelGap, viewport.height - height - viewportPadding)),
  }
}

export function getFloatingPanelStyle(panel: { width?: number, height: number }): Record<string, string> {
  const position = getFloatingPanelPosition(lastAnchor, {
    width: window.innerWidth,
    height: window.innerHeight,
  }, {
    width: panel.width ?? 380,
    height: panel.height,
  })
  return {
    left: `${position.x}px`,
    top: `${position.y}px`,
  }
}

export function clampFloatingPanelPosition(
  position: FloatingPanelAnchor,
  viewport: FloatingPanelViewport,
  panel: { width: number, height: number },
): FloatingPanelAnchor {
  return {
    x: Math.max(viewportPadding, Math.min(position.x, viewport.width - panel.width - viewportPadding)),
    y: Math.max(viewportPadding, Math.min(position.y, viewport.height - panel.height - viewportPadding)),
  }
}

export function isFloatingPanelInteractiveTarget(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && !!target.closest('button, input, textarea, select, [role="button"], a')
}
