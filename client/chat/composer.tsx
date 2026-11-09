import * as React from 'react'
import { createLayout, type AutoLayout } from 'animejs'
import { FileIcon, IdCardIcon, PaperclipIcon, PencilIcon, PlusIcon, SendIcon, Trash2Icon, XIcon } from 'lucide-react'
import {
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
import { MEBIBYTE } from '../../src/media-limits'
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
import {
  getUserStackLayoutMetrics,
  getUserStackMetrics,
  orderUsersByActive,
  USER_AVATAR_SIZE,
  USER_STACK_COLLAPSED_STEP,
  USER_STACK_EXPANDED_STEP,
} from '../webqq/user-stack'
import { errorText } from '../workspace/store'
import { useSandbox, useWorkspace } from '../workspace/context'
import { ExtensionMark } from './extension-mark'
import './composer.css'

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

// 胶囊内 padding(8) + 三个 gap(12) + 附件按钮(32) + 发送按钮(36)。
const COMPOSER_FIXED_WIDTH = 88
// 输入区可压缩到 0（min-width: 0），低于这个宽度就该省略头像而不是压扁输入框。
const COMPOSER_MIN_INPUT_WIDTH = 100
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
 * 发送框：悬浮在消息区底部的胶囊。左侧是可切换的发送者头像堆叠（用户与机器人都能作为当前操作者），
 * 中间是支持 @ 成员胶囊的富文本草稿，右侧是附件与发送。Enter 发送、Shift+Enter 换行，输入法组字期间不提交。
 *
 * 外观与动画逐条对齐源插件：折叠时只露当前操作者与最近两位、其余并成 "+N"，悬停或聚焦时展开；
 * 切换发送者时当前操作者移到最前，由 Anime.js 的布局 FLIP 补间重排。消息区底部留白经 `onSpaceChange` 回报。
 */
export const Composer = React.forwardRef<ComposerHandle, {
  replyingTo?: { id: string, authorName: string, content: string }
  mentionCandidates: MentionCandidate[]
  onClearReply(): void
  onSend(intent: ComposerSendIntent): Promise<void>
  onOpenImage?(url: string): void
  onSpaceChange?(space: number): void
}>(function Composer({ replyingTo, mentionCandidates, onClearReply, onSend, onOpenImage, onSpaceChange }, ref) {
  const t = useT()
  const { store, dialogs } = useSandbox()
  const { conversation, operatorId, snapshot, resolveAvatar, workspace } = useWorkspace()
  const editor = React.useRef<HTMLDivElement>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const [, rerender] = React.useReducer((value: number) => value + 1, 0)
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState('')
  const [stackExpanded, setStackExpanded] = React.useState(false)
  const [overflowMotion, setOverflowMotion] = React.useState<'idle' | 'expanding' | 'collapsing'>('idle')
  const [compactStack, setCompactStack] = React.useState(false)
  const layoutRoot = React.useRef<HTMLDivElement>(null)
  const form = React.useRef<HTMLFormElement>(null)
  const context = React.useRef<HTMLDivElement>(null)
  const stackRoot = React.useRef<HTMLDivElement>(null)
  const layout = React.useRef<AutoLayout>(undefined)
  const pendingLayout = React.useRef<AutoLayout>(undefined)
  const transitionUntil = React.useRef(0)
  const timers = React.useRef<{ motion?: ReturnType<typeof setTimeout>, suppress?: ReturnType<typeof setTimeout> }>({})
  const pointer = React.useRef({ hovered: false, focused: false, creating: false, suppress: false })
  const stack = React.useRef({ hasOverflow: false, expanded: false })
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
        chip.className = 'sandbox-composer-mention'
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
      if (file.size > workspace.mediaMaxSize) {
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
    if (oversize) setError(t('sandbox.composer.oversize', { size: workspace.mediaMaxSize / MEBIBYTE }))
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
      refocus.current = request
      setSending(false)
    }
  }

  // 发送期间编辑器是 contentEditable=false，focus() 无效，要等 sending 复位的提交完成后再还焦点。
  // 只有请求期间没换会话、没换身份时才还，避免抢走用户已经转移的焦点。
  const refocus = React.useRef<{ conversationId?: string, operatorId?: string }>(undefined)
  React.useLayoutEffect(() => {
    const request = refocus.current
    if (sending || !request) return
    refocus.current = undefined
    if (current.current.conversationId !== request.conversationId || current.current.operatorId !== request.operatorId) return
    const root = editor.current
    if (!root) return
    root.focus()
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [sending])

  const senders = orderUsersByActive(
    snapshot.participants.map((participant) => ({ ...participant, avatar: resolveAvatar(participant.avatar) })),
    operatorId,
  )
  const metrics = getUserStackMetrics(senders.length, compactStack)
  const layoutMetrics = getUserStackLayoutMetrics(senders.length, compactStack)
  const hasOverflow = metrics.overflowCount > 0
  const expanded = stackExpanded && hasOverflow
  const visualExpanded = expanded || !hasOverflow
  const overflowPreview = senders[metrics.collapsedVisibleCount]
  const isCollapsedExtra = (index: number) => hasOverflow && index >= metrics.collapsedVisibleCount
  const isCollapsedHidden = (index: number) => !expanded && isCollapsedExtra(index)
  stack.current = { hasOverflow, expanded }

  const setExpanded = (next: boolean) => {
    if (!stack.current.hasOverflow || stack.current.expanded === next) return
    setOverflowMotion(next ? 'expanding' : 'collapsing')
    clearTimeout(timers.current.motion)
    timers.current.motion = setTimeout(() => setOverflowMotion('idle'), 280)
    stack.current.expanded = next
    setStackExpanded(next)
    transitionUntil.current = performance.now() + 180
  }

  // Chrome 会在 keyed 按钮重排时短暂触发 focusout，切换动画完成前不能据此折叠头像堆叠。
  const syncExpanded = () => {
    if (pointer.current.suppress) return
    setExpanded(pointer.current.hovered || pointer.current.focused || pointer.current.creating)
  }

  // 人数减少到不再溢出时收起，下次溢出从折叠态开始。
  React.useEffect(() => {
    if (!hasOverflow) setStackExpanded(false)
  }, [hasOverflow])

  // 只记录头像区；把发送框正文加入 FLIP 会让整个控件在切换发送者时横向跳动。
  const recordLayout = () => {
    if (!layout.current && stackRoot.current) {
      layout.current = createLayout(stackRoot.current, {
        children: ['.sandbox-composer-user-capsule', '.sandbox-composer-user-stack', '.sandbox-composer-user-switch', '.sandbox-composer-user-overflow', '.sandbox-composer-user-add'],
      })
    }
    layout.current?.record()
    return layout.current
  }

  // 新顺序提交到 DOM 后、绘制之前从记录的旧位置补间过去，等价于原版 nextTick 之后的 animate。
  React.useLayoutEffect(() => {
    const pending = pendingLayout.current
    if (!pending) return
    pendingLayout.current = undefined
    pending.animate({ duration: 260, ease: 'out(3)' })
  }, [operatorId])

  React.useEffect(() => () => {
    layout.current?.revert()
    clearTimeout(timers.current.motion)
    clearTimeout(timers.current.suppress)
  }, [])

  const switchOperator = async (participantId: string) => {
    if (participantId === operatorId) return
    pointer.current.suppress = true
    clearTimeout(timers.current.suppress)
    const remaining = transitionUntil.current - performance.now()
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
    pendingLayout.current = recordLayout()
    try {
      await store.selectOperator(participantId)
      setError('')
    } catch (failure) {
      pendingLayout.current = undefined
      setError(errorText(failure, t('sandbox.composer.switchFailed')))
    } finally {
      timers.current.suppress = setTimeout(() => {
        pointer.current.suppress = false
        pointer.current.focused = !!layoutRoot.current?.contains(document.activeElement)
        syncExpanded()
      }, 280)
    }
  }

  // 极限窄屏：胶囊被 max-width 钳住后头像堆叠会把附件、发送图标挤出胶囊背景，宽度不足时折叠态只留
  // 当前操作者 + "+N"。阈值恒按完整（非 compact）堆叠宽度计算，compact 与否不影响判定，无反馈循环。
  const senderCount = senders.length
  React.useLayoutEffect(() => {
    const element = form.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const fullWidth = getUserStackLayoutMetrics(senderCount).collapsedWidth
      setCompactStack(element.clientWidth < fullWidth + COMPOSER_FIXED_WIDTH + COMPOSER_MIN_INPUT_WIDTH)
      // 回复与附件共用一个浮动包络，消息区底部留白按包络真实高度计算。28 = 胶囊距底 20px + 置底时
      // 末条消息与输入区的可视间隙 8px；包络与胶囊之间的 8px 已计入包络高度。
      // 量布局高度（offsetHeight）而不是 getBoundingClientRect：进出测试空间的缩放动画期间工作区带 scale，
      // 量到的是缩小后的高度，动画结束时布局尺寸不变、ResizeObserver 不再触发，留白就一直偏小。
      const formHeight = element.offsetHeight
      const overlay = context.current ? context.current.offsetHeight + 8 : 0
      onSpaceChange?.(formHeight + overlay + 28)
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (context.current) observer.observe(context.current)
    update()
    return () => observer.disconnect()
  }, [senderCount, !!replyingTo, attachments.length, onSpaceChange])

  const extraWidth = Math.max(0, layoutMetrics.collapsedWidth - USER_AVATAR_SIZE)
  const visualExtension = visualExpanded ? Math.max(0, layoutMetrics.expandedWidth - layoutMetrics.collapsedWidth) : 0
  const coveredByExpanded = expanded || overflowMotion === 'expanding'
  const vars = (values: Record<string, string | number>) => values as React.CSSProperties

  const mentionOpen = host.mentionMenuOpen.value
  const mentionList = host.mentionCandidates.value
  const mentionIndex = host.mentionMenuIndex.value

  return (
    <div ref={layoutRoot} className="sandbox-composer-layout-root">
      <form
        ref={form}
        className="sandbox-composer"
        style={vars({ width: `${460 + extraWidth}px`, '--sandbox-composer-visual-extension': `${visualExtension}px` })}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {error && <span role="alert" className="sandbox-composer-error">{error}</span>}
        {(replyingTo || attachments.length > 0) && (
          <div ref={context} className="sandbox-composer-context">
            {replyingTo && (
              <div className="sandbox-composer-reply">
                <span>{t('sandbox.composer.replyTo', { name: replyingTo.authorName, content: replyingTo.content })}</span>
                <button type="button" aria-label={t('sandbox.composer.clearReply')} onClick={onClearReply}><XIcon className="size-[15px]" aria-hidden /></button>
              </div>
            )}
            {attachments.map((item) => item.previewUrl ? (
              <span key={item.id} className="sandbox-composer-attachment-image">
                <button type="button" className="sandbox-composer-attachment-preview" aria-label={t('sandbox.composer.preview', { name: item.file.name })} onClick={() => onOpenImage?.(item.previewUrl!)}>
                  <img src={item.previewUrl} alt={item.file.name} />
                </button>
                <button type="button" className="sandbox-composer-attachment-remove" aria-label={t('sandbox.composer.remove', { name: item.file.name })} onClick={() => removeAttachment(item.id)}>
                  <XIcon className="size-3" aria-hidden />
                </button>
              </span>
            ) : (
              <span key={item.id} className="sandbox-composer-attachment-file">
                <FileIcon className="size-3.5" strokeWidth={2} aria-hidden />
                <span className="sandbox-composer-attachment-name">
                  <span className="sandbox-composer-attachment-base">{item.baseName}</span><span>{item.extension}</span>
                </span>
                <button type="button" aria-label={t('sandbox.composer.remove', { name: item.file.name })} onClick={() => removeAttachment(item.id)}>
                  <XIcon className="size-3.5" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        <div ref={stackRoot} className="sandbox-composer-user-layout-root" style={vars({ '--sandbox-user-layout-width': `${layoutMetrics.collapsedWidth}px` })}>
          <div
            className={cn('sandbox-composer-user-capsule', visualExpanded && 'is-expanded')}
            style={vars({
              '--sandbox-user-capsule-collapsed-width': `${layoutMetrics.collapsedWidth}px`,
              '--sandbox-user-capsule-expanded-width': `${layoutMetrics.expandedWidth}px`,
            })}
            onPointerEnter={() => {
              pointer.current.hovered = true
              syncExpanded()
            }}
            onPointerLeave={() => {
              pointer.current.hovered = false
              syncExpanded()
            }}
            onFocus={() => {
              pointer.current.focused = true
              syncExpanded()
            }}
            onBlur={(event) => {
              pointer.current.focused = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
              syncExpanded()
            }}
          >
            <div
              className={cn(
                'sandbox-composer-user-stack',
                visualExpanded && 'is-expanded',
                overflowMotion === 'expanding' && 'is-overflow-expanding',
                overflowMotion === 'collapsing' && 'is-overflow-collapsing',
              )}
              style={vars({
                '--sandbox-user-stack-collapsed-width': `${layoutMetrics.collapsedWidth}px`,
                '--sandbox-user-stack-expanded-width': `${layoutMetrics.expandedWidth}px`,
              })}
            >
              {senders.map((sender, index) => {
                const active = sender.id === operatorId
                const label = sender.kind === 'bot' ? `${sender.name}（${t('sandbox.kind.bot')}）` : sender.name
                return (
                  <Tooltip key={sender.id}>
                    {/* Tooltip 挂在外层定位节点，ContextMenu 直接绑定内部按钮，两者的锚点互不干扰。 */}
                    <TooltipTrigger render={(
                      <span
                        className={cn('sandbox-composer-user-switch', index > 0 && 'is-overlapped', isCollapsedExtra(index) && 'is-collapsed-extra')}
                        aria-hidden={isCollapsedHidden(index) || undefined}
                        style={vars({
                          '--sandbox-user-collapsed-right': `${(isCollapsedExtra(index) ? metrics.collapsedVisibleCount : index) * USER_STACK_COLLAPSED_STEP}px`,
                          '--sandbox-user-expanded-right': `${index * USER_STACK_EXPANDED_STEP}px`,
                          zIndex: senders.length - index,
                        })}
                      />
                    )}>
                      <ContextMenu>
                        <ContextMenuTrigger render={(
                          <button
                            type="button"
                            className="sandbox-composer-user-button"
                            aria-pressed={active}
                            aria-label={t(active ? 'sandbox.composer.currentSender' : 'sandbox.composer.switchSender', { name: label })}
                            tabIndex={isCollapsedHidden(index) ? -1 : undefined}
                            onClick={() => void switchOperator(sender.id)}
                          />
                        )}>
                          <SandboxAvatar kind={sender.kind} name={sender.name} src={sender.avatar} badge={false} className="sandbox-composer-user-avatar" />
                        </ContextMenuTrigger>
                        <ContextMenuContent className="sandbox-glass">
                          <ContextMenuItem onClick={() => dialogs.openProfile(sender.id)}>
                            <IdCardIcon />{t('sandbox.menu.profile')}
                          </ContextMenuItem>
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
                )
              })}
              {hasOverflow && (
                <span
                  className="sandbox-composer-user-overflow"
                  aria-hidden
                  style={vars({
                    '--sandbox-user-overflow-right': `${metrics.collapsedVisibleCount * USER_STACK_COLLAPSED_STEP}px`,
                    '--sandbox-user-overflow-expanded-right': `${metrics.collapsedVisibleCount * USER_STACK_EXPANDED_STEP}px`,
                    '--sandbox-user-overflow-z-index': `${senders.length - metrics.collapsedVisibleCount - (coveredByExpanded ? 1 : 0)}`,
                  })}
                >
                  {overflowPreview && (
                    <SandboxAvatar kind={overflowPreview.kind} name={overflowPreview.name} src={overflowPreview.avatar} badge={false} className="sandbox-composer-user-overflow-avatar" />
                  )}
                  <span className="sandbox-composer-user-overflow-label">
                    <span className="sandbox-composer-user-overflow-plus">+</span>
                    <span className="sandbox-composer-user-overflow-count">{metrics.overflowCount}</span>
                  </span>
                </span>
              )}
              <CreateEntityPopover
                type="participant"
                side="top"
                onOpenChange={(open) => {
                  pointer.current.creating = open
                  syncExpanded()
                }}
                trigger={(
                  <button
                    type="button"
                    className={cn('sandbox-composer-user-add', hasOverflow && !visualExpanded && 'is-collapsed-hidden')}
                    style={vars({
                      '--sandbox-user-add-collapsed-right': `${layoutMetrics.addCollapsedRight}px`,
                      '--sandbox-user-add-expanded-right': `${layoutMetrics.addExpandedRight}px`,
                    })}
                    aria-label={t('sandbox.composer.addAccount')}
                  >
                    <PlusIcon className="size-[18px]" strokeWidth={2} aria-hidden />
                  </button>
                )}
              />
            </div>
          </div>
        </div>
        <div className="sandbox-composer-main">
          {host.isEmpty.value && <span aria-hidden className="sandbox-composer-placeholder">{t('sandbox.composer.placeholder')}</span>}
          <div
            ref={editor}
            role="textbox"
            aria-multiline="true"
            aria-label={t('sandbox.composer.input')}
            aria-disabled={disabled || undefined}
            contentEditable={!disabled}
            suppressContentEditableWarning
            className="sandbox-composer-editor"
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
            <div className="sandbox-glass absolute right-0 bottom-[calc(100%+8px)] left-0 z-30 flex max-h-[220px] flex-col gap-0.5 overflow-y-auto rounded-[14px] bg-popover p-1.5 text-popover-foreground shadow-popup ring-1 ring-border" role="listbox" aria-label={t('sandbox.composer.mention')}>
              {mentionList.map((candidate, index) => (
                <button
                  key={candidate.id}
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  className={cn('flex min-w-0 items-center gap-2 rounded-[10px] px-2 py-1.5 text-left hover:bg-accent', index === mentionIndex && 'bg-accent')}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    host.selectMentionCandidate(candidate)
                  }}
                  onMouseEnter={() => host.setMentionSelection(index)}
                >
                  <SandboxAvatar kind={candidate.kind} name={candidate.name} src={candidate.avatar} className="size-7" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="truncate text-[13px] leading-4 font-semibold">{candidate.name}</strong>
                    <small className="truncate text-[11px] leading-[14px] text-muted-foreground">{candidate.id}</small>
                  </span>
                </button>
              ))}
              {!mentionList.length && <p className="px-2 py-2.5 text-center text-xs text-muted-foreground">{t('sandbox.composer.noMention')}</p>}
            </div>
          )}
        </div>
        <input ref={fileInput} type="file" multiple accept={ACCEPT} className="sr-only" onChange={(event) => {
          if (event.target.files) addFiles(Array.from(event.target.files))
          event.target.value = ''
        }} />
        <button type="button" className="sandbox-composer-action" aria-label={t('sandbox.composer.attach')} disabled={disabled} onClick={() => fileInput.current?.click()}>
          <PaperclipIcon className="size-[19px]" strokeWidth={2} aria-hidden />
        </button>
        <button type="submit" className="sandbox-composer-action is-primary" aria-label={t('sandbox.composer.send')} disabled={disabled || (host.isEmpty.value && !attachments.length)}>
          <SendIcon className="size-[19px]" strokeWidth={2} aria-hidden />
        </button>
      </form>
    </div>
  )
})
