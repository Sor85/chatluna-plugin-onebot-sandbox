import { App } from './helpers/app'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerConsole, type SandboxConsoleRegistrar } from '../src/console'
import { SandboxControlService } from '../src/control-service'
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

async function createControl() {
  const app = new App()
  const mediaDirectory = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-reactions-'))
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

describe('消息表情回应', () => {
  it('普通用户与机器人写入同一场景回应事实，并可切换取消', async () => {
    const { control } = await createControl()
    control.createGroup({
      id: '30101',
      name: '回应群',
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '20001', role: 'member' },
        { participantId: '10003', role: 'member' },
      ],
    })

    const sent = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30101',
      content: '目标消息',
    })

    await control.setMessageReaction({
      operatorId: '10003',
      messageId: sent.messageId,
      emojiId: '76',
      enabled: true,
    })
    expect(control.getSnapshot().messages.find(({ id }) => id === sent.messageId)!.reactions).toEqual([
      { emojiId: '76', participantIds: ['10003'] },
    ])

    await control.bot.internal._request('set_msg_emoji_like', {
      message_id: sent.messageId,
      emoji_id: '76',
    })
    expect(control.getSnapshot().messages.find(({ id }) => id === sent.messageId)!.reactions).toEqual([
      { emojiId: '76', participantIds: ['10003', '20001'] },
    ])

    await control.setMessageReaction({
      operatorId: '10003',
      messageId: sent.messageId,
      emojiId: '76',
      enabled: false,
    })
    expect(control.getSnapshot().messages.find(({ id }) => id === sent.messageId)!.reactions).toEqual([
      { emojiId: '76', participantIds: ['20001'] },
    ])
  })

  it('领域层允许私聊回应写入，供 WebQQ 与协议入口共用', async () => {
    const { control } = await createControl()
    const sent = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '私聊目标',
    })

    // 私聊与群聊共用回应事实，WebQQ 和协议入口最终都落到这里。
    await control.setMessageReaction({
      operatorId: '10001',
      messageId: sent.messageId,
      emojiId: '76',
      enabled: true,
    })
    expect(control.getSnapshot().messages.find(({ id }) => id === sent.messageId)?.reactions).toEqual([
      { emojiId: '76', participantIds: ['10001'] },
    ])
  })

  it('撤回后保留已有回应但禁止新增或取消', async () => {
    const { control } = await createControl()
    control.createGroup({
      id: '30102',
      name: '撤回回应群',
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '20001', role: 'member' },
        { participantId: '10003', role: 'member' },
      ],
    })
    const sent = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30102',
      content: '将被撤回',
    })
    await control.setMessageReaction({
      operatorId: '10003',
      messageId: sent.messageId,
      emojiId: '76',
      enabled: true,
    })
    await control.recallMessage({
      operatorId: '10001',
      messageId: sent.messageId,
      conversationId: 'group:30102',
    })

    const message = control.getSnapshot().messages.find(({ id }) => id === sent.messageId)!
    expect(message.lifecycle).toEqual(expect.objectContaining({ status: 'recalled', operatorId: '10001' }))
    expect(message.content).toBe('将被撤回')
    expect(message.reactions).toEqual([{ emojiId: '76', participantIds: ['10003'] }])

    await expect(control.setMessageReaction({
      operatorId: '10003',
      messageId: sent.messageId,
      emojiId: '76',
      enabled: false,
    })).rejects.toThrow('已撤回消息不支持修改表情回应')
    await expect(control.bot.internal._request('set_msg_emoji_like', {
      message_id: sent.messageId,
      emoji_id: '128077',
    })).rejects.toThrow('已撤回消息不支持修改表情回应')
  })

  it('机器人操作者走 set_msg_emoji_like，能力禁用时失败', async () => {
    const { control } = await createControl()
    control.createGroup({
      id: '30103',
      name: '能力群',
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '20001', role: 'member' },
      ],
    })
    const sent = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30103',
      content: '能力目标',
    })

    await control.setMessageReaction({
      operatorId: '20001',
      messageId: sent.messageId,
      emojiId: '76',
      enabled: true,
    })
    expect(control.getSnapshot().messages.find(({ id }) => id === sent.messageId)!.reactions).toEqual([
      { emojiId: '76', participantIds: ['20001'] },
    ])

    control.updateBot({
      id: '20001',
      name: 'ChatLuna',
      implementation: 'napcat',
      enabled: true,
      disabledCapabilities: ['message.emoji-like'],
    })
    await expect(control.setMessageReaction({
      operatorId: '20001',
      messageId: sent.messageId,
      emojiId: '76',
      enabled: false,
    })).rejects.toThrow('能力已被禁用：message.emoji-like')
  })

  it('LLBot 与 NapCat 都支持 set_msg_emoji_like 写入回应', async () => {
    const { control } = await createControl()
    control.createBot({ id: '20002', name: 'LLBot', implementation: 'llbot', enabled: true })
    control.createGroup({
      id: '30105',
      name: '双实现群',
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '20001', role: 'member' },
        { participantId: '20002', role: 'member' },
      ],
    })
    const sent = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30105',
      content: '双实现目标',
    })
    await control.bot.internal._request('set_msg_emoji_like', {
      message_id: sent.messageId,
      emoji_id: '76',
    })
    const llbot = control.getRuntimeBot('20002')
    await llbot.internal._request('set_msg_emoji_like', {
      message_id: sent.messageId,
      emoji_id: '66',
    })
    expect(control.getSnapshot().messages.find(({ id }) => id === sent.messageId)!.reactions).toEqual([
      { emojiId: '76', participantIds: ['20001'] },
      { emojiId: '66', participantIds: ['20002'] },
    ])
  })

  it('Console RPC 暴露 set-message-reaction 并返回工作区', async () => {
    const { app, control } = await createControl()
    control.createGroup({
      id: '30104',
      name: 'RPC 群',
      members: [
        { participantId: '10001', role: 'owner' },
        { participantId: '10003', role: 'member' },
      ],
    })
    const sent = await control.sendMessage({
      operatorId: '10001',
      conversationId: 'group:30104',
      content: 'RPC 目标',
    })

    const listeners = new Map<string, unknown>()
    const consoleRegistrar: SandboxConsoleRegistrar = {
      addEntry() {},
      addListener(event, callback) {
        listeners.set(event, callback)
      },
      broadcast() {},
    }
    registerConsole(consoleRegistrar, control, appearance)

    const setReaction = listeners.get('onebot-sandbox.set-message-reaction')
    if (typeof setReaction !== 'function') throw new Error('未注册 set-message-reaction')

    const workspace = await setReaction({
      operatorId: '10003',
      messageId: sent.messageId,
      emojiId: '76',
      enabled: true,
    })
    expect(workspace.snapshot.messages.find(({ id }: { id: string }) => id === sent.messageId)!.reactions).toEqual([
      { emojiId: '76', participantIds: ['10003'] },
    ])
    expect(app).toBeTruthy()
  })
})
