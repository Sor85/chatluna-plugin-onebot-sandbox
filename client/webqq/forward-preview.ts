import type {
  SandboxForward,
  SandboxForwardNode,
  SandboxForwardPreview,
  SandboxMessage,
} from '../../src/types'
import { getMediaLabel } from './message-presentation'

function summarizeNode(node: SandboxForwardNode): string {
  if (node.forwardId) return '[合并转发]'
  const text = node.content.replace(/\s+/g, ' ').trim()
  if (text) return text
  if (node.media?.length) {
    return node.media.map((item) => `[${getMediaLabel(item)}] ${item.name}`).join(' ')
  }
  return '[消息]'
}

// 列表卡片只需要标题、总数和最多 4 行摘要；完整 node 仍由 SandboxForward 承载。
export function buildForwardPreview(forward: SandboxForward): SandboxForwardPreview {
  return {
    title: '群聊的聊天记录',
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
