import type { SandboxRelationshipRequest, SandboxSnapshot } from '../../src/types'

export interface IncomingNotificationRequests {
  friends: SandboxRelationshipRequest[]
  groups: SandboxRelationshipRequest[]
}

export function getIncomingNotificationRequests(snapshot: SandboxSnapshot, operatorId: string | undefined): IncomingNotificationRequests {
  if (!operatorId) return { friends: [], groups: [] }

  const manageableGroupIds = new Set(snapshot.groups
    .filter(({ members }) => members.some(({ participantId, role }) => participantId === operatorId && (role === 'owner' || role === 'admin')))
    .map(({ id }) => id))

  return {
    friends: snapshot.requests.filter(({ type, targetId }) => type === 'friend' && targetId === operatorId),
    groups: snapshot.requests.filter(({ type, subType, groupId, targetId }) => type === 'group' && !!groupId
      && ((subType === 'invite' && targetId === operatorId) || ((subType ?? 'add') === 'add' && manageableGroupIds.has(groupId)))),
  }
}
