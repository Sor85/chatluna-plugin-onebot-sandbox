import { describe, expect, it } from 'vitest'
import type { SandboxSnapshot } from '../src/types'
import { resolveWorkspaceSelection } from '../client/workspace/state'

const snapshot: SandboxSnapshot = {
  revision: 0,
  participants: [
    { kind: 'user', id: '10001', name: '测试用户' },
    { kind: 'user', id: '10002', name: '协作用户' },
    { kind: 'bot', id: '20001', name: 'OneBot Sandbox', implementation: 'napcat', enabled: true },
  ],
  groups: [],
  conversations: [
    { id: 'private:10001:20001', type: 'direct', participantIds: ['10001', '20001'], messageIds: [] },
    { id: 'private:10002:20001', type: 'direct', participantIds: ['10002', '20001'], messageIds: [] },
  ],
  messages: [],
  forwards: [],
  friendships: [],
  requests: [],
}

describe('WebQQ 工作区选中恢复', () => {
  it('恢复机器人选择并在无效选择时回退到首个参与者', () => {
    expect(resolveWorkspaceSelection(snapshot, {
      currentOperatorId: '20001',
      activeConversationId: 'private:10002:20001',
    })).toEqual({
      currentOperatorId: '20001',
      activeConversationId: 'private:10002:20001',
    })

    expect(resolveWorkspaceSelection(snapshot, {
      currentOperatorId: 'deleted-user',
      activeConversationId: 'deleted-conversation',
    })).toEqual({
      currentOperatorId: '10001',
      activeConversationId: 'private:10001:20001',
    })
  })
})
