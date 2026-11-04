import { describe, expect, it } from 'vitest'
import { getIncomingNotificationRequests } from '../client/webqq/notification-requests'
import type { SandboxSnapshot } from '../src/types'

const snapshot = {
  revision: 0,
  participants: [
    { kind: 'user', id: 'owner', name: '群主' },
    { kind: 'user', id: 'member', name: '成员' },
    { kind: 'user', id: 'applicant', name: '申请人' },
    { kind: 'bot', id: 'bot', name: '机器人', implementation: 'napcat', enabled: true },
  ],
  groups: [{
    id: 'group',
    name: '测试群',
    members: [{ participantId: 'owner', role: 'owner' }, { participantId: 'member', role: 'member' }, { participantId: 'bot', role: 'admin' }],
    announcements: [],
  }],
  conversations: [],
  messages: [],
  forwards: [],
  friendships: [],
  requests: [
    { id: 'friend', type: 'friend', requesterId: 'applicant', targetId: 'owner', status: 'pending', createdAt: '' },
    { id: 'group-request', type: 'group', subType: 'add', requesterId: 'applicant', groupId: 'group', status: 'pending', createdAt: '' },
    { id: 'group-invite', type: 'group', subType: 'invite', requesterId: 'owner', targetId: 'member', groupId: 'group', status: 'pending', createdAt: '' },
    { id: 'friend-bot', type: 'friend', requesterId: 'applicant', targetId: 'bot', status: 'pending', createdAt: '' },
  ],
} satisfies SandboxSnapshot

describe('铃铛通知申请', () => {
  it('群主可以看到发给自己的好友申请和负责群组的入群申请', () => {
    expect(getIncomingNotificationRequests(snapshot, 'owner')).toEqual({
      friends: [snapshot.requests[0]],
      groups: [snapshot.requests[1]],
    })
  })

  it('普通群成员看不到入群申请，但能处理发给自己的群邀请', () => {
    expect(getIncomingNotificationRequests(snapshot, 'member')).toEqual({ friends: [], groups: [snapshot.requests[2]] })
  })

  it('机器人操作者按自身好友和群管理身份接收申请', () => {
    expect(getIncomingNotificationRequests(snapshot, 'bot')).toEqual({
      friends: [snapshot.requests[3]],
      groups: [snapshot.requests[1]],
    })
  })
})
