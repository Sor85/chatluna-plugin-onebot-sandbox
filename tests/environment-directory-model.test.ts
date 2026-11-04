import { describe, expect, it } from 'vitest'
import {
  buildEnvironmentDirectoryModel,
  buildSandboxBotDirectory,
} from '../client/environment/directory-model'
import type { SandboxSnapshot } from '../src/types'

function snapshot(overrides: Partial<SandboxSnapshot> = {}): SandboxSnapshot {
  return {
    revision: 1,
    participants: [],
    groups: [],
    conversations: [],
    messages: [],
    friendships: [],
    requests: [],
    ...overrides,
  }
}

function user(id: string, name: string, avatar?: string) {
  return { id, name, kind: 'user' as const, avatar }
}

function bot(id: string, name: string, avatar?: string) {
  return {
    id,
    name,
    kind: 'bot' as const,
    avatar,
    implementation: 'napcat' as const,
    enabled: true,
  }
}

function group(id: string, name: string, memberIds: string[], avatar?: string) {
  return {
    id,
    name,
    avatar,
    ownerId: memberIds[0] ?? '',
    members: memberIds.map((participantId) => ({ participantId, role: 'member' as const })),
    announcements: [],
  }
}

describe('环境目录区域模型', () => {
  it('机器人目录先列主环境再按空间顺序列测试空间，并标注来源', () => {
    const main = snapshot({ participants: [user('10001', '用户一'), bot('20001', '主机器人')] })
    const spaces = [
      { id: 'space-a', name: '空间甲', snapshot: snapshot({ participants: [bot('20002', '甲机器人')] }) },
      { id: 'space-b', name: '空间乙', snapshot: snapshot({ participants: [bot('20003', '乙机器人')] }) },
    ]

    expect(buildSandboxBotDirectory(main, spaces).map(({ id, source }) => [id, source])).toEqual([
      ['20001', { type: 'main', name: '主环境' }],
      ['20002', { type: 'test-space', spaceId: 'space-a', name: '空间甲' }],
      ['20003', { type: 'test-space', spaceId: 'space-b', name: '空间乙' }],
    ])
  })

  it('机器人目录只收机器人，普通用户不进目录', () => {
    const main = snapshot({ participants: [user('10001', '用户一'), bot('20001', '主机器人')] })

    expect(buildSandboxBotDirectory(main).map(({ id }) => id)).toEqual(['20001'])
  })

  it('测试空间里的机器人头像与主环境一样经过解析', () => {
    const main = snapshot({ participants: [bot('20001', '主机器人', 'sandbox-media://main')] })
    const spaces = [{
      id: 'space-a',
      name: '空间甲',
      snapshot: snapshot({ participants: [bot('20002', '甲机器人', 'sandbox-media://space')] }),
    }]

    const directory = buildSandboxBotDirectory(main, spaces, (avatar) => `resolved:${avatar}`)

    expect(directory.map(({ avatar }) => avatar)).toEqual([
      'resolved:sandbox-media://main',
      'resolved:sandbox-media://space',
    ])
  })

  it('省略头像解析函数时保留原始引用', () => {
    const main = snapshot({ participants: [bot('20001', '主机器人', 'sandbox-media://main')] })

    expect(buildSandboxBotDirectory(main)[0]?.avatar).toBe('sandbox-media://main')
  })

  it('环境目录的用户与群组只取当前工作区，机器人跨全部空间', () => {
    const current = snapshot({
      participants: [user('10001', '用户一'), bot('20001', '主机器人')],
      groups: [group('30001', '群一', ['10001'])],
    })
    const spaces = [{
      id: 'space-a',
      name: '空间甲',
      snapshot: snapshot({
        participants: [user('10002', '空间用户'), bot('20002', '甲机器人')],
        groups: [group('30002', '空间群', ['10002'])],
      }),
    }]

    const directory = buildEnvironmentDirectoryModel(current, spaces)

    expect(directory.users.map(({ id }) => id)).toEqual(['10001'])
    expect(directory.groups.map(({ id }) => id)).toEqual(['30001'])
    expect(directory.bots.map(({ id }) => id)).toEqual(['20001', '20002'])
  })

  it('环境目录对用户、机器人与群组三处头像都做解析', () => {
    const current = snapshot({
      participants: [user('10001', '用户一', 'sandbox-media://u'), bot('20001', '主机器人', 'sandbox-media://b')],
      groups: [group('30001', '群一', ['10001'], 'sandbox-media://g')],
    })

    const directory = buildEnvironmentDirectoryModel(current, [], (avatar) => `resolved:${avatar}`)

    expect(directory.users[0]?.avatar).toBe('resolved:sandbox-media://u')
    expect(directory.bots[0]?.avatar).toBe('resolved:sandbox-media://b')
    expect(directory.groups[0]?.avatar).toBe('resolved:sandbox-media://g')
  })

  it('群组保留成员数量供计数展示', () => {
    const current = snapshot({ groups: [group('30001', '群一', ['10001', '10002', '10003'])] })

    expect(buildEnvironmentDirectoryModel(current, []).groups[0]?.members).toHaveLength(3)
  })
})
