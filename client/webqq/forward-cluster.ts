import type { SandboxForwardNode } from '../../src/types'

function isSameForwardSender(left: SandboxForwardNode | undefined, right: SandboxForwardNode | undefined) {
  return !!left && !!right && left.userId === right.userId
}

// 合并转发详情弹窗复用 TIM 连续消息合并：同发送者相邻节点隐藏重复头像。
export function isMergedForwardNode(items: readonly SandboxForwardNode[], index: number) {
  return isSameForwardSender(items[index - 1], items[index])
}

export function getForwardNodeClusterClass(items: readonly SandboxForwardNode[], index: number) {
  if (!items[index]) return ''
  const hasPrevious = isSameForwardSender(items[index - 1], items[index])
  const hasNext = isSameForwardSender(items[index], items[index + 1])
  if (hasPrevious && hasNext) return 'is-cluster-middle'
  if (hasNext) return 'is-cluster-first'
  if (hasPrevious) return 'is-cluster-last'
  return ''
}
