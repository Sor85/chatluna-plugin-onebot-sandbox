import { describe, expect, it } from 'vitest'
import { getGroupAuthorityBadge, getGroupMemberDisplayName } from '../client/webqq/group-display'

describe('WebQQ 群身份显示', () => {
  it('群名片优先，空白名片回退全局昵称', () => {
    expect(getGroupMemberDisplayName({ card: ' 群内昵称 ' }, '全局昵称')).toBe('群内昵称')
    expect(getGroupMemberDisplayName({ card: '   ' }, '全局昵称')).toBe('全局昵称')
    expect(getGroupMemberDisplayName(undefined, '全局昵称')).toBe('全局昵称')
  })

  it('消息徽标只显示群主和管理员', () => {
    expect(getGroupAuthorityBadge({ role: 'owner' })).toEqual({ kind: 'owner' })
    expect(getGroupAuthorityBadge({ role: 'admin' })).toEqual({ kind: 'admin' })
    expect(getGroupAuthorityBadge({ role: 'member' })).toBeUndefined()
    expect(getGroupAuthorityBadge(undefined)).toBeUndefined()
  })

  it('专属头衔覆盖徽标文案但保留群身份配色', () => {
    expect(getGroupAuthorityBadge({ role: 'owner', title: ' 创始人 ' })).toEqual({ kind: 'owner', title: '创始人' })
    expect(getGroupAuthorityBadge({ role: 'admin', title: '副群主' })).toEqual({ kind: 'admin', title: '副群主' })
    expect(getGroupAuthorityBadge({ role: 'member', title: '荣誉成员' })).toEqual({ kind: 'title', title: '荣誉成员' })
    expect(getGroupAuthorityBadge({ role: 'member', title: '   ' })).toBeUndefined()
  })
})
