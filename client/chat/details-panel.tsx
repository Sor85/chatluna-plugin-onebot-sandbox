import * as React from 'react'
import { DatabaseIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import {
  Badge,
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  Input,
  Textarea,
} from '@chatluna/ui-kit'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { getGroupMemberDisplayName } from '../webqq/group-display'
import { errorText } from '../workspace/store'
import { useSandbox, useWorkspace } from '../workspace/context'
import { GroupMemberMenuItems } from './member-menu'

/** 会话信息栏：群聊显示群公告与成员，私聊显示对方资料与当前环境状态。 */
export function DetailsPanel({ onClose, onMention, className }: {
  onClose(): void
  onMention(participantId: string): void
  className?: string
}) {
  const t = useT()
  const { store, dialogs } = useSandbox()
  const { group, peer, bot, conversation, operator, participants, workspace } = useWorkspace()
  const [memberQuery, setMemberQuery] = React.useState('')
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [deleting, setDeleting] = React.useState('')
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    setMemberQuery('')
    setEditorOpen(false)
    setDraft('')
    setDeleting('')
    setError('')
  }, [conversation?.id])

  const persistence = workspace.persistence
  const persistenceLabel = persistence.mode === 'memory'
    ? t('sandbox.details.memory')
    : !persistence.available ? t('sandbox.details.databaseUnavailable') : persistence.persisted ? t('sandbox.details.database') : t('sandbox.details.databasePending')
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

  const label = group ? t('sandbox.details.group') : t('sandbox.details.private')
  return (
    <aside className={cn('flex min-h-0 w-72 shrink-0 flex-col border-l border-border bg-sidebar/40', className)} aria-label={label}>
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <strong className="text-sm font-medium">{label}</strong>
        <Button variant="ghost" size="icon-sm" aria-label={t('sandbox.details.close')} onClick={onClose}><XIcon /></Button>
      </header>
      {group ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <section className="flex max-h-[45%] min-h-0 flex-col gap-2 border-b border-border p-4">
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
            {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
            {editorOpen && (
              <form className="flex flex-col gap-2" onSubmit={publish}>
                <Textarea rows={3} value={draft} placeholder={t('sandbox.details.announcementPlaceholder')} onChange={(event) => setDraft(event.target.value)} />
                <Button type="submit" size="sm" className="self-end" disabled={sending || !draft.trim()}>{sending ? t('sandbox.details.publishing') : t('sandbox.details.publish')}</Button>
              </form>
            )}
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
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
                    onClick={() => remove(announcement.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </article>
              ))}
            </div>
          </section>
          <section className="flex min-h-0 flex-1 flex-col gap-2 p-4">
            <h3 className="text-[13px] font-medium">{t('sandbox.details.members', { count: group.members.length })}</h3>
            <Input type="search" className="h-8" value={memberQuery} placeholder={t('sandbox.details.memberSearch')} onChange={(event) => setMemberQuery(event.target.value)} />
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
                      {member.title && <Badge variant="secondary" className="text-[10px]">{member.title}</Badge>}
                      {member.role !== 'member' && <Badge variant="outline" className="text-[10px]">{t(`sandbox.role.${member.role}`)}</Badge>}
                    </span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <GroupMemberMenuItems target={member} onMention={onMention} />
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          <div className="flex flex-col items-center gap-2 pt-4 text-center">
            <SandboxAvatar kind={bot ? 'bot' : 'user'} name={peer?.name} src={participants[peer?.id ?? '']?.avatar} className="size-16" />
            <h2 className="text-sm font-medium">{peer?.name ?? t('sandbox.details.noPeer')}</h2>
            <p className="text-xs text-muted-foreground">{peer?.id ?? t('sandbox.details.noConversation')}</p>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />{t('sandbox.details.online')}</span>
          </div>
          <dl className="flex flex-col gap-2.5 text-xs">
            {peer?.profile?.personalNote && <Fact label={t('sandbox.field.personalNote')} value={peer.profile.personalNote} />}
            <Fact label={t('sandbox.details.platform')} value="OneBot" />
            <Fact label={t('sandbox.details.type')} value={t('sandbox.details.privateType')} />
            <Fact label={t('sandbox.details.operator')} value={operator?.name ?? t('sandbox.details.none')} />
            <Fact label={t('sandbox.details.environment')} value={persistenceLabel} title={persistence.message} />
          </dl>
          <div className="mt-auto flex items-center gap-2 rounded-lg bg-muted/60 p-3 text-[11px] text-muted-foreground">
            <DatabaseIcon className="size-4 shrink-0" />
            <span>{t('sandbox.details.revision', { revision: workspace.snapshot.revision })}</span>
          </div>
        </div>
      )}
    </aside>
  )
}

function Fact({ label, value, title }: { label: string, value: string, title?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words" title={title}>{value}</dd>
    </div>
  )
}
