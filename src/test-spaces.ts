import { errorDetail } from './error-detail'
import { onDispose, onStart } from './lifecycle'
import { resolveBaseDir } from './base-dir'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from 'cordis'
import { createEmptyScene, SandboxControlService, type SandboxRuntimeBotRegistry } from './control-service'
import type { SandboxOneBotDebugPersistence } from './onebot-debug'
import type { SandboxTestSpacePersistence, SandboxTestSpacePersistenceRecord } from './persistence'
import { trimConversationMessages } from './conversation-resolution'
import type { SandboxSnapshot } from './types'
import { SandboxDomainError, SandboxSpaceNotFoundError } from './types'

export type SandboxTestSpaceStatus = 'running' | 'taken-over' | 'completed' | 'failed'

export interface SandboxTestSpaceSummary {
  id: string
  name: string
  status: SandboxTestSpaceStatus
  createdAt: string
  updatedAt: string
  completedAt?: string
  snapshot: SandboxSnapshot
}

export interface CreateSandboxTestSpaceInput {
  name?: string
}

// Console 每 1.5s 轮询全部空间快照，裁掉历史消息避免带宽随消息量线性增长；MCP 契约仍返回完整快照，不走此函数。
export function trimSnapshotMessages(snapshot: SandboxSnapshot, limit: number): SandboxSnapshot {
  const trimmed = trimConversationMessages(snapshot, limit)
  const messages = snapshot.messages.filter(({ id }) => trimmed.messageIds.has(id))
  const visibleForwardIds = new Set(messages.flatMap(({ forwardId }) => forwardId ? [forwardId] : []))
  return {
    ...snapshot,
    conversations: trimmed.conversations,
    // 实例行必须一起换成投影版本：投影把继承前缀物化进它的消息列表并去掉分叉点，留下权威行
    // 会让消费端拿着「只有自有消息」的列表去拼一份已经被裁过的来源前缀。
    conversationInstances: trimmed.conversationInstances,
    messages,
    forwards: snapshot.forwards.filter(({ id }) => visibleForwardIds.has(id)),
  }
}

export interface SandboxTestSpaceRetention {
  sceneMessageLimit?: number
  sceneMessageMaxBytes?: number
  mediaMaxSize?: number
}

interface SandboxTestSpaceRecord extends Omit<SandboxTestSpaceSummary, 'snapshot'> {
  control: SandboxControlService
}

export class SandboxTestSpaceService {
  private spaces = new Map<string, SandboxTestSpaceRecord>()
  private spaceCreatedListeners = new Set<(spaceId: string, control: SandboxControlService) => void>()
  private occupationListeners = new Set<() => void>()
  private occupied = false
  private persistenceQueue = Promise.resolve()

  constructor(
    private ctx: Context,
    private runtimeBots: SandboxRuntimeBotRegistry,
    private persistence?: SandboxTestSpacePersistence,
    private createDebugPersistence?: (scopeId: string) => SandboxOneBotDebugPersistence,
    private retention: SandboxTestSpaceRetention = {},
  ) {
    onStart(ctx, async () => {
      if (!this.persistence) return
      let records: SandboxTestSpacePersistenceRecord[]
      try {
        records = await this.persistence.loadAll()
      } catch (error) {
        ctx.logger('onebot-sandbox').error('%s\n%s', 'AI 测试空间恢复失败。', errorDetail(error))
        return
      }
      // 逐条隔离：多个已保存空间可能持有同一个机器人 ID，而运行时注册表只允许一个活动
      // 占用者。共用一个 try 会让第一次冲突吞掉后面所有空间，表现为重启后空间凭空消失。
      for (const record of records) {
        try {
          this.restoreSpace(record)
        } catch (error) {
          ctx.logger('onebot-sandbox').error('%s\n%s', `AI 测试空间恢复失败：${record.id}`, errorDetail(error))
        }
      }
    })
    // Koishi 的 dispose 是 fire-and-forget（cordis scope.reset 不 await 任何 disposer），
    // 返回 Promise 不会让宿主等待。这里只保证挂起的写入被显式收尾并把失败写进日志，
    // 而不是静默丢弃；真正的"关机零丢失"需要宿主提供可等待的关机钩子。
    onDispose(ctx, () => {
      void this.persistenceQueue.catch((error) => {
        ctx.logger('onebot-sandbox').error('%s\n%s', 'AI 测试空间关机收尾持久化失败。', errorDetail(error))
      })
      // 内存模式的空间不落盘，重启后无法恢复，它们的媒体目录在关机后纯属垃圾；
      // 不清理会让每次插件重载都在 data/chatluna/onebot-sandbox/spaces 下堆积孤儿目录。
      if (this.persistence) return
      for (const space of this.spaces.values()) this.destroySpaceDirectory(space.id)
    })
  }

  createSpace(input: CreateSandboxTestSpaceInput): SandboxTestSpaceSummary & { control: SandboxControlService } {
    const id = randomUUID()
    const now = new Date().toISOString()
    const control = this.createControl(id, createEmptyScene(), true)
    const record: SandboxTestSpaceRecord = {
      id,
      name: input.name?.trim() || `AI 测试空间 ${this.spaces.size + 1}`,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      control,
    }
    this.spaces.set(id, record)
    this.attachControl(record)
    this.queuePersistence(record)
    this.syncOccupation()
    return { ...this.toSummary(record), control }
  }

  onSpaceCreated(listener: (spaceId: string, control: SandboxControlService) => void): () => void {
    this.spaceCreatedListeners.add(listener)
    return () => this.spaceCreatedListeners.delete(listener)
  }

  isOccupied(): boolean {
    return this.listSpaces().some(({ status }) => status === 'running')
  }

  onOccupationChange(listener: () => void): () => void {
    this.occupationListeners.add(listener)
    return () => this.occupationListeners.delete(listener)
  }

  waitForPersistence(): Promise<void> {
    return this.persistenceQueue
  }

  listSpaces(): SandboxTestSpaceSummary[] {
    return [...this.spaces.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((space) => this.toSummary(space))
  }

  getSpace(spaceId: string): SandboxTestSpaceSummary {
    return this.toSummary(this.requireSpace(spaceId))
  }

  getControl(spaceId: string): SandboxControlService {
    return this.requireSpace(spaceId).control
  }

  requireReadable(spaceId: string): SandboxControlService {
    return this.requireSpace(spaceId).control
  }

  requireAiControl(spaceId: string): SandboxControlService {
    const space = this.requireSpace(spaceId)
    if (space.status === 'taken-over') throw new SandboxDomainError('空间已由用户接管')
    if (space.status !== 'running') throw new SandboxDomainError(`空间当前不可修改：${space.status}`)
    return space.control
  }

  requireUserControl(spaceId: string): SandboxControlService {
    const space = this.requireSpace(spaceId)
    if (space.status !== 'taken-over') throw new SandboxDomainError('请先接管测试空间')
    return space.control
  }

  takeOver(spaceId: string): SandboxTestSpaceSummary {
    return this.setStatus(spaceId, 'taken-over')
  }

  returnControl(spaceId: string): SandboxTestSpaceSummary {
    return this.setStatus(spaceId, 'running')
  }

  // WebUI 空间内任务栏的“终止任务”代表用户主动结束，因此落到 completed 而不是 failed。
  terminateSpace(spaceId: string): SandboxTestSpaceSummary {
    const space = this.requireSpace(spaceId)
    if (space.status === 'completed' || space.status === 'failed') throw new SandboxDomainError('空间已结束')
    space.status = 'completed'
    space.completedAt = new Date().toISOString()
    space.updatedAt = space.completedAt
    space.control.setRuntimeActive(false)
    this.queuePersistence(space)
    this.syncOccupation()
    return this.toSummary(space)
  }

  completeSpace(spaceId: string): SandboxTestSpaceSummary {
    const space = this.requireRunningAiSpace(spaceId)
    space.status = 'completed'
    space.completedAt = new Date().toISOString()
    space.updatedAt = space.completedAt
    space.control.setRuntimeActive(false)
    this.queuePersistence(space)
    this.syncOccupation()
    return this.toSummary(space)
  }

  failSpace(spaceId: string): SandboxTestSpaceSummary {
    const space = this.requireRunningAiSpace(spaceId)
    space.status = 'failed'
    space.completedAt = new Date().toISOString()
    space.updatedAt = space.completedAt
    space.control.setRuntimeActive(false)
    this.queuePersistence(space)
    this.syncOccupation()
    return this.toSummary(space)
  }

  reactivateSpace(spaceId: string, status: 'running' | 'taken-over' = 'taken-over'): SandboxTestSpaceSummary {
    const space = this.requireSpace(spaceId)
    if (space.status !== 'completed' && space.status !== 'failed') throw new SandboxDomainError('只有已完成或失败的空间可以重新激活')
    space.control.setRuntimeActive(true)
    // WebUI 重新激活代表用户接管，MCP 重新激活则必须归还原 AI 控制者；两条入口不能共用隐式默认身份。
    space.status = status
    space.updatedAt = new Date().toISOString()
    delete space.completedAt
    this.queuePersistence(space)
    this.syncOccupation()
    return this.toSummary(space)
  }

  deleteSpace(spaceId: string): void {
    const space = this.requireSpace(spaceId)
    this.spaces.delete(spaceId)
    // 删除空间时清空并落盘独立调试证据，再 dispose，避免恢复到已删空间记录。
    space.control.getOneBotDebugStore().clear()
    void space.control.waitForPersistence().finally(() => {
      void space.control.dispose().finally(() => {
        // 空间目录由本服务分配（spaces/<id>/），删除空间后必须整棵回收，
        // 否则每个被删空间都会留下一份完整的媒体正文占用磁盘。
        this.destroySpaceDirectory(spaceId)
      })
    })
    const persistence = this.persistence
    if (persistence) this.queuePersistenceTask(() => persistence.delete(spaceId))
    this.syncOccupation()
  }

  private setStatus(spaceId: string, status: 'running' | 'taken-over'): SandboxTestSpaceSummary {
    const space = this.requireSpace(spaceId)
    if (space.status === 'completed' || space.status === 'failed') throw new SandboxDomainError('请先重新激活已结束空间')
    space.status = status
    space.updatedAt = new Date().toISOString()
    this.queuePersistence(space)
    this.syncOccupation()
    return this.toSummary(space)
  }

  private createControl(id: string, scene: SandboxSnapshot, runtimeActive: boolean): SandboxControlService {
    return new SandboxControlService(this.ctx, {
      initialScene: scene,
      runtimeActive,
      scopeId: id,
      runtimeBots: this.runtimeBots,
      mediaDirectory: resolve(this.spaceDirectory(id), 'media'),
      debugPersistence: this.createDebugPersistence?.(id),
      // 每个空间独立持有场景消息配额，与主环境和其他空间互不共享。
      sceneMessageLimit: this.retention.sceneMessageLimit,
      sceneMessageMaxBytes: this.retention.sceneMessageMaxBytes,
      mediaMaxSize: this.retention.mediaMaxSize,
    })
  }

  // 每个空间独占 data/chatluna/onebot-sandbox/spaces/<id>/ 整棵子树；回收时必须删到这一层，
  // 只删内部的 media 会留下一串空的 <id>/ 目录持续堆积。
  private spaceDirectory(id: string): string {
    return resolve(resolveBaseDir(this.ctx), 'data/chatluna/onebot-sandbox/spaces', id)
  }

  private destroySpaceDirectory(id: string): void {
    try {
      rmSync(this.spaceDirectory(id), { recursive: true, force: true })
    } catch (error) {
      this.ctx.logger('onebot-sandbox').warn('%s\n%s', `AI 测试空间目录清理失败：${id}`, errorDetail(error))
    }
  }

  private restoreSpace(stored: SandboxTestSpacePersistenceRecord): void {
    if (this.spaces.has(stored.id)) return
    const shouldBeActive = stored.status === 'running' || stored.status === 'taken-over'
    let control: SandboxControlService
    try {
      control = this.createControl(stored.id, stored.scene, shouldBeActive)
    } catch (error) {
      // 机器人 ID 已被其他已恢复空间占用时，仍然恢复这个空间的场景数据，只是不接管运行时。
      // 直接丢弃会让用户的历史测试空间在重启后凭空消失，而它的场景本身完全可读。
      if (!shouldBeActive) throw error
      this.ctx.logger('onebot-sandbox').warn('%s\n%s', `AI 测试空间的机器人运行时不可用，已以停用状态恢复：${stored.id}`, errorDetail(error))
      control = this.createControl(stored.id, stored.scene, false)
    }
    const record: SandboxTestSpaceRecord = {
      id: stored.id,
      name: stored.name,
      status: stored.status,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      // 空串是"未结束"的落盘表示（见 queuePersistence），不能当成真实时间戳恢复。
      completedAt: stored.completedAt || undefined,
      control,
    }
    this.spaces.set(record.id, record)
    this.attachControl(record)
    this.syncOccupation()
  }

  private syncOccupation() {
    const occupied = this.isOccupied()
    if (occupied === this.occupied) return
    this.occupied = occupied
    for (const listener of this.occupationListeners) listener()
  }

  private attachControl(record: SandboxTestSpaceRecord): void {
    record.control.onSceneMutation(() => {
      record.updatedAt = new Date().toISOString()
      this.queuePersistence(record)
    })
    for (const listener of this.spaceCreatedListeners) listener(record.id, record.control)
  }

  private queuePersistence(record: SandboxTestSpaceRecord): void {
    const persistence = this.persistence
    if (!persistence) return
    const stored: SandboxTestSpacePersistenceRecord = {
      id: record.id,
      name: record.name,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      // Minato 的 Model.format() 会丢弃值为 undefined 的字段，upsert 因此不会清空
      // 数据库里的旧 completedAt。reactivateSpace 之后必须显式写空串，否则重启恢复的
      // running/taken-over 空间会带着上一次结束时的 completedAt。
      completedAt: record.completedAt ?? '',
      scene: record.control.getSnapshot(),
    }
    this.queuePersistenceTask(() => persistence.save(stored))
  }

  private queuePersistenceTask(task: () => Promise<void>): void {
    this.persistenceQueue = this.persistenceQueue.then(task).catch((error) => {
      this.ctx.logger('onebot-sandbox').error('%s\n%s', 'AI 测试空间持久化失败。', errorDetail(error))
    })
  }

  private requireRunningAiSpace(spaceId: string): SandboxTestSpaceRecord {
    const space = this.requireSpace(spaceId)
    if (space.status === 'taken-over') throw new SandboxDomainError('空间已由用户接管')
    if (space.status !== 'running') throw new SandboxDomainError(`空间当前不可修改：${space.status}`)
    return space
  }

  private requireSpace(spaceId: string): SandboxTestSpaceRecord {
    const space = this.spaces.get(spaceId)
    if (!space) throw new SandboxSpaceNotFoundError(spaceId)
    return space
  }

  private toSummary(space: SandboxTestSpaceRecord): SandboxTestSpaceSummary {
    return {
      id: space.id,
      name: space.name,
      status: space.status,
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
      completedAt: space.completedAt,
      snapshot: space.control.getSnapshot(),
    }
  }
}
