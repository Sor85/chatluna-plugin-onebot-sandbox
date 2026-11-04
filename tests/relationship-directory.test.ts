import { describe, expect, it } from 'vitest'
import { getConversationPeerId, getFriendDirectory, getGroupDirectory } from '../client/webqq/relationship-directory'
import { requireConversation } from '../src/conversation-resolution'
import type { SandboxSnapshot } from '../src/types'

const snapshot: SandboxSnapshot = {
  revision: 1,
  participants: [
    { kind: 'user', id: '10001', name: '当前用户' },
    { kind: 'user', id: '10002', name: '好友用户' },
    { kind: 'user', id: '10003', name: '陌生用户' },
    { kind: 'bot', id: '20001', name: 'Koishi', implementation: 'napcat', enabled: true },
  ],
  groups: [
    { id: '30001', name: '已加入群', announcements: [], members: [{ participantId: '10001', role: 'member' }] },
    { id: '30002', name: '未加入群', announcements: [], members: [{ participantId: '10002', role: 'owner' }] },
    { id: '30003', name: '可申请群', announcements: [], members: [{ participantId: '10003', role: 'owner' }] },
  ],
  conversations: [
    { id: 'private:10001:10002', type: 'direct', participantIds: ['10001', '10002'], messageIds: [] },
    { id: 'private:10001:20001', type: 'direct', participantIds: ['10001', '20001'], messageIds: [] },
    { id: 'group:30001', type: 'group', groupId: '30001', messageIds: [] },
  ],
  messages: [],
  forwards: [],
  friendships: [{ id: 'friend:10001:10002', participantIds: ['10001', '10002'], remarks: { 10001: '搭档' }, createdAt: '' }],
  requests: [{ id: 'request:group', type: 'group', requesterId: '10001', groupId: '30002', status: 'pending', createdAt: '' }],
}

describe('当前操作者关系目录', () => {
  it('机器人视角把会话中的普通用户识别为对端', () => {
    const conversation = requireConversation(snapshot, 'private:10001:20001')

    expect(getConversationPeerId(conversation, '10001')).toBe('20001')
    expect(getConversationPeerId(conversation, '20001')).toBe('10001')
  })

  it('展示除当前操作者外的全部用户和机器人并标记好友关系', () => {
    const directory = getFriendDirectory(snapshot, '10001')

    expect(directory.map(({ id }) => id)).toEqual(['10002', '10003', '20001'])
    expect(directory.find(({ id }) => id === '10002')).toMatchObject({
      displayName: '搭档',
      relation: 'added',
      conversationId: 'private:10001:10002',
    })
    expect(directory.find(({ id }) => id === '10003')).toMatchObject({ relation: 'missing' })
    expect(directory.find(({ id }) => id === '20001')).toMatchObject({ relation: 'missing', conversationId: 'private:10001:20001' })
  })

  it('展示全部群组并标记已加入、待处理和未加入状态', () => {
    const directory = getGroupDirectory(snapshot, '10001')

    expect(directory).toHaveLength(3)
    expect(directory.find(({ id }) => id === '30001')).toMatchObject({ relation: 'joined', conversationId: 'group:30001' })
    expect(directory.find(({ id }) => id === '30002')).toMatchObject({ relation: 'pending' })
    expect(directory.find(({ id }) => id === '30003')).toMatchObject({ relation: 'missing' })
  })

  it('机器人作为当前操作者时使用机器人自身的群成员关系', () => {
    const directory = getGroupDirectory(snapshot, '20001')

    expect(directory.find(({ id }) => id === '30001')).toMatchObject({ relation: 'missing' })
  })
})
