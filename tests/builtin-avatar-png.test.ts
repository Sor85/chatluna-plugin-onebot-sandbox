import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './helpers/app'
import { BUILTIN_AVATARS as SVG_AVATARS } from '../src/builtin-avatar-options'
import { BUILTIN_AVATAR_SOURCE_HASH } from '../src/builtin-avatar-png'
import { BUILTIN_AVATARS, findBuiltinAvatarByReference } from '../src/builtin-avatars'
import { createDefaultScene, SandboxControlService, type SandboxControlServiceOptions } from '../src/control-service'
import type { SandboxSnapshot } from '../src/types'

const apps: App[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup(options: SandboxControlServiceOptions = {}) {
  const app = new App()
  const directory = await mkdtemp(join(tmpdir(), 'sandbox-png-avatar-'))
  apps.push(app)
  directories.push(directory)
  const control = new SandboxControlService(app, { ...options, mediaDirectory: directory })
  await app.start()
  await control.waitForSceneReady()
  return control
}

function builtinScene(): SandboxSnapshot {
  const scene = createDefaultScene()
  scene.participants.find(({ id }) => id === '10001')!.avatar = BUILTIN_AVATARS.user[0].reference
  scene.participants.find(({ id }) => id === '20001')!.avatar = BUILTIN_AVATARS.bot[0].reference
  scene.groups[0].avatar = BUILTIN_AVATARS.group[0].reference
  return scene
}

function expectPngAvatars(scene: SandboxSnapshot) {
  expect(scene.participants.find(({ id }) => id === '10001')!.avatar).toBe(BUILTIN_AVATARS.user[0].reference)
  expect(scene.participants.find(({ id }) => id === '20001')!.avatar).toBe(BUILTIN_AVATARS.bot[0].reference)
  expect(scene.groups[0].avatar).toBe(BUILTIN_AVATARS.group[0].reference)
}

function expectPngContent(control: SandboxControlService) {
  const media = control.getMediaContent({ operatorId: '10001', mediaId: BUILTIN_AVATARS.user[0].reference.slice('sandbox-media://'.length) })
  expect(media.mimeType).toBe('image/png')
  expect(media.dataBase64).toBe(BUILTIN_AVATARS.user[0].png)
}

describe('预生成 PNG 头像', () => {
  it('与 SVG 源的分类、ID、顺序一致，每张都是内容寻址的 512×512 PNG', () => {
    expect(BUILTIN_AVATAR_SOURCE_HASH).toBe(createHash('sha256').update(JSON.stringify(SVG_AVATARS)).digest('hex'))
    for (const kind of ['user', 'bot', 'group'] as const) {
      const pool = BUILTIN_AVATARS[kind]
      expect(pool.map(({ id }) => id)).toEqual(SVG_AVATARS[kind].map(({ id }) => id))
      for (const avatar of pool) {
        expect(avatar.kind).toBe(kind)
        const png = Buffer.from(avatar.png, 'base64')
        expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        expect(png.readUInt32BE(16)).toBe(512)
        expect(png.readUInt32BE(20)).toBe(512)
        expect(avatar.reference).toBe(`sandbox-media://${createHash('sha256').update(png).digest('hex').slice(0, 32)}`)
        expect(findBuiltinAvatarByReference(avatar.reference)).toBe(avatar)
      }
    }
  })

  it('Resvg 只属于开发期生成器，不进入运行依赖', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.dependencies).not.toHaveProperty('@resvg/resvg-js')
    expect(pkg.devDependencies['@resvg/resvg-js']).toBe('2.6.2')
  })

  it('初始场景恢复当前内置 PNG，重置后引用与内容仍稳定', async () => {
    const control = await setup({ initialScene: builtinScene() })
    expectPngAvatars(control.getSnapshot())
    expectPngContent(control)
    const users = control.getSnapshot().participants.filter(({ kind }) => kind === 'user')
    expect(new Set(users.map(({ avatar }) => avatar))).toHaveLength(users.length)
    control.resetScene()
    expectPngAvatars(control.getSnapshot())
    expectPngContent(control)
  })

  it('导入当前快照时补齐缺失的内置 PNG 文件，不改内容 ID', async () => {
    const control = await setup()
    control.replaceScene(builtinScene())
    expectPngAvatars(control.getSnapshot())
    expectPngContent(control)
  })

  it('持久化恢复保持当前头像引用、修订号及未知自定义引用', async () => {
    let persisted = builtinScene()
    persisted.revision = 42
    const customReference = `sandbox-media://${'f'.repeat(32)}`
    persisted.participants.find(({ id }) => id === '10002')!.avatar = customReference
    const control = await setup({
      persistence: {
        getStatus: () => ({ mode: 'database', available: true, persisted: true }),
        load: async () => ({ kind: 'loaded', scene: structuredClone(persisted) }),
        save: async (scene) => { persisted = structuredClone(scene) },
      },
    })
    expectPngAvatars(control.getSnapshot())
    expectPngContent(control)
    expectPngAvatars(persisted)
    expect(persisted.revision).toBe(42)
    expect(persisted.participants.find(({ id }) => id === '10002')!.avatar).toBe(customReference)
  })

  it('导入 SVG 保持原始字节，不按内置图形自动替换为 PNG', async () => {
    const control = await setup()
    const svg = SVG_AVATARS.user[0].svg
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    control.updateUser({ id: '10001', name: '用户', avatar: dataUrl })
    const reference = control.getSnapshot().participants.find(({ id }) => id === '10001')!.avatar!
    expect(findBuiltinAvatarByReference(reference)).toBeUndefined()
    expect((await control.bot.getUser('10001')).avatar).toBe(dataUrl)
  })
})
