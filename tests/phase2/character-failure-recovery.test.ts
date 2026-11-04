import { App } from '@koishijs/core'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply, type Config } from '../src'
import type { SandboxConsoleEvents } from '../src/console-contract'
import type { SandboxTestSpaceSummary } from '../src/test-spaces'
import type {
  SandboxConsoleModelRequestDetail,
  SandboxConsoleModelRequestListItem,
  SandboxModelRequestTrajectory,
} from '../src/types'

const CHAT_URL = 'https://api.example.com/v1/chat/completions'
const PROMPT = '同一个问题'

type ConsoleListener = (...args: any[]) => any

type RuntimePlugin = {
  new(): { fetch(info: unknown, init?: { method?: string, body?: unknown }): Promise<Response> }
  responseBodies: unknown[]
}

function config(): Config {
  return {
    persistenceMode: 'memory',
    enableSandboxFrostedGlass: true,
    sandboxTimBubbleTail: true,
    sandboxColorMode: 'auto',
    sandboxAccentColor: '#2563eb',
    sandboxMarkRecalledMessages: true,
    modelRequestRecordLimit: 50,
    modelRequestRecordMaxMegabytes: 8,
    sceneMessageLimit: 2000,
    sceneMessageMaxBytes: 8 * 1024 * 1024,
    testEndpoint: {
      mcp: { enabled: false, path: '/mcp' },
      http: { enabled: false, path: '/api' },
      shared: {
        host: '127.0.0.1',
        port: 61901,
        allowedSources: [],
        allowedOrigins: [],
        readPerMinute: 120,
        mutationPerMinute: 60,
        waitPerMinute: 120,
        uploadPerMinute: 30,
        maxConcurrentMutations: 4,
        maxConcurrentWaits: 8,
        maxConcurrentUploads: 2,
      },
    },
  }
}

function installFakeChatLuna(baseDir: string): RuntimePlugin {
  writeFileSync(join(baseDir, 'package.json'), JSON.stringify({ private: true }))
  const packageDir = join(baseDir, 'node_modules/koishi-plugin-chatluna')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: 'koishi-plugin-chatluna',
    exports: { './services/chat': './chat.cjs' },
  }))
  writeFileSync(join(packageDir, 'chat.cjs'), `
class ChatLunaPlugin {
  static responseBodies = []
  async fetch() {
    const body = ChatLunaPlugin.responseBodies.shift()
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}
exports.ChatLunaPlugin = ChatLunaPlugin
`)
  const runtimeRequire = createRequire(join(baseDir, 'package.json'))
  return (runtimeRequire('koishi-plugin-chatluna/services/chat') as { ChatLunaPlugin: RuntimePlugin }).ChatLunaPlugin
}

function session(botId: string, conversationId: string) {
  const direct = conversationId.startsWith('private:')
  const targetId = direct ? conversationId.split(':')[1]! : conversationId.slice('group:'.length)
  return {
    platform: 'onebot',
    selfId: botId,
    channelId: conversationId,
    userId: direct ? targetId : '10001',
    guildId: direct ? undefined : targetId,
    isDirect: direct,
    bot: { selfId: botId, platform: 'onebot' },
    channel: { id: conversationId },
  }
}

function characterPayload(currentSession: ReturnType<typeof session>, identity: string) {
  return {
    session: currentSession,
    presetName: 'shared-character',
    preset: {
      name: 'shared-character',
      system: { rawString: '身份：{identity}' },
      input: { rawString: '问题：{prompt}' },
    },
    identity,
  }
}

function requestBody(model: string, identity: string) {
  return JSON.stringify({
    model,
    stream: false,
    messages: [
      { role: 'system', content: `身份：${identity}` },
      { role: 'user', content: `问题：${PROMPT}` },
    ],
  })
}

async function emit(app: App, event: string, ...args: unknown[]): Promise<void> {
  await (app.parallel as unknown as (event: string, ...args: unknown[]) => Promise<void>)(event, ...args)
}

async function invokeModel(plugin: InstanceType<RuntimePlugin>, model: string, identity: string): Promise<void> {
  const response = await plugin.fetch(CHAT_URL, { method: 'POST', body: requestBody(model, identity) })
  const completion = await response.json() as { choices?: unknown[] }
  // 这里只替代 provider 把最终空 completion 转成 103 的边界；请求采集和生命周期均走真实实现。
  if (!completion.choices?.length) {
    throw Object.assign(new Error('模型 API 请求失败'), { name: 'ChatLunaError', errorCode: 103 })
  }
}

function requireListener<Event extends keyof SandboxConsoleEvents>(
  listeners: Map<string, ConsoleListener>,
  event: Event,
): SandboxConsoleEvents[Event] {
  const listener = listeners.get(event)
  if (!listener) throw new Error(`Console 监听器未注册：${event}`)
  return listener as SandboxConsoleEvents[Event]
}

function variableValues(detail: SandboxConsoleModelRequestDetail) {
  return Object.fromEntries(detail.variables.map(({ name, value }) => [name, value]))
}

async function assertVariableEvidence(
  trajectory: SandboxModelRequestTrajectory,
  detail: SandboxConsoleModelRequestDetail,
  identity: string,
) {
  expect.soft(variableValues(detail)).toEqual({ identity, prompt: PROMPT })
  expect.soft(trajectory.rows.filter(({ kind }) => kind === 'variable').map(({ variableName }) => variableName))
    .toEqual(['identity', 'prompt'])
  expect.soft(trajectory.promptComposition.filter(({ variableId }) => variableId).map(({ kind, variableName }) => ({
    kind,
    variableName,
  }))).toEqual([
    { kind: 'user', variableName: 'identity' },
    { kind: 'user', variableName: 'prompt' },
  ])
}

describe('Character 失败后的 Sandbox 模型请求归属恢复', () => {
  it('最终 103 且无 after-chat 时，真实 release 后立即恢复跨记录域、Core 私聊与同会话新轮', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-character-failure-'))
    const ChatLunaPlugin = installFakeChatLuna(baseDir)
    ChatLunaPlugin.responseBodies.push(
      { choices: [] },
      { choices: [] },
      { choices: [{ message: { role: 'assistant', content: '跨记录域 B 完成' } }] },
      { choices: [{ message: { role: 'assistant', content: '同记录域 B 完成' } }] },
      { choices: [{ message: { role: 'assistant', content: 'Core 完成' } }] },
      { choices: [{ message: { role: 'assistant', content: 'A 新轮完成' } }] },
    )
    const corePreset = {
      messages: [
        { content: '身份：{identity}', _getType: () => 'system' },
        { content: '问题：{prompt}', _getType: () => 'human' },
      ],
    }

    const app = new App()
    app.baseDir = baseDir
    const listeners = new Map<string, ConsoleListener>()
    const consoleService = {
      addEntry() {},
      addListener(event: string, callback: ConsoleListener) { listeners.set(event, callback) },
      broadcast() {},
    }
    const character = {
      releaseResponseLock(_session: unknown) {
        return Promise.resolve()
      },
    }
    app.set('console', consoleService as any)
    app.set('chatluna_character', character as any)
    app.set('chatluna', {
      preset: { getPreset: () => ({ value: corePreset }) },
    } as any)
    apply(app as any, config())
    await app.start()

    try {
      const createSpace = requireListener(listeners, 'onebot-sandbox.create-test-space')
      const manageEnvironment = requireListener(listeners, 'onebot-sandbox.manage-environment')
      const listRecords = requireListener(listeners, 'onebot-sandbox.model-request-records')
      const readRecord = requireListener(listeners, 'onebot-sandbox.model-request-record')
      const readTrajectory = requireListener(listeners, 'onebot-sandbox.model-request-trajectory')
      const space = await createSpace({ name: 'B 记录域' }) as SandboxTestSpaceSummary
      await manageEnvironment({ spaceId: space.id, action: 'create-user', data: { id: '11001', name: 'B 用户' } })
      await manageEnvironment({
        spaceId: space.id,
        action: 'create-bot',
        data: { id: '21001', name: 'B 机器人', implementation: 'napcat', enabled: true },
      })
      await manageEnvironment({
        spaceId: space.id,
        action: 'create-group',
        data: {
          id: '31001',
          name: 'B 群',
          members: [
            { participantId: '11001', role: 'owner' },
            { participantId: '21001', role: 'member' },
          ],
        },
      })

      const plugin = new ChatLunaPlugin()
      const failedA = characterPayload(session('20001', 'group:30001'), 'A 群旧角色')
      await emit(app, 'chatluna_character/message_collect', failedA.session, [])
      await emit(app, 'chatluna_character/before-chat', failedA)
      await expect(invokeModel(plugin, 'a-failure-1', failedA.identity)).rejects.toMatchObject({ errorCode: 103 })
      await expect(invokeModel(plugin, 'a-failure-2', failedA.identity)).rejects.toMatchObject({ errorCode: 103 })
      // 上游错误路径不发 after-chat，但 collect 最外层 finally 必定调用这个真实终态。
      await character.releaseResponseLock(failedA.session)

      const groupB = characterPayload(session('21001', 'group:31001'), 'B 群角色')
      await emit(app, 'chatluna_character/message_collect', groupB.session, [])
      await emit(app, 'chatluna_character/before-chat', groupB)
      await invokeModel(plugin, 'group-b', groupB.identity)
      await emit(app, 'chatluna_character/after-chat', groupB)
      await character.releaseResponseLock(groupB.session)

      const sameScopeB = characterPayload(session('20001', 'private:10002:20001'), '同记录域 B 角色')
      await emit(app, 'chatluna_character/message_collect', sameScopeB.session, [])
      await emit(app, 'chatluna_character/before-chat', sameScopeB)
      await invokeModel(plugin, 'same-scope-b', sameScopeB.identity)
      await emit(app, 'chatluna_character/after-chat', sameScopeB)
      await character.releaseResponseLock(sameScopeB.session)

      const direct = session('20001', 'private:10001:20001')
      const chatInterface = { ctx: app }
      await emit(app, 'chatluna/before-chat', 'core-private-turn', {}, { built: { preset: 'core-demo' } }, chatInterface, direct)
      await invokeModel(plugin, 'core-private', 'Core 私聊角色')
      await emit(app, 'chatluna/after-chat', 'core-private-turn', {}, {}, {}, chatInterface, direct)

      const nextA = characterPayload(session('20001', 'group:30001'), 'A 群新角色')
      await emit(app, 'chatluna_character/message_collect', nextA.session, [])
      await emit(app, 'chatluna_character/before-chat', nextA)
      await invokeModel(plugin, 'a-next', nextA.identity)
      await emit(app, 'chatluna_character/after-chat', nextA)
      await character.releaseResponseLock(nextA.session)

      const mainPage = await listRecords({ scope: 'main', order: 'asc', limit: 20 })
      const spacePage = await listRecords({ scope: 'space', spaceId: space.id, order: 'asc', limit: 20 })
      const unattributedPage = await listRecords({ scope: 'unattributed', order: 'asc', limit: 20 })
      expect.soft(mainPage.records.map(({ model }) => model)).toEqual([
        'a-failure-1',
        'a-failure-2',
        'same-scope-b',
        'core-private',
        'a-next',
      ])
      expect.soft(spacePage.records.map(({ model }) => model)).toEqual(['group-b'])
      expect.soft(unattributedPage.records).toEqual([])

      const pages: Array<{
        scope: 'main' | 'space' | 'unattributed'
        spaceId?: string
        records: SandboxConsoleModelRequestListItem[]
      }> = [
        { scope: 'main', records: mainPage.records },
        { scope: 'space', spaceId: space.id, records: spacePage.records },
        { scope: 'unattributed', records: unattributedPage.records },
      ]
      const readByModel = async (model: string) => {
        const page = pages.find(({ records }) => records.some((record) => record.model === model))
        const record = page?.records.find((candidate) => candidate.model === model)
        if (!page || !record) throw new Error(`模型请求未记录：${model}`)
        const scope = page.spaceId ? { scope: page.scope, spaceId: page.spaceId } : { scope: page.scope }
        return {
          detail: await readRecord({ ...scope, recordId: record.id } as any),
          trajectory: await readTrajectory({ ...scope, recordId: record.id, mode: 'request' } as any),
        }
      }

      const firstFailure = await readByModel('a-failure-1')
      const secondFailure = await readByModel('a-failure-2')
      expect.soft(firstFailure.detail).toMatchObject({
        attribution: 'attributed',
        entities: { scopeId: 'main', botId: '20001', conversationId: 'group:30001' },
      })
      expect.soft(secondFailure.detail).toMatchObject({
        attribution: 'attributed',
        entities: { scopeId: 'main', botId: '20001', conversationId: 'group:30001' },
      })

      const b = await readByModel('group-b')
      expect.soft(b.detail).toMatchObject({
        attribution: 'attributed',
        source: { type: 'test-space', spaceId: space.id },
        entities: { scopeId: space.id, botId: '21001', conversationId: 'group:31001' },
        presetSnapshots: [{ kind: 'character', presetName: 'shared-character' }],
      })
      await assertVariableEvidence(b.trajectory, b.detail, groupB.identity)

      const sameScope = await readByModel('same-scope-b')
      expect.soft(sameScope.detail).toMatchObject({
        attribution: 'attributed',
        source: { type: 'main' },
        entities: { scopeId: 'main', botId: '20001', conversationId: 'private:10002:20001' },
        presetSnapshots: [{ kind: 'character', presetName: 'shared-character' }],
      })
      await assertVariableEvidence(sameScope.trajectory, sameScope.detail, sameScopeB.identity)

      const core = await readByModel('core-private')
      expect.soft(core.detail).toMatchObject({
        attribution: 'attributed',
        source: { type: 'main' },
        entities: { scopeId: 'main', botId: '20001', conversationId: 'private:10001:20001' },
        presetSnapshots: [{ kind: 'core', presetName: 'core-demo' }],
      })
      await assertVariableEvidence(core.trajectory, core.detail, 'Core 私聊角色')

      const next = await readByModel('a-next')
      expect.soft(next.detail).toMatchObject({
        attribution: 'attributed',
        source: { type: 'main' },
        entities: { scopeId: 'main', botId: '20001', conversationId: 'group:30001' },
        presetSnapshots: [{ kind: 'character', presetName: 'shared-character' }],
      })
      await assertVariableEvidence(next.trajectory, next.detail, nextA.identity)
    } finally {
      await app.stop()
      rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
