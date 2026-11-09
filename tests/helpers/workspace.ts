import { projectVisibleConversations } from '../../src/conversation-resolution'
import type { SandboxSnapshot, SandboxWorkspaceState } from '../../src/types'

/** 每个用户都有两条机器人私聊，并共享同一个群；不含媒体或真实场景数据。 */
export function workspaceFor(operatorId = '10001', revision = 1): SandboxWorkspaceState {
  const snapshot: SandboxSnapshot = {
    revision,
    participants: [
      { kind: 'user', id: '10001', name: '测试用户1' },
      { kind: 'user', id: '10003', name: '测试用户3' },
      { kind: 'bot', id: '20001', name: 'Koishi', implementation: 'napcat', enabled: true },
      { kind: 'bot', id: '20002', name: 'SnowLuma 实测', implementation: 'snowluma', enabled: true },
    ],
    groups: [{
      id: '30001',
      name: '测试群',
      announcements: [],
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '10003', role: 'member' },
        { participantId: '20001', role: 'admin' },
      ],
    }],
    conversations: [
      ...['10001', '10003'].flatMap((userId) => ['20001', '20002'].map((botId) => ({
        id: `private:${userId}:${botId}`,
        type: 'direct' as const,
        participantIds: [userId, botId] as [string, string],
        messageIds: [],
      }))),
      { id: 'group:30001', type: 'group', groupId: '30001', messageIds: [] },
    ],
    conversationInstances: [],
    forwards: [],
    messages: [],
    friendships: ['10001', '10003'].flatMap((userId) => ['20001', '20002'].map((botId) => ({
      id: `friend:${userId}:${botId}`,
      participantIds: [userId, botId] as [string, string],
      remarks: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    }))),
    requests: [],
  }
  const projection = projectVisibleConversations(snapshot, operatorId, 50)
  return {
    snapshot: {
      ...snapshot,
      conversations: projection.conversations,
      conversationInstances: projection.conversationInstances,
    },
    chatLunaStates: [],
    appearance: {
      sandboxTimBubbleTail: true,
      sandboxIncomingBubbleStyle: 'shadow',
      sandboxAccentColor: '#2563eb',
      sandboxMarkRecalledMessages: true,
    },
    persistence: { mode: 'memory', available: false, persisted: false },
  }
}
