import { describe, expect, it } from 'vitest'
import { clampFloatingPanelPosition, getFloatingPanelPosition, getFloatingPanelRectAnchor, isFloatingPanelInteractiveTarget } from '../client/shared/floating-panel'

describe('WebQQ 局部浮层定位', () => {
  it('从点击位置右下方展开，并在视口边缘内翻', () => {
    expect(getFloatingPanelPosition(
      { x: 240, y: 180 },
      { width: 1200, height: 800 },
      { width: 380, height: 520 },
    )).toEqual({ x: 248, y: 188 })

    expect(getFloatingPanelPosition(
      { x: 1100, y: 760 },
      { width: 1200, height: 800 },
      { width: 380, height: 520 },
    )).toEqual({ x: 808, y: 268 })
  })

  it('键盘激活时以目标控件中心作为浮层锚点', () => {
    expect(getFloatingPanelRectAnchor({ left: 120, top: 80, width: 40, height: 32 })).toEqual({
      x: 140,
      y: 96,
    })
  })

  it('拖动位置限制在视口边距内，并识别标题栏交互控件', () => {
    expect(clampFloatingPanelPosition(
      { x: -40, y: 900 },
      { width: 1200, height: 800 },
      { width: 380, height: 520 },
    )).toEqual({ x: 12, y: 268 })

    expect(isFloatingPanelInteractiveTarget(null)).toBe(false)
    expect(isFloatingPanelInteractiveTarget({} as EventTarget)).toBe(false)
  })
})
