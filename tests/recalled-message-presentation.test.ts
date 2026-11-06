import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './helpers/app'
import { Universal } from '@satorijs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src'
import { SandboxControlService } from '../src/control-service'
import { SandboxMcpService } from '../src/mcp/service'
import { getOneBotMessageSequence } from '../src/onebot-profiles'
import type { SandboxScenePersistence } from '../src/persistence'
import { isRecalledMessage, type SandboxPersistenceStatus, type SandboxSnapshot } from '../src/types'

const runningApps: App[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function createControl() {
  const app = new App()
  const mediaDirectory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-recall-media-'))
  temporaryDirectories.push(mediaDirectory)
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, { mediaDirectory })
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  return { app, control }
}

async function emit(app: App, event: string, ...args: unknown[]) {
  await (app.parallel as unknown as (event: string, ...args: unknown[]) => Promise<void>)(event, ...args)
}

class TestScenePersistence implements SandboxScenePersistence {
  private scene?: SandboxSnapshot
  private status: SandboxPersistenceStatus = {
    mode: 'database',
    available: true,
    persisted: false,
  }

  getStatus() {
    return { ...this.status }
  }

  async load() {
    return this.scene
      ? { kind: 'loaded' as const, scene: structuredClone(this.scene) }
      : { kind: 'missing' as const }
  }

  async save(scene: SandboxSnapshot) {
    this.scene = structuredClone(scene)
    this.status.persisted = true
  }
}

async function createPersistedControl(persistence: SandboxScenePersistence, mediaDirectory: string) {
  const app = new App()
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, { persistence, mediaDirectory })
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  await control.waitForPersistence()
  return { app, control }
}

describe('撤回消息生命周期与呈现', () => {
  it('撤回后权威场景保留正文、媒体、回复、回应，并记录生命周期状态', async () => {
    const { control } = await createControl()
    control.createGroup({
      id: '30103',
      name: '撤回保留群',
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '20001', role: 'member' },
        { participantId: '10003', role: 'member' },
      ],
    })
    const quoted = await control.sendMessage({
      operatorId: '10003',
      conversationId: 'group:30103',
      content: '被引用',
    })
    const media = control.storeMedia({
      fileName: 'photo.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('recalled-image').toString('base64'),
    })
    const sent = await control.sendStoredMediaMessage({
      operatorId: '10001',
      conversationId: 'group:30103',
      content: '将被撤回的原文',
      replyToMessageId: quoted.messageId,
      media: [media],
    })
    await control.setMessageReaction({
      operatorId: '10003',
      messageId: sent.messageId,
      emojiId: '76',
      enabled: true,
    })

    const before = control.getSnapshot().revision
    await control.recallMessage({
      operatorId: '10001',
      messageId: sent.messageId,
      conversationId: 'group:30103',
    })

    const message = control.getSnapshot().messages.find(({ id }) => id === sent.messageId)!
    expect(isRecalledMessage(message)).toBe(true)
    expect(message).toEqual(expect.objectContaining({
      content: '将被撤回的原文',
      replyToMessageId: quoted.messageId,
      media: [expect.objectContaining({ id: media.id, name: 'photo.png' })],
      reactions: [{ emojiId: '76', participantIds: ['10003'] }],
      lifecycle: {
        status: 'recalled',
        operatorId: '10001',
        recalledAt: expect.any(String),
      },
    }))
    expect(message.event).toBeUndefined()
    expect(control.getMediaContent({ operatorId: '10001', mediaId: media.id }).dataBase64)
      .toBe(Buffer.from('recalled-image').toString('base64'))
    expect(control.getSnapshot().revision).toBeGreaterThan(before)
  })

  it('普通 get_msg 与消息历史不得泄露撤回原文', async () => {
    const { control } = await createControl()
    const sent = await control.sendMessage({
      operatorId: '20001',
      conversationId: 'private:10001:20001',
      content: '秘密原文',
    })
    const reply = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '未撤回的回复',
      replyToMessageId: sent.messageId,
    })
    const sequence = getOneBotMessageSequence(sent.messageId)
    await control.recallBotMessage('20001', sent.messageId)

    await expect(control.bot.internal._request('get_msg', { message_id: sequence }))
      .rejects.toThrow(/消息不存在|已撤回/)
    await expect(control.bot.getMessage('private:10001:20001', sent.messageId))
      .rejects.toThrow(/消息不存在|已撤回/)
    const readableReply = await control.bot.getMessage('private:10001:20001', reply.messageId)
    expect(readableReply.quote).toBeUndefined()
    expect(JSON.stringify(readableReply)).not.toContain('秘密原文')

    const history = await control.bot.internal._request('get_friend_msg_history', {
      user_id: 10001,
      count: 20,
    }) as { data: { messages: Array<{ message_id: number; raw_message?: string }> } }
    expect(history.data.messages.some((item) => item.message_id === sequence)).toBe(false)
    expect(JSON.stringify(history)).not.toContain('秘密原文')
  })

  it('撤回发出 message.recalled 与 scene.changed，且不销毁场景数据', async () => {
    const { app, control } = await createControl()
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-recall-mcp-'))
    temporaryDirectories.push(directory)
    const mcp = new SandboxMcpService(app, control, { dataDirectory: directory })
    const credential = mcp.createCredential('撤回事件', ['read', 'interact'])
    const cursor = mcp.currentCursor()
    const sent = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '可恢复原文',
    })
    await control.recallMessage({
      operatorId: '10001',
      messageId: sent.messageId,
      conversationId: 'private:10001:20001',
    })

    const recalled = await mcp.callTool(credential.token, 'wait_for_event', {
      cursor,
      type: 'message.recalled',
      timeoutSeconds: 1,
    }) as { outcome: string; event: { type: string; data: { id: string; content: string; lifecycle: { status: string; operatorId: string } } } }
    expect(recalled.outcome).toBe('matched')
    expect(recalled.event).toEqual(expect.objectContaining({
      type: 'message.recalled',
      data: expect.objectContaining({
        id: sent.messageId,
        content: '可恢复原文',
        lifecycle: expect.objectContaining({ status: 'recalled', operatorId: '10001' }),
      }),
    }))

    const scene = await mcp.callTool(credential.token, 'wait_for_event', {
      cursor,
      type: 'scene.changed',
      timeoutSeconds: 1,
    }) as { outcome: string }
    expect(scene.outcome).toBe('matched')
    expect(control.getSnapshot().messages.find(({ id }) => id === sent.messageId)?.content)
      .toBe('可恢复原文')
  })

  it('ChatLuna 归档在撤回后仍挂到原消息，不落到更早消息', async () => {
    const { app, control } = await createControl()
    const session = control.getRuntimeBot('20001').session({
      type: 'message',
      user: { id: '10001', name: '测试用户1' },
      channel: { id: 'private:10001:20001', type: Universal.Channel.Type.DIRECT },
    })
    await control.sendMessage({
      operatorId: '20001',
      conversationId: 'private:10001:20001',
      content: '更早的机器人消息',
    })
    const agent = { session: { id: 'route:direct' } }
    await emit(app, 'chat/receive', session, { sessionId: 'route:direct' })
    await emit(app, 'chatluna/agent-status', { agent, status: 'busy' })
    await emit(app, 'chatluna/agent-step', {
      agent,
      step: { content: [{ type: 'text', text: '<think>本轮思考</think>本轮回复' }], toolCalls: [] },
    })
    const latest = await control.sendMessage({
      operatorId: '20001',
      conversationId: 'private:10001:20001',
      content: '本轮回复',
    })
    await control.recallMessage({
      operatorId: '20001',
      messageId: latest.messageId,
      conversationId: 'private:10001:20001',
    })
    await emit(app, 'chatluna/agent-status', { agent, status: 'idle' })

    const messages = control.getSnapshot().messages
    expect(messages.find(({ content }) => content === '更早的机器人消息')?.chatLuna).toBeUndefined()
    expect(messages.find(({ id }) => id === latest.messageId)).toEqual(expect.objectContaining({
      content: '本轮回复',
      chatLuna: expect.objectContaining({ thought: '本轮思考' }),
      lifecycle: expect.objectContaining({ status: 'recalled' }),
    }))
  })

  it('场景导入导出与持久化重启保留撤回生命周期和权威原文', async () => {
    const persistence = new TestScenePersistence()
    const mediaDirectory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-recall-persistence-'))
    temporaryDirectories.push(mediaDirectory)
    const { app: firstApp, control: first } = await createPersistedControl(persistence, mediaDirectory)
    const sent = await first.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '跨重启撤回原文',
    })
    await first.recallMessage({
      operatorId: '10001',
      messageId: sent.messageId,
      conversationId: 'private:10001:20001',
    })
    await first.waitForPersistence()

    const exported = first.getSnapshot()
    const { control: imported } = await createControl()
    imported.replaceScene(structuredClone(exported))
    expect(imported.getSnapshot().messages.find(({ id }) => id === sent.messageId)).toEqual(expect.objectContaining({
      content: '跨重启撤回原文',
      lifecycle: expect.objectContaining({
        status: 'recalled',
        operatorId: '10001',
        recalledAt: expect.any(String),
      }),
    }))

    await firstApp.stop()
    const { control: restored } = await createPersistedControl(persistence, mediaDirectory)
    expect(restored.getSnapshot().messages.find(({ id }) => id === sent.messageId)).toEqual(expect.objectContaining({
      content: '跨重启撤回原文',
      lifecycle: expect.objectContaining({
        status: 'recalled',
        operatorId: '10001',
        recalledAt: expect.any(String),
      }),
    }))
  })

  it('配置 sandboxMarkRecalledMessages 默认开启且只影响外观', () => {
    if (!Config.dict) throw new Error('配置 Schema 缺少字段定义')
    expect(Config.dict.sandboxMarkRecalledMessages.meta.default).toBe(true)
    expect(Config.dict.sandboxMarkRecalledMessages.meta.description).toMatch(/撤回/)
  })
})
