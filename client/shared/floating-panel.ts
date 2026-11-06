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
