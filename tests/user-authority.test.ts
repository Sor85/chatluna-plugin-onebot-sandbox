import Permissions, { type Subject } from '@chatluna/permission'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './helpers/app'
import { createDefaultScene, SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { Config } from '../src'
import { normalizeUserAuthority } from '../src/user-authority'
import type { SandboxSnapshot, SandboxUserAuthority } from '../src/types'

const apps: App[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.stop())) })

async function createControl(initialScene?: SandboxSnapshot) {
  const app = new App()
  apps.push(app)
  await app.ready()
  const permissionFiber = app.plugin(Permissions, Permissions.Config({}))
  await permissionFiber
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { initialScene, runtimeBots })
  await app.start()
  const permissions = app.get('permissions')!
  return { app, control, permissions, permissionFiber, runtimeBots }
}

const subject: Subject = { platform: 'onebot', selfId: '20001', user: '10001', channel: '30001', guild: '30001' }
const userOf = (control: SandboxControlService, id = '10001') => control.getSnapshot().participants.find((user) => user.kind === 'user' && user.id === id)

function sceneWithAuthority(authority: SandboxUserAuthority) {
  const scene = createDefaultScene()
  const user = scene.participants.find((participant) => participant.kind === 'user' && participant.id === '10001')!
  if (user.kind === 'user') user.authority = authority
  return scene
}

describe('沙盒用户权限数据', () => {
  it('默认不授权工具编辑，旧用户继续沿用宿主权限', async () => {
    expect(Config({}).allowToolPermissionEditing).toBe(false)
    const { control, permissions } = await createControl()
    expect(userOf(control)).not.toHaveProperty('authority')
    expect(await permissions.levelOf(subject)).toBe(2)
    expect(permissions.rules().filter(({ source }) => source === 'onebot-sandbox')).toEqual([])
  })

  it('创建、编辑、省略保留与清除等级不改变 QQ 等级或群身份', async () => {
    const { control } = await createControl()
    control.createUser({ id: '10099', name: '权限测试用户', authority: 0, profile: { level: 64 } })
    expect(userOf(control, '10099')).toMatchObject({ authority: 0, profile: { level: 64 } })
    control.updateUser({ id: '10099', name: '改名用户', authority: 4 })
    control.updateUser({ id: '10099', name: '再次改名' })
    expect(userOf(control, '10099')).toMatchObject({ authority: 4, profile: { level: 64 } })
    control.updateUser({ id: '10099', name: '恢复默认', authority: null })
    expect(userOf(control, '10099')).not.toHaveProperty('authority')
    expect(control.getSnapshot().groups[0]?.members.find(({ participantId }) => participantId === '10001')?.role).toBe('owner')
  })

  it.each([-1, 6, 1.5, NaN, Infinity, '4', true, {}, []])('拒绝非法等级 %j', (value) => {
    expect(() => normalizeUserAuthority(value)).toThrow('用户权限等级必须是 0 到 5 的整数')
  })

  it('非法创建、更新和场景导入不提交半成品', async () => {
    const { control } = await createControl()
    const before = control.getSnapshot()
    // 模拟越过 TypeScript 的 RPC/JSON 输入。
    const invalid = JSON.parse('{"id":"10001","name":"不应保存","authority":6}')
    expect(() => control.updateUser(invalid)).toThrow(/权限等级/)
    expect(() => control.createUser({ ...invalid, id: '10099' })).toThrow(/权限等级/)
    const snapshot = JSON.parse(JSON.stringify(before))
    snapshot.participants[0].authority = 1.5
    expect(() => control.replaceScene(snapshot)).toThrow(/权限等级/)
    expect(control.getSnapshot()).toEqual(before)
  })

  it('等级随场景导出、恢复，重置恢复初始值', async () => {
    const { control } = await createControl(sceneWithAuthority(4))
    control.updateUser({ id: '10001', name: '权限用户', authority: 1 })
    const { control: restored, permissions } = await createControl(control.getSnapshot())
    expect(userOf(restored)).toMatchObject({ authority: 1 })
    expect(await permissions.levelOf(subject)).toBe(1)
    control.resetScene()
    expect(userOf(control)).toMatchObject({ authority: 4 })
  })
})

describe('真实 ChatLuna 工具权限门禁', () => {
  it('模型工具事件读取已分配等级，不需要 Koishi user 行', async () => {
    const { app, control } = await createControl()
    const request = { name: 'exec', tool: 'permission-test', speakers: [{ user: '10001', addressed: true as const }], location: { platform: 'onebot', selfId: '20001', channel: '30001', guild: '30001' } }
    expect(await app.serial('chatluna/tool-authorize', request)).toMatchObject({ ok: false })
    control.updateUser({ id: '10001', name: '权限用户', authority: 4 })
    expect(await app.serial('chatluna/tool-authorize', request)).toMatchObject({ ok: true, actor: { user: '10001' } })
    control.updateUser({ id: '10001', name: '权限用户', authority: 1 })
    expect(await app.serial('chatluna/tool-authorize', request)).toMatchObject({ ok: false })
    expect(app.get('database')).toBeUndefined()
  })

  it.each([0, 1, 2, 3, 4, 5] as const)('%i 级精确生效，不被宿主默认等级抬高', async (authority) => {
    const { control, permissions } = await createControl()
    // 自定义档位而不用 v2 内置的 `exec`：内置权限的默认档位随宿主版本调整，这里只验证等级逐档落到 allow/ask/deny。
    permissions.define('sandbox-test:tiered', { allow: 4, ask: 3 })
    control.updateUser({ id: '10001', name: '权限用户', authority })
    expect(await permissions.levelOf(subject)).toBe(authority)
    expect(await permissions.evaluate('sandbox-test:tiered', { subject })).toMatchObject({ level: authority, effect: authority >= 4 ? 'allow' : authority === 3 ? 'ask' : 'deny' })
  })

  it('不改全局用户等级，其他机器人、平台与用户不借用授权', async () => {
    const { control, permissions } = await createControl(sceneWithAuthority(5))
    for (const other of [{ ...subject, selfId: '90001' }, { ...subject, platform: 'telegram' }, { ...subject, user: '10002' }, { platform: 'onebot', user: '10001' }]) {
      expect(await permissions.levelOf(other)).toBe(2)
    }
    expect(permissions.saved()).toEqual([])
    const before = permissions.rules()
    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '不应重建权限规则' })
    expect(permissions.rules()).toEqual(before)
  })

  it('高等级仍遵守显式拒绝与危险操作审批，0 级拒绝显式允许', async () => {
    const { control, permissions } = await createControl(sceneWithAuthority(5))
    const remove = permissions.rule({ permission: 'exec', effect: 'deny' })
    expect(await permissions.evaluate('exec', { subject })).toMatchObject({ effect: 'deny' })
    remove()
    expect(await permissions.evaluate('exec', { subject, risk: 'critical' })).toMatchObject({ effect: 'ask' })
    permissions.rule({ permission: 'exec', effect: 'allow' })
    control.updateUser({ id: '10001', name: '权限用户', authority: 0 })
    expect(await permissions.evaluate('exec', { subject })).toMatchObject({ effect: 'deny', level: 0 })
  })

  it('机器人停用或删除后撤销授权，重新启用与新建时同步注册', async () => {
    const { control, permissions } = await createControl(sceneWithAuthority(4))
    control.updateBot({ id: '20001', name: '测试机器人', implementation: 'napcat', enabled: false })
    expect(await permissions.levelOf(subject)).toBe(2)
    control.updateBot({ id: '20001', name: '测试机器人', implementation: 'napcat', enabled: true })
    expect(await permissions.levelOf(subject)).toBe(4)
    control.deleteBot({ id: '20001' })
    expect(await permissions.levelOf(subject)).toBe(2)
    control.createBot({ id: '29001', name: '新机器人', implementation: 'napcat', enabled: true })
    expect(await permissions.levelOf({ ...subject, selfId: '29001' })).toBe(4)
  })

  it('停止、切换测试空间、删除用户和销毁控制服务时撤销对应规则', async () => {
    const { app, control, permissions, runtimeBots } = await createControl(sceneWithAuthority(4))
    const other = new SandboxControlService(app, { initialScene: sceneWithAuthority(1), runtimeBots, runtimeActive: false, scopeId: 'other' })
    await app.start()
    expect(await permissions.levelOf(subject)).toBe(4)
    control.setRuntimeActive(false)
    expect(await permissions.levelOf(subject)).toBe(2)
    other.setRuntimeActive(true)
    expect(await permissions.levelOf(subject)).toBe(1)
    other.deleteUser({ id: '10001' })
    expect(await permissions.levelOf(subject)).toBe(2)
    await other.dispose()
    control.setRuntimeActive(true)
    expect(await permissions.levelOf(subject)).toBe(4)
    await control.dispose()
    expect(await permissions.levelOf(subject)).toBe(2)
  })

  it('权限服务晚于沙盒加载时，已保存的等级仍会注册', async () => {
    const app = new App()
    apps.push(app)
    await app.ready()
    const control = new SandboxControlService(app)
    control.updateUser({ id: '10001', name: '提前设置', authority: 4 })
    await app.start()
    await app.plugin(Permissions, Permissions.Config({}))
    await app.start()
    expect(await app.get('permissions')!.levelOf(subject)).toBe(4)
  })

  it('权限服务重载后重新注册，沙盒场景与等级不丢失', async () => {
    const { app, control, permissionFiber } = await createControl(sceneWithAuthority(4))
    const before = control.getSnapshot()
    await permissionFiber.dispose()
    await app.plugin(Permissions, Permissions.Config({ authority: 1 }))
    await app.start()
    expect(await app.get('permissions')!.levelOf(subject)).toBe(4)
    expect(control.getSnapshot()).toEqual(before)
  })
})
