import * as React from 'react'
import { ChevronLeftIcon, PaperclipIcon, SearchIcon } from 'lucide-react'
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@chatluna/ui-kit'
import type { SandboxForwardNode } from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar, type AvatarKind } from '../shared/avatar'
import type { ForwardDialogFrame } from '../webqq/forward-dialog-stack'
import { isMergedForwardNode } from '../webqq/forward-cluster'
import { buildForwardPreview } from '../webqq/forward-preview'
import { formatMediaSize, getMediaLabel } from '../webqq/message-presentation'
import { useWorkspace } from '../workspace/context'

export interface ForwardTargetOption {
  conversationId: string
  title: string
  subtitle?: string
  avatar?: string
  avatarKind: AvatarKind
}

export type ForwardTargets = Record<'recent' | 'friends' | 'groups', ForwardTargetOption[]>

/** 选择合并转发的目标：最近会话、好友或群组中的一个根会话。 */
export function ForwardTargetDialog({ open, targets, onOpenChange, onConfirm }: {
  open: boolean
  targets: ForwardTargets
  onOpenChange(open: boolean): void
  onConfirm(conversationId: string): Promise<void>
}) {
  const t = useT()
  const [tab, setTab] = React.useState<keyof ForwardTargets>('recent')
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')
  const needle = query.trim().toLowerCase()
  const visible = targets[tab].filter((target) => !needle
    || target.title.toLowerCase().includes(needle)
    || target.conversationId.toLowerCase().includes(needle)
    || !!target.subtitle?.toLowerCase().includes(needle))

  React.useEffect(() => {
    if (!open) return
    setTab('recent')
    setQuery('')
    setSubmitting(false)
    setError('')
    setSelected(targets.recent[0]?.conversationId ?? targets.friends[0]?.conversationId ?? targets.groups[0]?.conversationId ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  React.useEffect(() => {
    if (!visible.some(({ conversationId }) => conversationId === selected)) setSelected(visible[0]?.conversationId ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, needle])

  const confirm = async () => {
    if (!selected || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onConfirm(selected)
      onOpenChange(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('sandbox.forward.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sandbox-glass sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sandbox.forward.targetTitle')}</DialogTitle>
          <DialogDescription>{t('sandbox.forward.targetHint')}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="pl-8!" value={query} placeholder={t('sandbox.forward.search')} aria-label={t('sandbox.forward.search')} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="flex gap-0.5 rounded-lg bg-muted p-0.5" role="tablist">
          {(['recent', 'friends', 'groups'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={cn('h-7 flex-1 rounded-md text-xs text-muted-foreground', tab === id && 'bg-background text-foreground shadow-sm')}
              onClick={() => setTab(id)}
            >
              {t(`sandbox.sidebar.${id}`)}
            </button>
          ))}
        </div>
        <div className="flex max-h-72 min-h-40 flex-col gap-0.5 overflow-y-auto" role="listbox" aria-label={t('sandbox.forward.targets')}>
          {visible.map((target) => (
            <button
              key={target.conversationId}
              type="button"
              role="option"
              aria-selected={selected === target.conversationId}
              className={cn('flex items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-accent', selected === target.conversationId && 'bg-accent ring-1 ring-primary/40')}
              onClick={() => setSelected(target.conversationId)}
            >
              <SandboxAvatar kind={target.avatarKind} name={target.title} src={target.avatar} className="size-8" />
              <span className="flex min-w-0 flex-col">
                <strong className="truncate text-[13px] font-medium">{target.title}</strong>
                <small className="truncate text-xs text-muted-foreground">{target.subtitle || target.conversationId}</small>
              </span>
            </button>
          ))}
          {!visible.length && (
            <p className="py-10 text-center text-xs text-muted-foreground">
              {needle ? t('sandbox.forward.noMatch') : t(`sandbox.forward.empty.${tab}`)}
            </p>
          )}
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>{t('sandbox.common.cancel')}</Button>
          <Button disabled={!selected || submitting} onClick={confirm}>{submitting ? t('sandbox.forward.sending') : t('sandbox.forward.send')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 合并转发详情：可逐层打开嵌套转发，返回上一层或整体关闭。 */
export function ForwardViewer({ frame, canBack, onBack, onClose, onOpenForward, onOpenImage }: {
  frame?: ForwardDialogFrame
  canBack: boolean
  onBack(): void
  onClose(): void
  onOpenForward(forwardId: string): void
  onOpenImage(url: string): void
}) {
  const t = useT()
  const { participants, media, mediaFailures } = useWorkspace()
  const nodeText = (item: SandboxForwardNode) => item.media?.length === 1 && item.content === `[${getMediaLabel(item.media[0]!)}] ${item.media[0]!.name}` ? '' : item.content
  return (
    <Dialog open={!!frame} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sandbox-glass flex max-h-[80vh] flex-col gap-3 sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-2">
          {canBack && (
            <Button variant="ghost" size="icon-sm" aria-label={t('sandbox.forward.back')} onClick={onBack}><ChevronLeftIcon /></Button>
          )}
          <DialogTitle>{frame?.title || t('sandbox.forward.title')}</DialogTitle>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
          {frame?.items.map((item, index) => {
            const merged = isMergedForwardNode(frame.items, index)
            const nested = item.forwardId ? frame.nestedForwards[item.forwardId] : undefined
            const preview = nested ? buildForwardPreview(nested) : undefined
            const text = nodeText(item)
            return (
              <article key={index} className={cn('flex gap-2.5', merged ? 'mt-1' : 'mt-3 first:mt-0')}>
                {merged
                  ? <span className="w-8 shrink-0" />
                  : <SandboxAvatar kind={participants[item.userId]?.isBot ? 'bot' : 'user'} name={item.nickname} src={participants[item.userId]?.avatar} className="size-8" />}
                <div className="flex min-w-0 flex-col gap-1">
                  {!merged && <span className="text-[11px] text-muted-foreground">{item.nickname}</span>}
                  <div className="flex max-w-full flex-col gap-1.5 self-start rounded-2xl rounded-tl-md bg-muted px-3 py-2 text-[13px] leading-6 break-words whitespace-pre-wrap">
                    {item.forwardId ? (
                      <button type="button" className="flex w-56 flex-col gap-0.5 text-left" aria-label={t('sandbox.forward.open')} onClick={() => item.forwardId && onOpenForward(item.forwardId)}>
                        <strong className="font-medium">{preview?.title ?? t('sandbox.forward.title')}</strong>
                        {preview
                          ? (
                            <>
                              {preview.lines.map((line, lineIndex) => <span key={lineIndex} className="truncate text-xs text-muted-foreground">{line}</span>)}
                              <span className="mt-1 border-t border-border pt-1 text-[11px] text-muted-foreground">{t('sandbox.forward.total', { count: preview.total })}</span>
                            </>
                          )
                          : <span className="text-xs text-muted-foreground">{item.content || t('sandbox.forward.placeholder')}</span>}
                      </button>
                    ) : (
                      <>
                        {item.media?.map((entry) => {
                          const source = media[entry.id]
                          if (!source) return <span key={entry.id} className="text-xs text-muted-foreground">{mediaFailures[entry.id] ? t('sandbox.media.unavailable') : t('sandbox.media.loading')}</span>
                          if (entry.type === 'image') return <button key={entry.id} type="button" aria-label={t('sandbox.media.viewImage')} onClick={() => onOpenImage(source)}><img src={source} alt={entry.name} className="max-h-56 max-w-56 rounded-lg object-cover" /></button>
                          if (entry.type === 'audio') return <audio key={entry.id} src={source} controls preload="metadata" />
                          if (entry.type === 'video') return <video key={entry.id} src={source} controls preload="metadata" className="max-h-56 rounded-lg" />
                          return (
                            <a key={entry.id} href={source} download={entry.name} className="flex items-center gap-2 rounded-lg bg-background/60 px-3 py-2">
                              <PaperclipIcon className="size-4" />
                              <span className="flex flex-col"><strong className="text-[13px] font-medium">{entry.name}</strong><small className="text-[11px] text-muted-foreground">{formatMediaSize(entry.size)}</small></span>
                            </a>
                          )
                        })}
                        {text ? <span>{text}</span> : !item.media?.length && <span className="text-muted-foreground">{t('sandbox.forward.emptyNode')}</span>}
                      </>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
          {!frame?.items.length && <p className="py-8 text-center text-xs text-muted-foreground">{t('sandbox.forward.noItems')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
