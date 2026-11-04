export const USER_AVATAR_SIZE = 36
export const USER_STACK_COLLAPSED_STEP = 21
export const USER_STACK_EXPANDED_STEP = 27

export interface UserStackMetrics {
  collapsedVisibleCount: number
  overflowCount: number
  collapsedWidth: number
  expandedWidth: number
}

export interface UserStackLayoutMetrics {
  collapsedWidth: number
  expandedWidth: number
  addCollapsedRight: number
  addExpandedRight: number
}

export function orderUsersByActive<User extends { id: string }>(users: User[], activeUserId?: string): User[] {
  const activeIndex = users.findIndex(({ id }) => id === activeUserId)
  return activeIndex > 0
    ? [users[activeIndex], ...users.slice(0, activeIndex), ...users.slice(activeIndex + 1)]
    : users
}

// compact：极限窄屏下折叠态只保留当前操作者头像，其余全部并入 +N 省略，
// 保证胶囊剩余宽度足够包住输入框与附件、发送图标。
export function getUserStackMetrics(userCount: number, compact = false): UserStackMetrics {
  const collapsedVisibleCount = Math.min(userCount, compact ? 1 : 3)
  const overflowCount = Math.max(0, userCount - collapsedVisibleCount)
  return {
    collapsedVisibleCount,
    overflowCount,
    collapsedWidth: USER_AVATAR_SIZE
      + Math.max(0, collapsedVisibleCount - 1) * USER_STACK_COLLAPSED_STEP
      + (overflowCount ? USER_STACK_COLLAPSED_STEP : 0),
    expandedWidth: USER_AVATAR_SIZE + Math.max(0, userCount - 1) * USER_STACK_EXPANDED_STEP,
  }
}

export function getUserStackLayoutMetrics(userCount: number, compact = false): UserStackLayoutMetrics {
  const metrics = getUserStackMetrics(userCount, compact)
  const addCollapsedRight = metrics.overflowCount
    ? metrics.collapsedWidth - USER_AVATAR_SIZE
    : userCount * USER_STACK_COLLAPSED_STEP
  const addExpandedRight = userCount * USER_STACK_EXPANDED_STEP
  return {
    collapsedWidth: metrics.overflowCount ? metrics.collapsedWidth : USER_AVATAR_SIZE + addCollapsedRight,
    expandedWidth: USER_AVATAR_SIZE + addExpandedRight,
    addCollapsedRight,
    addExpandedRight,
  }
}
