import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

async function createControl() {
  const app = new App()
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx)
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  return control
}

describe('类型化账号资料', () => {
  it('环境管理写入的账号资料与好友备注、群成员资料保持独立', async () => {
    const control = await createControl()

    control.createUser({
      id: '10088',
      name: '资料用户',
      profile: {
        personalNote: '环境签名',
        sex: 'female',
        age: 21,
        qid: 'qid-user',
        level: 48,
        loginDays: 120,
        city: '上海',
        country: '中国',
        birthdayYear: 2004,
        birthdayMonth: 5,
        birthdayDay: 18,
        labels: ['测试'],
        isVip: true,
        isYearsVip: false,
        vipLevel: 2,
      },
    })
    control.updateUser({
      id: '10088',
      name: '资料用户',
      profile: {
        personalNote: '更新后的签名',
        sex: 'female',
        age: 22,
      },
    })
    control.createGroup({
      id: '30088',
      name: '资料群',
      members: [
        {
          participantId: '10088',
          card: '群内名片',
          role: 'owner',
          title: '元老',
          area: '浦东',
          joinTime: 1_700_000_000,
          lastSentTime: 1_700_000_100,
          level: '12',
        },
        { participantId: '20001', role: 'admin' },
      ],
    })
    await control.performFriendAction({
      action: 'set-remark',
      operatorId: '20001',
      targetId: '10088',
      remark: '机器人备注',
    })

    const user = control.getSnapshot().participants.find(({ id }) => id === '10088')
    expect(user).toMatchObject({
      kind: 'user',
      id: '10088',
      name: '资料用户',
      profile: {
        personalNote: '更新后的签名',
        sex: 'female',
        age: 22,
      },
    })
    // 更新后未显式携带的可选字段不保留虚构默认值，也不回落到旧备注。
    expect(user && 'profile' in user ? user.profile : undefined).toEqual({
      personalNote: '更新后的签名',
      sex: 'female',
      age: 22,
    })
    expect(control.getSnapshot().friendships.find(({ participantIds }) => participantIds.includes('10088') && participantIds.includes('20001'))?.remarks)
      .toEqual({ '20001': '机器人备注' })
    expect(control.getSnapshot().groups.find(({ id }) => id === '30088')?.members.find(({ participantId }) => participantId === '10088'))
      .toMatchObject({
        card: '群内名片',
        title: '元老',
        area: '浦东',
        joinTime: 1_700_000_000,
        lastSentTime: 1_700_000_100,
        level: '12',
      })
  })

  it('set_qq_profile 两端可写昵称和签名，性别仅 NapCat 可写', async () => {
    const control = await createControl()
    control.createBot({ id: '20088', name: 'LLBot 资料机器人', implementation: 'llbot', enabled: true })

    await control.bot.internal._request('set_qq_profile', {
      nickname: 'NapCat 新昵称',
      personal_note: 'NapCat 签名',
      sex: 1,
    })
    expect(control.getSnapshot().participants.find(({ id }) => id === '20001')).toMatchObject({
      name: 'NapCat 新昵称',
      profile: { personalNote: 'NapCat 签名', sex: 'male' },
    })

    const llbot = control.getRuntimeBot('20088')
    await llbot.internal._request('set_qq_profile', {
      nickname: 'LLBot 新昵称',
      personal_note: 'LLBot 签名',
    })
    expect(control.getSnapshot().participants.find(({ id }) => id === '20088')).toMatchObject({
      name: 'LLBot 新昵称',
      profile: { personalNote: 'LLBot 签名' },
    })
    await expect(llbot.internal._request('set_qq_profile', {
      nickname: 'LLBot 新昵称',
      sex: 2,
    })).rejects.toThrow(/不支持修改性别|性别/)

    // LLOneBot 拒绝性别写入后，不得静默改掉已有签名或昵称。
    expect(control.getSnapshot().participants.find(({ id }) => id === '20088')).toMatchObject({
      name: 'LLBot 新昵称',
      profile: { personalNote: 'LLBot 签名' },
    })
  })

  it('OneBot 查询按实现字段名读回已建模资料，且不返回未建模 raw JSON', async () => {
    const control = await createControl()
    control.updateUser({
      id: '10001',
      name: '测试用户1',
      profile: {
        personalNote: '用户签名',
        sex: 'male',
        age: 20,
        qid: 'qid-10001',
        level: 36,
        loginDays: 88,
        regTime: 1_600_000_000,
        city: '杭州',
        country: '中国',
        birthdayYear: 2005,
        birthdayMonth: 1,
        birthdayDay: 2,
        labels: ['沙盒'],
        isVip: true,
        isYearsVip: true,
        vipLevel: 3,
      },
    })
    control.updateGroup({
      id: '30001',
      name: '测试群',
      members: [
        {
          participantId: '10001',
          card: '群主名片',
          role: 'owner',
          title: '群主头衔',
          area: '西湖',
          joinTime: 1_650_000_000,
          lastSentTime: 1_660_000_000,
          level: '5',
          unfriendly: false,
          titleExpireTime: 0,
          cardChangeable: true,
        },
        { participantId: '10002', card: '测试用户2', role: 'admin' },
        { participantId: '10003', card: '测试用户3', role: 'member' },
        { participantId: '20001', card: 'ChatLuna', role: 'admin' },
      ],
    })
    control.updateBot({
      id: '20001',
      name: 'ChatLuna',
      implementation: 'napcat',
      enabled: true,
      profile: { personalNote: '机器人签名', sex: 'unknown' },
    })

    await expect(control.bot.internal._request('get_login_info', {})).resolves.toEqual({
      status: 'ok',
      retcode: 0,
      data: {
        user_id: 20001,
        nickname: 'ChatLuna',
        long_nick: '机器人签名',
        sex: 'unknown',
      },
    })

    await expect(control.bot.internal._request('get_stranger_info', { user_id: 10001 })).resolves.toEqual({
      status: 'ok',
      retcode: 0,
      data: {
        user_id: 10001,
        nickname: '测试用户1',
        sex: 'male',
        age: 20,
        qid: 'qid-10001',
        level: 36,
        login_days: 88,
        reg_time: 1_600_000_000,
        long_nick: '用户签名',
        city: '杭州',
        country: '中国',
        birthday_year: 2005,
        birthday_month: 1,
        birthday_day: 2,
        labels: ['沙盒'],
        is_vip: true,
        is_years_vip: true,
        vip_level: 3,
      },
    })

    await expect(control.bot.internal._request('get_friend_list', {})).resolves.toMatchObject({
      status: 'ok',
      retcode: 0,
      data: expect.arrayContaining([
        expect.objectContaining({
          user_id: 10001,
          nickname: '测试用户1',
          long_nick: '用户签名',
          sex: 'male',
          age: 20,
          remark: '',
        }),
      ]),
    })

    await expect(control.bot.internal._request('get_group_member_info', {
      group_id: 30001,
      user_id: 10001,
    })).resolves.toEqual({
      status: 'ok',
      retcode: 0,
      data: {
        group_id: 30001,
        user_id: 10001,
        nickname: '测试用户1',
        card: '群主名片',
        sex: 'male',
        age: 20,
        area: '西湖',
        join_time: 1_650_000_000,
        last_sent_time: 1_660_000_000,
        level: '5',
        role: 'owner',
        unfriendly: false,
        title: '群主头衔',
        title_expire_time: 0,
        card_changeable: true,
        shut_up_timestamp: 0,
      },
    })
  })

  it('导入导出与场景替换保留类型化资料', async () => {
    const control = await createControl()
    control.updateUser({
      id: '10001',
      name: '测试用户1',
      profile: { personalNote: '导出签名', sex: 'female', age: 19 },
    })
    const exported = control.getSnapshot()
    const second = await createControl()
    second.replaceScene(structuredClone(exported))
    expect(second.getSnapshot().participants.find(({ id }) => id === '10001')).toMatchObject({
      profile: { personalNote: '导出签名', sex: 'female', age: 19 },
    })
  })

  it('场景导入剥离未建模 raw 字段，好友备注与群成员资料不覆盖全局昵称', async () => {
    const control = await createControl()
    const dirtyUser = {
      kind: 'user' as const,
      id: '10001',
      name: '全局昵称',
      profile: {
        personalNote: '签名',
        sex: 'male' as const,
        rawApiBlob: { foo: 1 },
      },
    }
    const dirtyMember = {
      participantId: '10001',
      role: 'owner' as const,
      card: '群名片',
      title: '头衔',
      area: '西湖',
      joinTime: 1_700_000_000,
      level: '8',
      host_only_field: 'drop-me',
    }
    control.replaceScene({
      revision: 0,
      participants: [
        dirtyUser as never,
        { kind: 'user', id: '10002', name: '测试用户2' },
        { kind: 'bot', id: '20001', name: 'ChatLuna', implementation: 'napcat', enabled: true },
      ],
      groups: [{
        id: '30001',
        name: '测试群',
        members: [
          dirtyMember as never,
          { participantId: '10002', role: 'member' },
          { participantId: '20001', role: 'admin' },
        ],
        announcements: [],
      }],
      conversations: [
        { id: 'private:10001:20001', type: 'direct', participantIds: ['10001', '20001'], messageIds: [] },
        { id: 'group:30001', type: 'group', groupId: '30001', messageIds: [] },
      ],
      messages: [],
      forwards: [],
      friendships: [{
        id: 'friend:10001:20001',
        participantIds: ['10001', '20001'],
        remarks: { '20001': '机器人备注', '10001': '  ' },
        createdAt: '2026-07-30T00:00:00.000Z',
      }],
      requests: [],
    })

    const user = control.getSnapshot().participants.find(({ id }) => id === '10001')
    expect(user).toMatchObject({
      name: '全局昵称',
      profile: { personalNote: '签名', sex: 'male' },
    })
    expect(JSON.stringify(user)).not.toContain('rawApiBlob')
    expect(control.getSnapshot().friendships[0]?.remarks).toEqual({ '20001': '机器人备注' })
    expect(control.getSnapshot().groups[0]?.members.find(({ participantId }) => participantId === '10001')).toEqual({
      participantId: '10001',
      role: 'owner',
      card: '群名片',
      title: '头衔',
      area: '西湖',
      joinTime: 1_700_000_000,
      level: '8',
    })
    // 群名片/好友备注不改写全局昵称。
    expect(control.getSnapshot().participants.find(({ id }) => id === '10001')?.name).toBe('全局昵称')
  })

  it('MCP 可准备完整类型化资料、好友备注与群成员资料', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { SandboxMcpService } = await import('../src/mcp/service')
    const { SandboxTestSpaceService } = await import('../src/test-spaces')
    const { SandboxRuntimeBotRegistry } = await import('../src/control-service')

    const app = new App()
    runningApps.push(app)
    const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-profile-'))
    const runtimeBots = new SandboxRuntimeBotRegistry()
    const control = new SandboxControlService(app, { runtimeBots })
    const testSpaces = new SandboxTestSpaceService(app, runtimeBots)
    const service = new SandboxMcpService(app, control, { dataDirectory: directory, testSpaces })
    const credential = service.createCredential('资料凭证', ['read', 'manage'])
    const created = await service.callTool(credential.token, 'create_test_space', {
      name: '资料空间',
      idempotencyKey: 'profile-space-1',
    }) as { spaceId: string }

    await service.callTool(credential.token, 'apply_environment_changes', {
      spaceId: created.spaceId,
      expectedRevision: 0,
      idempotencyKey: 'profile-env-1',
      changes: [
        {
          action: 'create-user',
          data: {
            id: '11088',
            name: 'MCP 用户',
            profile: {
              personalNote: 'MCP 签名',
              sex: 'female',
              age: 23,
              city: '深圳',
              labels: ['mcp'],
            },
          },
        },
        {
          action: 'create-bot',
          data: {
            id: '21088',
            name: 'MCP 机器人',
            implementation: 'llbot',
            enabled: true,
            profile: { personalNote: '机器人签名', sex: 'unknown' },
          },
        },
        {
          action: 'create-group',
          data: {
            id: '31088',
            name: 'MCP 群',
            members: [
              {
                participantId: '11088',
                role: 'owner',
                card: '群内称呼',
                title: '测试头衔',
                area: '南山',
                joinTime: 1_710_000_000,
                level: '3',
                host_only: true,
              },
              { participantId: '21088', role: 'admin' },
            ],
          },
        },
        {
          action: 'set-friendship',
          data: {
            firstId: '11088',
            secondId: '21088',
            remarks: { '21088': 'MCP 备注' },
          },
        },
      ],
    })

    const space = testSpaces.getControl(created.spaceId)
    expect(space.getSnapshot().participants.find(({ id }) => id === '11088')).toMatchObject({
      name: 'MCP 用户',
      profile: {
        personalNote: 'MCP 签名',
        sex: 'female',
        age: 23,
        city: '深圳',
        labels: ['mcp'],
      },
    })
    expect(space.getSnapshot().friendships.find(({ participantIds }) => participantIds.includes('11088') && participantIds.includes('21088'))?.remarks)
      .toEqual({ '21088': 'MCP 备注' })
    expect(space.getSnapshot().groups.find(({ id }) => id === '31088')?.members.find(({ participantId }) => participantId === '11088'))
      .toEqual({
        participantId: '11088',
        role: 'owner',
        card: '群内称呼',
        title: '测试头衔',
        area: '南山',
        joinTime: 1_710_000_000,
        level: '3',
      })

    const bot = space.getRuntimeBot('21088')
    await expect(bot.internal._request('get_friend_list', {})).resolves.toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          user_id: 11088,
          nickname: 'MCP 用户',
          remark: 'MCP 备注',
          long_nick: 'MCP 签名',
        }),
      ]),
    })
  })

  it('数据库持久化跨重启恢复类型化资料与备注', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    type Scene = import('../src/types').SandboxSnapshot
    type Status = import('../src/types').SandboxPersistenceStatus
    type ScenePersistence = import('../src/persistence').SandboxScenePersistence

    class TestScenePersistence implements ScenePersistence {
      private scene?: Scene
      private status: Status = { mode: 'database', available: true, persisted: false }
      getStatus() { return { ...this.status } }
      async load() {
        return this.scene
          ? { kind: 'loaded' as const, scene: structuredClone(this.scene) }
          : { kind: 'missing' as const }
      }
      async save(scene: Scene) {
        this.scene = structuredClone(scene)
        this.status.persisted = true
      }
    }

    async function createPersistedControl(persistence: ScenePersistence, mediaDirectory: string) {
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

    const mediaDirectory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-profile-media-'))
    const persistence = new TestScenePersistence()
    const { app: firstApp, control: first } = await createPersistedControl(persistence, mediaDirectory)
    first.createUser({
      id: '10077',
      name: '持久资料用户',
      profile: {
        personalNote: '持久签名',
        sex: 'male',
        age: 30,
        qid: 'qid-persist',
        city: '北京',
      },
    })
    first.createBot({
      id: '20077',
      name: '持久资料机器人',
      implementation: 'napcat',
      enabled: true,
      profile: { personalNote: '机器人持久签名', sex: 'unknown' },
    })
    first.createGroup({
      id: '30077',
      name: '持久资料群',
      members: [
        {
          participantId: '10077',
          role: 'owner',
          card: '持久名片',
          title: '持久头衔',
          area: '朝阳',
          joinTime: 1_720_000_000,
          level: '9',
        },
        { participantId: '20077', role: 'admin' },
      ],
    })
    await first.performFriendAction({
      action: 'set-remark',
      operatorId: '20077',
      targetId: '10077',
      remark: '持久备注',
    })
    await first.waitForPersistence()
    await firstApp.stop()

    const { control: second } = await createPersistedControl(persistence, mediaDirectory)
    expect(second.getSnapshot().participants.find(({ id }) => id === '10077')).toMatchObject({
      name: '持久资料用户',
      profile: {
        personalNote: '持久签名',
        sex: 'male',
        age: 30,
        qid: 'qid-persist',
        city: '北京',
      },
    })
    expect(second.getSnapshot().friendships.find(({ participantIds }) => participantIds.includes('10077') && participantIds.includes('20077'))?.remarks)
      .toEqual({ '20077': '持久备注' })
    expect(second.getSnapshot().groups.find(({ id }) => id === '30077')?.members.find(({ participantId }) => participantId === '10077'))
      .toMatchObject({
        card: '持久名片',
        title: '持久头衔',
        area: '朝阳',
        joinTime: 1_720_000_000,
        level: '9',
      })
  })
})
