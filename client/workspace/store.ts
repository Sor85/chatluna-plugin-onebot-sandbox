import { callAction } from '@chatluna/ui-client/client'
import { readStored, writeStored } from '@chatluna/ui-storage'
import {
  includesConversationParticipant,
  listConversations,
  readConversationMessageIds,
  type ResolvedConversation,
} from '../../src/conversation-resolution'
import type { SandboxConsoleEvents } from '../../src/console-contract'
import type {
  ManageSandboxEnvironmentInput,
  SandboxFriendAction,
  SandboxGroupAction,
  SandboxMessage,
  SandboxSnapshot,
  SandboxWorkspaceState,
} from '../../src/types'
import { resolveWorkspaceSelection } from './state'

type Endpoint = keyof SandboxConsoleEvents
type InputOf<K extends Endpoint> = Parameters<SandboxConsoleEvents[K]>[0]
type OutputOf<K extends Endpoint> = Awaited<ReturnType<SandboxConsoleEvents[K]>>

/** 控制台契约的统一调用口：错误只保留服务端给出的第一行说明，不带错误码前缀。 */
export async function invoke<K extends Endpoint>(name: K, input: InputOf<K>): Promise<OutputOf<K>> {
  try {
    // 无参端点的入参类型是 undefined，action 请求体仍需一个对象。
    return await callAction(name, (input ?? {}) as never) as OutputOf<K>
  } catch (error) {
    throw new Error(errorText(error))
  }
}

export function errorText(error: unknown, fallback = '操作失败') {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.trim().split(/\r?\n/, 1)[0]?.replace(/^Error:\s*/, '') || fallback
}

const MEDIA_REFERENCE = /^sandbox-media:\/\/([a-f0-9]{32})$/

export function mediaIdOf(reference: string | undefined) {
  return reference?.match(MEDIA_REFERENCE)?.[1]
}

interface StoredSelection {
  currentOperatorId?: string
  activeConversationId?: string
}

function selectionKey(spaceId: string | undefined) {
  return `chatluna.onebot-sandbox.selection.${spaceId ?? 'main'}`
}

function readSelection(spaceId: string | undefined): StoredSelection {
  const value = readStored(selectionKey(spaceId))
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  return {
    currentOperatorId: typeof record['currentOperatorId'] === 'string' ? record['currentOperatorId'] : undefined,
    activeConversationId: typeof record['activeConversationId'] === 'string' ? record['activeConversationId'] : undefined,
  }
}

export interface WorkspaceView {
  workspace?: SandboxWorkspaceState
  currentOperatorId?: string
  activeConversationId?: string
  loadError?: string
  media: Readonly<Record<string, string>>
  mediaFailures: Readonly<Record<string, true>>
}

/**
 * 一个沙盒空间的工作区状态：权威快照来自服务端，当前操作者与选中会话只存在浏览器本地。
 *
 * 每次变更端点都返回完整工作区，因此这里只做整份替换；选中按新快照重新解析，删除了正选中的
 * 会话或操作者时自然回退到第一个可见项。
 */
export class WorkspaceStore {
  private view: WorkspaceView = { media: {}, mediaFailures: {} }
  private listeners = new Set<() => void>()
  private refreshTask: Promise<void> | undefined
  private pendingRefresh = false
  private mediaLoading = new Set<string>()
  private disposed = false

  constructor(readonly spaceId: string | undefined) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getView = () => this.view

  /** StrictMode 会卸载再挂载同一个 store，挂载时要撤销上一次 {@link dispose}。 */
  activate() {
    this.disposed = false
  }

  /** 只停止写入视图；监听器由 `useSyncExternalStore` 自行退订，清空会误删重挂载后的订阅。 */
  dispose() {
    this.disposed = true
  }

  private set(patch: Partial<WorkspaceView>) {
    if (this.disposed) return
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener()
  }

  private scoped<T extends object>(input: T): T & { spaceId?: string } {
    return this.spaceId ? { ...input, spaceId: this.spaceId } : input
  }

  get snapshot(): SandboxSnapshot | undefined {
    return this.view.workspace?.snapshot
  }

  requireOperatorId() {
    const operatorId = this.view.currentOperatorId
    if (!operatorId) throw new Error('当前操作者不可用')
    return operatorId
  }

  private saveSelection() {
    writeStored(selectionKey(this.spaceId), {
      currentOperatorId: this.view.currentOperatorId,
      activeConversationId: this.view.activeConversationId,
    })
  }

  private replaceWorkspace(workspace: SandboxWorkspaceState, preferred: StoredSelection = {}) {
    const selection = resolveWorkspaceSelection(workspace.snapshot, {
      currentOperatorId: preferred.currentOperatorId ?? this.view.currentOperatorId,
      activeConversationId: preferred.activeConversationId ?? this.view.activeConversationId,
      currentView: 'messages',
    })
    this.set({
      workspace,
      currentOperatorId: selection.currentOperatorId,
      activeConversationId: selection.activeConversationId,
      loadError: undefined,
    })
    this.saveSelection()
    void this.loadVisibleMedia()
  }

  async load() {
    const stored = readSelection(this.spaceId)
    try {
      let workspace: SandboxWorkspaceState
      try {
        workspace = await invoke('onebot-sandbox.workspace', this.scoped(stored.currentOperatorId ? { operatorId: stored.currentOperatorId } : {}))
      } catch {
        // 本地记住的操作者可能已被删除；退回默认视角再解析一次选择。
        workspace = await invoke('onebot-sandbox.workspace', this.scoped({}))
      }
      this.replaceWorkspace(workspace, stored)
    } catch (error) {
      this.set({ loadError: errorText(error, '读取工作区失败') })
    }
  }

  /** 场景变更广播只是失效信号；多次信号合并成串行的若干次读取，不会并发打满。 */
  notifySceneChanged() {
    this.pendingRefresh = true
    if (this.refreshTask) return
    this.refreshTask = (async () => {
      try {
        while (this.pendingRefresh && !this.disposed) {
          this.pendingRefresh = false
          const operatorId = this.view.currentOperatorId
          try {
            const workspace = await invoke('onebot-sandbox.workspace', this.scoped(operatorId ? { operatorId } : {}))
            if (workspace.snapshot.revision >= (this.snapshot?.revision ?? 0)) this.replaceWorkspace(workspace)
          } catch {
            // 刷新失败保留当前画面，下一次信号会再试。
          }
        }
      } finally {
        this.refreshTask = undefined
      }
    })()
  }

  selectConversation(conversationId: string) {
    this.set({ activeConversationId: conversationId })
    this.saveSelection()
  }

  async selectOperator(participantId: string) {
    const workspace = await invoke('onebot-sandbox.workspace', this.scoped({ operatorId: participantId }))
    this.set({ currentOperatorId: participantId })
    this.replaceWorkspace(workspace, { currentOperatorId: participantId })
  }

  /** 统一形态的变更：注入当前操作者与空间定域，用返回的完整工作区整份替换。 */
  private async mutate<K extends Endpoint>(name: K, input: object): Promise<OutputOf<K>> {
    const result = await invoke(name, this.scoped({ ...input, operatorId: this.requireOperatorId() }) as InputOf<K>)
    if (result && typeof result === 'object' && 'snapshot' in result) this.replaceWorkspace(result as SandboxWorkspaceState)
    return result
  }

  sendMessage(input: { conversationId: string, content: string, replyToMessageId?: string }) {
    return this.mutate('onebot-sandbox.send-message', input)
  }

  sendMediaMessage(input: { conversationId: string, content?: string, replyToMessageId?: string, media: InputOf<'onebot-sandbox.send-media-message'>['media'] }) {
    return this.mutate('onebot-sandbox.send-media-message', input)
  }

  sendForwardMessage(input: { conversationId: string, messageIds: string[] }) {
    return this.mutate('onebot-sandbox.send-forward-message', input)
  }

  recallMessage(input: { conversationId: string, messageId: string }) {
    return this.mutate('onebot-sandbox.recall-message', input)
  }

  clearConversationMessages(input: { conversationId: string }) {
    return this.mutate('onebot-sandbox.clear-conversation-messages', input)
  }

  setMessageReaction(input: { conversationId: string, messageId: string, emojiId: string, enabled: boolean }) {
    return this.mutate('onebot-sandbox.set-message-reaction', input)
  }

  async createConversationInstance(rootConversationId: string) {
    const { conversationId } = await this.mutate('onebot-sandbox.create-conversation-instance', { rootConversationId })
    this.selectConversation(conversationId)
    return conversationId
  }

  async branchConversationInstance(input: { conversationId: string, messageId: string }) {
    const { conversationId } = await this.mutate('onebot-sandbox.branch-conversation-instance', input)
    this.selectConversation(conversationId)
    return conversationId
  }

  renameConversationInstance(input: { conversationId: string, title: string }) {
    return this.mutate('onebot-sandbox.rename-conversation-instance', input)
  }

  deleteConversationInstance(conversationId: string) {
    return this.mutate('onebot-sandbox.delete-conversation-instance', { conversationId })
  }

  performFriendAction(input: SandboxFriendAction) {
    return this.mutate('onebot-sandbox.friend-action', input)
  }

  performGroupAction(input: SandboxGroupAction) {
    return this.mutate('onebot-sandbox.group-action', input)
  }

  handleRelationshipRequest(requestId: string, approve: boolean) {
    const request = this.snapshot?.requests.find(({ id }) => id === requestId)
    if (!request) throw new Error('关系申请不存在')
    return request.type === 'group'
      ? this.performGroupAction({ action: 'handle-request', requestId, approve })
      : this.performFriendAction({ action: 'handle-request', requestId, approve })
  }

  setGroupAnnouncement(input: { groupId: string, content: string }) {
    return this.mutate('onebot-sandbox.set-group-announcement', input)
  }

  deleteGroupAnnouncement(input: { groupId: string, announcementId: string }) {
    return this.mutate('onebot-sandbox.delete-group-announcement', input)
  }

  /** 环境管理不带操作者；删除的不是当前操作者时，再按当前视角取一次，保持可见性口径一致。 */
  async manageEnvironment(input: ManageSandboxEnvironmentInput) {
    const operatorId = this.view.currentOperatorId
    const managed = await invoke('onebot-sandbox.manage-environment', this.scoped(input))
    const deletesOperator = (input.action === 'delete-user' || input.action === 'delete-bot') && input.data.id === operatorId
    this.replaceWorkspace(operatorId && !deletesOperator
      ? await invoke('onebot-sandbox.workspace', this.scoped({ operatorId }))
      : managed)
  }

  searchConversationMessages(input: Omit<InputOf<'onebot-sandbox.search-conversation-messages'>, 'operatorId'>) {
    return invoke('onebot-sandbox.search-conversation-messages', this.scoped({ ...input, operatorId: this.requireOperatorId() }))
  }

  async getForwardMessage(input: { forwardId?: string, messageId?: string }) {
    const forward = await invoke('onebot-sandbox.get-forward-message', this.scoped({ ...input, operatorId: this.requireOperatorId() }))
    const workspace = this.view.workspace
    if (workspace && !(workspace.snapshot.forwards ?? []).some(({ id }) => id === forward.id)) {
      this.set({ workspace: { ...workspace, snapshot: { ...workspace.snapshot, forwards: [...(workspace.snapshot.forwards ?? []), forward] } } })
      void this.loadVisibleMedia()
    }
    return forward
  }

  /** 向前翻历史：服务端只给最近一段，旧消息按最早一条的 ID 继续取，拼到会话头部。 */
  async loadEarlierMessages(conversationId: string) {
    const workspace = this.view.workspace
    if (!workspace) return
    const beforeMessageId = readConversationMessageIds(workspace.snapshot, conversationId)[0]
    if (!beforeMessageId) return
    const history = await invoke('onebot-sandbox.message-history', this.scoped({
      operatorId: this.requireOperatorId(),
      conversationId,
      beforeMessageId,
      limit: 50,
    }))
    const current = this.view.workspace ?? workspace
    const snapshot = current.snapshot
    const knownIds = new Set(snapshot.messages.map(({ id }) => id))
    const knownForwardIds = new Set((snapshot.forwards ?? []).map(({ id }) => id))
    const prepend = <T extends { id: string, messageIds: string[] }>(rows: T[]) => rows.map((row) => row.id === conversationId ? {
      ...row,
      messageIds: [...history.messages.map(({ id }) => id), ...row.messageIds],
      hasMoreMessages: !!history.nextBeforeMessageId,
    } : row)
    this.set({
      workspace: {
        ...current,
        snapshot: {
          ...snapshot,
          conversations: prepend(snapshot.conversations),
          conversationInstances: prepend(snapshot.conversationInstances ?? []),
          messages: [...history.messages.filter(({ id }) => !knownIds.has(id)), ...snapshot.messages],
          forwards: [...(snapshot.forwards ?? []), ...(history.forwards ?? []).filter(({ id }) => !knownForwardIds.has(id))],
        },
      },
    })
    void this.loadVisibleMedia()
  }

  resolveAvatar(reference: string | undefined) {
    const id = mediaIdOf(reference)
    return id ? this.view.media[id] ?? '' : reference ?? ''
  }

  /** 头像与消息媒体都是受控引用；按需拉取 Base64 并缓存为 Data URL，失败只标记不重试风暴。 */
  async loadVisibleMedia() {
    const snapshot = this.snapshot
    const operatorId = this.view.currentOperatorId
    if (!snapshot || !operatorId) return
    const ids = [
      ...snapshot.messages.flatMap(({ media }) => media?.map(({ id }) => id) ?? []),
      ...(snapshot.forwards ?? []).flatMap(({ nodes }) => nodes.flatMap(({ media }) => media?.map(({ id }) => id) ?? [])),
      ...[...snapshot.participants.map(({ avatar }) => avatar), ...snapshot.groups.map(({ avatar }) => avatar)]
        .flatMap((reference) => mediaIdOf(reference) ?? []),
    ]
    const missing = [...new Set(ids)].filter((id) => !this.view.media[id] && !this.mediaLoading.has(id))
    await Promise.all(missing.map(async (mediaId) => {
      this.mediaLoading.add(mediaId)
      try {
        const content = await invoke('onebot-sandbox.media-content', this.scoped({ operatorId, mediaId }))
        const { [mediaId]: _, ...failures } = this.view.mediaFailures
        this.set({ media: { ...this.view.media, [mediaId]: `data:${content.mimeType};base64,${content.dataBase64}` }, mediaFailures: failures })
      } catch {
        this.set({ mediaFailures: { ...this.view.mediaFailures, [mediaId]: true } })
      } finally {
        this.mediaLoading.delete(mediaId)
      }
    }))
  }
}

/** 当前操作者可见的全部会话（根会话与实例），与侧栏、选择恢复同一口径。 */
export function visibleConversationsOf(snapshot: SandboxSnapshot, operatorId: string | undefined): ResolvedConversation[] {
  if (!operatorId) return []
  return listConversations(snapshot).filter((conversation) => includesConversationParticipant(snapshot, conversation, operatorId))
}

export function conversationMessagesOf(snapshot: SandboxSnapshot, conversationId: string | undefined): SandboxMessage[] {
  if (!conversationId) return []
  const ids = readConversationMessageIds(snapshot, conversationId)
  const byId = new Map(snapshot.messages.map((message) => [message.id, message]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}
