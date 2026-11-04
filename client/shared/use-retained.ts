import * as React from 'react'

/**
 * 按需打开的弹窗在关闭时数据立即清空，而 Base UI 退场动画期间仍按新 props 渲染约 200ms，
 * 内容会在淡出时变成空态或另一种模式。这里保留最后一份非空值，让退场期间画面不变；
 * 再次打开时直接换成新值，不沿用上一次的内容。
 */
export function useRetained<T>(value: T | undefined): T | undefined {
  const last = React.useRef(value)
  if (value !== undefined) last.current = value
  return value ?? last.current
}
