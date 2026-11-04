import * as React from 'react'
import { ChevronLeftIcon, EllipsisIcon, SearchIcon, Share2Icon } from 'lucide-react'
import { Button, cn } from '@chatluna/ui-kit'
import { buildMessageCapabilityMap } from '../webqq/message-capabilities'
import { buildForwardPreviewMap } from '../webqq/forward-preview'
import { buildConversationTree, toRecentForwardTargets } from '../webqq/conversation-tree'
import { getFriendDirectory, getGroupDirectory } from '../webqq/relationship-directory'
import {
  closeForwardStack,
  hasParentForwardFrame,
  loadForwardDialogFrame,
  popForwardFrame,
  pushForwardFrame,
  readForwardStackTop,
  type ForwardDialogFrame,
} from '../webqq/forward-dialog-stack'
import { enterMessageSelection, exitMessageSelection, resolveForwardConfirmation, toggleMessageSelection, type MessageSelectionState } from '../webqq/message-selection'
import { formatMentionContent } from '../webqq/mention'
import type { FriendMenuState } from '../webqq/friend-menu'
import type { SandboxMessage } from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { conversationMessagesOf } from '../workspace/store'
import { useSandbox, useWorkspace } from '../workspace/context'
import { Composer, type ComposerHandle } from './composer'
import { EmojiPicker } from './emoji-picker'
import { ForwardTargetDialog, ForwardViewer, type ForwardTargets } from './forward'
import { ImagePreview } from './image-preview'
import { MessageList, type MessageListHandle } from './message-list'
import { MessageSearchPanel } from './search-panel'

// 多选条悬浮在消息区底部（glass.css 的 .sandbox-selection-bar：最小高 48px、距底 16px），再留 16px 间隙。
const SELECTION_BAR_SPACE = 80

export function ChatPane({ detailsVisible, onToggleDetails, onBack, mentionBridge, className }: {
  detailsVisible: boolean
  /** 信息栏的成员菜单借这条桥把 @ 插进本聊天区的发送框。 */
  mentionBridge?: React.RefObject<(participantId: string) => void>
  onToggleDetails(): void
  onBack?(): void
  className?: string
}) {
  const t = useT()
  const { store, run, dialogs } = useSandbox()
  const workspace = useWorkspace()
  const { snapshot, conversation, group, peer, bot, operatorId, participants, participantNames, resolveAvatar } = workspace
  const list = React.useRef<MessageListHandle>(null)
  const composer = React.useRef<ComposerHandle>(null)
  const [replyTo, setReplyTo] = React.useState('')
  const [reactionTarget, setReactionTarget] = React.useState('')
  const [selection, setSelection] = React.useState<MessageSelectionState>(exitMessageSelection())
  const [forwardTargetOpen, setForwardTargetOpen] = React.useState(false)
  const [forwardStack, setForwardStack] = React.useState<ForwardDialogFrame[]>([])
  const [imageUrl, setImageUrl] = React.useState('')
  // 悬浮发送框回报的占位高度，初值按单行胶囊估算（44 + 28），首帧不至于让末条消息被遮住。
  const [composerSpace, setComposerSpace] = React.useState(72)
  const [searchOpen, setSearchOpen] = React.useState(false)

  const messages = React.useMemo(() => conversationMessagesOf(snapshot, conversation?.id), [snapshot, conversation?.id])
  const replyMessages = React.useMemo(() => {
    const byId = new Map(snapshot.messages.map((message) => [message.id, message]))
    return Object.fromEntries(messages.flatMap(({ replyToMessageId }) => {
      const reply = replyToMessageId ? byId.get(replyToMessageId) : undefined
      return reply ? [[reply.id, reply] as const] : []
    })) as Record<string, SandboxMessage>
  }, [messages, snapshot.messages])
  const forwardPreviews = React.useMemo(() => buildForwardPreviewMap(messages, snapshot.forwards ?? []), [messages, snapshot.forwards])
  const capabilities = React.useMemo(() => buildMessageCapabilityMap({ messages, conversation, operatorId, group }), [messages, conversation, operatorId, group])
  const friendMenuStates = React.useMemo<Record<string, FriendMenuState>>(() => {
    if (!operatorId) return {}
    return Object.fromEntries(snapshot.participants.map(({ id: targetId }) => [targetId, {
      isFriend: snapshot.friendships.some(({ participantIds }) => participantIds.includes(operatorId) && participantIds.includes(targetId)),
      pendingOutgoing: snapshot.requests.some((request) => request.type === 'friend' && request.requesterId === operatorId && request.targetId === targetId),
      pendingIncoming: snapshot.requests.some((request) => request.type === 'friend' && request.requesterId === targetId && request.targetId === operatorId),
    }]))
  }, [snapshot, operatorId])
  const mentionCandidates = React.useMemo(() => group?.members.flatMap((member) => {
    const participant = participants[member.participantId]
    if (!participant) return []
    const card = member.card?.trim()
    return [{
      id: member.participantId,
      name: card || participant.name,
      avatar: participant.avatar,
      kind: participant.isBot ? 'bot' as const : 'user' as const,
      keywords: card && card !== participant.name ? [participant.name] : undefined,
    }]
  }) ?? [], [group, participants])
  const forwardTargets = React.useMemo<ForwardTargets>(() => ({
    recent: toRecentForwardTargets(buildConversationTree({ scene: snapshot, conversations: workspace.conversations, operatorId, resolveAvatar })),
    friends: getFriendDirectory(snapshot, operatorId).filter((entry) => entry.isFriend && entry.conversationId).map((entry) => ({
      conversationId: entry.conversationId!,
      title: entry.displayName,
      subtitle: entry.status,
      avatar: resolveAvatar(entry.avatar),
      avatarKind: entry.isBot ? 'bot' as const : 'user' as const,
    })),
    groups: getGroupDirectory(snapshot, operatorId).filter((entry) => entry.member && entry.conversationId).map((entry) => ({
      conversationId: entry.conversationId!,
      title: entry.name,
      subtitle: t('sandbox.chat.groupSubtitle', { id: entry.id, count: entry.members.length }),
      avatar: resolveAvatar(entry.avatar),
      avatarKind: 'group' as const,
    })),
  }), [snapshot, workspace.conversations, operatorId, resolveAvatar, t])
  const chatLunaStates = workspace.workspace.chatLunaStates.filter(({ conversationId }) => conversationId === conversation?.id)

  // 换会话时清掉与上一个会话绑定的临时状态。
  React.useEffect(() => {
    setReplyTo('')
    setReactionTarget('')
    setSelection(exitMessageSelection())
    setForwardTargetOpen(false)
    setForwardStack(closeForwardStack())
    setSearchOpen(false)
  }, [conversation?.id])

  // Esc 的优先级：先关转发目标，再退出多选，最后关闭查找。
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !selection.active || forwardTargetOpen) return
      event.preventDefault()
      setSelection(exitMessageSelection())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection.active, forwardTargetOpen])

  const mentionMember = (id: string) => composer.current?.insertMention({ id, name: mentionCandidates.find((candidate) => candidate.id === id)?.name ?? participantNames[id] ?? id })
  React.useEffect(() => {
    if (mentionBridge) mentionBridge.current = mentionMember
  })

  const selectionContext = { messageCapabilities: capabilities }
  const replyMessage = messages.find(({ id }) => id === replyTo)
  const conversationId = conversation?.id

  const openForward = async (input: { forwardId?: string, messageId?: string }, mode: 'replace' | 'push') => {
    const frame = await loadForwardDialogFrame({ input, load: (request) => store.getForwardMessage(request) })
    if (frame) setForwardStack((stack) => pushForwardFrame(stack, frame, mode))
  }

  const title = conversation?.title ?? group?.name ?? peer?.name ?? conversation?.id ?? t('sandbox.chat.pick')
  const rootTitle = group?.name ?? peer?.name ?? ''
  const instancePrefix = conversation?.kind === 'instance' ? `${rootTitle} · ` : ''
  const subtitle = group
    ? `${instancePrefix}${t('sandbox.chat.groupSubtitle', { id: group.id, count: group.members.length })}`
    : bot ? `${instancePrefix}${t('sandbox.chat.botSubtitle')}` : peer ? `${instancePrefix}${t('sandbox.chat.friendSubtitle')}` : t('sandbox.chat.none')
  const avatarKind = group ? 'group' : bot ? 'bot' : 'user'
  const openTitleProfile = (event: React.MouseEvent) => {
    const anchor = { x: event.clientX, y: event.clientY }
    if (group) dialogs.openGroupProfile(group.id, anchor)
    else if (peer) dialogs.openProfile(peer.id, anchor)
  }

  return (
    <main className={cn('sandbox-chat-pane flex min-h-0 min-w-0 flex-1 flex-col bg-background', className)}>
      <header className="sandbox-chat-header flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        {onBack && (
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={t('sandbox.chat.back')} onClick={onBack}><ChevronLeftIcon /></Button>
        )}
        <button type="button" className="flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1 text-left hover:bg-accent/60 disabled:hover:bg-transparent" disabled={!group && !peer} aria-label={t('sandbox.chat.viewProfileOf', { name: title })} onClick={openTitleProfile}>
          <SandboxAvatar kind={avatarKind} name={title} src={resolveAvatar(group?.avatar ?? peer?.avatar)} className="size-8" />
          <span className="flex min-w-0 flex-col">
            <strong className="truncate text-sm font-medium">{title}</strong>
            <span className="truncate text-[11px] text-muted-foreground">{subtitle}</span>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          {searchOpen && conversation ? (
            <MessageSearchPanel
              adapter={{
                conversationId,
                search: (input) => store.searchConversationMessages(input),
                isLoaded: (messageId) => conversationMessagesOf(store.snapshot ?? snapshot, conversationId).some(({ id }) => id === messageId),
                canLoadMore: () => !!visibleConversation(store, conversationId)?.hasMoreMessages,
                oldestLoadedId: () => conversationMessagesOf(store.snapshot ?? snapshot, conversationId)[0]?.id,
                loadMore: () => conversationId ? store.loadEarlierMessages(conversationId) : Promise.resolve(),
                reveal: (messageId) => list.current?.revealMessage(messageId) ?? false,
              }}
              onClose={() => setSearchOpen(false)}
            />
          ) : (
            <Button variant="ghost" size="icon" disabled={!conversation} aria-label={t('sandbox.search.label')} onClick={() => {
              setSelection(exitMessageSelection())
              setSearchOpen(true)
            }}>
              <SearchIcon />
            </Button>
          )}
          <Button variant="ghost" size="icon" aria-pressed={detailsVisible} aria-label={t(detailsVisible ? 'sandbox.details.close' : 'sandbox.details.open')} onClick={onToggleDetails}>
            <EllipsisIcon />
          </Button>
        </div>
      </header>
      {conversation ? (
        <>
          <div className="sandbox-chat-stage relative flex min-h-0 flex-1 flex-col">
            <MessageList
              ref={list}
              bottomSpace={selection.active ? SELECTION_BAR_SPACE : composerSpace}
              messages={messages}
              chatLunaStates={chatLunaStates}
              replyMessages={replyMessages}
              forwardPreviews={forwardPreviews}
              capabilities={capabilities}
              friendMenuStates={friendMenuStates}
              hasMoreMessages={!!conversation.hasMoreMessages}
              scrollKey={`${store.spaceId ?? 'main'}:${conversation.id}`}
              selectionMode={selection.active}
              selectedIds={[...selection.messageIds]}
              onReply={(id) => {
                setReplyTo(id)
                requestAnimationFrame(() => composer.current?.focus())
              }}
              onBranch={(messageId) => run(t('sandbox.error.branch'), () => store.branchConversationInstance({ conversationId: conversation.id, messageId }))}
              onRecall={(messageId) => run(t('sandbox.error.recall'), () => store.recallMessage({ conversationId: conversation.id, messageId }))}
              onReact={(messageId, emojiId, enabled) => run(t('sandbox.error.react'), () => store.setMessageReaction({ conversationId: conversation.id, messageId, emojiId, enabled }))}
              onOpenReactionPicker={(id) => !selection.active && setReactionTarget(id)}
              onEnterSelection={(id) => {
                const next = enterMessageSelection(id, selectionContext)
                if (!next) return
                setReplyTo('')
                setSearchOpen(false)
                setSelection(next)
              }}
              onToggleSelection={(id) => setSelection((state) => toggleMessageSelection(state, id, selectionContext))}
              onOpenForward={(input) => void openForward(input, 'replace')}
              onOpenImage={setImageUrl}
              onLoadHistory={() => store.loadEarlierMessages(conversation.id)}
              onClearConversation={() => run(t('sandbox.error.clear'), () => store.clearConversationMessages({ conversationId: conversation.id }))}
              onMention={mentionMember}
            />
            {!selection.active && (
              <Composer
                ref={composer}
                replyingTo={replyMessage ? {
                  id: replyMessage.id,
                  authorName: participantNames[replyMessage.authorId] ?? replyMessage.authorId,
                  content: formatMentionContent(replyMessage.content, participantNames),
                } : undefined}
                mentionCandidates={mentionCandidates}
                onClearReply={() => setReplyTo('')}
                onOpenImage={setImageUrl}
                onSpaceChange={setComposerSpace}
                onSend={async (intent) => {
                  if (intent.media?.length) {
                    await store.sendMediaMessage({ conversationId: intent.conversationId, media: intent.media, content: intent.content || undefined, replyToMessageId: intent.replyToMessageId })
                  } else {
                    await store.sendMessage({ conversationId: intent.conversationId, content: intent.content, replyToMessageId: intent.replyToMessageId })
                  }
                }}
              />
            )}
            {selection.active && (
              <div role="toolbar" aria-label={t('sandbox.chat.selectionToolbar')} className="sandbox-selection-bar">
                <strong className="text-[13px] font-medium">{t('sandbox.chat.selected', { count: selection.messageIds.length })}</strong>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setSelection(exitMessageSelection())}>{t('sandbox.common.cancel')}</Button>
                  <Button disabled={!selection.messageIds.length} onClick={() => setForwardTargetOpen(true)}><Share2Icon />{t('sandbox.forward.send')}</Button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t('sandbox.chat.pick')}</div>
      )}
      <EmojiPicker
        open={!!reactionTarget}
        onOpenChange={(open) => !open && setReactionTarget('')}
        onSelect={(emojiId) => {
          if (conversation && reactionTarget) void run(t('sandbox.error.react'), () => store.setMessageReaction({ conversationId: conversation.id, messageId: reactionTarget, emojiId, enabled: true }))
        }}
      />
      <ForwardTargetDialog
        open={forwardTargetOpen}
        targets={forwardTargets}
        onOpenChange={setForwardTargetOpen}
        onConfirm={async (targetId) => {
          const confirmation = resolveForwardConfirmation(selection, targetId, selectionContext)
          if (confirmation.kind === 'reject') throw new Error(t('sandbox.forward.noSelectable'))
          await store.sendForwardMessage({ conversationId: targetId, messageIds: [...confirmation.messageIds] })
          setSelection(exitMessageSelection())
        }}
      />
      <ForwardViewer
        frame={readForwardStackTop(forwardStack)}
        canBack={hasParentForwardFrame(forwardStack)}
        onBack={() => setForwardStack(popForwardFrame)}
        onClose={() => setForwardStack(closeForwardStack())}
        onOpenForward={(forwardId) => void openForward({ forwardId }, 'push')}
        onOpenImage={setImageUrl}
      />
      {imageUrl && <ImagePreview url={imageUrl} onClose={() => setImageUrl('')} />}
    </main>
  )
}

function visibleConversation(store: ReturnType<typeof useSandbox>['store'], conversationId: string | undefined) {
  const snapshot = store.snapshot
  if (!snapshot || !conversationId) return undefined
  return [...snapshot.conversations, ...(snapshot.conversationInstances ?? [])].find(({ id }) => id === conversationId)
}
