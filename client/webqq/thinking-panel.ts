/**
 * 思考面板的展开、时长文案与离场冻结。
 *
 * 离场冻结那一步内含一条真判定——按消息方向决定钉左缘还是钉右缘——今天只写在注释里，
 * 选错会让面板在离场瞬间水平跳位，而不会报错。判定进这个模块，DOM 写入留在视图里（ADR 0075）。
 */

/** 折叠按钮上的时长文案。没有时长时退回「思考过程」，负值兜底到 0。 */
export function formatThinkingDuration(durationMs?: number): string {
  if (durationMs === undefined) return '思考过程'
  return `已思考 ${Math.max(0, Math.round(durationMs / 1000))}s`
}

/**
 * 切换一条消息的思考面板展开态。
 *
 * 返回新对象而不是就地改：展开态是响应式引用的值，就地改不会触发重渲染，表现为点了没反应。
 */
export function toggleThinkingExpansion(
  expanded: Readonly<Record<string, true>>,
  messageId: string,
): Record<string, true> {
  const next = { ...expanded }
  if (next[messageId]) delete next[messageId]
  else next[messageId] = true
  return next
}

export interface ThinkingPanelRect {
  readonly top: number
  readonly right: number
  readonly left: number
  readonly width: number
}

/** 视图往面板 `style` 上写的那七项。声明成这七个字符串字段，`CSSStyleDeclaration` 天然满足。 */
export interface ThinkingPanelFreezeStyle {
  position: string
  top: string
  left: string
  right: string
  width: string
  maxWidth: string
  marginTop: string
}

/**
 * 把离场中的思考面板冻结在它原来的视觉位置。
 *
 * Vue 的离场节点默认继续占住文档流，后续消息只能等面板淡出结束才上移；脱流后消息位移与面板
 * 离场才同步开始。脱流带来两件必须一起处理的事：
 *
 * - **水平锚点选收缩后位置不变的那一侧。** 面板脱流后思考行的宽度立刻收缩成指标行宽度，
 *   入向行左缘固定、出向行右缘固定。钉错一侧面板会在离场瞬间水平跳位。
 * - **解除宽度百分比约束。** `max-width` 里的 `100%` 同样按收缩后的行宽重算，会把冻结宽度
 *   压小，迫使单行思考内容先换行再淡出。
 */
export function computeThinkingPanelFreeze(input: {
  readonly panel: ThinkingPanelRect
  readonly row: ThinkingPanelRect
  readonly incoming: boolean
}): ThinkingPanelFreezeStyle {
  const { panel, row, incoming } = input
  return {
    position: 'absolute',
    top: `${panel.top - row.top}px`,
    left: incoming ? `${panel.left - row.left}px` : '',
    right: incoming ? '' : `${row.right - panel.right}px`,
    width: `${panel.width}px`,
    maxWidth: 'none',
    marginTop: '0',
  }
}

/** 入向行的类名。方向决定钉哪一侧，因此它是冻结判定的输入而不是呈现细节。 */
export const INCOMING_ROW_CLASS = 'is-incoming'

export interface ThinkingPanelRowNode {
  getBoundingClientRect(): ThinkingPanelRect
  readonly classList: { contains(token: string): boolean }
}

export interface ThinkingPanelNode {
  readonly parentElement: ThinkingPanelRowNode | null
  readonly style: ThinkingPanelFreezeStyle
  getBoundingClientRect(): ThinkingPanelRect
}

/**
 * 读面板与它所在行的几何，算出冻结样式并写回。没有父行时什么都不做——那意味着节点已经脱离
 * 文档树，此时读到的矩形全是零，写回去会把面板钉到视口左上角。
 */
export function freezeThinkingPanel(panel: ThinkingPanelNode): ThinkingPanelFreezeStyle | undefined {
  const row = panel.parentElement
  if (!row) return
  const style = computeThinkingPanelFreeze({
    panel: panel.getBoundingClientRect(),
    row: row.getBoundingClientRect(),
    incoming: row.classList.contains(INCOMING_ROW_CLASS),
  })
  Object.assign(panel.style, style)
  return style
}
