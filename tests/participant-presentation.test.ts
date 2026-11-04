import { describe, expect, it } from 'vitest'
import {
  GROUP_MANAGEMENT_ACTIONS,
  getChatFriendActions,
  getCurrentGroupMember,
  getFriendMenuStateOf,
  getMessageAuthorName,
  getMessageGroupMemberActions,
  getMessageRoleBadge,
  getParticipantAvatar,
  getParticipantName,
  hasGroupMemberManagementActions,
  isBotParticipant,
  type ParticipantPresentationContext,
} from '../client/webqq/participant-presentation'
import type { SandboxGroup, SandboxGroupMember, SandboxGroupRole } from '../src/types'

function member(participantId: string, role: SandboxGroupRole, extra: Partial<SandboxGroupMember> = {}): SandboxGroupMember {
  return { participantId, role, joinedAt: '2026-08-01T00:00:00.000Z', ...extra } as SandboxGroupMember
}

function group(members: SandboxGroupMember[]): SandboxGroup {
  return { id: 'g1', name: '测试群', ownerId: '10001', members, announcements: [] } as unknown as SandboxGroup
}

function context(overrides: Partial<ParticipantPresentationContext> = {}): ParticipantPresentationContext {
  return {
    participants: {
      '10001': { name: '群主昵称', avatar: 'a-owner', isBot: false },
      '20001': { name: '成员昵称', avatar: 'a-member', isBot: false },
      '30001': { name: '机器人', isBot: true },
    },
    friendMenuStates: {},
    currentOperatorId: '10001',
    ...overrides,
  }
}

describe('参与者呈现投影', () => {
  describe('名称与头像', () => {
    it('按参与者目录取名称与头像', () => {
      expect(getParticipantName('20001', context())).toBe('成员昵称')
      expect(getParticipantAvatar('20001', context())).toBe('a-member')
    })

    /** 界面上宁可显示一串 ID 也不显示空白：退群的历史发言者仍要有名字。 */
    it('目录里没有这个人时名称退回标识本身，头像取不到', () => {
      expect(getParticipantName('99999', context())).toBe('99999')
      expect(getParticipantAvatar('99999', context())).toBeUndefined()
    })

    it('没有头像的参与者取不到头像', () => {
      expect(getParticipantAvatar('30001', context())).toBeUndefined()
    })
  })

  describe('机器人判定', () => {
    it('目录标记为机器人的才算机器人；缺失时按非机器人处理', () => {
      expect(isBotParticipant('30001', context())).toBe(true)
      expect(isBotParticipant('20001', context())).toBe(false)
      expect(isBotParticipant('99999', context())).toBe(false)
    })
  })

  describe('群名片与全局昵称的回退', () => {
    it('有群名片时用群名片', () => {
      const withCard = context({ currentGroup: group([member('20001', 'member', { card: '小明' })]) })
      expect(getMessageAuthorName('20001', withCard)).toBe('小明')
    })

    /**
     * 回退按「去空白后为空」判定。只判字段存在会让一张全是空格的群名片顶掉昵称，
     * 表现为消息上的名字整个消失，而且不会报错。
     */
    it('群名片为空白时回退到全局昵称', () => {
      for (const card of ['', '   ', '\t\n']) {
        const blank = context({ currentGroup: group([member('20001', 'member', { card })]) })
        expect(getMessageAuthorName('20001', blank), JSON.stringify(card)).toBe('成员昵称')
      }
    })

    it('不在当前群里（含私聊）时用全局昵称', () => {
      expect(getMessageAuthorName('20001', context())).toBe('成员昵称')
      expect(getMessageAuthorName('20001', context({ currentGroup: group([]) }))).toBe('成员昵称')
    })
  })

  describe('群身份徽标与专属头衔', () => {
    it('群主与管理员各有默认徽标，普通成员没有', () => {
      const members = group([member('10001', 'owner'), member('20001', 'admin'), member('30001', 'member')])
      const withGroup = context({ currentGroup: members })

      expect(getMessageRoleBadge('10001', withGroup)).toEqual({ text: '群主', kind: 'owner' })
      expect(getMessageRoleBadge('20001', withGroup)).toEqual({ text: '管理员', kind: 'admin' })
      expect(getMessageRoleBadge('30001', withGroup)).toBeUndefined()
    })

    /** 头衔占用同一个槽位并覆盖身份文案，但配色仍跟随群身份。 */
    it('专属头衔覆盖身份文案，配色跟随群身份', () => {
      const members = group([member('10001', 'owner', { title: '大家长' }), member('30001', 'member', { title: '活跃王' })])
      const withGroup = context({ currentGroup: members })

      expect(getMessageRoleBadge('10001', withGroup)).toEqual({ text: '大家长', kind: 'owner' })
      expect(getMessageRoleBadge('30001', withGroup)).toEqual({ text: '活跃王', kind: 'title' })
    })

    it('不在群里时没有徽标', () => {
      expect(getMessageRoleBadge('20001', context())).toBeUndefined()
    })
  })

  describe('群成员菜单取数', () => {
    const members = group([member('10001', 'owner'), member('20001', 'member')])

    it('按当前操作者与目标算动作', () => {
      const actions = getMessageGroupMemberActions('20001', context({ currentGroup: members }))
      expect(actions).toContain('mention')
      expect(actions).toContain('kick')
    })

    /** 私聊里点头像不该冒出群操作，已退群的历史发言者那些操作也真的做不到。 */
    it('目标不在当前群里时一个动作都没有', () => {
      expect(getMessageGroupMemberActions('20001', context())).toEqual([])
      expect(getMessageGroupMemberActions('99999', context({ currentGroup: members }))).toEqual([])
    })

    it('当前操作者不在群里时一个动作都没有', () => {
      const outsider = context({ currentGroup: members, currentOperatorId: '99999' })
      expect(getMessageGroupMemberActions('20001', outsider)).toEqual([])
    })

    it('没有当前操作者时一个动作都没有', () => {
      const anonymous = context({ currentGroup: members, currentOperatorId: undefined })
      expect(getMessageGroupMemberActions('20001', anonymous)).toEqual([])
    })

    it('能取到当前群成员记录', () => {
      expect(getCurrentGroupMember('20001', context({ currentGroup: members }))?.role).toBe('member')
      expect(getCurrentGroupMember('20001', context())).toBeUndefined()
    })
  })

  describe('哪六个动作算群管理操作', () => {
    /**
     * 这张表决定头像右键里那个「群成员操作」子菜单出不出现。`mention` 与 `poke` 是互动
     * 而不是管理，它们留在一级菜单里，因此不进表。
     */
    it('表里恰是那六项，不含互动动作', () => {
      expect([...GROUP_MANAGEMENT_ACTIONS]).toEqual([
        'set-card',
        'set-title',
        'set-admin',
        'unset-admin',
        'transfer-owner',
        'kick',
      ])
      expect(GROUP_MANAGEMENT_ACTIONS).not.toContain('mention')
      expect(GROUP_MANAGEMENT_ACTIONS).not.toContain('poke')
    })

    it('群主对普通成员有管理动作，子菜单出现', () => {
      const members = group([member('10001', 'owner'), member('20001', 'member')])
      expect(hasGroupMemberManagementActions('20001', context({ currentGroup: members }))).toBe(true)
    })

    /** 普通成员对普通成员只剩 mention 与 poke，子菜单不该出现。 */
    it('只有互动动作时子菜单不出现', () => {
      const members = group([member('10001', 'member'), member('20001', 'member')])
      expect(getMessageGroupMemberActions('20001', context({ currentGroup: members }))).toEqual(['mention', 'poke'])
      expect(hasGroupMemberManagementActions('20001', context({ currentGroup: members }))).toBe(false)
    })

    it('不在群里时子菜单不出现', () => {
      expect(hasGroupMemberManagementActions('20001', context())).toBe(false)
    })
  })

  describe('好友菜单取数', () => {
    it('投影里没有这个人时按「不是好友、没有待处理申请」处理', () => {
      expect(getFriendMenuStateOf('20001', context())).toEqual({
        isFriend: false,
        pendingOutgoing: false,
        pendingIncoming: false,
      })
      expect(getChatFriendActions('20001', context())).toEqual(['request'])
    })

    it('已经是好友时给出互动、备注与删除', () => {
      const friend = context({
        friendMenuStates: { '20001': { isFriend: true, pendingOutgoing: false, pendingIncoming: false } },
      })
      expect(getChatFriendActions('20001', friend)).toEqual(['poke', 'remark', 'delete'])
    })

    it('有待处理申请时不给发送好友申请', () => {
      const pending = context({
        friendMenuStates: { '20001': { isFriend: false, pendingOutgoing: true, pendingIncoming: false } },
      })
      expect(getChatFriendActions('20001', pending)).toEqual([])
    })
  })
})
