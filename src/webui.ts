import type { Context } from 'cordis'
import type {} from '@chatluna/ui-server'
import { ApiError } from '@chatluna/server'
import type { SandboxConsoleBroadcasts, SandboxConsoleEvents } from './console-contract'
import type { SandboxConsoleRegistrar } from './console'
import { SandboxDomainError } from './types'

/**
 * WebUI 的失效信号：服务端只广播「哪个空间变了」与 MCP 活动，客户端按需重新读取工作区。
 *
 * 场景键用空串表示主环境；值是单调递增的变更序号而不是场景修订号，因为 ChatLuna 等待态这类
 * 瞬时变化不推进修订号，却同样需要客户端刷新。
 */
export interface SandboxSignal {
  scenes: Record<string, number>
  mcpRunning: boolean
}

export const SIGNAL_STATE = 'onebot-sandbox.signal'

/** 领域错误是调用方可以修正的输入问题，映射成 400；其余异常保持 500 并由服务端记录堆栈。 */
function toApiError(error: unknown): unknown {
  if (error instanceof ApiError) return error
  if (error instanceof SandboxDomainError || (error instanceof Error && error.constructor === Error)) {
    return new ApiError('INVALID_ARGUMENT', error.message)
  }
  return error
}

/** 把 Console 契约接到 ChatLuna WebUI：端点注册为 action，广播折叠进一个实时 state。 */
export function createWebuiRegistrar(ctx: Context): SandboxConsoleRegistrar {
  const signal: SandboxSignal = { scenes: {}, mcpRunning: false }
  let tick = 0
  ctx.chatluna_webui.state(SIGNAL_STATE, { get: () => signal })
  return {
    addEntry() {
      return ctx.chatluna_webui.addEntry({
        baseUrl: import.meta.url,
        source: '../client/index.ts',
        bundle: '../dist/client.js',
      })
    },
    addListener(event, callback) {
      const handler: (input: unknown) => Promise<unknown> = async (input) => {
        try {
          return await Reflect.apply(callback, undefined, [input ?? undefined])
        } catch (error) {
          throw toApiError(error)
        }
      }
      // 契约逐端点的签名已由 registerConsole 约束；这里只做错误映射，统一以宽签名登记。
      return ctx.chatluna_webui.action(event, {}, handler as never)
    },
    broadcast<Channel extends keyof SandboxConsoleBroadcasts>(type: Channel, body: SandboxConsoleBroadcasts[Channel]) {
      if (type === 'onebot-sandbox.scene-mutated') {
        const { spaceId } = body as SandboxConsoleBroadcasts['onebot-sandbox.scene-mutated']
        signal.scenes = { ...signal.scenes, [spaceId ?? '']: ++tick }
      } else {
        signal.mcpRunning = (body as SandboxConsoleBroadcasts['onebot-sandbox.mcp-activity']).running
      }
      ctx.chatluna_webui.refresh(SIGNAL_STATE)
    },
  }
}

declare module '@chatluna/ui-client/client' {
  interface States {
    'onebot-sandbox.signal': SandboxSignal
  }
  interface Actions extends SandboxConsoleEvents {}
}
