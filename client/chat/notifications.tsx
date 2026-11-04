import * as React from 'react'
import { Button, cn } from '@chatluna/ui-kit'
import type { SandboxRelationshipRequest } from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { errorText } from '../workspace/store'
import { useSandbox, useWorkspace } from '../workspace/context'
import type { IncomingNotificationRequests } from '../webqq/notification-requests'

function formatNoticeTime(value: string) {
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 通知面板：只列出发给当前操作者的好友申请与群通知，逐条同意或拒绝。 */
export function NotificationList({ requests }: { requests: IncomingNotificationRequests }) {
  const t = useT()
  const { store } = useSandbox()
  const { participants, snapshot } = useWorkspace()
  const [tab, setTab] = React.useState<'friends' | 'groups'>('friends')
  const [handling, setHandling] = React.useState('')
  const [error, setError] = React.useState('')
  const visible = tab === 'friends' ? requests.friends : requests.groups
  const groupName = (id?: string) => snapshot.groups.find((group) => group.id === id)?.name ?? t('sandbox.notice.group')
  const name = (id: string) => participants[id]?.name ?? id

  const handle = async (request: SandboxRelationshipRequest, approve: boolean) => {
    setHandling(request.id)
    setError('')
    try {
      await store.handleRelationshipRequest(request.id, approve)
    } catch (failure) {
      setError(errorText(failure, t('sandbox.notice.failed')))
    } finally {
      setHandling('')
    }
  }

  return (
    <div className="flex max-h-96 flex-col">
      <div className="flex gap-1 border-b border-border p-1.5">
        {(['friends', 'groups'] as const).map((id) => (
          <Button
            key={id}
            variant="ghost"
            size="sm"
            className={cn('flex-1', tab === id && 'bg-accent')}
            onClick={() => setTab(id)}
          >
            {t(`sandbox.notice.${id}`)}
            {(id === 'friends' ? requests.friends : requests.groups).length > 0 && (
              <span className="ml-1 rounded-full bg-destructive px-1.5 text-[10px] leading-4 text-white">{(id === 'friends' ? requests.friends : requests.groups).length}</span>
            )}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
        {!visible.length && <p className="py-8 text-center text-xs text-muted-foreground">{t('sandbox.notice.empty')}</p>}
        {visible.map((request) => (
          <article key={request.id} className="flex items-start gap-2.5 rounded-lg p-2 hover:bg-accent/50">
            <SandboxAvatar kind={participants[request.requesterId]?.isBot ? 'bot' : 'user'} name={name(request.requesterId)} src={participants[request.requesterId]?.avatar} className="size-8" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="truncate text-[13px] font-medium">{request.type === 'friend' ? name(request.requesterId) : groupName(request.groupId)}</strong>
              <span className="truncate text-xs text-muted-foreground">
                {request.type === 'friend'
                  ? t('sandbox.notice.fromQQ', { id: request.requesterId })
                  : t(request.subType === 'invite' ? 'sandbox.notice.invite' : 'sandbox.notice.join', { name: name(request.requesterId) })}
              </span>
              {request.comment && <small className="truncate text-[11px] text-muted-foreground">{request.comment}</small>}
              <time className="text-[11px] text-muted-foreground">{formatNoticeTime(request.createdAt)}</time>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="xs" disabled={handling === request.id} onClick={() => handle(request, true)}>{t('sandbox.notice.approve')}</Button>
              <Button size="xs" variant="outline" disabled={handling === request.id} onClick={() => handle(request, false)}>{t('sandbox.notice.reject')}</Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
