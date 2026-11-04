import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { registerConsole, type SandboxConsoleRegistrar } from '../src/console'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxTestSpaceService } from '../src/test-spaces'
import type { SandboxAppearance } from '../src/types'

const apps: App[] = []
const appearance: SandboxAppearance = { enableSandboxFrostedGlass: true, sandboxTimBubbleTail: true, sandboxColorMode: 'auto', sandboxAccentColor: '#2563eb', sandboxMarkRecalledMessages: true }
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.stop())))

describe('AI 测试空间 Console 适配器', () => {
  it('支持观察、接管、操作、归还和重新激活空间', async () => {
    const app = new App()
    apps.push(app)
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const control = new SandboxControlService(app, { runtimeBots })
    const spaces = new SandboxTestSpaceService(app, runtimeBots)
    const space = spaces.createSpace({ name: 'Console 空间' })
    const listeners = new Map<string, (...args: any[]) => any>()
    const registrar: SandboxConsoleRegistrar = { addEntry() {}, addListener(event, callback) { listeners.set(event, callback as never) }, broadcast() {} }
    registerConsole(registrar, control, appearance, undefined, spaces)

    expect(listeners.get('onebot-sandbox.test-spaces')?.()).toMatchObject([{ id: space.id, status: 'running' }])
    expect((await listeners.get('onebot-sandbox.workspace')?.({ spaceId: space.id })).snapshot.participants).toEqual([])
    await expect(listeners.get('onebot-sandbox.manage-environment')?.({ spaceId: space.id, action: 'create-user', data: { id: '11001', name: '用户' } })).rejects.toThrow('请先接管测试空间')

    listeners.get('onebot-sandbox.take-over-test-space')?.({ spaceId: space.id })
    const workspace = await listeners.get('onebot-sandbox.manage-environment')?.({ spaceId: space.id, action: 'create-user', data: { id: '11001', name: '用户' } })
    expect(workspace.snapshot.participants).toContainEqual(expect.objectContaining({ kind: 'user', id: '11001', name: '用户' }))
    listeners.get('onebot-sandbox.return-test-space')?.({ spaceId: space.id })
    expect(spaces.getSpace(space.id).status).toBe('running')

    expect(listeners.get('onebot-sandbox.terminate-test-space')?.({ spaceId: space.id })).toMatchObject({ status: 'completed' })
    expect(spaces.getSpace(space.id).status).toBe('completed')
  })
})
