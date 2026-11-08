import { createElement, Fragment, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../client/chat/composer'
import { MessageList, type MessageListProps } from '../client/chat/message-list'
import { SandboxProvider, type SandboxDialogs } from '../client/workspace/context'
import { WorkspaceStore } from '../client/workspace/store'
import { workspaceFor } from './helpers/workspace'

const { menuItems } = vi.hoisted(() => ({ menuItems: [] as Array<{ children?: ReactNode; onClick?: () => void }> }))

// 菜单 Portal 与触发器换成可在服务端展开的容器，只收集实际组件传入的菜单回调；
// 工作区派生、参与者判定与菜单内容使用真实实现，不依赖浏览器布局或鼠标事件合成。
vi.mock('@chatluna/ui-kit', async () => {
  const { createElement, cloneElement, Fragment } = await import('react')
  const Container = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children)
  const Trigger = ({ render, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => render
    ? cloneElement(render, {}, children)
    : createElement(Fragment, null, children)
  return {
    cn: (...classes: unknown[]) => classes.filter((value) => typeof value === 'string').join(' '),
    ContextMenu: ({ disabled, children }: { disabled?: boolean; children?: ReactNode }) => disabled ? null : createElement(Fragment, null, children),
    ContextMenuContent: Container,
    ContextMenuTrigger: Trigger,
    ContextMenuItem: (props: { children?: ReactNode; onClick?: () => void }) => { menuItems.push(props); return createElement(Fragment, null, props.children) },
    ContextMenuSeparator: () => null,
    ContextMenuSub: Container,
    ContextMenuSubContent: Container,
    ContextMenuSubTrigger: Container,
    Tooltip: Container,
    TooltipTrigger: Trigger,
    TooltipContent: () => null,
  }
})
vi.mock('@chatluna/ui-client/client', () => ({ callAction: vi.fn(), toast: { error: vi.fn() } }))
vi.mock('@chatluna/ui-storage', () => ({ readStored: () => undefined, writeStored: vi.fn() }))
vi.mock('../client/i18n', () => ({ useT: () => (key: string, params?: object) => `${key}${params ? JSON.stringify(params) : ''}` }))
vi.mock('../client/environment/create-popover', () => ({ CreateEntityPopover: () => null }))

beforeEach(() => { menuItems.length = 0 })

function renderInWorkspace(element: ReactElement) {
  const store = new WorkspaceStore(undefined)
  store.seed(workspaceFor())
  store.selectConversation('group:30001')
  const dialogs: SandboxDialogs = {
    openEntity: vi.fn(), openProfile: vi.fn(), openGroupProfile: vi.fn(), openRemark: vi.fn(),
    openGroupAction: vi.fn(), openConversationRename: vi.fn(),
  }
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SandboxProvider, { store, dialogs, children: element })))
  return { store, dialogs }
}

function items(key: string) {
  return menuItems.filter(({ children }) => renderToStaticMarkup(createElement(Fragment, null, children)).includes(key))
}

function messageProps(authorIds = ['10001', '10003', '20001']): MessageListProps {
  return {
    messages: authorIds.map((authorId, index) => ({
      id: `m${index}`, authorId, conversationId: 'group:30001', content: '测试消息', createdAt: '2026-01-01T00:00:00.000Z',
    })),
    chatLunaStates: [], replyMessages: {}, forwardPreviews: {}, capabilities: {}, friendMenuStates: {},
    hasMoreMessages: false, scrollKey: 'group:30001', selectionMode: false, selectedIds: [],
    onReply() {}, onBranch() {}, onRecall() {}, onReact() {}, onOpenReactionPicker() {}, onEnterSelection() {},
    onToggleSelection() {}, onOpenForward() {}, onOpenImage() {}, onLoadHistory: async () => {}, onClearConversation() {}, onMention() {},
  }
}

describe('聊天头像菜单入口', () => {
  it('发送框每个用户和机器人的菜单都能查看对应资料，且不切换发送者', () => {
    const { store, dialogs } = renderInWorkspace(createElement(Composer, { mentionCandidates: [], onClearReply() {}, onSend: async () => {} }))
    const profiles = items('sandbox.menu.profile')
    expect(profiles).toHaveLength(4)
    for (const item of profiles) item.onClick?.()
    expect(dialogs.openProfile).toHaveBeenCalledTimes(4)
    for (const id of ['10001', '10003', '20001', '20002']) expect(dialogs.openProfile).toHaveBeenCalledWith(id)
    expect(store.getView().currentOperatorId).toBe('10001')
    expect(items('sandbox.menu.editEntity')).toHaveLength(4)
    expect(items('sandbox.menu.deleteEntity')).toHaveLength(4)
  })

  it('消息头像能编辑自己的用户、其他用户和机器人，目标类型与作者一致', () => {
    const { dialogs } = renderInWorkspace(createElement(MessageList, messageProps()))
    const edits = items('sandbox.menu.editEntity')
    expect(edits).toHaveLength(3)
    for (const item of edits) item.onClick?.()
    expect(dialogs.openEntity).toHaveBeenNthCalledWith(1, 'edit', { type: 'user', id: '10001' })
    expect(dialogs.openEntity).toHaveBeenNthCalledWith(2, 'edit', { type: 'user', id: '10003' })
    expect(dialogs.openEntity).toHaveBeenNthCalledWith(3, 'edit', { type: 'bot', id: '20001' })
    expect(items('sandbox.menu.profile')).toHaveLength(3)
  })

  it('不存在的作者不提供编辑入口，多选模式不打开头像菜单', () => {
    renderInWorkspace(createElement(MessageList, messageProps(['missing'])))
    expect(items('sandbox.menu.editEntity')).toHaveLength(0)
    menuItems.length = 0
    renderInWorkspace(createElement(MessageList, { ...messageProps(), selectionMode: true }))
    expect(items('sandbox.menu.editEntity')).toHaveLength(0)
    expect(items('sandbox.menu.profile')).toHaveLength(0)
  })
})
