import { afterEach, describe, expect, it } from 'vitest'
import { App } from './helpers/app'
import { createDefaultScene, createEmptyScene, SandboxControlService } from '../src/control-service'
import { BUILTIN_AVATARS } from '../src/builtin-avatars'

const apps: App[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()))
})

describe('当前场景快照契约', () => {
  it('空白场景和默认场景均提供完整集合', () => {
    for (const scene of [createEmptyScene(), createDefaultScene()]) {
      expect(scene.conversationInstances).toEqual([])
      expect(scene.forwards).toEqual([])
    }
  })

  it.each(['unknown', 'user', 'bot'])('群的附加 kind=%s 不影响头像分类或导入提交', async (kind) => {
    const app = new App()
    apps.push(app)
    const control = new SandboxControlService(app, { runtimeActive: false })
    await app.start()
    await control.waitForSceneReady()
    const scene = control.getSnapshot()
    const revision = scene.revision
    scene.groups[0].name = '导入后的群'
    delete scene.groups[0].avatar
    Reflect.set(scene.groups[0], 'kind', kind)
    const mutations: number[] = []
    control.onSceneMutation((snapshot) => mutations.push(snapshot.revision))

    expect(() => control.replaceScene(scene)).not.toThrow()
    const imported = control.getSnapshot()
    expect(imported.groups[0].name).toBe('导入后的群')
    expect(BUILTIN_AVATARS.group.map(({ reference }) => reference)).toContain(imported.groups[0].avatar)
    expect(imported.revision).toBe(revision + 1)
    expect(mutations).toEqual([revision + 1])
  })

  describe.each(['conversationInstances', 'forwards'] as const)('%s 集合', (field) => {
    it.each([undefined, null, '不是数组'])('初始快照拒绝 %s，不自动补空集合', (value) => {
      const app = new App()
      apps.push(app)
      const scene = createDefaultScene()
      Reflect.set(scene, field, value)
      expect(() => new SandboxControlService(app, { initialScene: scene, runtimeActive: false }))
        .toThrow(`场景集合必须是数组：${field}`)
    })

    it.each([undefined, null, '不是数组'])('导入拒绝 %s，原场景保持不变', async (value) => {
      const app = new App()
      apps.push(app)
      const control = new SandboxControlService(app, { runtimeActive: false })
      await app.start()
      await control.waitForSceneReady()
      const before = control.getSnapshot()
      const invalid = structuredClone(before)
      Reflect.set(invalid, field, value)
      expect(() => control.replaceScene(invalid)).toThrow(`场景集合必须是数组：${field}`)
      expect(control.getSnapshot()).toEqual(before)
    })
  })
})
