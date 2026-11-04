export interface MessageListScrollAnchor {
  messageId: string
  offsetTop: number
}

export interface MessageListScrollState {
  scrollTop: number
  stickingToBottom: boolean
  anchor?: MessageListScrollAnchor
}

export function calculateAnchoredMessageListScrollTop(input: {
  currentScrollTop: number
  currentAnchorTop: number
  containerTop: number
  savedAnchorOffsetTop: number
}) {
  return input.currentScrollTop
    + input.currentAnchorTop
    - input.containerTop
    - input.savedAnchorOffsetTop
}

const MAX_SCROLL_STATES = 100
const messageListScrollStates = new Map<string, MessageListScrollState>()

export function buildMessageListScrollStateKey(scope: string | undefined, conversationId: string | undefined) {
  return conversationId ? JSON.stringify([scope ?? 'main', conversationId]) : undefined
}

export function readMessageListScrollState(key: string | undefined) {
  if (!key) return undefined
  return messageListScrollStates.get(key)
}

export function writeMessageListScrollState(key: string | undefined, state: MessageListScrollState) {
  if (!key) return
  messageListScrollStates.delete(key)
  messageListScrollStates.set(key, state)
  if (messageListScrollStates.size <= MAX_SCROLL_STATES) return
  const oldestKey = messageListScrollStates.keys().next().value
  if (oldestKey) messageListScrollStates.delete(oldestKey)
}
