import type { SandboxForward, SandboxForwardNode } from '../../src/types'
import { buildForwardPreview } from './forward-preview'

/**
 * 嵌套合并转发的逐层打开与逐层返回。
 *
 * 它是一个纯栈加一次异步读取，此前和整个聊天区域的其余状态混在一起，只能靠点界面验证
 * 「读完一条转发链再逐层退回来」这件事。
 */

export interface ForwardDialogFrame {
  readonly title: string
  readonly items: SandboxForwardNode[]
  readonly nestedForwards: Record<string, SandboxForward>
}

/** 顶层弹窗显示的是栈顶那一帧；空栈等于弹窗关闭。 */
export function readForwardStackTop(
  stack: readonly ForwardDialogFrame[],
): ForwardDialogFrame | undefined {
  return stack.at(-1)
}

/**
 * 压入新的一帧。
 *
 * 根消息用 `replace` 重置整条历史——从消息气泡打开的是一条新的转发链，把它压在旧链后面会让
 * 「返回」退到一条无关的转发里。嵌套详情用 `push`，返回时直接恢复上一帧而不重复 RPC。
 */
export function pushForwardFrame(
  stack: readonly ForwardDialogFrame[],
  frame: ForwardDialogFrame,
  mode: 'replace' | 'push',
): ForwardDialogFrame[] {
  return mode === 'push' ? [...stack, frame] : [frame]
}

/**
 * 返回上一层。
 *
 * 只剩根帧时不弹——根帧的返回按钮本来就不显示，弹掉它等于用「返回」把弹窗关掉，
 * 而关闭是另一个动作（`closeForwardStack`）。
 */
export function popForwardFrame(stack: readonly ForwardDialogFrame[]): ForwardDialogFrame[] {
  if (stack.length <= 1) return [...stack]
  return stack.slice(0, -1)
}

/** 关闭：清空整条历史，下次打开重新读。 */
export function closeForwardStack(): ForwardDialogFrame[] {
  return []
}

/**
 * 返回按钮只在栈里还有上一层时出现。
 *
 * 名字避开「can + 动作」的形状：那是架构守卫「客户端不自己判定消息能力」的谓词，
 * 而这里问的是栈深度，不是消息能力。
 */
export function hasParentForwardFrame(stack: readonly ForwardDialogFrame[]): boolean {
  return stack.length > 1
}

/**
 * 按入参读一帧。
 *
 * 两种入参：从消息气泡打开时给的是转发资源标识与消息标识，从嵌套卡片打开时只有转发资源标识。
 * 嵌套资源逐个尝试读取，失败的那个不算整帧失败——外层弹窗照旧打开，那张卡片回退为占位文案。
 * 整帧读取失败则返回 undefined，弹窗不打开，错误由页面控制层展示。
 */
export async function loadForwardDialogFrame(input: {
  readonly input: { forwardId?: string, messageId?: string }
  readonly load: (input: { forwardId?: string, messageId?: string }) => Promise<SandboxForward>
}): Promise<ForwardDialogFrame | undefined> {
  let forward: SandboxForward
  try {
    forward = await input.load(input.input)
  } catch {
    return
  }

  const nestedEntries = await Promise.all(
    forward.nodes
      .map((node) => node.forwardId)
      .filter((forwardId): forwardId is string => !!forwardId)
      .map(async (forwardId) => {
        try {
          return [forwardId, await input.load({ forwardId })] as const
        } catch {
          return undefined
        }
      }),
  )

  return {
    title: buildForwardPreview(forward).title || '合并转发',
    items: forward.nodes.map((node) => ({ ...node })),
    nestedForwards: Object.fromEntries(
      nestedEntries.filter((entry): entry is readonly [string, SandboxForward] => !!entry),
    ),
  }
}
