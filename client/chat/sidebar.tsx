import * as React from 'react'
import {
  BellIcon,
  ChevronDownIcon,
  ClockIcon,
  IdCardIcon,
  MessageCircleIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
  Trash2Icon,
  UserIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react'
import {
  Badge,
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from '@chatluna/ui-kit'
import { getSandboxBots } from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { CreateEntityPopover } from '../environment/create-popover'
import { buildConversationTree, type ConversationTreeNode, type ConversationTreeRow } from '../webqq/conversation-tree'
import { getIncomingNotificationRequests } from '../webqq/notification-requests'
import { getFriendDirectory, getGroupDirectory } from '../webqq/relationship-directory'
import { useSandbox, useWorkspace } from '../workspace/context'
import { ExtensionMark } from './extension-mark'
import { NotificationList } from './notifications'

type SidebarTab = 'recent' | 'friends' | 'groups'

export function ChatSidebar({ onSelectConversation, className }: {
  onSelectConversation(conversationId: string): void
  className?: string
}) {
  const t = useT()
  const { store, run, dialogs } = useSandbox()
  const workspace = useWorkspace()
  const { snapshot, operatorId, operator, conversation, group: currentGroup, resolveAvatar } = workspace
  const [tab, setTab] = React.useState<SidebarTab>('recent')
  const [query, setQuery] = React.useState('')
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})

  const tree = React.useMemo(() => buildConversationTree({
    scene: snapshot,
    conversations: workspace.conversations,
    operatorId,
    resolveAvatar,
  }), [snapshot, workspace.conversations, operatorId, resolveAvatar])
  const notifications = getIncomingNotificationRequests(snapshot, operatorId)
  const pending = notifications.friends.length + notifications.groups.length
  const bots = getSandboxBots(snapshot)

  // 选中会话实例时自动展开它所属的根会话，避免选中项藏在折叠里。
  React.useEffect(() => {
    if (conversation?.kind !== 'instance') return
    setExpanded((value) => value[conversation.rootConversationId] ? value : { ...value, [conversation.rootConversationId]: true })
  }, [conversation])

  const needle = query.trim().toLowerCase()
  const friends = tab === 'friends'
    ? getFriendDirectory(snapshot, operatorId).filter(({ id, displayName }) => !needle || id.includes(needle) || displayName.toLowerCase().includes(needle))
    : []
  const groups = tab === 'groups'
    ? getGroupDirectory(snapshot, operatorId).filter(({ id, name }) => !needle || id.includes(needle) || name.toLowerCase().includes(needle))
    : []
  const empty = tab === 'recent' ? !tree.length : tab === 'friends' ? !friends.length : !groups.length

  const friendAction = (label: string, input: Parameters<typeof store.performFriendAction>[0]) => run(label, () => store.performFriendAction(input))
  const groupAction = (label: string, input: Parameters<typeof store.performGroupAction>[0]) => run(label, () => store.performGroupAction(input))

  const tabs: Array<{ id: SidebarTab, icon: typeof ClockIcon }> = [
    { id: 'recent', icon: ClockIcon },
    { id: 'friends', icon: UserIcon },
    { id: 'groups', icon: UsersIcon },
  ]

  return (
    <aside className={cn('flex min-h-0 w-72 shrink-0 flex-col border-r border-border bg-sidebar/40', className)} aria-label={t('sandbox.sidebar.label')}>
      <header className="flex items-center gap-1 px-3 pt-3 pb-2">
        <div className="flex flex-1 items-center gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label={t('sandbox.sidebar.tabs')}>
          {tabs.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={cn(
                'flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-xs text-muted-foreground transition-colors',
                tab === id ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground',
              )}
              onClick={() => {
                setTab(id)
                setQuery('')
              }}
            >
              <Icon className="size-3.5" />
              {t(`sandbox.sidebar.${id}`)}
            </button>
          ))}
        </div>
        <Popover>
          <PopoverTrigger render={(
            <Button variant="ghost" size="icon" className="relative" aria-label={pending ? t('sandbox.notice.labelCount', { count: pending }) : t('sandbox.notice.label')}>
              <BellIcon />
              {pending > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-destructive" />}
            </Button>
          )} />
          <PopoverContent align="end" className="w-80 p-0">
            <NotificationList requests={notifications} />
          </PopoverContent>
        </Popover>
      </header>
      {tab !== 'recent' && (
        <div className="px-3 pb-2"><div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="h-8 pl-8"
            value={query}
            autoComplete="off"
            aria-label={t('sandbox.sidebar.search')}
            placeholder={t(tab === 'friends' ? 'sandbox.sidebar.searchFriends' : 'sandbox.sidebar.searchGroups')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div></div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          {tab === 'groups' && (
            <CreateEntityPopover
              type="group"
              operator={operator}
              bots={bots}
              trigger={(
                <button type="button" className="flex items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent">
                  <span className="flex size-9 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground"><PlusIcon className="size-4" /></span>
                  <span className="flex min-w-0 flex-col">
                    <strong className="text-[13px] font-medium">{t('sandbox.sidebar.addGroup')}</strong>
                    <small className="text-xs text-muted-foreground">{t('sandbox.sidebar.addGroupHint')}</small>
                  </span>
                </button>
              )}
            />
          )}
          {tab === 'recent' && tree.map((node) => (
            <ConversationNode
              key={node.id}
              node={node}
              activeId={conversation?.id}
              expanded={!!expanded[node.id]}
              onToggle={() => setExpanded((value) => ({ ...value, [node.id]: !value[node.id] }))}
              onSelect={onSelectConversation}
            />
          ))}
          {friends.map((entry) => (
            <ContextMenu key={entry.id}>
              <ContextMenuTrigger render={(
                <DirectoryRow
                  kind={entry.isBot ? 'bot' : 'user'}
                  title={entry.displayName}
                  subtitle={entry.status}
                  avatar={resolveAvatar(entry.avatar)}
                  active={!!entry.conversationId && entry.conversationId === conversation?.id}
                  status={t(entry.isFriend ? 'sandbox.sidebar.added' : entry.pendingOutgoing || entry.pendingIncoming ? 'sandbox.sidebar.pending' : 'sandbox.sidebar.notAdded')}
                  onClick={() => entry.conversationId && onSelectConversation(entry.conversationId)}
                />
              )} />
              <ContextMenuContent>
                <ContextMenuItem onClick={() => dialogs.openProfile(entry.id)}><IdCardIcon />{t('sandbox.menu.profile')}</ContextMenuItem>
                {!entry.isFriend && !entry.pendingOutgoing && !entry.pendingIncoming && (
                  <ContextMenuItem onClick={() => friendAction(t('sandbox.error.friend'), { action: 'request', targetId: entry.id, comment: t('sandbox.friend.requestComment') })}>
                    <UserPlusIcon />{t('sandbox.menu.requestFriend')}<ExtensionMark />
                  </ContextMenuItem>
                )}
                {entry.pendingOutgoing && <ContextMenuItem disabled><ClockIcon />{t('sandbox.menu.waitingPeer')}</ContextMenuItem>}
                {entry.pendingIncoming && <ContextMenuItem disabled><BellIcon />{t('sandbox.menu.handleInNotice')}</ContextMenuItem>}
                {entry.isFriend && (
                  <>
                    <ContextMenuItem onClick={() => dialogs.openRemark(entry.id)}><TagIcon />{t('sandbox.menu.remark')}<ExtensionMark /></ContextMenuItem>
                    <ContextMenuItem variant="destructive" onClick={() => friendAction(t('sandbox.error.friend'), { action: 'delete', targetId: entry.id })}>
                      <UserMinusIcon />{t('sandbox.menu.deleteFriend')}
                    </ContextMenuItem>
                  </>
                )}
                {currentGroup && !currentGroup.members.some(({ participantId }) => participantId === entry.id) && (
                  <ContextMenuItem onClick={() => groupAction(t('sandbox.error.group'), { action: 'invite', groupId: currentGroup.id, targetId: entry.id })}>
                    <UserPlusIcon />{t('sandbox.menu.inviteToGroup')}<ExtensionMark />
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <EntityMenuItems target={{ type: entry.isBot ? 'bot' : 'user', id: entry.id }} />
              </ContextMenuContent>
            </ContextMenu>
          ))}
          {groups.map((entry) => (
            <ContextMenu key={entry.id}>
              <ContextMenuTrigger render={(
                <DirectoryRow
                  kind="group"
                  title={entry.name}
                  subtitle={t('sandbox.chat.groupSubtitle', { id: entry.id, count: entry.members.length })}
                  avatar={resolveAvatar(entry.avatar)}
                  active={!!entry.conversationId && entry.conversationId === conversation?.id}
                  status={t(entry.member ? 'sandbox.sidebar.joined' : entry.pending ? 'sandbox.sidebar.pending' : 'sandbox.sidebar.notJoined')}
                  onClick={() => entry.conversationId && onSelectConversation(entry.conversationId)}
                />
              )} />
              <ContextMenuContent>
                {!entry.member && !entry.pending && (
                  <ContextMenuItem onClick={() => groupAction(t('sandbox.error.group'), { action: 'request-join', groupId: entry.id, comment: t('sandbox.group.requestComment') })}>
                    <UserPlusIcon />{t('sandbox.menu.requestJoin')}<ExtensionMark />
                  </ContextMenuItem>
                )}
                {!entry.member && entry.pending && <ContextMenuItem disabled><ClockIcon />{t('sandbox.menu.waitingAdmin')}</ContextMenuItem>}
                {entry.member && <GroupRootItems groupId={entry.id} role={entry.member.role} />}
                <ContextMenuSeparator />
                <EntityMenuItems target={{ type: 'group', id: entry.id }} />
              </ContextMenuContent>
            </ContextMenu>
          ))}
          {empty && <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t('sandbox.sidebar.empty')}</p>}
        </div>
      </ScrollArea>
    </aside>
  )
}

const DirectoryRow = React.forwardRef<HTMLButtonElement, React.ComponentProps<'button'> & {
  kind: 'user' | 'bot' | 'group'
  title: string
  subtitle: string
  avatar?: string
  status?: string
  time?: string
  active?: boolean
}>(function DirectoryRow({ kind, title, subtitle, avatar, status, time, active, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent',
        active && 'bg-accent',
        className,
      )}
      aria-current={active || undefined}
      {...props}
    >
      <SandboxAvatar kind={kind} name={title} src={avatar} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <strong className="truncate text-[13px] font-medium">{title}</strong>
          {time && <time className="ml-auto shrink-0 text-[11px] text-muted-foreground">{time}</time>}
        </span>
        <small className="truncate text-xs text-muted-foreground">{subtitle}</small>
      </span>
      {status && <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">{status}</Badge>}
    </button>
  )
})

function ConversationNode({ node, activeId, expanded, onToggle, onSelect }: {
  node: ConversationTreeNode
  activeId?: string
  expanded: boolean
  onToggle(): void
  onSelect(id: string): void
}) {
  const t = useT()
  const { store, run, dialogs } = useSandbox()
  const count = node.children.length
  return (
    <div className="flex flex-col">
      <ContextMenu>
        <ContextMenuTrigger render={(
          <div className="group relative">
            <DirectoryRow
              kind={node.avatarKind}
              title={node.title}
              subtitle={node.preview}
              avatar={node.avatar}
              time={node.time}
              active={node.id === activeId}
              className={count ? 'pr-12' : undefined}
              onClick={() => onSelect(node.id)}
            />
            {count > 0 && (
              <button
                type="button"
                className="absolute top-1/2 right-2 flex h-6 -translate-y-1/2 items-center gap-0.5 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
                aria-expanded={expanded}
                aria-label={t(expanded ? 'sandbox.sidebar.collapse' : 'sandbox.sidebar.expand', { count })}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggle()
                }}
              >
                {count}
                <ChevronDownIcon className={cn('size-3.5 transition-transform duration-200 ease-spring', expanded && 'rotate-180')} />
              </button>
            )}
          </div>
        )} />
        <ContextMenuContent>
          {node.groupId && <GroupRootItems groupId={node.groupId} role={node.actorRole} />}
          <ContextMenuItem onClick={() => run(t('sandbox.error.createConversation'), () => store.createConversationInstance(node.id))}>
            <PlusIcon />{t('sandbox.menu.newConversation')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <EntityMenuItems target={node.entityTarget} />
        </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <div className="ml-6 flex flex-col gap-0.5 border-l border-border pl-2">
          {node.children.map((child) => (
            <ContextMenu key={child.id}>
              <ContextMenuTrigger render={<InstanceRow row={child} active={child.id === activeId} onClick={() => onSelect(child.id)} />} />
              <ContextMenuContent>
                <ContextMenuItem onClick={() => dialogs.openConversationRename(child.id)}><PencilIcon />{t('sandbox.menu.renameConversation')}</ContextMenuItem>
                <ContextMenuItem variant="destructive" onClick={() => run(t('sandbox.error.deleteConversation'), () => store.deleteConversationInstance(child.id))}>
                  <Trash2Icon />{t('sandbox.menu.deleteConversation')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      )}
    </div>
  )
}

const InstanceRow = React.forwardRef<HTMLButtonElement, React.ComponentProps<'button'> & { row: ConversationTreeRow, active: boolean }>(
  function InstanceRow({ row, active, className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent', active && 'bg-accent', className)}
        aria-current={active || undefined}
        {...props}
      >
        <MessageCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <strong className="truncate text-xs font-medium">{row.title}</strong>
            {row.time && <time className="ml-auto shrink-0 text-[11px] text-muted-foreground">{row.time}</time>}
          </span>
          <small className="truncate text-[11px] text-muted-foreground">{row.preview}</small>
        </span>
      </button>
    )
  },
)

/** 已加入群组的根会话菜单：改群名需要管理员，群主不能直接退群。 */
function GroupRootItems({ groupId, role }: { groupId: string, role?: 'owner' | 'admin' | 'member' }) {
  const t = useT()
  const { store, run, dialogs } = useSandbox()
  return (
    <>
      <ContextMenuItem disabled={role === 'member'} onClick={() => dialogs.openGroupAction('name', '', groupId)}>
        <PencilIcon />{t(role === 'member' ? 'sandbox.menu.renameGroupNeedAdmin' : 'sandbox.menu.renameGroup')}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={role === 'owner'}
        variant="destructive"
        onClick={() => run(t('sandbox.error.group'), () => store.performGroupAction({ action: 'leave', groupId }))}
      >
        <UserMinusIcon />{t(role === 'owner' ? 'sandbox.menu.ownerCannotLeave' : 'sandbox.menu.leaveGroup')}
      </ContextMenuItem>
    </>
  )
}

export function EntityMenuItems({ target }: { target: { type: 'user' | 'bot' | 'group', id: string } }) {
  const t = useT()
  const { dialogs } = useSandbox()
  const kind = t(`sandbox.kind.${target.type}`)
  return (
    <>
      <ContextMenuItem onClick={() => dialogs.openEntity('edit', target)}><PencilIcon />{t('sandbox.menu.editEntity', { kind })}<ExtensionMark /></ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={() => dialogs.openEntity('delete', target)}><Trash2Icon />{t('sandbox.menu.deleteEntity', { kind })}<ExtensionMark /></ContextMenuItem>
    </>
  )
}
