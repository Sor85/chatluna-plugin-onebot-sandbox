import { App } from './helpers/app'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_AVATARS, pickUnusedBuiltinAvatar, type BuiltinAvatarKind } from '../src/builtin-avatars'
import { SandboxControlService, createEmptyScene } from '../src/control-service'

const apps: App[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createControl() {
  const app = new App()
  const directory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-builtin-avatar-'))
  apps.push(app)
  directories.push(directory)
  const control = new SandboxControlService(app, { initialScene: createEmptyScene(), mediaDirectory: directory, runtimeActive: false })
  await app.start()
  return control
}

function avatarOf(control: SandboxControlService, kind: BuiltinAvatarKind, id: string) {
  return kind === 'group'
    ? control.getSnapshot().groups.find((group) => group.id === id)?.avatar
    : control.getSnapshot().participants.find((participant) => participant.id === id)?.avatar
}

function createEntity(control: SandboxControlService, kind: BuiltinAvatarKind, id: string, name: string) {
  if (kind === 'user') control.createUser({ id, name })
  if (kind === 'bot') control.createBot({ id, name, implementation: 'napcat', enabled: true })
  if (kind === 'group') control.createGroup({ id, name, members: [{ participantId: '10001', role: 'owner' }] })
}

describe('三类内置头像池', () => {
  it('三类头像各有8项且视觉资源互不复用', () => {
    expect(BUILTIN_AVATARS.user).toHaveLength(8)
    expect(BUILTIN_AVATARS.bot).toHaveLength(8)
    expect(BUILTIN_AVATARS.group).toHaveLength(8)
    const svgs = Object.values(BUILTIN_AVATARS).flatMap((pool) => pool.map(({ svg }) => svg))
    expect(new Set(svgs)).toHaveLength(24)
  })

  it('池未耗尽前只从未占用头像中选择，耗尽后才允许复用', () => {
    const pool = ['a', 'b', 'c']
    expect(pickUnusedBuiltinAvatar(pool, new Set(['a']), () => 0)).toBe('b')
    expect(pickUnusedBuiltinAvatar(pool, new Set(['a', 'b']), () => 0)).toBe('c')
    expect(pickUnusedBuiltinAvatar(pool, new Set(pool), () => 0)).toBe('a')
  })

  for (const kind of ['user', 'bot', 'group'] as const) {
    it(`${kind} 在内置池耗尽前不重复，耗尽后允许复用`, async () => {
      const control = await createControl()
      if (kind === 'group') control.createUser({ id: '10001', name: '群主' })
      const references: string[] = []
      for (let index = 0; index < BUILTIN_AVATARS[kind].length; index++) {
        const id = `${kind === 'user' ? 11 : kind === 'bot' ? 22 : 33}${String(index).padStart(3, '0')}`
        createEntity(control, kind, id, `${kind} ${index + 1}`)
        references.push(avatarOf(control, kind, id)!)
      }

      expect(references.every((reference) => /^sandbox-media:\/\//.test(reference))).toBe(true)
      expect(new Set(references)).toHaveLength(BUILTIN_AVATARS[kind].length)

      const overflowId = `${kind === 'user' ? 11 : kind === 'bot' ? 22 : 33}999`
      createEntity(control, kind, overflowId, `${kind} 池外实体`)
      expect(references).toContain(avatarOf(control, kind, overflowId))
    })
  }

  it('允许把用户头像修改为自定义图片且不影响其他用户', async () => {
    const control = await createControl()
    control.createUser({ id: '11001', name: '用户 1' })
    control.createUser({ id: '11002', name: '用户 2' })
    const firstBefore = avatarOf(control, 'user', '11001')
    const secondBefore = avatarOf(control, 'user', '11002')
    const custom = `data:image/png;base64,${Buffer.from('custom-user-avatar').toString('base64')}`

    control.updateUser({ id: '11001', name: '用户 1', avatar: custom })

    expect(avatarOf(control, 'user', '11001')).toMatch(/^sandbox-media:\/\//)
    expect(avatarOf(control, 'user', '11001')).not.toBe(firstBefore)
    expect(avatarOf(control, 'user', '11002')).toBe(secondBefore)
  })
})
