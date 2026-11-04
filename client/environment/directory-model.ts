import {
  getSandboxBots,
  getSandboxUsers,
  type SandboxDirectoryBot,
  type SandboxGroup,
  type SandboxSnapshot,
  type SandboxUser,
} from '../../src/types'

/** 一个能提供机器人的环境：主环境或某个 AI 测试空间。 */
export interface SandboxBotDirectorySource {
  id: string
  name: string
  snapshot: Pick<SandboxSnapshot, 'participants'>
}

type ResolveAvatar = (avatar?: string) => string | undefined

function identity(avatar?: string) {
  return avatar
}

/**
 * 主环境与全部 AI 测试空间的机器人合成一张目录。环境管理页与模型请求工作台都按这张
 * 目录展示机器人，因此两处的来源标签、排列顺序与头像解析口径只有一份。
 */
export function buildSandboxBotDirectory(
  mainSnapshot: Pick<SandboxSnapshot, 'participants'>,
  testSpaces: readonly SandboxBotDirectorySource[] = [],
  resolveAvatar: ResolveAvatar = identity,
): SandboxDirectoryBot[] {
  return [
    ...getSandboxBots(mainSnapshot).map((bot) => ({
      ...bot,
      avatar: resolveAvatar(bot.avatar),
      source: { type: 'main' as const, name: '主环境' },
    })),
    ...testSpaces.flatMap((space) => getSandboxBots(space.snapshot).map((bot) => ({
      ...bot,
      avatar: resolveAvatar(bot.avatar),
      source: { type: 'test-space' as const, spaceId: space.id, name: space.name },
    }))),
  ]
}

/** 环境管理页需要的区域视图模型：三份目录，不含完整工作区快照。 */
export interface EnvironmentDirectoryModel {
  users: SandboxUser[]
  bots: SandboxDirectoryBot[]
  groups: SandboxGroup[]
}

export function buildEnvironmentDirectoryModel(
  mainSnapshot: SandboxSnapshot,
  testSpaces: readonly SandboxBotDirectorySource[] = [],
  resolveAvatar: ResolveAvatar = identity,
): EnvironmentDirectoryModel {
  return {
    users: getSandboxUsers(mainSnapshot).map((user) => ({ ...user, avatar: resolveAvatar(user.avatar) })),
    bots: buildSandboxBotDirectory(mainSnapshot, testSpaces, resolveAvatar),
    groups: mainSnapshot.groups.map((group) => ({ ...group, avatar: resolveAvatar(group.avatar) })),
  }
}
