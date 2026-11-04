import { describe, expect, it } from 'vitest'
import { getGroupAuthorityBadge, getGroupMemberDisplayName, getGroupRoleLabel } from '../client/webqq/group-display'

describe('WebQQ 群身份显示', () => {
  it('群名片优先，空白名片回退全局昵称', () => {
    expect(getGroupMemberDisplayName({ card: ' 群内昵称 ' }, '全局昵称')).toBe('群内昵称')
    expect(getGroupMemberDisplayName({ card: '   ' }, '全局昵称')).toBe('全局昵称')
    expect(getGroupMemberDisplayName(undefined, '全局昵称')).toBe('全局昵称')
  })

  it('角色标签保持详情栏文案，消息徽标只显示群主和管理员', () => {
    expect(getGroupRoleLabel('owner')).toBe('群主')
    expect(getGroupRoleLabel('admin')).toBe('管理员')
    expect(getGroupRoleLabel('member')).toBe('成员')
    expect(getGroupAuthorityBadge({ role: 'owner' })).toEqual({ text: '群主', kind: 'owner' })
    expect(getGroupAuthorityBadge({ role: 'admin' })).toEqual({ text: '管理员', kind: 'admin' })
    expect(getGroupAuthorityBadge({ role: 'member' })).toBeUndefined()
    expect(getGroupAuthorityBadge(undefined)).toBeUndefined()
  })

  it('专属头衔覆盖徽标文案但保留群身份配色', () => {
    expect(getGroupAuthorityBadge({ role: 'owner', title: ' 创始人 ' })).toEqual({ text: '创始人', kind: 'owner' })
    expect(getGroupAuthorityBadge({ role: 'admin', title: '副群主' })).toEqual({ text: '副群主', kind: 'admin' })
    expect(getGroupAuthorityBadge({ role: 'member', title: '荣誉成员' })).toEqual({ text: '荣誉成员', kind: 'title' })
    expect(getGroupAuthorityBadge({ role: 'member', title: '   ' })).toBeUndefined()
  })
})
