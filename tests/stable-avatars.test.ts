import { App } from './helpers/app'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'

const apps: App[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createControl() {
  const app = new App()
  const directory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-stable-avatar-'))
  directories.push(directory)
  apps.push(app)
  const control = new SandboxControlService(app, { mediaDirectory: directory })
  await app.start()
  return { control, directory }
}

function avatarOf(control: SandboxControlService, id: string) {
  return control.getSnapshot().participants.find(({ id: participantId }) => participantId === id)!.avatar!
}

describe('稳定实体头像', () => {
  it('为默认实体生成受管头像，并在改名后保持头像不变', async () => {
    const first = await createControl()
    const firstReferences = first.control.getSnapshot().participants.map(({ avatar }) => avatar)
    const firstGroup = first.control.getSnapshot().groups[0].avatar
    expect(firstReferences.every((avatar) => /^sandbox-media:\/\//.test(avatar!))).toBe(true)
    expect(firstGroup).toMatch(/^sandbox-media:\/\//)
    expect(new Set(firstReferences).size).toBe(firstReferences.length)

    first.control.updateUser({ id: '10001', name: '改名用户' })
    expect(avatarOf(first.control, '10001')).toBe(firstReferences[0])

    const second = await createControl()
    expect(avatarOf(second.control, '10001')).toMatch(/^sandbox-media:\/\//)
    expect(second.control.getSnapshot().groups[0].avatar).toMatch(/^sandbox-media:\/\//)
  })

  it('相同内容去重，并在最后一个引用移除后回收媒体', async () => {
    const { control, directory } = await createControl()
    const avatar = `data:image/png;base64,${Buffer.from('shared-avatar').toString('base64')}`
    control.createUser({ id: '10098', name: '共享用户 1', avatar })
    control.createUser({ id: '10099', name: '共享用户 2', avatar })
    const firstReference = avatarOf(control, '10098')
    expect(avatarOf(control, '10099')).toBe(firstReference)

    const filesAfterDedup = await readdir(directory)
    const matchingFiles = filesAfterDedup.filter((file) => file.startsWith(firstReference.slice('sandbox-media://'.length)))
    expect(matchingFiles).toHaveLength(2)

    control.updateUser({
      id: '10098',
      name: '共享用户 1',
      avatar: `data:image/png;base64,${Buffer.from('replacement-avatar').toString('base64')}`,
    })
    expect(await readdir(directory)).toContain(`${firstReference.slice('sandbox-media://'.length)}.meta.json`)
    control.deleteUser({ id: '10099' })
    expect(await readdir(directory)).not.toContain(firstReference.slice('sandbox-media://'.length))
  })
})
