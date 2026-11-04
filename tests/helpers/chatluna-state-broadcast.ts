import type { App } from './app'
import { Universal } from '@satorijs/core'
import type { SandboxControlService } from '../../src/control-service'

/**
 * 驱动 ChatLuna 状态广播的共享辅助函数。
 *
 * ChatLuna 的思考状态由宿主事件推动，测试必须在真实的 Koishi 事件总线上广播
 * `chatluna/before-chat` 与 `chatluna/after-chat` 才能观察到 thinking 的建立与结束。
 * 状态归属靠 Session 的 selfId 与 channelId 判定，因此 Session 必须来自被测机器人的运行时。
 */
export async function emitChatLunaEvent(app: App, event: string, ...args: unknown[]): Promise<void> {
  await (app.parallel as unknown as (event: string, ...args: unknown[]) => Promise<void>)(event, ...args)
}

export function createGroupSession(control: SandboxControlService, botParticipantId: string, groupId = '30001') {
  return control.getRuntimeBot(botParticipantId).session({
    type: 'message',
    user: { id: '10001', name: '测试用户1' },
    channel: { id: `group:${groupId}`, type: Universal.Channel.Type.TEXT },
    guild: { id: groupId, name: '测试群' },
  })
}

export function createDirectSession(control: SandboxControlService, botParticipantId: string, userId = '10001') {
  return control.getRuntimeBot(botParticipantId).session({
    type: 'message',
    user: { id: userId, name: '测试用户1' },
    channel: { id: `private:${userId}:${botParticipantId}`, type: Universal.Channel.Type.DIRECT },
  })
}
