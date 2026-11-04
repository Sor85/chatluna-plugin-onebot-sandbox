import type { MessageCapabilities } from '../../src/message-capabilities'

/**
 * 点头像／点气泡／点整条这三条路的分流规则。
 *
 * 三条今天全靠人点界面验证，改坏了不会报错：多选下点头像失效、点气泡里的图片被当成打开预览、
 * 点行内空白没反应。判定进这个模块，`preventDefault` / `stopPropagation` / `closest` 这些
 * DOM 机械动作留在视图里（ADR 0075）。
 */

export type MessagePointerAction =
  /** 什么都不做，并且**不阻断冒泡**——让事件继续交给外层。 */
  | { readonly kind: 'none' }
  /** 打开资料卡，并吞掉事件。 */
  | { readonly kind: 'open-profile' }
  /** 切换这条消息的勾选，并吞掉事件。 */
  | { readonly kind: 'toggle-selection' }

/** 分流只问两件事：现在是不是多选态，以及这条消息能不能进多选。 */
export interface MessagePointerContext {
  readonly selectionMode: boolean
  readonly forwardCapability: boolean
}

export function readPointerContext(
  selectionMode: boolean | undefined,
  capabilities: MessageCapabilities,
): MessagePointerContext {
  return { selectionMode: !!selectionMode, forwardCapability: capabilities.forward }
}

/**
 * 点头像。
 *
 * 多选态下返回 `none`：头像仍属于整条消息的可选区域，**不得阻断冒泡**，否则点头像无法勾选。
 * 这条是三条里最容易改坏的——加一个 `.stop` 就静默失效。
 */
export function routeAvatarClick(context: MessagePointerContext): MessagePointerAction {
  if (context.selectionMode) return { kind: 'none' }
  return { kind: 'open-profile' }
}

/**
 * 点气泡（捕获阶段）。
 *
 * 捕获先于卡片、媒体与回应控件执行，因此多选时整颗气泡只负责切换勾选，不会误打开详情或文件。
 * 但只在「多选且这条能进多选」时才接管：不可转发的消息（事件行、已撤回）在多选态下点气泡
 * 仍应交回气泡自己处理。
 */
export function routeBubbleClick(context: MessagePointerContext): MessagePointerAction {
  if (!context.selectionMode || !context.forwardCapability) return { kind: 'none' }
  return { kind: 'toggle-selection' }
}

/** 气泡的类名。整条点击靠它排除气泡区，因此它是分流判定的一部分而不是呈现细节。 */
export const MESSAGE_BUBBLE_SELECTOR = '.chatluna-sandbox-message-bubble'

export interface MessagePointerTarget {
  closest(selector: string): unknown
}

/**
 * 点整条。
 *
 * 气泡由捕获处理器统一接管，因此这里必须排除气泡区，只覆盖头像、发送者信息与行内空白；
 * 不排除的话同一次点击会被切换两次，净效果是勾选状态不变。
 */
export function routeRowClick(
  context: MessagePointerContext,
  target: MessagePointerTarget | null,
): MessagePointerAction {
  if (!context.selectionMode || !context.forwardCapability) return { kind: 'none' }
  if (target?.closest(MESSAGE_BUBBLE_SELECTOR)) return { kind: 'none' }
  return { kind: 'toggle-selection' }
}
