/**
 * 让 Koishi 的 channel 受理人跟上沙盒的虚拟机器人。
 *
 * Koishi 在跑任何中间件之前有一道门（`@koishijs/core` 的 `Processor.attach`）：群聊会话的
 * `channel.assignee` 不等于收到这条消息的机器人、且这条消息不是字面 `@` 时直接 return——不抛错、
 * 不记日志、被测插件一行都收不到，而沙盒这边 `bot.dispatch()` 照样成功，调试记录也照样是 success。
 * 于是整条会话表现成「只有 @ 能唤醒」，三处无痕，只能靠读 Koishi 源码或查 channel 表定位。
 *
 * `autoAssign` 只在 channel 行**不存在**时把接收者写成受理人，已经存在的过期受理人永远不会被纠正。
 * 而 `group:*` 这些 channelId 完全归沙盒所有：上一次场景里的机器人号、被删掉重加的插件实例都可能
 * 在表里留下一个再也对不上的受理人。因此投递前把它对齐一次，这不是替用户改配置，是清自己的垃圾状态。
 *
 * 只对齐 `assignee`，不动 `flag`：那道门里的 ignore 标记会连 @ 一起挡掉，属于用户显式设下的语义，
 * 沙盒不该替他清。私聊也不对齐：那道门只在 `!session.isDirect` 时生效。
 */

/** 写入 channel 表的一行。`guildId` 一并写上：行不存在时 upsert 只会带上这里给出的列。 */
export interface SandboxChannelAssigneeRow {
  platform: string
  id: string
  assignee: string
  guildId: string
}

export interface SandboxChannelAssigneeTarget {
  /** 收件机器人的标识，也就是这条会话该有的受理人。 */
  botId: string
  /** Koishi 侧的频道标识，等于沙盒的会话 ID。 */
  channelId: string
  groupId: string
}

/**
 * 写 channel 表的那一小片能力。
 *
 * 返回是否真的写了：没有 database 服务时返回 false——那种部署下 Koishi 那道门本身就不生效，
 * 没有可对齐的状态，也不该把「没有数据库」当成一次失败报出来。
 */
export type SandboxChannelAssigneeWriter = (rows: readonly SandboxChannelAssigneeRow[]) => Promise<boolean>

/** 虚拟机器人注册到 Koishi 的平台名。与 {@link SandboxBot} 用的必须是同一个值，否则对齐会写到另一张命名空间里。 */
export const SANDBOX_CHANNEL_PLATFORM = 'onebot'

export class SandboxChannelAssignee {
  /** 已经对齐过的（机器人，频道）。插件重载时连同实例一起丢弃，正好让重载后再对齐一次。 */
  private aligned = new Set<string>()

  constructor(private readonly write: SandboxChannelAssigneeWriter) {}

  /**
   * 对齐一次这条会话的受理人，返回是否真的写了。
   *
   * 每个（机器人，频道）只写一次：受理人一旦对上就不会再自己漂走，而每条消息都打一次数据库
   * 会把投递的成本抬到与消息量同阶。写失败不记账，下一条消息会再试一次。
   */
  async align(target: SandboxChannelAssigneeTarget): Promise<boolean> {
    const key = `${target.botId}|${target.channelId}`
    if (this.aligned.has(key)) return false
    const written = await this.write([{
      platform: SANDBOX_CHANNEL_PLATFORM,
      id: target.channelId,
      assignee: target.botId,
      guildId: target.groupId,
    }])
    if (written) this.aligned.add(key)
    return written
  }
}
