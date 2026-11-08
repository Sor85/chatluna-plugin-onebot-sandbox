import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerConsole, type SandboxConsoleRegistrar } from '../src/console'
import type { SandboxConsoleEvents } from '../src/console-contract'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxTestSpaceService } from '../src/test-spaces'
import { App } from './helpers/app'
import { workspaceFor } from './helpers/workspace'

const apps: App[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.stop())))

async function createSandbox() {
  const app = new App()
  apps.push(app)
  app.baseDir = mkdtempSync(join(tmpdir(), 'sandbox-card-edit-'))
  await app.ready()
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { runtimeBots, mediaDirectory: join(app.baseDir, 'media') })
  const spaces = new SandboxTestSpaceService(app, runtimeBots)
  const listeners: Partial<SandboxConsoleEvents> = {}
  const registrar: SandboxConsoleRegistrar = {
    addEntry() {},
    addListener(event, callback) { Object.assign(listeners, { [event]: callback }) },
    broadcast() {},
  }
  registerConsole(registrar, control, workspaceFor().appearance, undefined, spaces)
  await app.start()
  const manage = listeners['onebot-sandbox.manage-environment']!
  return { control, spaces, manage }
}

describe('Sandbox 群名片环境编辑', () => {
  it('只修改目标名片，保留最新群资料、成员角色和账户昵称，支持清空', async () => {
    const { control, manage } = await createSandbox()
    const group = control.getSnapshot().groups[0]!
    control.updateGroup({
      ...group,
      name: '刚更新的群名称',
      members: group.members.map((member) => member.participantId === '10001'
        ? { ...member, card: '旧名片', title: '保留头衔', mutedUntil: '2099-01-01T00:00:00.000Z', cardChangeable: false }
        : member),
    })
    const before = control.getSnapshot()
    await manage({ action: 'set-group-card', data: { groupId: '30001', targetId: '10001', card: '  Sandbox 名片  ' } })
    const after = control.getSnapshot()
    expect(after.groups).toEqual(before.groups.map((current) => ({
      ...current, members: current.members.map((member) => member.participantId === '10001' ? { ...member, card: 'Sandbox 名片' } : member),
    })))
    expect(after.participants).toEqual(before.participants)
    expect(after.messages).toEqual(before.messages)

    await manage({ action: 'set-group-card', data: { groupId: '30001', targetId: '10001', card: '   ' } })
    expect(control.getSnapshot().groups[0]!.members.find(({ participantId }) => participantId === '10001')?.card).toBeUndefined()
  })

  it('修改测试空间名片必须先接管，不影响主环境同号群', async () => {
    const { control, spaces, manage } = await createSandbox()
    const before = control.getSnapshot()
    const space = spaces.createSpace({ name: '群名片验证' })
    const scoped = spaces.getControl(space.id)
    scoped.createUser({ id: '10001', name: '空间用户' })
    scoped.createGroup({ id: '30001', name: '空间群', members: [{ participantId: '10001', role: 'owner' }] })
    const input = { spaceId: space.id, action: 'set-group-card' as const, data: { groupId: '30001', targetId: '10001', card: '空间名片' } }
    await expect(manage(input)).rejects.toThrow('请先接管测试空间')
    spaces.takeOver(space.id)
    await manage(input)
    expect(scoped.getSnapshot().groups[0]!.members[0]!.card).toBe('空间名片')
    expect(control.getSnapshot()).toEqual(before)
    spaces.returnControl(space.id)
    await expect(manage({ ...input, data: { ...input.data, card: '不能再改' } })).rejects.toThrow('请先接管测试空间')
    expect(scoped.getSnapshot().groups[0]!.members[0]!.card).toBe('空间名片')
  })

  it('群或目标成员已不存在时拒绝保存，不重新创建成员', async () => {
    const { control, manage } = await createSandbox()
    const group = control.getSnapshot().groups[0]!
    control.updateGroup({ ...group, members: group.members.filter(({ participantId }) => participantId !== '10003') })
    const before = control.getSnapshot()
    await expect(manage({ action: 'set-group-card', data: { groupId: '30001', targetId: '10003', card: '退群后修改' } })).rejects.toThrow('群成员不存在')
    await expect(manage({ action: 'set-group-card', data: { groupId: '39999', targetId: '10001', card: '不存在的群' } })).rejects.toThrow('群组不存在')
    expect(control.getSnapshot()).toEqual(before)
  })

  it('普通群操作和 OneBot action 仍不能越权修改他人名片', async () => {
    const { control, manage } = await createSandbox()
    const group = control.getSnapshot().groups[0]!
    control.updateGroup({ ...group, members: group.members.map((member) => member.participantId === '20001' ? { ...member, role: 'member' } : member) })
    await expect(control.performGroupAction({ action: 'set-card', operatorId: '10003', groupId: '30001', targetId: '10001', card: '越权名片' })).rejects.toThrow()
    await expect(control.bot.internal._request('set_group_card', { group_id: 30001, user_id: 10001, card: '越权名片' })).rejects.toThrow()
    await manage({ action: 'set-group-card', data: { groupId: '30001', targetId: '10001', card: 'Sandbox 编辑' } })
    expect(control.getSnapshot().groups[0]!.members[0]!.card).toBe('Sandbox 编辑')
  })
})
