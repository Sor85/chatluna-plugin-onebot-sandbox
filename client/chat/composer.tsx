import * as React from 'react'
import { FileIcon, PaperclipIcon, PencilIcon, PlusIcon, SendHorizontalIcon, Trash2Icon, XIcon } from 'lucide-react'
import {
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@chatluna/ui-kit'
import type { SendMediaFileInput } from '../../src/types'
import { useT } from '../i18n'
import { SandboxAvatar } from '../shared/avatar'
import { CreateEntityPopover } from '../environment/create-popover'
import type { MentionCandidate } from '../webqq/composer-draft'
import {
  createComposerDraftHost,
  resolveComposerHostTextOffset,
  type ComposerHostCaretReading,
  type ComposerHostCaretTarget,
  type ComposerHostNodePlan,
  type ComposerHostNodeReading,
} from '../webqq/composer-draft-host'
import { orderUsersByActive } from '../webqq/user-stack'
import { errorText } from '../workspace/store'
import { useSandbox, useWorkspace } from '../workspace/context'
import { ExtensionMark } from './extension-mark'

export interface ComposerHandle {
  focus(): void
  insertMention(mention: { id: string, name: string }): void
}

export interface ComposerSendIntent {
  conversationId: string
  content: string
  replyToMessageId?: string
  media?: SendMediaFileInput[]
}

interface Attachment {
  id: string
  file: File
  previewUrl?: string
  baseName: string
  extension: string
}

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024
const COLLAPSED_SENDERS = 4
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,audio/*,video/mp4,video/webm,video/quicktime,.txt,.csv,.json,.pdf,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx'

function splitFileName(name: string) {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? { baseName: name, extension: '' } : { baseName: name.slice(0, dot), extension: name.slice(dot) }
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(typeof reader.result === 'string' ? reader.result : ''))
    reader.addEventListener('error', () => reject(reader.error ?? new Error('unreadable')))
    reader.readAsDataURL(file)
  })
}

/**
 * 发送框：左侧是可切换的发送者头像栈（用户与机器人都能作为当前操作者），中间是支持 @ 成员胶囊的
 * 富文本草稿，右侧是附件与发送。Enter 发送、Shift+Enter 换行，输入法组字期间不提交。
 */
export const Composer = React.forwardRef<ComposerHandle, {
  replyingTo?: { id: string, authorName: string, content: string }
  mentionCandidates: MentionCandidate[]
  onClearReply(): void
  onSend(intent: ComposerSendIntent): Promise<void>
}>(function Composer({ replyingTo, mentionCandidates, onClearReply, onSend }, ref) {
  const t = useT()
  const { store, dialogs } = useSandbox()
  const { conversation, operatorId, snapshot, resolveAvatar } = useWorkspace()
  const editor = React.useRef<HTMLDivElement>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const [, rerender] = React.useReducer((value: number) => value + 1, 0)
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState('')
  const [stackExpanded, setStackExpanded] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const candidates = React.useRef(mentionCandidates)
  candidates.current = mentionCandidates
  const current = React.useRef({ conversationId: conversation?.id, operatorId })
  current.current = { conversationId: conversation?.id, operatorId }

  const host = React.useMemo(() => createComposerDraftHost({
    readNodes: () => {
      const root = editor.current
      if (!root) return undefined
      const map = (node: Node): ComposerHostNodeReading => {
        if (node.nodeType === Node.TEXT_NODE) return { kind: 'text', text: node.textContent ?? '' }
        if (!(node instanceof HTMLElement)) return { kind: 'container', children: [] }
        if (node.dataset['mentionId']) {
          return { kind: 'mention', id: node.dataset['mentionId'], name: node.dataset['mentionName'] || node.textContent?.replace(/^@/, '') || node.dataset['mentionId'] }
        }
        if (node.tagName === 'BR') return { kind: 'line-break' }
        return { kind: 'container', children: Array.from(node.childNodes).map(map) }
      }
      return Array.from(root.childNodes).map(map)
    },
    renderNodes: (plan: readonly ComposerHostNodePlan[]) => {
      const root = editor.current
      if (!root) return
      root.replaceChildren()
      for (const node of plan) {
        if (node.kind === 'text') {
          root.appendChild(document.createTextNode(node.text))
          continue
        }
        const chip = document.createElement('span')
        chip.className = 'mx-0.5 inline-block rounded bg-primary/12 px-1 text-primary'
        chip.contentEditable = 'false'
        chip.dataset['mentionId'] = node.id
        chip.dataset['mentionName'] = node.name
        chip.textContent = `@${node.name}`
        root.appendChild(chip)
      }
    },
    readCaret: (): ComposerHostCaretReading | undefined => {
      const root = editor.current
      const selection = window.getSelection()
      if (!root || !selection || selection.rangeCount === 0) return undefined
      const range = selection.getRangeAt(0)
      if (!root.contains(range.startContainer)) return undefined
      if (range.startContainer === root) return { kind: 'editor', childOffset: range.startOffset }
      let childIndex = 0
      for (const child of Array.from(root.childNodes)) {
        if (child === range.startContainer || child.contains(range.startContainer)) return { kind: 'child', childIndex, offset: range.startOffset }
        if (child.nodeType === Node.TEXT_NODE || (child instanceof HTMLElement && child.dataset['mentionId'])) childIndex += 1
      }
      return { kind: 'editor', childOffset: root.childNodes.length }
    },
    writeCaret: (target: ComposerHostCaretTarget) => {
      const root = editor.current
      const selection = window.getSelection()
      if (!root || !selection) return
      let node: Node = root
      let offset = root.childNodes.length
      if (target.kind === 'child') {
        const child = root.childNodes[target.childIndex]
        if (child) {
          node = child
          offset = resolveComposerHostTextOffset(child.textContent ?? '', target.offset)
        }
      }
      try {
        const range = document.createRange()
        range.setStart(node, offset)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
      } catch {
        // 节点在本帧被替换时放弃这次定位，下一次输入会重新同步。
      }
    },
    nextTick: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    focus: () => editor.current?.focus(),
    readMentionCandidates: () => candidates.current,
  }, rerender), [])

  React.useImperativeHandle(ref, () => ({
    focus: () => host.focus(),
    insertMention: (mention) => host.insertMention(mention),
  }), [host])

  React.useEffect(() => {
    host.render()
  }, [host])

  // 换会话或换操作者时草稿作废；附件一并清掉，避免把上一个身份的附件发到新会话。
  React.useEffect(() => {
    host.reset()
    setError('')
    setAttachments((list) => {
      for (const item of list) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return []
    })
  }, [conversation?.id, operatorId, host])

  React.useEffect(() => () => {
    setAttachments((list) => {
      for (const item of list) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return list
    })
  }, [])

  const addFiles = (files: Iterable<File>) => {
    const next: Attachment[] = []
    let oversize = false
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        oversize = true
        continue
      }
      next.push({
        id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        ...splitFileName(file.name),
      })
    }
    if (oversize) setError(t('sandbox.composer.oversize'))
    if (next.length) setAttachments((list) => [...list, ...next])
  }

  const removeAttachment = (id: string) => setAttachments((list) => list.filter((item) => {
    if (item.id !== id) return true
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    return false
  }))

  const disabled = sending || !conversation
  const submit = async () => {
    host.closeMentionMenu()
    const content = host.serialize()
    const request = { ...current.current }
    if (sending || host.composing.value || (!content && !attachments.length) || !request.conversationId || !request.operatorId) return
    setSending(true)
    setError('')
    try {
      const media = attachments.length
        ? await Promise.all(attachments.map(async ({ file }) => {
          const dataUrl = await readDataUrl(file)
          return { fileName: file.name, mimeType: file.type, dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) }
        }))
        : undefined
      await onSend({ conversationId: request.conversationId, content, replyToMessageId: replyingTo?.id, media })
      host.reset()
      for (const item of attachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      setAttachments([])
      onClearReply()
    } catch (failure) {
      setError(errorText(failure, t('sandbox.composer.failed')))
    } finally {
      setSending(false)
      // 只有请求期间没换会话、没换身份时才把焦点还给输入框，避免抢走用户已经转移的焦点。
      requestAnimationFrame(() => {
        if (current.current.conversationId === request.conversationId && current.current.operatorId === request.operatorId) editor.current?.focus()
      })
    }
  }

  const senders = orderUsersByActive(
    snapshot.participants.map((participant) => ({ ...participant, avatar: resolveAvatar(participant.avatar) })),
    operatorId,
  )
  const expanded = stackExpanded || creating || senders.length <= COLLAPSED_SENDERS
  const shown = expanded ? senders : senders.slice(0, COLLAPSED_SENDERS)
  const overflow = senders.length - shown.length

  const switchOperator = async (participantId: string) => {
    if (participantId === operatorId) return
    try {
      await store.selectOperator(participantId)
      setError('')
    } catch (failure) {
      setError(errorText(failure, t('sandbox.composer.switchFailed')))
    }
  }

  const mentionOpen = host.mentionMenuOpen.value
  const mentionList = host.mentionCandidates.value
  const mentionIndex = host.mentionMenuIndex.value

  return (
    <div className="px-4 pb-4">
      <form
        className="relative mx-auto flex max-w-4xl flex-col gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {error && <span role="alert" className="px-2 text-xs text-destructive">{error}</span>}
        {(replyingTo || attachments.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-1">
            {replyingTo && (
              <div className="flex max-w-full min-w-0 items-center gap-1 rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground">
                <span className="truncate">{t('sandbox.composer.replyTo', { name: replyingTo.authorName, content: replyingTo.content })}</span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={t('sandbox.composer.clearReply')} onClick={onClearReply}><XIcon /></Button>
              </div>
            )}
            {attachments.map((item) => item.previewUrl ? (
              <span key={item.id} className="relative size-14 overflow-hidden rounded-lg ring-1 ring-border">
                <img src={item.previewUrl} alt={item.file.name} className="size-full object-cover" />
                <button type="button" className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white" aria-label={t('sandbox.composer.remove', { name: item.file.name })} onClick={() => removeAttachment(item.id)}>
                  <XIcon className="size-3" />
                </button>
              </span>
            ) : (
              <span key={item.id} className="flex max-w-48 items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-2 text-xs">
                <FileIcon className="size-3.5 shrink-0" />
                <span className="flex min-w-0"><span className="truncate">{item.baseName}</span><span className="shrink-0">{item.extension}</span></span>
                <Button type="button" variant="ghost" size="icon-xs" aria-label={t('sandbox.composer.remove', { name: item.file.name })} onClick={() => removeAttachment(item.id)}><XIcon /></Button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <div
            className="flex shrink-0 items-center self-center pl-1"
            onPointerEnter={() => setStackExpanded(true)}
            onPointerLeave={() => setStackExpanded(false)}
            onFocus={() => setStackExpanded(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setStackExpanded(false)
            }}
          >
            <div className={cn('flex items-center transition-[gap] duration-200 ease-spring', expanded ? 'gap-1' : '-space-x-2.5')}>
              {shown.map((sender, index) => (
                <Tooltip key={sender.id}>
                  <TooltipTrigger render={<span className="inline-flex" style={{ zIndex: shown.length - index }} />}>
                    <ContextMenu>
                      <ContextMenuTrigger render={(
                        <button
                          type="button"
                          className={cn(
                            'rounded-full ring-2 ring-card transition-transform duration-200 ease-spring hover:-translate-y-0.5',
                            sender.id === operatorId && 'ring-primary',
                          )}
                          aria-pressed={sender.id === operatorId}
                          aria-label={t(sender.id === operatorId ? 'sandbox.composer.currentSender' : 'sandbox.composer.switchSender', {
                            name: sender.kind === 'bot' ? `${sender.name}（${t('sandbox.kind.bot')}）` : sender.name,
                          })}
                          onClick={() => switchOperator(sender.id)}
                        />
                      )}>
                        <SandboxAvatar kind={sender.kind} name={sender.name} src={sender.avatar} className="size-8" />
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onClick={() => dialogs.openEntity('edit', { type: sender.kind, id: sender.id })}>
                          <PencilIcon />{t('sandbox.menu.editEntity', { kind: t(`sandbox.kind.${sender.kind}`) })}<ExtensionMark />
                        </ContextMenuItem>
                        <ContextMenuItem variant="destructive" onClick={() => dialogs.openEntity('delete', { type: sender.kind, id: sender.id })}>
                          <Trash2Icon />{t('sandbox.menu.deleteEntity', { kind: t(`sandbox.kind.${sender.kind}`) })}<ExtensionMark />
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </TooltipTrigger>
                  <TooltipContent side="top">{sender.name}</TooltipContent>
                </Tooltip>
              ))}
              {overflow > 0 && (
                <span className="z-0 flex size-8 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground ring-2 ring-card" aria-hidden>+{overflow}</span>
              )}
            </div>
            {expanded && (
              <CreateEntityPopover
                type="participant"
                side="top"
                onOpenChange={setCreating}
                trigger={(
                  <Button type="button" variant="ghost" size="icon-sm" className="ml-1 rounded-full border border-dashed border-border" aria-label={t('sandbox.composer.addAccount')}>
                    <PlusIcon />
                  </Button>
                )}
              />
            )}
          </div>
          <div className="relative min-w-0 flex-1">
            {host.isEmpty.value && <span aria-hidden className="pointer-events-none absolute top-1.5 left-2 text-[13.5px] leading-6 text-muted-foreground">{t('sandbox.composer.placeholder')}</span>}
            <div
              ref={editor}
              role="textbox"
              aria-multiline="true"
              aria-label={t('sandbox.composer.input')}
              aria-disabled={disabled || undefined}
              contentEditable={!disabled}
              suppressContentEditableWarning
              className="max-h-40 min-h-9 overflow-y-auto rounded-lg px-2 py-1.5 text-[13.5px] leading-6 break-words whitespace-pre-wrap outline-none"
              onKeyDown={(event) => {
                const action = host.routeKey({ key: event.key, shiftKey: event.shiftKey, disabled })
                if (action.kind !== 'none') event.preventDefault()
                if (action.kind === 'submit') void submit()
              }}
              onInput={() => void host.handleInput()}
              onCompositionStart={() => host.startComposition()}
              onCompositionEnd={() => void host.endComposition()}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? [])
                if (files.length) {
                  event.preventDefault()
                  addFiles(files)
                  return
                }
                // 只接受纯文本粘贴，避免把外部富文本结构带进草稿宿主。
                event.preventDefault()
                document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
              }}
              onMouseUp={() => host.syncCaretFromHost()}
              onKeyUp={() => host.syncCaretFromHost()}
            />
            {mentionOpen && (
              <div className="absolute bottom-full left-0 z-30 mb-2 flex max-h-60 w-64 flex-col gap-0.5 overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-popup ring-1 ring-border" role="listbox" aria-label={t('sandbox.composer.mention')}>
                {mentionList.map((candidate, index) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="option"
                    aria-selected={index === mentionIndex}
                    className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-left', index === mentionIndex && 'bg-accent')}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      host.selectMentionCandidate(candidate)
                    }}
                    onMouseEnter={() => host.setMentionSelection(index)}
                  >
                    <SandboxAvatar kind={candidate.kind} name={candidate.name} src={candidate.avatar} className="size-6" />
                    <span className="flex min-w-0 flex-col">
                      <strong className="truncate text-xs font-medium">{candidate.name}</strong>
                      <small className="text-[11px] text-muted-foreground">{candidate.id}</small>
                    </span>
                  </button>
                ))}
                {!mentionList.length && <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t('sandbox.composer.noMention')}</p>}
              </div>
            )}
          </div>
          <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(event) => {
            if (event.target.files) addFiles(Array.from(event.target.files))
            event.target.value = ''
          }} />
          <Button type="button" variant="ghost" size="icon" aria-label={t('sandbox.composer.attach')} disabled={disabled} onClick={() => fileInput.current?.click()}>
            <PaperclipIcon />
          </Button>
          <Button type="submit" size="icon" aria-label={t('sandbox.composer.send')} disabled={disabled || (host.isEmpty.value && !attachments.length)}>
            <SendHorizontalIcon />
          </Button>
        </div>
      </form>
    </div>
  )
})
