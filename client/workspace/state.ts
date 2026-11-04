import { includesConversationParticipant, listConversations } from '../../src/conversation-resolution'
import type { SandboxSnapshot } from '../../src/types'

export type SandboxWorkspaceView = 'messages' | 'contacts' | 'profile' | 'debug' | 'test-calls' | 'model-requests' | 'presets' | 'spaces'
export type SandboxDetailsPreference = 'auto' | 'open' | 'closed'

export interface SandboxWorkspacePreferences {
  currentOperatorId?: string
  activeConversationId?: string
  currentView: SandboxWorkspaceView
}

interface WorkspaceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const STORAGE_KEY = 'chatluna-sandbox.workspace'
const DEFAULT_PREFERENCES: SandboxWorkspacePreferences = {
  currentView: 'messages',
}
const WORKSPACE_VIEWS = new Set<SandboxWorkspaceView>(['messages', 'contacts', 'profile', 'debug', 'test-calls', 'model-requests', 'presets', 'spaces'])

export function resolveDetailsVisibility(preference: SandboxDetailsPreference, wideLayout: boolean) {
  if (preference === 'open') return true
  if (preference === 'closed') return false
  return wideLayout
}

export function toggleDetailsPreference(visible: boolean): SandboxDetailsPreference {
  return visible ? 'closed' : 'open'
}

export function resolveDetailsPreferenceAfterLayoutChange(wideLayout: boolean): SandboxDetailsPreference {
  return wideLayout ? 'open' : 'closed'
}

export function loadWorkspacePreferences(storage: Pick<WorkspaceStorage, 'getItem'>): SandboxWorkspacePreferences {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as Partial<SandboxWorkspacePreferences>
    return {
      currentOperatorId: typeof value.currentOperatorId === 'string' ? value.currentOperatorId : undefined,
      activeConversationId: typeof value.activeConversationId === 'string' ? value.activeConversationId : undefined,
      currentView: WORKSPACE_VIEWS.has(value.currentView as SandboxWorkspaceView)
        ? value.currentView as SandboxWorkspaceView
        : DEFAULT_PREFERENCES.currentView,
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function saveWorkspacePreferences(
  storage: Pick<WorkspaceStorage, 'setItem'>,
  preferences: SandboxWorkspacePreferences,
) {
  storage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}

export function resolveWorkspaceSelection(
  snapshot: SandboxSnapshot,
  preferences: SandboxWorkspacePreferences,
): SandboxWorkspacePreferences {
  const currentOperator = snapshot.participants.find(({ id }) => id === preferences.currentOperatorId)
    ?? snapshot.participants.find(({ kind }) => kind === 'user')
    ?? snapshot.participants[0]
  // 会话实例也参与选中恢复：新建实例后立刻被选中，刷新页面不该把选中弹回根会话。
  const conversations = currentOperator
    ? listConversations(snapshot)
      .filter((conversation) => includesConversationParticipant(snapshot, conversation, currentOperator.id))
    : []
  const activeConversation = conversations.find(({ id }) => id === preferences.activeConversationId)
    ?? conversations[0]

  return {
    currentOperatorId: currentOperator?.id,
    activeConversationId: activeConversation?.id,
    currentView: preferences.currentView,
  }
}
