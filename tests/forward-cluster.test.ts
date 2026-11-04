import { describe, expect, it } from 'vitest'
import { getForwardNodeClusterClass, isMergedForwardNode } from '../client/webqq/forward-cluster'
import type { SandboxForwardNode } from '../src/types'

describe('合并转发详情节点聚类', () => {
  it('同发送者相邻节点合并头像并给出 cluster 类名', () => {
    const items: SandboxForwardNode[] = [
      { userId: '1', nickname: 'A', content: '1', createdAt: '2026-01-01T00:00:00.000Z' },
      { userId: '1', nickname: 'A', content: '2', createdAt: '2026-01-01T00:00:01.000Z' },
      { userId: '1', nickname: 'A', content: '3', createdAt: '2026-01-01T00:00:02.000Z' },
      { userId: '2', nickname: 'B', content: '4', createdAt: '2026-01-01T00:00:03.000Z' },
    ]

    expect(isMergedForwardNode(items, 0)).toBe(false)
    expect(isMergedForwardNode(items, 1)).toBe(true)
    expect(isMergedForwardNode(items, 2)).toBe(true)
    expect(isMergedForwardNode(items, 3)).toBe(false)
    expect(getForwardNodeClusterClass(items, 0)).toBe('is-cluster-first')
    expect(getForwardNodeClusterClass(items, 1)).toBe('is-cluster-middle')
    expect(getForwardNodeClusterClass(items, 2)).toBe('is-cluster-last')
    expect(getForwardNodeClusterClass(items, 3)).toBe('')
  })
})
