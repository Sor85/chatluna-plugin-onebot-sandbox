import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@satorijs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import type { SandboxImplementationProfile } from '../src/types'
import { App } from './helpers/app'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

async function createControl(implementation: SandboxImplementationProfile) {
  const app = new App()
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, { mediaDirectory: mkdtempSync(join(tmpdir(), 'sandbox-member-')) })
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  control.updateBot({ id: '20001', name: '测试机器人', implementation, enabled: true })
  return { app, control }
}

describe.each<SandboxImplementationProfile>(['napcat', 'llbot', 'snowluma'])('%s 群消息成员身份', (implementation) => {
  it.each(['owner', 'admin', 'member'] as const)('群名片与 %s 身份同时进入 OneBot 载荷和标准 Session', async (role) => {
    const { app, control } = await createControl(implementation)
    control.updateGroup({
      id: '30001', name: '测试群',
      members: [
        { participantId: '10001', role, card: '群内专属名片' },
        { participantId: '10002', role: role === 'owner' ? 'member' : 'owner' },
        { participantId: '20001', role: 'member' },
      ],
    })
    let captured: Session | undefined
    app.middleware((session) => {
      captured = session
      return session.author.nick || session.author.name
    })

    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '读取群名片' })

    expect(captured).toBeDefined()
    expect(Reflect.get(captured!, 'onebot').sender).toMatchObject({
      user_id: 10001, nickname: '测试用户1', card: '群内专属名片', role,
    })
    expect(captured!.event.user).toMatchObject({ id: '10001', name: '测试用户1' })
    expect(captured!.event.member).toMatchObject({
      user: { id: '10001', name: '测试用户1' }, nick: '群内专属名片', roles: [{ id: role }],
    })
    expect(captured!.author).toMatchObject({ name: '测试用户1', nick: '群内专属名片', roles: [{ id: role }] })
    expect(control.getSnapshot().messages.at(-1)).toMatchObject({ authorId: '20001', content: '群内专属名片' })
  })

  it.each([undefined, ''])('未设置名片（%s）时保留空名片，由插件回退到账户昵称', async (card) => {
    const { app, control } = await createControl(implementation)
    const group = control.getSnapshot().groups[0]!
    control.updateGroup({ ...group, members: group.members.map((member) => ({ ...member, card })) })
    let captured: Session | undefined
    app.middleware((session) => {
      captured = session
      return session.author.nick || session.author.name
    })

    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '读取空群名片' })

    expect(captured).toBeDefined()
    expect(Reflect.get(captured!, 'onebot').sender).toMatchObject({ nickname: '测试用户1', card: '', role: 'owner' })
    expect(captured!.event.member?.nick).toBe('')
    expect(captured!.author.name).toBe('测试用户1')
    expect(control.getSnapshot().messages.at(-1)).toMatchObject({ authorId: '20001', content: '测试用户1' })
  })

  it('名片按当前群成员资料读取，群会话实例沿用所属群，私聊不携带群身份', async () => {
    const { app, control } = await createControl(implementation)
    const group = control.getSnapshot().groups[0]!
    const members = group.members.map((member) => member.participantId === '10001' ? { ...member, card: '第一群名片' } : member)
    control.updateGroup({ ...group, members })
    control.createGroup({
      id: '30002', name: '第二群',
      members: members.map((member) => member.participantId === '10001' ? { ...member, card: '第二群名片' } : member),
    })
    const instance = control.createConversationInstance({ operatorId: '10001', rootConversationId: 'group:30001' })
    const captured: Session[] = []
    app.middleware((session) => { captured.push(session) })

    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30001', content: '第一群' })
    await control.sendMessage({ operatorId: '10001', conversationId: 'group:30002', content: '第二群' })
    control.updateGroup({ ...group, members: members.map((member) => member.participantId === '10001' ? { ...member, card: '更新后的名片' } : member) })
    await control.sendMessage({ operatorId: '10001', conversationId: instance.conversationId, content: '群会话实例' })
    await control.sendMessage({ operatorId: '10001', conversationId: 'private:10001:20001', content: '私聊' })

    expect(captured.map((session) => ({ guildId: session.guildId, channelId: session.channelId, nick: session.author.nick }))).toEqual([
      { guildId: '30001', channelId: '30001', nick: '第一群名片' },
      { guildId: '30002', channelId: '30002', nick: '第二群名片' },
      { guildId: '30001', channelId: instance.conversationId, nick: '更新后的名片' },
      { guildId: undefined, channelId: 'private:10001', nick: undefined },
    ])
    expect(captured.map((session) => Reflect.get(session, 'onebot').sender.card)).toEqual(['第一群名片', '第二群名片', '更新后的名片', undefined])
    expect(captured[3]!.event.member).toBeUndefined()
    expect(Reflect.get(captured[3]!, 'onebot').sender).not.toHaveProperty('role')
  })
})
