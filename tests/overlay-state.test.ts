import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { useOverlayState, type OverlayState } from '../client/workspace/overlay-host'
import { WorkspaceStore } from '../client/workspace/store'
import { workspaceFor } from './helpers/workspace'

vi.mock('@chatluna/ui-kit', () => ({}))
vi.mock('@chatluna/ui-client/client', () => ({ callAction: vi.fn(), toast: {} }))
vi.mock('@chatluna/ui-storage', () => ({ readStored: () => undefined, writeStored: vi.fn() }))
vi.mock('../client/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('../client/environment/entity-dialog', () => ({ EntityDialog: () => null }))

function openProfile(conversationId: string) {
  const workspace = workspaceFor()
  Object.assign(workspace.snapshot.groups[0].members[1], { card: '当前群名片', title: '当前群头衔' })
  workspace.snapshot.groups.push({
    id: '30002', name: '其他群', announcements: [],
    members: [{ participantId: '10003', role: 'admin', card: '其他群名片', title: '其他群头衔' }],
  })
  workspace.snapshot.conversationInstances.push(
    { id: 'group-instance', rootConversationId: 'group:30001', title: '群实例', messageIds: [] },
    { id: 'direct-instance', rootConversationId: 'private:10001:20001', title: '私聊实例', messageIds: [] },
  )
  const store = new WorkspaceStore(undefined)
  store.seed(workspace)
  store.selectConversation(conversationId)
  const before = store.getView()
  let profile: OverlayState['profile']
  // 在同一个 SSR 组件的渲染重试中读取更新后的 hook 状态，执行真实的 openProfile，不模拟其实现。
  function Probe() {
    const overlay = useOverlayState(store)
    if (!overlay.state.profile) overlay.dialogs.openProfile('10003', { x: 100, y: 200 })
    profile = overlay.state.profile
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  expect(store.getView()).toBe(before)
  expect(profile).toMatchObject({ x: 100, y: 200, card: { participantId: '10003' } })
  return profile!.card.fields.filter(({ group }) => group === 'group-member')
}

describe('资料卡的会话上下文', () => {
  it('群实例与群根会话展示相同的当前群成员资料', () => {
    const root = openProfile('group:30001')
    const instance = openProfile('group-instance')
    expect(instance).toEqual(root)
    expect(instance.map(({ value }) => value)).toEqual(['测试群', '30001', 'sandbox.role.member', '当前群名片', '当前群头衔'])
  })

  it('私聊实例与私聊根会话保留全部群资料的现行行为', () => {
    const root = openProfile('private:10001:20001')
    const instance = openProfile('direct-instance')
    expect(instance).toEqual(root)
    expect(instance.map(({ value }) => value)).toContain('其他群名片')
    expect(instance.map(({ value }) => value)).toContain('当前群名片')
  })
})
