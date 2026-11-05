import {
  forwardNodeText,
  type SandboxForward,
  type SandboxForwardNode,
  type SandboxForwardPreview,
  type SandboxMessage,
} from '../../src/types'
import { getMediaLabel } from './message-presentation'

// 自定义节点可以同时带文字、媒体与嵌套转发，三者都要进摘要；与服务端 formatForwardPreview 同步。
function summarizeNode(node: SandboxForwardNode): string {
  const text = forwardNodeText(node).replace(/\s+/g, ' ').trim()
  const parts = [
    text,
    ...(!text && node.media?.length ? node.media.map((item) => `[${getMediaLabel(item)}] ${item.name}`) : []),
    ...(node.forwardId ? ['[合并转发]'] : []),
  ].filter(Boolean)
  return parts.join(' ') || '[消息]'
}

// 列表卡片只需要标题、总数和最多 4 行摘要；完整 node 仍由 SandboxForward 承载。
export function buildForwardPreview(forward: SandboxForward): SandboxForwardPreview {
  return {
    title: forward.title ?? '群聊的聊天记录',
    total: forward.nodes.length,
    lines: forward.nodes.slice(0, 4).map((node) => `${node.nickname}：${summarizeNode(node)}`),
  }
}

export function buildForwardPreviewMap(
  messages: readonly Pick<SandboxMessage, 'id' | 'forwardId'>[],
  forwards: readonly SandboxForward[],
): Record<string, SandboxForwardPreview> {
  const forwardsById = new Map(forwards.map((forward) => [forward.id, forward]))
  return Object.fromEntries(messages.flatMap((message) => {
    if (!message.forwardId) return []
    const forward = forwardsById.get(message.forwardId)
    return forward ? [[message.id, buildForwardPreview(forward)]] : []
  }))
}
