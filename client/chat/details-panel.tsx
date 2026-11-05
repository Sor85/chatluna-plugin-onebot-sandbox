import * as React from 'react'
import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import {
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Input,
  ResizableHandle,
  type ResizableLayout,
  ResizablePanel,
  ResizablePanelGroup,
  Textarea,
} from '@chatluna/ui-kit'
import { readStored, writeStored } from '@chatluna/ui-storage'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { ConfirmDialog, type ConfirmRequest } from '../shared/confirm-dialog'
import { getGroupMemberDisplayName } from '../webqq/group-display'
import { errorText } from '../workspace/store'
import { useSandbox, useWorkspace } from '../workspace/context'
import { GroupMemberMenuItems } from './member-menu'
// 群主/管理员/头衔标签复用消息列表的 `sandbox-message-role-badge`，与聊天页保持同一套样式。
import './messages.css'

const layoutStorageKey = 'chatluna.onebot-sandbox.details-layout'
const announcementsPanelId = 'announcements'
const membersPanelId = 'members'

/** 群公告与群成员的分隔比例（百分比），拖动分隔线后存进浏览器。 */
function loadDetailsLayout(): ResizableLayout | undefined {
  const stored = readStored(layoutStorageKey)
  if (!stored || typeof stored !== 'object') return undefined
  const record = stored as Record<string, unknown>
  const announcements = record[announcementsPanelId]
  const members = record[membersPanelId]
  if (typeof announcements !== 'number' || typeof members !== 'number') return undefined
  return { [announcementsPanelId]: announcements, [membersPanelId]: members }
}

/** 群聊信息栏：群公告与群成员。 */
export function DetailsPanel({ onClose, onMention, className }: {
  onClose(): void
  onMention(participantId: string): void
  className?: string
}) {
  const t = useT()
  const { store, dialogs } = useSandbox()
  const { group, conversation, participants } = useWorkspace()
  const [memberQuery, setMemberQuery] = React.useState('')
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [deleting, setDeleting] = React.useState('')
  const [confirm, setConfirm] = React.useState<ConfirmRequest>()
  const [error, setError] = React.useState('')
  const [defaultLayout] = React.useState(loadDetailsLayout)

  React.useEffect(() => {
    setMemberQuery('')
    setEditorOpen(false)
    setDraft('')
    setDeleting('')
    setError('')
  }, [conversation?.id])

  const memberName = (participantId: string, card?: string) => getGroupMemberDisplayName({ card }, participants[participantId]?.name ?? participantId)
  const needle = memberQuery.trim().toLowerCase()
  const members = group?.members.filter((member) => !needle || memberName(member.participantId, member.card).toLowerCase().includes(needle) || member.participantId.includes(needle)) ?? []

  const publish = async (event: React.FormEvent) => {
    event.preventDefault()
    const content = draft.trim()
    if (!group || !content || sending) return
    setSending(true)
    setError('')
    try {
      await store.setGroupAnnouncement({ groupId: group.id, content })
      setDraft('')
      setEditorOpen(false)
    } catch (failure) {
      setError(errorText(failure, t('sandbox.details.publishFailed')))
    } finally {
      setSending(false)
    }
  }

  const remove = async (announcementId: string) => {
    if (!group || deleting) return
    setDeleting(announcementId)
    setError('')
    try {
      await store.deleteGroupAnnouncement({ groupId: group.id, announcementId })
    } catch (failure) {
      setError(errorText(failure, t('sandbox.details.deleteFailed')))
    } finally {
      setDeleting('')
    }
  }

  // 私聊不显示信息栏（webqq-view.tsx 只在群聊时渲染本组件）。
  if (!group) return null
  const label = t('sandbox.details.group')
  return (
    <aside className={cn('flex min-h-0 w-72 shrink-0 flex-col border-l border-border bg-sidebar/40', className)} aria-label={label}>
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <strong className="text-sm font-medium">{label}</strong>
        <Button variant="ghost" size="icon-sm" aria-label={t('sandbox.details.close')} onClick={onClose}><XIcon /></Button>
      </header>
      {/* 面板内层默认 overflow:auto，这里交给公告与成员列表各自滚动。 */}
      <ResizablePanelGroup
        orientation="vertical"
        className="min-h-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={(layout) => writeStored(layoutStorageKey, layout)}
      >
        <ResizablePanel id={announcementsPanelId} defaultSize="40" minSize={96} maxSize="75" className="flex min-h-0 flex-col gap-2 p-4" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-medium">{t('sandbox.details.announcements')}</h3>
            <Button variant="ghost" size="icon-xs" aria-label={t(editorOpen ? 'sandbox.details.cancelAnnouncement' : 'sandbox.details.addAnnouncement')} onClick={() => {
              setEditorOpen((open) => !open)
              setDraft('')
              setError('')
            }}>
              <PlusIcon className={cn('transition-transform duration-200 ease-spring', editorOpen && 'rotate-45')} />
            </Button>
          </div>
          {/* 提示、发布表单与公告列表同在一个滚动区：面板拖到最矮时发布按钮滚得到，不会被裁掉。 */}
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
            {editorOpen && (
              <form className="flex shrink-0 flex-col gap-2" onSubmit={publish}>
                <Textarea rows={3} value={draft} placeholder={t('sandbox.details.announcementPlaceholder')} onChange={(event) => setDraft(event.target.value)} />
                <Button type="submit" size="sm" className="self-end" disabled={sending || !draft.trim()}>{sending ? t('sandbox.details.publishing') : t('sandbox.details.publish')}</Button>
              </form>
            )}
            {!group.announcements.length && <p className="py-2 text-xs text-muted-foreground">{t('sandbox.details.noAnnouncement')}</p>}
            {group.announcements.map((announcement) => (
              <article key={announcement.id} className="group/notice relative rounded-lg bg-muted/60 p-2.5 pr-8">
                <p className="text-xs leading-5 whitespace-pre-wrap">{announcement.content}</p>
                <time className="mt-1 block text-[11px] text-muted-foreground">
                  {participants[announcement.authorId]?.name ?? announcement.authorId} · {new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(announcement.createdAt))}
                </time>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-1.5 right-1.5 opacity-0 group-hover/notice:opacity-100 focus-visible:opacity-100"
                  disabled={deleting === announcement.id}
                  aria-label={t('sandbox.details.deleteAnnouncement', { content: announcement.content })}
                  onClick={() => setConfirm({
                    title: t('sandbox.details.deleteAnnouncementTitle'),
                    description: t('sandbox.details.deleteAnnouncementDescription', { content: announcement.content }),
                    action: t('sandbox.common.delete'),
                    onConfirm: () => void remove(announcement.id),
                  })}
                >
                  <Trash2Icon />
                </Button>
              </article>
            ))}
          </div>
        </ResizablePanel>
        <ResizableHandle aria-label={t('sandbox.details.resize')} />
        <ResizablePanel id={membersPanelId} minSize={160} className="flex min-h-0 flex-col gap-2 p-4" style={{ overflow: 'hidden' }}>
          <h3 className="text-[13px] font-medium">{t('sandbox.details.members', { count: group.members.length })}</h3>
          <Input type="search" className="sandbox-search-input h-8" value={memberQuery} placeholder={t('sandbox.details.memberSearch')} onChange={(event) => setMemberQuery(event.target.value)} />
          <div className="-mx-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            {!members.length && <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('sandbox.details.noMember')}</p>}
            {members.map((member) => (
              <ContextMenu key={member.participantId}>
                <ContextMenuTrigger render={(
                  <button type="button" className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent" onClick={(event) => dialogs.openProfile(member.participantId, { x: event.clientX, y: event.clientY })} />
                )}>
                  <SandboxAvatar kind={participants[member.participantId]?.isBot ? 'bot' : 'user'} name={memberName(member.participantId, member.card)} src={participants[member.participantId]?.avatar} className="size-8" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <strong className="truncate text-xs font-medium">{memberName(member.participantId, member.card)}</strong>
                    <small className="text-[11px] text-muted-foreground">{member.participantId}</small>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {member.title && <span className="sandbox-message-role-badge is-title">{member.title}</span>}
                    {member.role !== 'member' && <span className={`sandbox-message-role-badge is-${member.role}`}>{t(`sandbox.role.${member.role}`)}</span>}
                  </span>
                </ContextMenuTrigger>
                <ContextMenuContent className="sandbox-glass">
                  <GroupMemberMenuItems target={member} onMention={onMention} />
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(undefined)} />
    </aside>
  )
}
