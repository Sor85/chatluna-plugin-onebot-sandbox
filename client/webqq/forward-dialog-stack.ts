import type { SandboxForward, SandboxForwardNode } from '../../src/types'
import { buildForwardPreview } from './forward-preview'

/**
 * 嵌套合并转发的逐层打开与逐层关闭。
 *
 * 它是一个纯栈加一次异步读取：每一帧对应一层叠起来的转发详情窗口，关掉上层只截断栈尾。
 */

export interface ForwardDialogFrame {
  readonly title: string
  readonly items: SandboxForwardNode[]
  readonly nestedForwards: Record<string, SandboxForward>
}

/**
 * 压入新的一帧。
 *
 * 根消息用 `replace` 重置整条历史——从消息气泡打开的是一条新的转发链，把它压在旧链后面会让
 * 关掉上层后露出一条无关的转发。嵌套详情用 `push`，关掉上层时下层原样保留而不重复 RPC。
 */
export function pushForwardFrame(
  stack: readonly ForwardDialogFrame[],
  frame: ForwardDialogFrame,
  mode: 'replace' | 'push',
): ForwardDialogFrame[] {
  return mode === 'push' ? [...stack, frame] : [frame]
}

/** 关闭：清空整条历史，下次打开重新读。 */
export function closeForwardStack(): ForwardDialogFrame[] {
  return []
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
    // 没有可推断的标题时留空，由界面按当前语言显示「合并转发」。
    title: buildForwardPreview(forward).title,
    items: forward.nodes.map((node) => ({ ...node })),
    nestedForwards: Object.fromEntries(
      nestedEntries.filter((entry): entry is readonly [string, SandboxForward] => !!entry),
    ),
  }
}
