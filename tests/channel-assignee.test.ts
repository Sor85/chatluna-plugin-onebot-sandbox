import { describe, expect, it } from 'vitest'
import {
  SANDBOX_CHANNEL_PLATFORM,
  SandboxChannelAssignee,
  type SandboxChannelAssigneeRow,
} from '../src/channel-assignee'

/**
 * 受理人对齐的规则全在「写不写、写什么」上，因此这一族用例不开 Koishi 运行时也不碰数据库：
 * 写入口按注入取得，断言直接落在写过去的那几行上。
 */

function createAssignee(options: { fails?: Error; written?: boolean } = {}) {
  const writes: SandboxChannelAssigneeRow[][] = []
  const assignee = new SandboxChannelAssignee(async (rows) => {
    if (options.fails) throw options.fails
    writes.push([...rows])
    return options.written ?? true
  })
  return { assignee, writes }
}

const TARGET = { botId: '20001', channelId: 'group:30001', groupId: '30001' }

describe('channel 受理人对齐', () => {
  it('把受理人写成收件机器人，并带上平台与群号', async () => {
    const { assignee, writes } = createAssignee()

    await expect(assignee.align(TARGET)).resolves.toBe(true)

    expect(writes).toEqual([[{
      platform: SANDBOX_CHANNEL_PLATFORM,
      id: 'group:30001',
      assignee: '20001',
      guildId: '30001',
    }]])
  })

  it('同一个（机器人，频道）只写一次，避免每条消息都打一次数据库', async () => {
    const { assignee, writes } = createAssignee()

    await assignee.align(TARGET)
    await expect(assignee.align(TARGET)).resolves.toBe(false)
    await assignee.align(TARGET)

    expect(writes).toHaveLength(1)
  })

  it('同一个频道换一个机器人时照样对齐：受理人是按机器人判定的', async () => {
    const { assignee, writes } = createAssignee()

    await assignee.align(TARGET)
    await assignee.align({ ...TARGET, botId: '20002' })

    expect(writes.flat().map(({ assignee: value }) => value)).toEqual(['20001', '20002'])
  })

  it('没有 database 服务时不记账，之后装上了还会再试', async () => {
    const writes: SandboxChannelAssigneeRow[][] = []
    let hasDatabase = false
    const assignee = new SandboxChannelAssignee(async (rows) => {
      if (!hasDatabase) return false
      writes.push([...rows])
      return true
    })

    await expect(assignee.align(TARGET)).resolves.toBe(false)
    hasDatabase = true
    await expect(assignee.align(TARGET)).resolves.toBe(true)

    expect(writes).toHaveLength(1)
  })

  it('写失败不记账，下一条消息会再试一次', async () => {
    const failure = new Error('数据库不可用')
    let fail = true
    const writes: SandboxChannelAssigneeRow[][] = []
    const assignee = new SandboxChannelAssignee(async (rows) => {
      if (fail) throw failure
      writes.push([...rows])
      return true
    })

    await expect(assignee.align(TARGET)).rejects.toBe(failure)
    fail = false
    await expect(assignee.align(TARGET)).resolves.toBe(true)

    expect(writes).toHaveLength(1)
  })
})
