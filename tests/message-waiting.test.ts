import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { MessageList, type MessageListProps } from '../client/chat/message-list'
import { SandboxProvider, type SandboxDialogs } from '../client/workspace/context'
import { WorkspaceStore } from '../client/workspace/store'
import type { SandboxChatLunaState, SandboxMessage } from '../src/types'
import { workspaceFor } from './helpers/workspace'

// 保留消息和触发器结构；未打开的菜单不渲染，也不依赖宿主 Portal。
vi.mock('@chatluna/ui-kit', async () => {
  const { createElement, cloneElement, Fragment } = await import('react')
  const Container = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children)
  const Trigger = ({ render, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => render
    ? cloneElement(render, {}, children)
    : createElement(Fragment, null, children)
  return {
    cn: (...classes: unknown[]) => classes.filter((value) => typeof value === 'string').join(' '),
    ContextMenu: Container,
    ContextMenuContent: () => null,
    ContextMenuTrigger: Trigger,
    ContextMenuItem: Container,
    ContextMenuSeparator: () => null,
    ContextMenuSub: Container,
    ContextMenuSubContent: () => null,
    ContextMenuSubTrigger: Container,
    Tooltip: Container,
    TooltipTrigger: Trigger,
    TooltipContent: () => null,
  }
})
vi.mock('@chatluna/ui-client/client', () => ({ callAction: vi.fn(), toast: { error: vi.fn() } }))
vi.mock('@chatluna/ui-storage', () => ({ readStored: () => undefined, writeStored: vi.fn() }))
vi.mock('../client/i18n', () => ({ useT: () => (key: string) => key }))

function message(id: string, authorId = '20001'): SandboxMessage {
  return { id, authorId, conversationId: 'group:30001', content: id, createdAt: '2026-01-01T00:00:00.000Z' }
}

function waiting(botParticipantId = '20001'): SandboxChatLunaState {
  return { botParticipantId, conversationId: 'group:30001', thinking: true, updatedAt: '2026-01-01T00:00:01.000Z' }
}

function renderMessages(messages: SandboxMessage[], chatLunaStates = [waiting()], options: Partial<MessageListProps> = {}) {
  const store = new WorkspaceStore(undefined)
  store.seed(workspaceFor())
  store.selectConversation('group:30001')
  const dialogs: SandboxDialogs = {
    openEntity: vi.fn(), openProfile: vi.fn(), openGroupProfile: vi.fn(), openRemark: vi.fn(),
    openGroupAction: vi.fn(), openConversationRename: vi.fn(),
  }
  const props: MessageListProps = {
    messages, chatLunaStates, replyMessages: {}, forwardPreviews: {}, capabilities: {}, friendMenuStates: {},
    hasMoreMessages: false, scrollKey: 'group:30001', selectionMode: false, selectedIds: [],
    onReply() {}, onBranch() {}, onRecall() {}, onReact() {}, onOpenReactionPicker() {}, onEnterSelection() {},
    onToggleSelection() {}, onOpenForward() {}, onOpenImage() {}, onLoadHistory: async () => {}, onClearConversation() {}, onMention() {},
    ...options,
  }
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SandboxProvider, {
    store, dialogs, children: createElement(MessageList, props),
  })))
  return Array.from(html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g), ([, attributes, body]) => ({ attributes, body }))
}

describe('等待气泡接续消息簇', () => {
  it('尚无回复时显示独立的机器人头像和昵称', () => {
    const rows = renderMessages([])
    expect(rows).toHaveLength(1)
    expect(rows[0].attributes).not.toContain('is-merged')
    expect(rows[0].body).toContain('sandbox-message-sender-line')
    expect(rows[0].body).toContain('sandbox.chat.thinking')
  })

  it('发出首条回复后，等待气泡接在消息簇末尾，不重复昵称', () => {
    const rows = renderMessages([message('首条回复')])
    expect(rows).toHaveLength(2)
    expect(rows[0].attributes).toContain('is-cluster-first')
    expect(rows[1].attributes).toContain('is-cluster-last')
    expect(rows[1].attributes).toContain('is-merged')
    expect(rows[1].body).not.toContain('sandbox-message-sender-line')
    expect(rows[1].body).toContain('sandbox.chat.thinking')
  })

  it('多段文字和图片之后仍接续同一消息簇', () => {
    const image: SandboxMessage = {
      ...message('图片'), content: '[图片] example.png',
      media: [{ id: 'image', type: 'image', name: 'example.png', mimeType: 'image/png', size: 1, reference: 'image.bin' }],
    }
    const rows = renderMessages([message('首条回复'), message('第二条回复'), image])
    expect(rows[0].attributes).toContain('is-cluster-first')
    expect(rows[1].attributes).toContain('is-cluster-middle')
    expect(rows[3].attributes).toContain('is-cluster-last')
    expect(rows[3].attributes).toContain('is-merged')
    expect(rows[3].body).not.toContain('sandbox-message-sender-line')
  })

  it.each(['10001', '20002'])('不跨过其他发送者 %s 的消息合并', (authorId) => {
    const rows = renderMessages([message('机器人回复'), message('插话', authorId)])
    expect(rows[0].attributes).not.toContain('is-cluster')
    expect(rows[2].attributes).not.toContain('is-merged')
    expect(rows[2].body).toContain('sandbox-message-sender-line')
  })

  it('系统事件打断等待气泡与前一条回复的合并', () => {
    const event: SandboxMessage = { ...message('戳一戳'), event: { type: 'poke', targetId: '10001' } }
    const rows = renderMessages([message('机器人回复'), event])
    expect(rows[0].attributes).not.toContain('is-cluster')
    expect(rows[2].attributes).not.toContain('is-merged')
    expect(rows[2].body).toContain('sandbox-message-sender-line')
  })

  it('继承消息与当前会话的等待气泡不跨会话合并', () => {
    const rows = renderMessages([{ ...message('继承回复'), conversationId: 'group:parent' }])
    expect(rows[0].attributes).not.toContain('is-cluster')
    expect(rows[1].attributes).not.toContain('is-merged')
    expect(rows[1].body).toContain('sandbox-message-sender-line')
  })

  it('多个机器人等待时按实际相邻关系分组', () => {
    const rows = renderMessages([message('机器人回复')], [waiting(), waiting('20002')])
    expect(rows[1].attributes).toContain('is-merged')
    expect(rows[1].attributes).toContain('is-cluster-last')
    expect(rows[2].attributes).not.toContain('is-merged')
    expect(rows[2].body).toContain('sandbox-message-sender-line')

    const interrupted = renderMessages([message('机器人回复')], [waiting('20002'), waiting()])
    expect(interrupted.every(({ attributes }) => !attributes.includes('is-merged'))).toBe(true)
  })

  it('多选模式仍保留等待气泡的接续布局', () => {
    const rows = renderMessages([message('机器人回复')], [waiting()], { selectionMode: true })
    expect(rows).toHaveLength(2)
    expect(rows[1].attributes).toContain('is-merged')
    expect(rows[1].body).not.toContain('sandbox-message-sender-line')
  })

  it('等待结束后，末条真实回复恢复消息簇尾部圆角', () => {
    const rows = renderMessages([message('首条回复'), message('第二条回复')], [{ ...waiting(), thinking: false }])
    expect(rows).toHaveLength(2)
    expect(rows[0].attributes).toContain('is-cluster-first')
    expect(rows[1].attributes).toContain('is-cluster-last')
    expect(rows.every(({ body }) => !body.includes('sandbox.chat.thinking'))).toBe(true)
    const single = renderMessages([message('唯一回复')], [])
    expect(single[0].attributes).not.toContain('is-cluster')
  })
})
