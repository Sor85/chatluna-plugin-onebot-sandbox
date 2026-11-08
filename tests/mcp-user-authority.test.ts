import { afterEach, describe, expect, it } from 'vitest'
import { createMcpTestService, stopMcpTestApps } from './helpers/mcp-service-harness'
import type { SandboxSnapshot } from '../src/types'
import { SandboxTestSpaceService } from '../src/test-spaces'
import { SandboxMcpService } from '../src/mcp/service'
import { join } from 'node:path'

afterEach(stopMcpTestApps)

async function setup(allowToolPermissionEditing = false) {
  const host = createMcpTestService(['read', 'manage'], true, { allowToolPermissionEditing })
  const { service, credential, testSpaces } = host
  const { spaceId } = await service.callTool(credential.token, 'create_test_space', { idempotencyKey: 'permission-space' }) as { spaceId: string }
  const control = testSpaces.getControl(spaceId)
  // 通过与 WebUI 相同的领域入口准备身份，不给工具隐式授权。
  control.createUser({ id: '11001', name: '权限测试用户', authority: 1 })
  let sequence = 0
  const edit = (data: Record<string, unknown>, transport: 'mcp' | 'http' | 'chatluna' = 'mcp', action = 'update-user') => {
    const args = {
      spaceId, expectedRevision: control.getSnapshot().revision, idempotencyKey: `permission-${++sequence}`,
      changes: [{ action, data }],
      // 请求参数不能开启服务端的安全开关。
      allowToolPermissionEditing: true,
    }
    return transport === 'chatluna'
      ? service.createInternalCaller({ id: 'permission-test', name: '测试机器人', scopes: ['manage'], transport }).callTool('apply_environment_changes', args)
      : service.callTool(credential.token, 'apply_environment_changes', args, { transport })
  }
  const importScene = async (scene: SandboxSnapshot) => {
    const args = { spaceId, document: { testApiVersion: 1, scene } }
    const { confirmationToken } = await service.callTool(credential.token, 'prepare_destructive_action', {
      spaceId, expectedRevision: control.getSnapshot().revision, tool: 'import_scene', arguments: args,
    }) as { confirmationToken: string }
    return service.callTool(credential.token, 'import_scene', { ...args, confirmationToken })
  }
  return { ...host, spaceId, control, edit, importScene }
}

describe('工具修改用户权限的独立开关', () => {
  it.each(['mcp', 'http', 'chatluna'] as const)('默认拒绝 %s 修改等级，manage 范围不等于提权许可', async (transport) => {
    const { control, edit, service } = await setup()
    const before = control.getSnapshot()
    for (const authority of [0, 4, null]) {
      await expect(edit({ id: '11001', name: '不应保存', authority }, transport)).rejects.toMatchObject({ code: 'permission_denied' })
      expect(control.getSnapshot()).toEqual(before)
    }
    await expect(edit({ id: '11002', name: '高权用户', authority: 5 }, transport, 'create-user')).rejects.toMatchObject({ code: 'permission_denied' })
    expect(control.getSnapshot()).toEqual(before)
    expect(service.listCallRecords({ transport }).records.some(({ id }) => service.getCallRecord(id).error?.code === 'permission_denied')).toBe(true)
  })

  it('开关关闭时仍能改昵称、创建普通用户，WebUI 入口仍可分配等级', async () => {
    const { control, edit } = await setup()
    await edit({ id: '11001', name: '新昵称' })
    expect(control.getSnapshot().participants[0]).toMatchObject({ name: '新昵称', authority: 1 })
    await edit({ id: '11002', name: '普通用户' }, 'mcp', 'create-user')
    expect(control.getSnapshot().participants[1]).not.toHaveProperty('authority')
    control.updateUser({ id: '11001', name: '手动分配', authority: 4 })
    expect(control.getSnapshot().participants[0]).toMatchObject({ authority: 4 })
  })

  it.each(['mcp', 'http', 'chatluna'] as const)('显式开启后 %s 可赋值、保留与清除等级', async (transport) => {
    const { control, edit } = await setup(true)
    await edit({ id: '11001', name: '授权用户', authority: 4 }, transport)
    await edit({ id: '11001', name: '保留等级' }, transport)
    expect(control.getSnapshot().participants[0]).toMatchObject({ authority: 4 })
    await edit({ id: '11001', name: '清除等级', authority: null }, transport)
    expect(control.getSnapshot().participants[0]).not.toHaveProperty('authority')
    await edit({ id: '11002', name: '禁用用户', authority: 0 }, transport, 'create-user')
    expect(control.getSnapshot().participants[1]).toMatchObject({ authority: 0 })
  })

  it('批量操作中夹带权限修改时整批不提交', async () => {
    const { service, credential, control, spaceId } = await setup()
    const before = control.getSnapshot()
    await expect(service.callTool(credential.token, 'apply_environment_changes', {
      spaceId, expectedRevision: before.revision, idempotencyKey: 'mixed-permission',
      changes: [
        { action: 'create-user', data: { id: '11002', name: '不应创建' } },
        { action: 'update-user', data: { id: '11001', name: '不应保存', authority: 5 } },
      ],
    })).rejects.toMatchObject({ code: 'permission_denied' })
    expect(control.getSnapshot()).toEqual(before)
  })

  it('场景导入不能绕过开关，包括清除原有等级和导入新高权用户', async () => {
    const { control, importScene } = await setup()
    const before = control.getSnapshot()
    for (const authority of [5, undefined] as const) {
      const scene = control.getSnapshot()
      const user = scene.participants[0]
      if (user.kind === 'user') user.authority = authority
      await expect(importScene(scene)).rejects.toMatchObject({ code: 'permission_denied' })
      expect(control.getSnapshot()).toEqual(before)
    }
    const scene = control.getSnapshot()
    scene.participants.push({ kind: 'user', id: '11003', name: '导入用户', authority: 5 })
    await expect(importScene(scene)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(importScene(before)).resolves.toHaveProperty('revision')
  })

  it('重置已恢复的空间不能恢复旧快照中的高等级', async () => {
    const { app, control, runtimeBots, directory } = await setup()
    const scene = control.getSnapshot()
    if (scene.participants[0].kind === 'user') scene.participants[0].authority = 5
    const testSpaces = new SandboxTestSpaceService(app, runtimeBots, {
      loadAll: async () => [{ id: 'restored', name: '已恢复空间', status: 'running', createdAt: '', updatedAt: '', scene }],
      save: async () => {}, delete: async () => {},
    })
    const service = new SandboxMcpService(app, control, { testSpaces, dataDirectory: join(directory, 'restored') })
    const credential = service.createCredential('测试凭证', ['manage'])
    await app.start()
    const restored = testSpaces.getControl('restored')
    restored.updateUser({ id: '11001', name: '已降权用户', authority: 1 })
    const before = restored.getSnapshot()
    const args = { spaceId: 'restored' }
    const { confirmationToken } = await service.callTool(credential.token, 'prepare_destructive_action', {
      ...args, tool: 'reset_scene', expectedRevision: before.revision, arguments: args,
    }) as { confirmationToken: string }
    await expect(service.callTool(credential.token, 'reset_scene', { ...args, confirmationToken })).rejects.toMatchObject({ code: 'permission_denied' })
    expect(restored.getSnapshot()).toEqual(before)
  })

  it('开启后可导入等级，非法等级仍拒绝且不污染快照', async () => {
    const { control, edit, importScene } = await setup(true)
    const before = control.getSnapshot()
    await expect(edit({ id: '11001', name: '非法等级', authority: 6 })).rejects.toMatchObject({ code: 'domain_error' })
    expect(control.getSnapshot()).toEqual(before)
    const scene = control.getSnapshot()
    if (scene.participants[0].kind === 'user') scene.participants[0].authority = 5
    await importScene(scene)
    expect(control.getSnapshot().participants[0]).toMatchObject({ authority: 5 })
  })
})
