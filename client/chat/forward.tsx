import * as React from 'react'
import { ChevronRightIcon, PaperclipIcon, SearchIcon } from 'lucide-react'
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
  Tabs,
  TabsList,
  TabsTrigger,
} from '@chatluna/ui-kit'
import { forwardNodeText, type SandboxForwardNode } from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar, type AvatarKind } from '../shared/avatar'
import { useRetained } from '../shared/use-retained'
import type { ForwardDialogFrame } from '../webqq/forward-dialog-stack'
import { getForwardNodeClusterClass, isMergedForwardNode } from '../webqq/forward-cluster'
import { buildForwardPreview } from '../webqq/forward-preview'
import { formatMediaSize, getMediaLabel } from '../webqq/message-presentation'
import { useWorkspace } from '../workspace/context'
import { errorText } from '../workspace/store'
import './messages.css'

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
      setError(errorText(failure, t('sandbox.forward.failed')))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sandbox.forward.targetTitle')}</DialogTitle>
          <DialogDescription>{t('sandbox.forward.targetHint')}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="sandbox-search-input pl-8!" value={query} placeholder={t('sandbox.forward.search')} aria-label={t('sandbox.forward.search')} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Tabs value={tab} onValueChange={(value) => setTab(value as keyof ForwardTargets)}>
          <TabsList className="w-full">
            {(['recent', 'friends', 'groups'] as const).map((id) => (
              <TabsTrigger key={id} value={id} className="text-xs">{t(`sandbox.sidebar.${id}`)}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {/* 视口很矮时列表先收缩，页头、搜索与页脚保持可见，不从透明的毛玻璃页头下面滚过。 */}
        <div className="-mx-5 flex max-h-72 min-h-0 flex-col gap-0.5 overflow-y-auto px-5" role="listbox" aria-label={t('sandbox.forward.targets')}>
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

/**
 * 合并转发详情：每层嵌套转发是叠在上一层之上的二级窗口，右上角关闭只退回上一层，关闭根层一并关闭整条链。
 * 各层以 React 子树嵌套，Esc 与点遮罩只作用于最上层。
 */
export function ForwardViewer({ stack, imageOpen, onCloseFrom, onOpenForward, onOpenImage }: {
  stack: readonly ForwardDialogFrame[]
  /** 大图预览开着时：预览挂在 body 下，点它或按 Esc 会被弹窗当成外部关闭，这期间不响应关闭请求。 */
  imageOpen: boolean
  /** 关闭第 `depth` 层及其上的全部层。 */
  onCloseFrom(depth: number): void
  onOpenForward(forwardId: string): void
  onOpenImage(url: string): void
}) {
  return <ForwardFrameDialog stack={stack} depth={0} imageOpen={imageOpen} onCloseFrom={onCloseFrom} onOpenForward={onOpenForward} onOpenImage={onOpenImage} />
}

function ForwardFrameDialog({ stack, depth, imageOpen, onCloseFrom, onOpenForward, onOpenImage }: {
  stack: readonly ForwardDialogFrame[]
  depth: number
  imageOpen: boolean
  onCloseFrom(depth: number): void
  onOpenForward(forwardId: string): void
  onOpenImage(url: string): void
}) {
  const t = useT()
  const { participants, media, mediaFailures, workspace } = useWorkspace()
  const current = stack[depth]
  // 退场动画期间保留这一层的内容，不闪成「暂无消息」。
  const frame = useRetained(current)
  if (!frame) return null
  // 媒体自动生成的标签与嵌套转发的占位都和画出来的内容重复，不再作为正文显示。
  const nodeText = (item: SandboxForwardNode) => {
    const text = forwardNodeText(item)
    return item.media?.length === 1 && text === `[${getMediaLabel(item.media[0]!)}] ${item.media[0]!.name}` ? '' : text
  }
  const { appearance } = workspace
  return (
    <Dialog open={!!current} onOpenChange={(open) => !open && !imageOpen && onCloseFrom(depth)}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 overflow-hidden sm:max-w-lg">
        {/* 右侧留出关闭按钮的位置，长标题截断而不压到 X 上。 */}
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="truncate leading-6">{frame.title || t('sandbox.forward.title')}</DialogTitle>
        </DialogHeader>
        <div className="-mx-5 flex min-h-0 flex-1 flex-col overflow-y-auto px-5">
          {frame.items.length ? (
            // 与聊天页同一套消息行结构与类名（messages.css）：气泡底色、连续收角、尖角与描边设置都和聊天页一致。
            // 弹窗经 Portal 挂到 body，不在 .sandbox-webqq 里，强调色在这里补上。
            <ol
              className={cn('sandbox-message-list sandbox-forward-list', appearance.sandboxTimBubbleTail && 'has-tail', appearance.sandboxIncomingBubbleStyle === 'outline' && 'has-outline')}
              style={{ '--sandbox-accent': appearance.sandboxAccentColor } as React.CSSProperties}
            >
              {frame.items.map((item, index) => {
                const merged = isMergedForwardNode(frame.items, index)
                const nested = item.forwardId ? frame.nestedForwards[item.forwardId] : undefined
                const preview = nested ? buildForwardPreview(nested) : undefined
                const text = nodeText(item)
                return (
                  <li key={index} className={cn('sandbox-message-row is-incoming', getForwardNodeClusterClass(frame.items, index), merged && 'is-merged')}>
                    {/* 合并项保留头像占位（visibility 隐藏），气泡与上一条对齐。 */}
                    <span className="sandbox-message-avatar-wrap">
                      <SandboxAvatar kind={participants[item.userId]?.isBot ? 'bot' : 'user'} name={item.nickname} src={participants[item.userId]?.avatar} className="size-8" />
                    </span>
                    <div className="sandbox-message-content">
                      {!merged && <div className="sandbox-message-sender-line"><span>{item.nickname}</span></div>}
                      <div className="sandbox-message-body">
                        <div className="sandbox-message-stack">
                          <div className="sandbox-message-bubble">
                            {/* 自定义节点可以同时带嵌套转发、媒体与文字：转发卡片与聊天页的引用一样放在最上面。 */}
                            {item.forwardId && (
                              <button type="button" className="sandbox-message-quote sandbox-message-forward" aria-label={t('sandbox.forward.open')} onClick={() => item.forwardId && onOpenForward(item.forwardId)}>
                                <strong className="sandbox-message-quote-title">{preview?.title || t('sandbox.forward.title')}</strong>
                                {preview ? (
                                  <>
                                    {preview.lines.map((line, lineIndex) => <span key={lineIndex}>{line}</span>)}
                                    <span className="sandbox-message-forward-entry">{t('sandbox.forward.total', { count: preview.total })}<ChevronRightIcon className="size-4" /></span>
                                  </>
                                ) : <span>{t('sandbox.forward.placeholder')}</span>}
                              </button>
                            )}
                            {item.media?.map((entry) => {
                              const source = media[entry.id]
                              return (
                                <div key={entry.id} className="sandbox-message-media">
                                  {!source ? (
                                    <span className="sandbox-message-media-loading">{mediaFailures[entry.id] ? t('sandbox.media.unavailable') : t('sandbox.media.loading')}</span>
                                  ) : entry.type === 'image' ? (
                                    <button type="button" className="sandbox-message-image" aria-label={t('sandbox.media.viewImage')} onClick={() => onOpenImage(source)}>
                                      <img src={source} alt={entry.name} />
                                    </button>
                                  ) : entry.type === 'audio' ? (
                                    <audio src={source} controls preload="metadata" />
                                  ) : entry.type === 'video' ? (
                                    <video src={source} controls preload="metadata" />
                                  ) : (
                                    <a href={source} download={entry.name} className="sandbox-message-file">
                                      <PaperclipIcon className="size-[18px]" />
                                      <span><strong>{entry.name}</strong><small>{formatMediaSize(entry.size)}</small></span>
                                    </a>
                                  )}
                                </div>
                              )
                            })}
                            {text && <span className="sandbox-message-text">{text}</span>}
                            {!text && !item.media?.length && !item.forwardId && <span className="sandbox-message-text">{t('sandbox.forward.emptyNode')}</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          ) : <p className="py-8 text-center text-xs text-muted-foreground">{t('sandbox.forward.noItems')}</p>}
        </div>
        <ForwardFrameDialog stack={stack} depth={depth + 1} imageOpen={imageOpen} onCloseFrom={onCloseFrom} onOpenForward={onOpenForward} onOpenImage={onOpenImage} />
      </DialogContent>
    </Dialog>
  )
}
