import * as React from 'react'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AtSignIcon,
  BellIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CornerUpLeftIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  HandIcon,
  IdCardIcon,
  ListChecksIcon,
  PaperclipIcon,
  ReplyIcon,
  SmilePlusIcon,
  TagIcon,
  Trash2Icon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react'
import {
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@chatluna/ui-kit'
import type { MessageCapabilities } from '../../src/message-capabilities'
import { Link, useNavigate } from 'react-router'
import { isRecalledMessage, type SandboxMessage, type SandboxMessageTraceReference } from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { formatSandboxTimeOfDay } from '../shared/format-time'
import { getMessageClusterClass, isMergedMessage } from '../webqq/message-cluster'
import {
  formatMediaSize,
  getEventMessageText,
  getForwardPreview,
  getMessageText,
  getMessageThinking,
  getMessageUsage,
  getReplyMessage,
  isForkBoundary,
  isInheritedMessage,
  readMessageCapabilities,
  resolveReactionToggle,
  shouldRenderAsEvent,
  shouldShowThinking,
  shouldShowUsage,
  type MessagePresentationContext,
} from '../webqq/message-presentation'
import {
  getChatFriendActions,
  getCurrentGroupMember,
  getFriendMenuStateOf,
  getMessageAuthorName,
  getMessageGroupMemberActions,
  getMessageRoleBadge,
  hasGroupMemberManagementActions,
  type ParticipantPresentationContext,
} from '../webqq/participant-presentation'
import { formatThinkingDuration } from '../webqq/thinking-panel'
import type { SandboxChatLunaState, SandboxForwardPreview } from '../../src/types'
import type { FriendMenuState } from '../webqq/friend-menu'
import { useSandbox, useWorkspace } from '../workspace/context'
import { ExtensionMark } from './extension-mark'
import { GroupMemberMenuItems } from './member-menu'
import { MessageReactions } from './reactions'

export interface MessageListHandle {
  revealMessage(messageId: string): boolean
}

export interface MessageListProps {
  messages: SandboxMessage[]
  chatLunaStates: SandboxChatLunaState[]
  replyMessages: Record<string, SandboxMessage>
  forwardPreviews: Record<string, SandboxForwardPreview>
  capabilities: Record<string, MessageCapabilities>
  friendMenuStates: Record<string, FriendMenuState>
  hasMoreMessages: boolean
  scrollKey: string
  /** 悬浮发送框占住的底部高度；内容区按它留白，置底时末条消息不被发送框遮住。 */
  bottomSpace?: number
  selectionMode: boolean
  selectedIds: string[]
  onReply(messageId: string): void
  onBranch(messageId: string): void
  onRecall(messageId: string): void
  onReact(messageId: string, emojiId: string, enabled: boolean): void
  onOpenReactionPicker(messageId: string): void
  onEnterSelection(messageId: string): void
  onToggleSelection(messageId: string): void
  onOpenForward(input: { messageId: string, forwardId: string }): void
  onOpenImage(url: string): void
  onLoadHistory(): Promise<void>
  onClearConversation(): void
  onMention(participantId: string): void
}

/** 每个会话最后一次离开时的滚动位置；贴底离开时只记贴底，回来照样贴底。 */
const scrollMemory = new Map<string, { top: number, bottom: boolean }>()
const BOTTOM_THRESHOLD = 48

export const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(function MessageList(props, ref) {
  const t = useT()
  const navigate = useNavigate()
  const { store, run, dialogs } = useSandbox()
  const { conversation, group, operatorId, participants, participantNames, media, mediaFailures, workspace } = useWorkspace()
  const markRecalled = workspace.appearance.sandboxMarkRecalledMessages
  const bubbleTail = workspace.appearance.sandboxTimBubbleTail
  const box = React.useRef<HTMLDivElement>(null)
  const content = React.useRef<HTMLOListElement>(null)
  const sticky = React.useRef(true)
  const anchor = React.useRef<{ messageId: string, offset: number } | undefined>(undefined)
  const [historyLoading, setHistoryLoading] = React.useState(false)
  const [highlighted, setHighlighted] = React.useState('')
  const [expandedThinking, setExpandedThinking] = React.useState<Record<string, boolean>>({})
  const highlightTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined)

  const presentation: MessagePresentationContext & ParticipantPresentationContext = {
    replyMessages: props.replyMessages,
    forwardPreviews: props.forwardPreviews,
    messageCapabilities: props.capabilities,
    participantNames,
    markRecalledMessages: markRecalled,
    currentConversationId: conversation?.id,
    currentOperatorId: operatorId,
    participants,
    friendMenuStates: props.friendMenuStates,
    currentGroup: group,
  }
  const authorName = (id: string) => getMessageAuthorName(id, presentation)

  const scrollToBottom = () => {
    const element = box.current
    if (element) element.scrollTop = element.scrollHeight
  }

  // 切换会话：恢复上次离开时的位置，没有记录或离开时贴底就贴底。
  React.useLayoutEffect(() => {
    const memory = scrollMemory.get(props.scrollKey)
    sticky.current = !memory || memory.bottom
    if (sticky.current) scrollToBottom()
    else if (box.current) box.current.scrollTop = memory!.top
    const key = props.scrollKey
    const element = box.current
    return () => {
      if (element) scrollMemory.set(key, { top: element.scrollTop, bottom: sticky.current })
    }
  }, [props.scrollKey])

  const tail = `${props.messages.at(-1)?.id ?? ''}:${props.messages.length}:${props.chatLunaStates.filter(({ thinking }) => thinking).length}`
  React.useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    // 加载更早历史后按加载前的锚点补偿，画面不跳。
    const pending = anchor.current
    if (pending) {
      anchor.current = undefined
      const row = element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(pending.messageId)}"]`)
      if (row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - pending.offset
      return
    }
    if (sticky.current) scrollToBottom()
  }, [tail])

  // 图片、视频加载会撑高内容；仍在贴底时跟着贴底。
  React.useEffect(() => {
    const element = content.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (sticky.current) scrollToBottom()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [props.scrollKey, props.messages.length > 0])

  const handleScroll = () => {
    const element = box.current
    if (!element) return
    sticky.current = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_THRESHOLD
  }

  const loadEarlier = async () => {
    const element = box.current
    if (historyLoading || !element) return
    const first = element.querySelector<HTMLElement>('[data-message-id]')
    if (first) anchor.current = { messageId: first.dataset['messageId'] ?? '', offset: first.getBoundingClientRect().top - element.getBoundingClientRect().top }
    sticky.current = false
    setHistoryLoading(true)
    try {
      await props.onLoadHistory()
    } catch {
      anchor.current = undefined
    } finally {
      setHistoryLoading(false)
    }
  }

  const revealMessage = (messageId: string) => {
    const element = box.current
    const row = element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    if (!element || !row) return false
    sticky.current = false
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setHighlighted(messageId)
    clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlighted(''), 1600)
    return true
  }
  React.useImperativeHandle(ref, () => ({ revealMessage }))
  React.useEffect(() => () => clearTimeout(highlightTimer.current), [])

  const thinkingStates = props.chatLunaStates.filter(({ thinking }) => thinking)
  const empty = !props.messages.length && !thinkingStates.length
  const peerKind = group ? 'group' : participants[conversation?.participantIds?.find((id) => id !== operatorId) ?? '']?.isBot ? 'bot' : 'user'

  const friendAction = (input: Parameters<typeof store.performFriendAction>[0]) => run(t('sandbox.error.friend'), () => store.performFriendAction(input))

  const renderMedia = (message: SandboxMessage) => message.media?.map((item) => {
    const source = media[item.id]
    if (!source) {
      return <span key={item.id} className="text-xs opacity-70">{mediaFailures[item.id] ? t('sandbox.media.unavailable') : t('sandbox.media.loading')}</span>
    }
    if (item.type === 'image') {
      return (
        <button key={item.id} type="button" className="block overflow-hidden rounded-lg" aria-label={t('sandbox.media.viewImage')} onClick={(event) => {
          if (props.selectionMode) return
          event.stopPropagation()
          props.onOpenImage(source)
        }}>
          <img src={source} alt={item.name} className="max-h-64 max-w-60 object-cover" />
        </button>
      )
    }
    if (item.type === 'audio') return <audio key={item.id} src={source} controls preload="metadata" className="max-w-64" />
    if (item.type === 'video') return <video key={item.id} src={source} controls preload="metadata" className="max-h-64 max-w-72 rounded-lg" />
    return (
      <a key={item.id} href={source} download={item.name} className="flex items-center gap-2 rounded-lg bg-background/60 px-3 py-2 text-foreground">
        <PaperclipIcon className="size-4 shrink-0" />
        <span className="flex min-w-0 flex-col">
          <strong className="truncate text-[13px] font-medium">{item.name}</strong>
          <small className="text-[11px] text-muted-foreground">{formatMediaSize(item.size)}</small>
        </span>
      </a>
    )
  })

  return (
    <ContextMenu disabled={props.selectionMode || !conversation}>
      <ContextMenuTrigger
        render={(
          <div
            ref={box}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            aria-label={t('sandbox.chat.messages')}
            onScroll={handleScroll}
          />
        )}
      >
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" style={{ paddingBottom: props.bottomSpace }}>
            <SandboxAvatar kind={peerKind} name={conversation?.title} src={undefined} className="size-14" />
            {peerKind === 'bot' ? (
              <>
                <h2 className="mt-2 text-sm font-medium">{t('sandbox.chat.emptyBotTitle')}</h2>
                <p className="text-xs text-muted-foreground">{t('sandbox.chat.emptyBotHint')}</p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t('sandbox.chat.emptyHint')}</p>
            )}
          </div>
        ) : (
          <ol ref={content} className="mx-auto flex max-w-4xl flex-col px-4 py-4" style={{ paddingBottom: props.bottomSpace }}>
            {props.hasMoreMessages && (
              <li className="flex justify-center pb-3">
                <button type="button" className="rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" disabled={historyLoading} onClick={loadEarlier}>
                  {historyLoading ? t('sandbox.common.loading') : t('sandbox.chat.earlier')}
                </button>
              </li>
            )}
            {props.messages.map((message, index) => {
              const outgoing = message.authorId === operatorId
              const capabilities = readMessageCapabilities(message, presentation)
              const merged = isMergedMessage(props.messages, index, operatorId)
              const cluster = getMessageClusterClass(props.messages, index, operatorId)
              const recalled = isRecalledMessage(message)
              const inherited = isInheritedMessage(message, presentation)
              const selected = props.selectedIds.includes(message.id)
              const selectable = props.selectionMode && capabilities.forward
              const reply = getReplyMessage(message, presentation)
              const forward = getForwardPreview(message, presentation)
              const text = getMessageText(message, presentation)
              const badge = getMessageRoleBadge(message.authorId, presentation)
              const isBot = participants[message.authorId]?.isBot
              const thinking = shouldShowThinking(message, presentation) ? getMessageThinking(message) : undefined
              const usage = !thinking && shouldShowUsage(message, presentation) ? getMessageUsage(message)?.usage : undefined
              const boundary = isForkBoundary(props.messages, index, presentation)

              const header = boundary && (
                <li key={`${message.id}:boundary`} className="my-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />{t('sandbox.chat.forkBoundary')}<span className="h-px flex-1 bg-border" />
                </li>
              )
              if (shouldRenderAsEvent(message, presentation)) {
                return (
                  <React.Fragment key={message.id}>
                    {header}
                    <li data-message-id={message.id} className="my-2 self-center rounded-full bg-muted/70 px-3 py-1 text-[11px] text-muted-foreground">
                      {getEventMessageText(message, authorName)}
                    </li>
                  </React.Fragment>
                )
              }

              const avatarMenu = (
                <ContextMenu disabled={props.selectionMode}>
                  <ContextMenuTrigger
                    render={(
                      <button
                        type="button"
                        className="shrink-0 self-start rounded-full"
                        aria-label={t('sandbox.chat.viewProfileOf', { name: authorName(message.authorId) })}
                        onClick={(event) => {
                          if (props.selectionMode) return
                          event.stopPropagation()
                          dialogs.openProfile(message.authorId, { x: event.clientX, y: event.clientY })
                        }}
                        onContextMenu={(event) => event.stopPropagation()}
                      />
                    )}
                  >
                    <SandboxAvatar kind={isBot ? 'bot' : 'user'} name={authorName(message.authorId)} src={participants[message.authorId]?.avatar} />
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => dialogs.openProfile(message.authorId)}><IdCardIcon />{t('sandbox.menu.profile')}</ContextMenuItem>
                    {!outgoing && (
                      <>
                        {getMessageGroupMemberActions(message.authorId, presentation).includes('mention') && (
                          <ContextMenuItem onClick={() => props.onMention(message.authorId)}><AtSignIcon />{t('sandbox.member.mention')}</ContextMenuItem>
                        )}
                        {group && conversation && getMessageGroupMemberActions(message.authorId, presentation).includes('poke') && (
                          <ContextMenuItem onClick={() => run(t('sandbox.error.group'), () => store.performGroupAction({ action: 'poke', groupId: group.id, targetId: message.authorId, conversationId: conversation.id }))}>
                            <HandIcon />{t('sandbox.member.poke')}
                          </ContextMenuItem>
                        )}
                        {hasGroupMemberManagementActions(message.authorId, presentation) && (
                          <ContextMenuSub>
                            <ContextMenuSubTrigger><UsersIcon />{t('sandbox.member.manage')}</ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                              <GroupMemberMenuItems target={getCurrentGroupMember(message.authorId, presentation)!} managementOnly />
                            </ContextMenuSubContent>
                          </ContextMenuSub>
                        )}
                        {getChatFriendActions(message.authorId, presentation).includes('request') ? (
                          <ContextMenuItem onClick={() => friendAction({ action: 'request', targetId: message.authorId, comment: t('sandbox.friend.requestComment') })}>
                            <UserPlusIcon />{t('sandbox.menu.requestFriend')}<ExtensionMark />
                          </ContextMenuItem>
                        ) : getFriendMenuStateOf(message.authorId, presentation).pendingOutgoing ? (
                          <ContextMenuItem disabled><ClockIcon />{t('sandbox.menu.waitingPeer')}</ContextMenuItem>
                        ) : getFriendMenuStateOf(message.authorId, presentation).pendingIncoming ? (
                          <ContextMenuItem disabled><BellIcon />{t('sandbox.menu.handleInNotice')}</ContextMenuItem>
                        ) : null}
                        {!group && conversation && getChatFriendActions(message.authorId, presentation).includes('poke') && (
                          <ContextMenuItem onClick={() => friendAction({ action: 'poke', targetId: message.authorId, conversationId: conversation.id })}><HandIcon />{t('sandbox.member.poke')}</ContextMenuItem>
                        )}
                        {!group && getChatFriendActions(message.authorId, presentation).includes('remark') && (
                          <ContextMenuItem onClick={() => dialogs.openRemark(message.authorId)}><TagIcon />{t('sandbox.menu.remark')}<ExtensionMark /></ContextMenuItem>
                        )}
                        {!group && getChatFriendActions(message.authorId, presentation).includes('delete') && (
                          <ContextMenuItem variant="destructive" onClick={() => friendAction({ action: 'delete', targetId: message.authorId })}><UserMinusIcon />{t('sandbox.menu.deleteFriend')}</ContextMenuItem>
                        )}
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              )

              const bubble = (
                <div
                  className={cn(
                    'relative flex max-w-full flex-col gap-1.5 rounded-2xl px-3 py-2 text-[13.5px] leading-6 break-words whitespace-pre-wrap',
                    outgoing ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
                    bubbleTail && !merged && (outgoing ? 'rounded-tr-md' : 'rounded-tl-md'),
                    !bubbleTail && cluster === 'is-cluster-middle' && (outgoing ? 'rounded-r-md' : 'rounded-l-md'),
                    forward && 'bg-card text-card-foreground ring-1 ring-border',
                    recalled && 'opacity-55',
                    highlighted === message.id && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
                  )}
                  onClickCapture={(event) => {
                    if (!props.selectionMode || !selectable) return
                    event.preventDefault()
                    event.stopPropagation()
                    props.onToggleSelection(message.id)
                  }}
                  onContextMenu={(event) => event.stopPropagation()}
                >
                  {reply && (
                    <button
                      type="button"
                      className={cn('flex flex-col rounded-lg border-l-2 px-2 py-1 text-left text-xs', outgoing ? 'border-primary-foreground/50 bg-primary-foreground/10' : 'border-primary/50 bg-background/60')}
                      aria-label={t('sandbox.chat.jumpToQuote')}
                      onClick={(event) => {
                        event.stopPropagation()
                        revealMessage(reply.id)
                      }}
                    >
                      <strong className="font-medium">{authorName(reply.authorId)}</strong>
                      <span className="line-clamp-2 opacity-80">{getMessageText(reply, presentation)}</span>
                    </button>
                  )}
                  {message.forwardId ? (
                    <button
                      type="button"
                      className="flex w-60 flex-col gap-0.5 text-left disabled:opacity-60"
                      disabled={!forward}
                      aria-label={t('sandbox.forward.open')}
                      onClick={(event) => {
                        if (props.selectionMode || !forward || !message.forwardId) return
                        event.stopPropagation()
                        props.onOpenForward({ messageId: message.id, forwardId: message.forwardId })
                      }}
                    >
                      <strong className="text-[13px] font-medium">{forward?.title || t('sandbox.forward.title')}</strong>
                      {forward ? (
                        <>
                          {forward.lines.map((line, lineIndex) => <span key={lineIndex} className="truncate text-xs text-muted-foreground">{line}</span>)}
                          <span className="mt-1 border-t border-border pt-1 text-[11px] text-muted-foreground">{t('sandbox.forward.total', { count: forward.total })}</span>
                        </>
                      ) : <span className="text-xs text-muted-foreground">{text || t('sandbox.forward.placeholder')}</span>}
                    </button>
                  ) : (
                    <>
                      {renderMedia(message)}
                      {text && <span>{text}</span>}
                    </>
                  )}
                  {recalled && <span className="text-[11px] italic opacity-80">{t('sandbox.chat.recalled')}</span>}
                  {!!message.reactions?.length && (
                    <MessageReactions
                      reactions={message.reactions}
                      readonly={!capabilities.react}
                      onToggle={(emojiId) => {
                        const toggle = resolveReactionToggle(message, emojiId, presentation)
                        if (toggle) props.onReact(toggle.messageId, toggle.emojiId, toggle.enabled)
                      }}
                    />
                  )}
                </div>
              )

              const trace = message.chatLuna?.trace
              return (
                <React.Fragment key={message.id}>
                  {header}
                  <li
                    data-message-id={message.id}
                    aria-selected={props.selectionMode ? selected : undefined}
                    className={cn(
                      'group/row relative flex gap-2.5 rounded-xl px-1 transition-colors',
                      outgoing && 'flex-row-reverse',
                      merged ? 'mt-1' : 'mt-3',
                      inherited && 'opacity-75',
                      selectable && 'hover:bg-accent/40',
                      selected && 'bg-accent/60',
                    )}
                    onClick={(event) => {
                      if (!selectable) return
                      if ((event.target as HTMLElement).closest('a,button,audio,video')) return
                      props.onToggleSelection(message.id)
                    }}
                  >
                    {props.selectionMode && (
                      <span
                        className={cn(
                          'mt-2 flex size-4 shrink-0 items-center justify-center rounded-full border border-input',
                          selected && 'border-primary bg-primary text-primary-foreground',
                          !selectable && 'invisible',
                        )}
                        aria-hidden
                      >
                        {selected && <CheckIcon className="size-3" strokeWidth={3} />}
                      </span>
                    )}
                    {merged ? <span className="w-9 shrink-0" aria-hidden /> : avatarMenu}
                    <div className={cn('flex min-w-0 max-w-[min(72%,40rem)] flex-col gap-1', outgoing && 'items-end')}>
                      {!merged && (
                        <div className={cn('flex items-center gap-1.5 text-[11px] text-muted-foreground', outgoing && 'flex-row-reverse')}>
                          <span>{authorName(message.authorId)}</span>
                          {badge && (
                            <span className={cn(
                              'rounded px-1 text-[10px] leading-4',
                              badge.kind === 'owner' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                : badge.kind === 'admin' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
                            )}>{badge.text}</span>
                          )}
                        </div>
                      )}
                      <div className={cn('flex items-end gap-2', outgoing && 'flex-row-reverse')}>
                        <ContextMenu disabled={recalled || props.selectionMode}>
                          <ContextMenuTrigger render={<div className="min-w-0" />}>
                            {bubble}
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            {isBot && trace && (
                              <ContextMenuItem onClick={() => navigate(traceHref(trace))}><ExternalLinkIcon />{t('sandbox.chat.openRequest')}</ContextMenuItem>
                            )}
                            {capabilities.reply && <ContextMenuItem onClick={() => props.onReply(message.id)}><ReplyIcon />{t('sandbox.chat.reply')}</ContextMenuItem>}
                            {capabilities.branch && <ContextMenuItem onClick={() => props.onBranch(message.id)}><GitBranchIcon />{t('sandbox.chat.branch')}</ContextMenuItem>}
                            {capabilities.react && <ContextMenuItem onClick={() => props.onOpenReactionPicker(message.id)}><SmilePlusIcon />{t('sandbox.chat.react')}</ContextMenuItem>}
                            {capabilities.forward && <ContextMenuItem onClick={() => props.onEnterSelection(message.id)}><ListChecksIcon />{t('sandbox.chat.multiSelect')}</ContextMenuItem>}
                            {capabilities.recall && (
                              <>
                                <ContextMenuSeparator />
                                <ContextMenuItem variant="destructive" onClick={() => props.onRecall(message.id)}><CornerUpLeftIcon />{t('sandbox.chat.recall')}</ContextMenuItem>
                              </>
                            )}
                          </ContextMenuContent>
                        </ContextMenu>
                        <time className="shrink-0 pb-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100">
                          {formatSandboxTimeOfDay(message.createdAt)}
                        </time>
                      </div>
                      {thinking && (
                        <div className={cn('flex w-full max-w-md flex-col', outgoing && 'items-end', recalled && 'opacity-55')}>
                          <button
                            type="button"
                            className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-expanded={!!expandedThinking[message.id]}
                            onClick={() => setExpandedThinking((value) => ({ ...value, [message.id]: !value[message.id] }))}
                          >
                            {thinking.usage && <UsageBadge input={thinking.usage.inputTokens} output={thinking.usage.outputTokens} />}
                            <span>{formatThinkingDuration(thinking.thoughtDurationMs)}</span>
                            <ChevronRightIcon className={cn('size-3 transition-transform duration-200 ease-spring', expandedThinking[message.id] && 'rotate-90')} />
                          </button>
                          {expandedThinking[message.id] && (
                            <div className="mt-1 max-h-80 w-full overflow-y-auto rounded-lg border-l-2 border-border bg-muted/40 px-3 py-2 text-xs leading-5 whitespace-pre-wrap text-muted-foreground animate-in fade-in-0 slide-in-from-top-1">
                              {thinking.thought}
                            </div>
                          )}
                        </div>
                      )}
                      {(usage || (isBot && trace && !recalled)) && (
                        <div className={cn('flex items-center gap-3 px-1.5 text-[11px] text-muted-foreground', outgoing && 'flex-row-reverse', recalled && 'opacity-55')}>
                          {usage && <UsageBadge input={usage.inputTokens} output={usage.outputTokens} />}
                          {isBot && trace && !recalled && (
                            <Link
                              to={traceHref(trace)}
                              className="inline-flex items-center gap-1 rounded-sm opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100"
                            >
                              <ExternalLinkIcon className="size-3" />{t('sandbox.chat.openRequest')}
                            </Link>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                </React.Fragment>
              )
            })}
            {thinkingStates.map((state) => (
              <li key={`${state.botParticipantId}:${state.conversationId}`} className={cn('mt-3 flex gap-2.5 px-1', state.botParticipantId === operatorId && 'flex-row-reverse')}>
                <SandboxAvatar kind="bot" name={participants[state.botParticipantId]?.name} src={participants[state.botParticipantId]?.avatar} />
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] text-muted-foreground">{participants[state.botParticipantId]?.name ?? state.botParticipantId}</span>
                  <div className="flex h-9 items-center gap-1 rounded-2xl rounded-tl-md bg-muted px-4" aria-label={t('sandbox.chat.thinking')}>
                    {[0, 1, 2].map((dot) => (
                      <span key={dot} className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70 motion-reduce:animate-none" style={{ animationDelay: `${dot * 150}ms` }} />
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={props.onClearConversation}><Trash2Icon />{t('sandbox.chat.clear')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

function UsageBadge({ input, output }: { input?: number, output?: number }) {
  const t = useT()
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" aria-label={t('sandbox.chat.usage')}>
      <span className="inline-flex items-center"><ArrowUpIcon className="size-3" />{input ?? '-'}</span>
      <span className="inline-flex items-center"><ArrowDownIcon className="size-3" />{output ?? '-'}</span>
    </span>
  )
}

/** v2 trace 页按会话 ID 打开，`turn` 与 `step` 一起出现时定位到这一步产生的回复。 */
function traceHref({ sessionId, turn, step }: SandboxMessageTraceReference) {
  return `/traces/${encodeURIComponent(sessionId)}?turn=${turn}&step=${step}`
}
