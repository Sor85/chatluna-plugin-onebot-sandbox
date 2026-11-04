import * as React from 'react'

/**
 * 元素自身的内容宽度。沙盒嵌在 v2 外壳里，左侧还有宿主侧栏，按视口宽度判断三栏布局会高估可用空间；
 * 用 ResizeObserver 量沙盒根节点，宿主侧栏展开收起也能跟上。首帧在布局阶段量好，不先按 0 渲染一次。
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.offsetWidth)
    const observer = new ResizeObserver(() => setWidth(element.offsetWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}
