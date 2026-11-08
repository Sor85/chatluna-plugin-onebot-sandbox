import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './helpers/app'
import { BUILTIN_AVATARS as SVG_AVATARS } from '../src/builtin-avatar-options'
import { BUILTIN_AVATAR_SOURCE_HASH } from '../src/builtin-avatar-png'
import { BUILTIN_AVATARS, findBuiltinAvatarByReference, type BuiltinAvatarKind } from '../src/builtin-avatars'
import { createDefaultScene, SandboxControlService, type SandboxControlServiceOptions } from '../src/control-service'
import { SandboxMediaStorage } from '../src/media-storage'
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
  return { control, directory }
}

// 冻结 1.1.0 的原始引用，不能用新实现现场生成“旧快照”。
const legacy: Record<BuiltinAvatarKind, string> = {
  user: 'sandbox-media://d7459f9345948f94b43fc87bc63ccefe',
  bot: 'sandbox-media://c195d8faa116df0c5ff1568d851c7274',
  group: 'sandbox-media://93c46087abc42a59ac045f44be5e5e39',
}

function legacyScene(): SandboxSnapshot {
  const scene = createDefaultScene()
  scene.participants.find(({ id }) => id === '10001')!.avatar = legacy.user
  scene.participants.find(({ id }) => id === '20001')!.avatar = legacy.bot
  scene.groups[0].avatar = legacy.group
  return scene
}

function expectPngAvatars(scene: SandboxSnapshot) {
  expect(scene.participants.find(({ id }) => id === '10001')!.avatar).toBe(BUILTIN_AVATARS.user[0].reference)
  expect(scene.participants.find(({ id }) => id === '20001')!.avatar).toBe(BUILTIN_AVATARS.bot[0].reference)
  expect(scene.groups[0].avatar).toBe(BUILTIN_AVATARS.group[0].reference)
}

describe('预生成 PNG 头像', () => {
  it('与 SVG 源的分类、ID、顺序一致，每张都是内容寻址的 512×512 PNG', () => {
    expect(BUILTIN_AVATAR_SOURCE_HASH).toBe(createHash('sha256').update(JSON.stringify(SVG_AVATARS)).digest('hex'))
    for (const kind of ['user', 'bot', 'group'] as const) {
      const pool = BUILTIN_AVATARS[kind]
      expect(pool.map(({ id }) => id)).toEqual(SVG_AVATARS[kind].map(({ id }) => id))
      for (const [index, avatar] of pool.entries()) {
        expect(avatar.kind).toBe(kind)
        const png = Buffer.from(avatar.png, 'base64')
        expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        expect(png.readUInt32BE(16)).toBe(512)
        expect(png.readUInt32BE(20)).toBe(512)
        expect(avatar.reference).toBe(`sandbox-media://${createHash('sha256').update(png).digest('hex').slice(0, 32)}`)
        const sourceReference = `sandbox-media://${createHash('sha256').update(SVG_AVATARS[kind][index].svg).digest('hex').slice(0, 32)}`
        expect(avatar.legacyReferences).toContain(sourceReference)
        expect(findBuiltinAvatarByReference(avatar.reference)).toBe(avatar)
        for (const reference of avatar.legacyReferences) expect(findBuiltinAvatarByReference(reference)).toBe(avatar)
      }
      expect(findBuiltinAvatarByReference(legacy[kind])).toBe(pool[0])
    }
  })

  it('Resvg 只属于开发期生成器，不进入运行依赖', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.dependencies).not.toHaveProperty('@resvg/resvg-js')
    expect(pkg.devDependencies['@resvg/resvg-js']).toBe('2.6.2')
  })

  it('初始场景与测试空间的旧 SVG 引用恢复为同图形 PNG，重置后仍稳定', async () => {
    const { control } = await setup({ initialScene: legacyScene() })
    expectPngAvatars(control.getSnapshot())
    const snapshot = control.getSnapshot()
    const users = snapshot.participants.filter(({ kind }) => kind === 'user')
    expect(new Set(users.map(({ avatar }) => avatar))).toHaveLength(users.length)
    control.resetScene()
    expectPngAvatars(control.getSnapshot())
  })

  it.each([false, true])('导入旧快照时迁移引用（旧文件存在：%s），不复用 SVG 的内容 ID', async (filesPresent) => {
    const { control, directory } = await setup()
    if (filesPresent) {
      const storage = new SandboxMediaStorage(directory)
      for (const kind of ['user', 'bot', 'group'] as const) {
        const avatar = SVG_AVATARS[kind][0]
        const stored = storage.save({ fileName: 'legacy.svg', mimeType: 'image/svg+xml', dataBase64: Buffer.from(avatar.svg).toString('base64') })
        expect(stored.reference).toBe(legacy[kind])
      }
    }
    control.replaceScene(legacyScene())
    expectPngAvatars(control.getSnapshot())
    const media = control.getMediaContent({ operatorId: '10001', mediaId: BUILTIN_AVATARS.user[0].reference.slice('sandbox-media://'.length) })
    expect(media.mimeType).toBe('image/png')
    expect(media.dataBase64).toBe(BUILTIN_AVATARS.user[0].png)
  })

  it('持久化恢复会保存迁移后的引用，未知的自定义引用保持原样', async () => {
    let persisted = legacyScene()
    persisted.revision = 42
    const customReference = `sandbox-media://${'f'.repeat(32)}`
    persisted.participants.find(({ id }) => id === '10002')!.avatar = customReference
    const { control } = await setup({
      persistence: {
        getStatus: () => ({ mode: 'database', available: true, persisted: true }),
        load: async () => ({ kind: 'loaded', scene: structuredClone(persisted) }),
        save: async (scene) => { persisted = structuredClone(scene) },
      },
    })
    expectPngAvatars(control.getSnapshot())
    expectPngAvatars(persisted)
    expect(persisted.revision).toBe(42)
    expect(persisted.participants.find(({ id }) => id === '10002')!.avatar).toBe(customReference)
  })

  it('旧版选择器发送的内置 SVG 仍能导入成同一 PNG，自定义 SVG 不做渲染', async () => {
    const { control } = await setup()
    const svg = SVG_AVATARS.user[0].svg
    control.updateUser({ id: '10001', name: '用户', avatar: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` })
    expect(control.getSnapshot().participants.find(({ id }) => id === '10001')!.avatar).toBe(BUILTIN_AVATARS.user[0].reference)
    const custom = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16"/></svg>').toString('base64')}`
    control.createUser({ id: '10999', name: '自定义头像', avatar: custom })
    expect((await control.bot.getUser('10999')).avatar).toBe(custom)
  })
})
