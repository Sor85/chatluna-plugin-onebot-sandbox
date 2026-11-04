export interface FriendMenuState {
  isFriend: boolean
  pendingOutgoing: boolean
  pendingIncoming: boolean
}

export type FriendMenuAction = 'request' | 'poke' | 'remark' | 'delete'

export function getFriendMenuActions(state: FriendMenuState, includeInteraction: boolean): FriendMenuAction[] {
  if (!state.isFriend) {
    return state.pendingOutgoing || state.pendingIncoming ? [] : ['request']
  }

  return includeInteraction
    ? ['poke', 'remark', 'delete']
    : ['remark', 'delete']
}
