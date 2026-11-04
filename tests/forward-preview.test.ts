import { describe, expect, it } from 'vitest'
import { buildForwardPreview, buildForwardPreviewMap } from '../client/webqq/forward-preview'
import type { SandboxForward, SandboxMessage } from '../src/types'

describe('合并转发列表预览投影', () => {
  it('生成标题、总数与最多 4 行摘要', () => {
    const forward: SandboxForward = {
      id: 'forward-1',
      authorId: '10001',
      createdAt: '2026-07-23T00:00:00.000Z',
      nodes: [
        { userId: '10001', nickname: '测试用户1', content: '第一条', createdAt: '2026-07-23T00:00:00.000Z' },
        { userId: '10002', nickname: '测试用户2', content: '第二条', createdAt: '2026-07-23T00:00:01.000Z' },
        { userId: '10001', nickname: '测试用户1', content: '第三条', createdAt: '2026-07-23T00:00:02.000Z' },
        {
          userId: '10002',
          nickname: '测试用户2',
          content: '',
          createdAt: '2026-07-23T00:00:03.000Z',
          media: [{
            id: 'media-1',
            type: 'image',
            name: 'a.png',
            mimeType: 'image/png',
            size: 12,
            reference: 'sandbox-media://media-1',
          }],
        },
        { userId: '10001', nickname: '测试用户1', content: '第五条', createdAt: '2026-07-23T00:00:04.000Z' },
        {
          userId: '10002',
          nickname: '测试用户2',
          content: '嵌套',
          createdAt: '2026-07-23T00:00:05.000Z',
          forwardId: 'forward-nested',
        },
      ],
    }

    expect(buildForwardPreview(forward)).toEqual({
      title: '群聊的聊天记录',
      total: 6,
      lines: [
        '测试用户1：第一条',
        '测试用户2：第二条',
        '测试用户1：第三条',
        '测试用户2：[图片] a.png',
      ],
    })
  })

  it('按消息 ID 投影当前页可见转发卡片', () => {
    const messages: SandboxMessage[] = [{
      id: 'message-1',
      authorId: '10001',
      conversationId: 'private:10001:20001',
      content: '测试用户1：第一条',
      createdAt: '2026-07-23T00:00:00.000Z',
      forwardId: 'forward-1',
    }, {
      id: 'message-2',
      authorId: '10001',
      conversationId: 'private:10001:20001',
      content: '普通消息',
      createdAt: '2026-07-23T00:00:01.000Z',
    }]
    const forwards: SandboxForward[] = [{
      id: 'forward-1',
      authorId: '10001',
      createdAt: '2026-07-23T00:00:00.000Z',
      nodes: [
        { userId: '10001', nickname: '测试用户1', content: '第一条', createdAt: '2026-07-23T00:00:00.000Z' },
        { userId: '10002', nickname: '测试用户2', content: '第二条', createdAt: '2026-07-23T00:00:01.000Z' },
      ],
    }]

    expect(buildForwardPreviewMap(messages, forwards)).toEqual({
      'message-1': {
        title: '群聊的聊天记录',
        total: 2,
        lines: [
          '测试用户1：第一条',
          '测试用户2：第二条',
        ],
      },
    })
  })
})
