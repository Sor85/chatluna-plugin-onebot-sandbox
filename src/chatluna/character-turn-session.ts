const identityKey = Symbol('chatluna-sandbox.character-turn-session')

/**
 * Cordis 会按监听器 Context 为 Koishi Session 建立不同的透明 Proxy。把不可枚举代次对象写到原 Session
 * 上，能让 message_collect、before/after-chat 与 release 收到的各层 Proxy 解析到同一身份；对象展开得到的
 * 克隆不会继承它，因此仍不能冒充原 Session。
 */
export function identifyCharacterTurnSession(session: unknown): object | undefined {
  if (!session || typeof session !== 'object') return
  const record = session as Record<PropertyKey, unknown>
  const existing = record[identityKey]
  if (existing && typeof existing === 'object') return existing
  const identity = {}
  try {
    Object.defineProperty(session, identityKey, { value: identity })
    return identity
  } catch {
    // 非标准冻结 Session 无法携带身份；退回对象本身仍保持不猜测，只是不能跨不同 Proxy 关联。
    return session
  }
}
