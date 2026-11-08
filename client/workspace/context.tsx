import * as React from 'react'
import { toast } from '@chatluna/ui-client/client'
import type { ResolvedConversation } from '../../src/conversation-resolution'
import { getSandboxBots, getSandboxUsers, type SandboxBotProfile, type SandboxGroup, type SandboxParticipant, type SandboxSnapshot, type SandboxWorkspaceState } from '../../src/types'
import { getConversationPeerId } from '../webqq/relationship-directory'
import { errorText, visibleConversationsOf, WorkspaceStore, type WorkspaceView } from './store'

export interface ParticipantSummary {
  name: string
  avatar?: string
  isBot: boolean
}

/** 一次渲染内复用的派生视图：所有组件按同一口径读当前操作者、会话与参与者。 */
export interface WorkspaceDerived {
  workspace: SandboxWorkspaceState
  snapshot: SandboxSnapshot
  operator?: SandboxParticipant
  operatorId?: string
  conversations: ResolvedConversation[]
  conversation?: ResolvedConversation
  group?: SandboxGroup
  peer?: SandboxParticipant
  bot?: SandboxBotProfile
  participants: Record<string, ParticipantSummary>
  participantNames: Record<string, string>
  resolveAvatar(reference: string | undefined): string
  media: Readonly<Record<string, string>>
  mediaFailures: Readonly<Record<string, true>>
}

interface SandboxContextValue {
  store: WorkspaceStore
  view: WorkspaceView
  derived?: WorkspaceDerived
  /** 运行一次操作；失败以 Toast 呈现并返回 false，调用方据此决定是否关闭浮层。 */
  run(label: string, task: () => Promise<unknown>): Promise<boolean>
  dialogs: SandboxDialogs
}

/** 跨区域打开的二级面统一由工作区托管，任一区域只发出「打开」意图。 */
export interface SandboxDialogs {
  openEntity(mode: 'edit' | 'delete', target: { type: 'user' | 'bot' | 'group', id: string }): void
  openRemark(targetId: string): void
  openGroupAction(mode: 'card' | 'sandbox-card' | 'name' | 'title', targetId: string, groupId?: string): void
  openConversationRename(conversationId: string): void
  openProfile(participantId: string, anchor?: { x: number, y: number }): void
  openGroupProfile(groupId: string, anchor?: { x: number, y: number }): void
}

const SandboxContext = React.createContext<SandboxContextValue | undefined>(undefined)

export function useSandbox() {
  const value = React.useContext(SandboxContext)
  if (!value) throw new Error('useSandbox must be used inside SandboxProvider')
  return value
}

export function useWorkspace(): WorkspaceDerived {
  const { derived } = useSandbox()
  if (!derived) throw new Error('workspace is not loaded')
  return derived
}

export function deriveWorkspace(view: WorkspaceView, store: WorkspaceStore): WorkspaceDerived | undefined {
  const workspace = view.workspace
  if (!workspace) return undefined
  const snapshot = workspace.snapshot
  const operatorId = view.currentOperatorId
  const operator = snapshot.participants.find(({ id }) => id === operatorId)
  const conversations = visibleConversationsOf(snapshot, operatorId)
  const conversation = conversations.find(({ id }) => id === view.activeConversationId)
  const peerId = conversation ? getConversationPeerId(conversation, operatorId) : undefined
  const bot = getSandboxBots(snapshot).find(({ id }) => id === peerId)
  const peer = bot ?? getSandboxUsers(snapshot).find(({ id }) => id === peerId)
  const resolveAvatar = (reference: string | undefined) => store.resolveAvatar(reference)
  const participants = Object.fromEntries(snapshot.participants.map(({ id, name, avatar, kind }) => [
    id,
    { name, avatar: resolveAvatar(avatar), isBot: kind === 'bot' },
  ]))
  return {
    workspace,
    snapshot,
    operator,
    operatorId,
    conversations,
    conversation,
    group: snapshot.groups.find(({ id }) => id === conversation?.groupId),
    peer,
    bot,
    participants,
    participantNames: Object.fromEntries(snapshot.participants.map(({ id, name }) => [id, name])),
    resolveAvatar,
    media: view.media,
    mediaFailures: view.mediaFailures,
  }
}

export function SandboxProvider({ store, dialogs, children }: {
  store: WorkspaceStore
  dialogs: SandboxDialogs
  children: React.ReactNode
}) {
  const view = React.useSyncExternalStore(store.subscribe, store.getView, store.getView)
  const derived = React.useMemo(() => deriveWorkspace(view, store), [view, store])
  const run = React.useCallback(async (label: string, task: () => Promise<unknown>) => {
    try {
      await task()
      return true
    } catch (error) {
      toast.error(label, { description: errorText(error) })
      return false
    }
  }, [])
  const value = React.useMemo(() => ({ store, view, derived, run, dialogs }), [store, view, derived, run, dialogs])
  return <SandboxContext.Provider value={value}>{children}</SandboxContext.Provider>
}
