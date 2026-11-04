import { App } from '@koishijs/core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerConsole, type SandboxConsoleRegistrar } from '../src/console'
import { SandboxControlService } from '../src/control-service'
import { SandboxPresetService } from '../src/presets'
import type { SandboxAppearance } from '../src/types'

const appearance: SandboxAppearance = {
  enableSandboxFrostedGlass: true,
  sandboxTimBubbleTail: true,
  sandboxColorMode: 'auto',
  sandboxAccentColor: '#2563eb',
  sandboxMarkRecalledMessages: true,
}

const runningApps: App[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('预设 Console RPC', () => {
  it('以 authority 4 注册 catalog/read/CRUD/locate 并委托给公开服务 interface', async () => {
    const app = new App()
    runningApps.push(app)
    const baseDir = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-console-presets-'))
    temporaryDirectories.push(baseDir)
    const control = new SandboxControlService(app)
    const presets = new SandboxPresetService({
      baseDir,
      mainModelRequests: control.getModelRequestStore(),
    })
    const listeners = new Map<string, { callback: (...args: any[]) => any, authority: number }>()
    const registrar: SandboxConsoleRegistrar = {
      addEntry() {},
      addListener(event, callback, options) {
        listeners.set(event, { callback, authority: options.authority })
      },
      broadcast() {},
    }

    registerConsole(registrar, control, appearance, undefined, undefined, undefined, undefined, presets)

    const eventNames = [
      'onebot-sandbox.preset-catalog',
      'onebot-sandbox.preset-read',
      'onebot-sandbox.preset-create',
      'onebot-sandbox.preset-save',
      'onebot-sandbox.preset-rename',
      'onebot-sandbox.preset-delete',
      'onebot-sandbox.preset-locate-expression',
    ]
    expect(eventNames.every((event) => listeners.get(event)?.authority === 4)).toBe(true)

    const create = listeners.get('onebot-sandbox.preset-create')?.callback
    const catalog = listeners.get('onebot-sandbox.preset-catalog')?.callback
    const read = listeners.get('onebot-sandbox.preset-read')?.callback
    const save = listeners.get('onebot-sandbox.preset-save')?.callback
    const rename = listeners.get('onebot-sandbox.preset-rename')?.callback
    const remove = listeners.get('onebot-sandbox.preset-delete')?.callback
    if (!create || !catalog || !read || !save || !rename || !remove) throw new Error('预设 RPC 未完整注册')

    const created = await create({ kind: 'core', fileName: 'demo.yml', source: 'keywords: [demo]\nprompts: []\n' })
    expect(await catalog()).toContainEqual(expect.objectContaining({ fileName: 'demo.yml', displayName: 'demo' }))
    expect(await read({ kind: 'core', fileName: 'demo.yml' })).toMatchObject({ revision: created.revision })
    const saved = await save({
      kind: 'core', fileName: 'demo.yml', expectedRevision: created.revision,
      source: 'keywords: [renamed-display]\nprompts: []\n',
    })
    expect(saved.displayName).toBe('renamed-display')
    const renamed = await rename({
      kind: 'core', fileName: 'demo.yml', newFileName: 'renamed.yml',
      expectedRevision: saved.revision, confirmed: true,
    })
    expect(renamed.fileName).toBe('renamed.yml')
    await expect(remove({
      kind: 'core', fileName: 'renamed.yml', expectedRevision: renamed.revision, confirmed: true,
    })).resolves.toEqual({ deleted: true })
  })
})
