import { includesConversationParticipant, listConversations } from '../../src/conversation-resolution'
import type { SandboxSnapshot } from '../../src/types'

export interface SandboxWorkspaceSelection {
  currentOperatorId?: string
  activeConversationId?: string
}

export function resolveWorkspaceSelection(
  snapshot: SandboxSnapshot,
  preferred: SandboxWorkspaceSelection,
): SandboxWorkspaceSelection {
  const currentOperator = snapshot.participants.find(({ id }) => id === preferred.currentOperatorId)
    ?? snapshot.participants.find(({ kind }) => kind === 'user')
    ?? snapshot.participants[0]
  // 会话实例也参与选中恢复：新建实例后立刻被选中，刷新页面不该把选中弹回根会话。
  const conversations = currentOperator
    ? listConversations(snapshot)
      .filter((conversation) => includesConversationParticipant(snapshot, conversation, currentOperator.id))
    : []
  const activeConversation = conversations.find(({ id }) => id === preferred.activeConversationId)
    ?? conversations[0]

  return {
    currentOperatorId: currentOperator?.id,
    activeConversationId: activeConversation?.id,
  }
}
