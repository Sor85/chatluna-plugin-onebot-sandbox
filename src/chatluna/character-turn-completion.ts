import type { Context } from 'cordis'
import { identifyCharacterTurnSession } from './character-turn-session'
import { findChatLunaRuntime } from './runtime'

type ReleaseResponseLock = (this: unknown, session: unknown, ...args: unknown[]) => unknown

type CharacterRuntime = Record<string, unknown> & {
  releaseResponseLock: ReleaseResponseLock
}

interface RuntimeState {
  service: CharacterRuntime
  original: ReleaseResponseLock
  wrapper: ReleaseResponseLock
  bindings: Set<RuntimeBinding>
}

interface RuntimeBinding {
  observer: CompletionObserver
  state: RuntimeState
  pending: WeakMap<object, number>
  pendingCount: number
  current: boolean
}

interface CompletionObserver {
  notify: (session: unknown) => void
  bindings: Set<RuntimeBinding>
  current?: RuntimeBinding
  disposed: boolean
}

interface CharacterEventRegistrar {
  (
    event: 'chatluna_character/message_collect',
    listener: (session: unknown) => void,
    options?: { prepend?: boolean },
  ): () => void
}

const runtimeStates = new WeakMap<object, RuntimeState>()

/**
 * 观察 chatluna-character 的 collect 回调真正退出的边界。
 *
 * Character 在 message_collect 后可能先于 before-chat 提前返回，但它自己的 collect 回调无论成功、失败
 * 还是提前返回都会在最外层 finally 调用公开 releaseResponseLock(session)。监听器前置登记 Session 并透明
 * 包装该方法，因此即使已有消费者在事件回调内同步 release，也会先完成 Sandbox 的 begin 与终态通知。
 */
export function observeCharacterTurnCompletion(
  ctx: Context,
  notify: (session: unknown) => void,
): () => void {
  const observer: CompletionObserver = {
    notify,
    bindings: new Set(),
    disposed: false,
  }
  const on = ctx.on.bind(ctx) as unknown as CharacterEventRegistrar
  const disposeListener = on('chatluna_character/message_collect', (session) => {
    if (observer.disposed) return
    const identity = identifyCharacterTurnSession(session)
    if (!identity) return
    const service = findChatLunaRuntime(ctx, 'chatluna_character', acceptCharacterRuntime)
    if (!service) return
    const binding = selectBinding(observer, ensureRuntimeState(service))
    trackSession(binding, identity)
  }, { prepend: true })

  return () => {
    if (observer.disposed) return
    observer.disposed = true
    disposeListener()
    for (const binding of [...observer.bindings]) detachBinding(binding)
    observer.current = undefined
  }
}

function acceptCharacterRuntime(service: Record<string, unknown>): CharacterRuntime | undefined {
  return typeof service.releaseResponseLock === 'function'
    ? service as CharacterRuntime
    : undefined
}

function ensureRuntimeState(service: CharacterRuntime): RuntimeState {
  const existing = runtimeStates.get(service)
  // Studio 也会透明包装同一个方法。只按服务实例复用，允许它位于外层；若按当前方法 identity 判断，
  // 两边会在每轮事件中互相再包一层，调用栈随轮数增长。
  if (existing) return existing

  const original = service.releaseResponseLock
  const state = {
    service,
    original,
    bindings: new Set<RuntimeBinding>(),
  } as RuntimeState
  state.wrapper = function (this: unknown, session: unknown, ...args: unknown[]) {
    // 原实现会在返回前唤醒同 Session waiter，必须在它之前同步收尾；通知失败不得改变 Character 行为。
    for (const binding of [...state.bindings]) {
      if (!consumeSession(binding, session)) continue
      try {
        binding.observer.notify(session)
      } catch {}
      pruneInactiveBinding(binding)
    }
    return original.apply(this, [session, ...args])
  }
  service.releaseResponseLock = state.wrapper
  runtimeStates.set(service, state)
  return state
}

function selectBinding(observer: CompletionObserver, state: RuntimeState): RuntimeBinding {
  if (observer.current?.state === state) return observer.current

  if (observer.current) {
    observer.current.current = false
    pruneInactiveBinding(observer.current)
  }

  let binding = [...observer.bindings].find(candidate => candidate.state === state)
  if (!binding) {
    binding = {
      observer,
      state,
      pending: new WeakMap(),
      pendingCount: 0,
      current: true,
    }
    observer.bindings.add(binding)
    state.bindings.add(binding)
  } else {
    binding.current = true
  }
  observer.current = binding
  return binding
}

function trackSession(binding: RuntimeBinding, session: object): void {
  binding.pending.set(session, (binding.pending.get(session) ?? 0) + 1)
  binding.pendingCount += 1
}

function consumeSession(binding: RuntimeBinding, session: unknown): boolean {
  const identity = identifyCharacterTurnSession(session)
  if (!identity) return false
  const count = binding.pending.get(identity)
  if (!count) return false
  if (count === 1) binding.pending.delete(identity)
  else binding.pending.set(identity, count - 1)
  binding.pendingCount -= 1
  return true
}

function pruneInactiveBinding(binding: RuntimeBinding): void {
  if (binding.current || binding.pendingCount > 0) return
  detachBinding(binding)
}

function detachBinding(binding: RuntimeBinding): void {
  binding.state.bindings.delete(binding)
  binding.observer.bindings.delete(binding)
  if (binding.observer.current === binding) binding.observer.current = undefined
  if (binding.state.bindings.size > 0) return

  const { service, wrapper, original } = binding.state
  // 另一插件的透明 wrapper 可能在外层；卸载时绝不能用自己的 original 覆盖它。
  if (service.releaseResponseLock === wrapper) service.releaseResponseLock = original
  if (runtimeStates.get(service) === binding.state) runtimeStates.delete(service)
}
