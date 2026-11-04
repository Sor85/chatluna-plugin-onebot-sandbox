import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService, type SandboxControlServiceOptions } from '../src/control-service'
import { SandboxDomainError } from '../src/types'

const runningApps: App[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.stop()))
})

async function createControl(options: SandboxControlServiceOptions = {}) {
  const app = new App()
  let control: SandboxControlService | undefined
  app.plugin((ctx) => {
    control = new SandboxControlService(ctx, options)
  })
  runningApps.push(app)
  await app.start()
  if (!control) throw new Error('沙盒控制服务未注册')
  return { app, control }
}

describe('OneBot 调试记录', () => {
  it('记录机器人 action 的规范名、结果与脱敏参数', async () => {
    const { control } = await createControl()
    await control.bot.internal._request('get_login_info', {
      access_token: 'secret-token',
      dataBase64: Buffer.from('binary').toString('base64'),
      message: '这是一段不应完整进入调试记录的消息正文'.repeat(8),
    })

    const page = (await control.getOneBotDebugStore().getRecords({ direction: 'action' }))
    const [record] = page.records
    expect(record).toEqual(expect.objectContaining({
      botId: '20001',
      implementation: 'napcat',
      direction: 'action',
      requestedAction: 'get_login_info',
      action: 'get_login_info',
      status: 'success',
      sequence: 1,
    }))
    expect(record).not.toHaveProperty('matchedAlias')
    expect(JSON.stringify(record.payload)).not.toContain('secret-token')
    // 短 Base64 不再按字段名抹除，完整保留；仅超过阈值的 Base64 在投影层折叠。
    expect(JSON.stringify(record.payload)).toContain(Buffer.from('binary').toString('base64'))
    expect(JSON.stringify(record.payload)).not.toContain('消息正文'.repeat(8))
    expect(record.result).toEqual(expect.objectContaining({
      status: 'ok',
      retcode: 0,
    }))

    control.createBot({ id: '20002', name: 'LLBot 测试机器人', implementation: 'llbot', enabled: true })
    await control.getRuntimeBot('20002').internal._request('get_version_info', {})
    expect((await control.getOneBotDebugStore().getRecords({ botId: '20002' })).records).toContainEqual(expect.objectContaining({
      botId: '20002',
      implementation: 'llbot',
      requestedAction: 'get_version_info',
      action: 'get_version_info',
    }))
  })

  it('记录发送给机器人的原始 OneBot 事件且不写入场景快照', async () => {
    const { control } = await createControl()
    await control.sendMessage({
      operatorId: '10001',
      conversationId: 'private:10001:20001',
      content: '用于调试记录的私聊消息',
    })

    const [record] = (await control.getOneBotDebugStore().getRecords({ direction: 'event', action: 'message.private' })).records
    expect(record).toEqual(expect.objectContaining({
      botId: '20001',
      implementation: 'napcat',
      direction: 'event',
      requestedAction: 'message.private',
      action: 'message.private',
      status: 'success',
      entities: expect.objectContaining({
        userId: '10001',
      }),
    }))
    expect(record.payload).toEqual(expect.objectContaining({
      post_type: 'message',
      message_type: 'private',
      // 正文逐字入库：调试页面要能核对插件收到的报文原文。
      raw_message: '用于调试记录的私聊消息',
      message: [{ type: 'text', data: { text: '用于调试记录的私聊消息' } }],
    }))
    expect(control.getSnapshot()).not.toHaveProperty('oneBotDebugRecords')
  })

  it('错误记录提供稳定 code 与 Logger 可关联 trace，并支持筛选和清理', async () => {
    const { control } = await createControl()

    await expect(control.bot.internal._request('host_only_action', { user_id: 10001 })).rejects.toThrow('不支持 OneBot action')

    const [record] = (await control.getOneBotDebugStore().getRecords({
      botId: '20001',
      direction: 'action',
      requestedAction: 'host_only_action',
      status: 'error',
    })).records
    expect(record.error).toEqual({
      code: 'action_unsupported',
      message: expect.stringContaining('不支持 OneBot action'),
      retryable: false,
      traceId: expect.any(String),
    })
    expect((await control.getOneBotDebugStore().clear())).toBe(1)
    expect((await control.getOneBotDebugStore().getRecords())).toMatchObject({ records: [], hasMore: false })
  })

  it('action 过滤覆盖别名，requestedAction 过滤仅精确匹配', async () => {
    const { control } = await createControl()
    await control.bot.internal._request('friend_poke', { user_id: 10001 })
    await control.bot.internal._request('get_group_info', { group_id: 30001 })

    expect((await control.getOneBotDebugStore().getRecords({ action: 'send_poke' })).records).toContainEqual(expect.objectContaining({
      requestedAction: 'friend_poke',
      action: 'send_poke',
      matchedAlias: 'friend_poke',
      status: 'success',
    }))
    expect((await control.getOneBotDebugStore().getRecords({ action: 'friend_poke' })).records).toContainEqual(expect.objectContaining({
      action: 'send_poke',
      matchedAlias: 'friend_poke',
    }))
    expect((await control.getOneBotDebugStore().getRecords({ requestedAction: 'friend_poke' })).records).toHaveLength(1)
    expect((await control.getOneBotDebugStore().getRecords({
      action: 'send_poke',
      requestedAction: 'get_group_info',
    })).records).toEqual([])
  })

  it('调试记录使用有界内存缓冲区并支持稳定新到旧分页', async () => {
    const { control } = await createControl({ debugRecordLimit: 10 })
    await control.bot.internal._request('get_status', {})
    await control.bot.internal._request('get_login_info', {})
    await control.bot.internal._request('get_version_info', {})
    await control.bot.internal._request('get_friend_list', {})

    const firstPage = (await control.getOneBotDebugStore().getRecords({ limit: 2 }))
    expect(firstPage.records.map(({ requestedAction, sequence }) => ({ requestedAction, sequence }))).toEqual([
      { requestedAction: 'get_friend_list', sequence: 4 },
      { requestedAction: 'get_version_info', sequence: 3 },
    ])
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.nextCursor).toBe(3)

    await control.bot.internal._request('get_group_list', {})
    const secondPage = (await control.getOneBotDebugStore().getRecords({ limit: 2, beforeSequence: firstPage.nextCursor }))
    // 插入新记录后，原分页窗口不会跳过/重复旧记录。
    expect(secondPage.records.map(({ requestedAction, sequence }) => ({ requestedAction, sequence }))).toEqual([
      { requestedAction: 'get_login_info', sequence: 2 },
      { requestedAction: 'get_status', sequence: 1 },
    ])
    expect(secondPage.hasMore).toBe(false)
  })

  it('容量回收后过期游标返回 earliestCursor', async () => {
    const { control } = await createControl({ debugRecordLimit: 2, debugRecordMaxBytes: 50 * 1024 * 1024 })
    await control.bot.internal._request('get_status', {})
    await control.bot.internal._request('get_login_info', {})
    await control.bot.internal._request('get_version_info', {})
    const page = (await control.getOneBotDebugStore().getRecords({ limit: 10 }))
    expect(page.records.map(({ sequence }) => sequence)).toEqual([3, 2])
    expect(page.earliestCursor).toBe(2)
    await expect(control.getOneBotDebugStore().getRecords({ beforeSequence: 1 })).rejects.toThrowError(
      expect.objectContaining({ code: 'cursor_expired', earliestCursor: 2 }),
    )
  })

  it('支持按时间正序或倒序返回调试记录', async () => {
    const { control } = await createControl()
    await control.bot.internal._request('get_status', {})
    await control.bot.internal._request('get_login_info', {})

    expect((await control.getOneBotDebugStore().getRecords({ order: 'asc' })).records.map(({ requestedAction }) => requestedAction)).toEqual([
      'get_status',
      'get_login_info',
    ])
    expect((await control.getOneBotDebugStore().getRecords({ order: 'desc' })).records.map(({ requestedAction }) => requestedAction)).toEqual([
      'get_login_info',
      'get_status',
    ])
  })

  it('正序分页使用 beforeSequence 作为更晚记录的游标', async () => {
    const { control } = await createControl()
    await control.bot.internal._request('get_status', {})
    await control.bot.internal._request('get_login_info', {})
    await control.bot.internal._request('get_version_info', {})
    await control.bot.internal._request('get_friend_list', {})

    const firstPage = (await control.getOneBotDebugStore().getRecords({ limit: 2, order: 'asc' }))
    expect(firstPage.records.map(({ requestedAction, sequence }) => ({ requestedAction, sequence }))).toEqual([
      { requestedAction: 'get_status', sequence: 1 },
      { requestedAction: 'get_login_info', sequence: 2 },
    ])
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.nextCursor).toBe(2)

    await control.bot.internal._request('get_group_list', {})
    const secondPage = (await control.getOneBotDebugStore().getRecords({ limit: 2, order: 'asc', beforeSequence: firstPage.nextCursor }))
    expect(secondPage.records.map(({ requestedAction, sequence }) => ({ requestedAction, sequence }))).toEqual([
      { requestedAction: 'get_version_info', sequence: 3 },
      { requestedAction: 'get_friend_list', sequence: 4 },
    ])
    expect(secondPage.hasMore).toBe(true)
  })

  /**
   * 「这条记录在不在」由记录库判定。两种读取并存而不是互相替代：跨记录域遍历要靠返回空值
   * 区分「这个域里没有」与「这个域坏了」，因此不能只留抛出的那一个。
   */
  it('取不到返回空值与取不到就抛并存，抛的是领域错误且消息含记录标识', async () => {
    const { control } = await createControl()
    const store = control.getOneBotDebugStore()

    expect(await store.getRecord('不存在的记录')).toBeUndefined()
    await expect(store.requireRecord('不存在的记录')).rejects.toThrow(SandboxDomainError)
    await expect(store.requireRecord('不存在的记录')).rejects.toThrow('调试记录不存在：不存在的记录')
  })
})
