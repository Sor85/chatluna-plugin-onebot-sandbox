/**
 * 证据记录行库的共享机制。OneBot 调试记录与模型请求记录都按行持久化，两者的
 * 「作用域摘要 + 按最旧回收」和「串行写入队列」语义完全一致，差异只在记录类型与过滤谓词；
 * 这些机制放在这里，内存适配器、数据库适配器与两个 Store 共用同一份实现。
 */

export interface SandboxRecordScopeSummary {
  /** 作用域内下一个可用序号；不因回收或清理而回退。 */
  nextSequence: number
  recordCount: number
  /** 全部记录完整持久化内容的字节数之和。 */
  totalBytes: number
  earliestSequence?: number
}

export interface SandboxRecordCapacityLimits {
  maxRecords: number
  maxBytes: number
}

/**
 * 作用域行索引：只保存每行的序号与体积。容量统计与回收决策只需要这两列，缓存后追加
 * 就不必回表统计，否则「一次追加一行」会换来「一次追加扫一遍元数据」。
 * 每个作用域只有一个适配器实例在写，索引因此可以作为权威值维护。
 */
export class ScopeRowIndex {
  private rows: Array<{ sequence: number, bytes: number }> = []
  private nextSequence = 1

  reset(rows: Array<{ sequence: number, bytes: number }>, persistedNextSequence: number): void {
    this.rows = rows
      .map(({ sequence, bytes }) => ({ sequence: Number(sequence), bytes: Number(bytes) || 0 }))
      .sort((left, right) => left.sequence - right.sequence)
    this.nextSequence = Math.max(
      1,
      persistedNextSequence,
      this.rows.reduce((max, row) => Math.max(max, row.sequence + 1), 1),
    )
  }

  put(sequence: number, bytes: number, nextSequence = 0): void {
    const index = this.rows.findIndex((row) => row.sequence === sequence)
    if (index >= 0) this.rows[index] = { sequence, bytes }
    else {
      this.rows.push({ sequence, bytes })
      this.rows.sort((left, right) => left.sequence - right.sequence)
    }
    this.nextSequence = Math.max(this.nextSequence, nextSequence, sequence + 1)
  }

  has(sequence: number): boolean {
    return this.rows.some((row) => row.sequence === sequence)
  }

  clear(nextSequence: number): void {
    this.rows = []
    this.nextSequence = Math.max(this.nextSequence, nextSequence)
  }

  /** 从最旧开始试算，返回需要一并删除的最大序号；索引在删除成功后才由 dropThrough 收敛。 */
  resolveCutoff(limits: SandboxRecordCapacityLimits): number | undefined {
    let count = this.rows.length
    let totalBytes = this.totalBytes()
    let cutoff: number | undefined
    for (const row of this.rows) {
      if (count <= limits.maxRecords && totalBytes <= limits.maxBytes) break
      cutoff = row.sequence
      totalBytes -= row.bytes
      count -= 1
    }
    return cutoff
  }

  dropThrough(cutoff: number): void {
    this.rows = this.rows.filter((row) => row.sequence > cutoff)
  }

  readNextSequence(): number {
    return this.nextSequence
  }

  summary(): SandboxRecordScopeSummary {
    return {
      nextSequence: this.nextSequence,
      recordCount: this.rows.length,
      totalBytes: this.totalBytes(),
      ...(this.rows.length ? { earliestSequence: this.rows[0]!.sequence } : {}),
    }
  }

  private totalBytes(): number {
    return this.rows.reduce((sum, row) => sum + row.bytes, 0)
  }
}

export interface SandboxRecordRowsQuery {
  order: 'asc' | 'desc'
  limit: number
}

interface SandboxRecordRow {
  id: string
  sequence: number
}

/**
 * 进程内记录行库。内存持久化模式与数据库不可用时的降级路径共用这一份语义，
 * 容量与回收决策复用 ScopeRowIndex，因此与数据库适配器给出一致的摘要。
 */
export class InMemoryRecordRows<Record extends SandboxRecordRow, Query extends SandboxRecordRowsQuery> {
  private bodies = new Map<number, Record>()
  private index = new ScopeRowIndex()

  constructor(private matches: (record: Record, query: Query) => boolean) {}

  async summarize(): Promise<SandboxRecordScopeSummary> {
    return this.index.summary()
  }

  async append(record: Record, bytes: number, nextSequence: number): Promise<SandboxRecordScopeSummary> {
    this.bodies.set(record.sequence, structuredClone(record))
    this.index.put(record.sequence, bytes, nextSequence)
    return this.index.summary()
  }

  async find(recordId: string): Promise<Record | undefined> {
    for (const record of this.bodies.values()) {
      if (record.id === recordId) return structuredClone(record)
    }
  }

  async replace(record: Record, bytes: number): Promise<SandboxRecordScopeSummary> {
    // 只有仍然存在的行才回写；否则容量回收删掉的记录会被 update 复活。
    if (this.index.has(record.sequence)) {
      this.bodies.set(record.sequence, structuredClone(record))
      this.index.put(record.sequence, bytes)
    }
    return this.index.summary()
  }

  async query(query: Query): Promise<Record[]> {
    return this.select(query).map((record) => structuredClone(record))
  }

  /**
   * 只读出记录的一部分。投影先在存有的行上执行，再拷贝投影结果，因此读取路径不需要的子树
   * （模型请求的请求体与响应原文）既不会被深拷贝，也不会被交给调用方。
   */
  async queryProjected<Projected>(query: Query, project: (record: Record) => Projected): Promise<Projected[]> {
    return this.select(query).map((record) => structuredClone(project(record)))
  }

  private select(query: Query): Record[] {
    return [...this.bodies.values()]
      .filter((record) => this.matches(record, query))
      .sort((left, right) => (query.order === 'asc' ? 1 : -1) * (left.sequence - right.sequence))
      .slice(0, Math.max(0, query.limit))
  }

  async reclaim(limits: SandboxRecordCapacityLimits): Promise<SandboxRecordScopeSummary> {
    const cutoff = this.index.resolveCutoff(limits)
    if (cutoff !== undefined) {
      for (const sequence of [...this.bodies.keys()]) {
        if (sequence <= cutoff) this.bodies.delete(sequence)
      }
      this.index.dropThrough(cutoff)
    }
    return this.index.summary()
  }

  async clear(nextSequence: number): Promise<SandboxRecordScopeSummary> {
    this.bodies.clear()
    this.index.clear(nextSequence)
    return this.index.summary()
  }
}

/**
 * 串行写入队列。所有写入都排在首次恢复之后并依次执行，读取等待同一条队列稳定，
 * 因此读取总能看到已提交状态，而 append 仍可以同步返回记录。
 */
export class SerialWriteQueue {
  private queue = Promise.resolve()

  constructor(private ready: Promise<void>) {}

  /** 队列任务可能在等待期间继续追加（例如 append 之后的容量回收），必须等到队列稳定。 */
  async settle(): Promise<void> {
    await this.ready
    for (let guard = 0; guard < 1000; guard += 1) {
      const queue = this.queue
      await queue
      if (queue === this.queue) return
    }
  }

  /** 写入失败不能变成未处理的 Promise 拒绝：证据落盘是旁路能力，不应影响调用方。 */
  push(task: () => Promise<void>): void {
    void this.run(task).catch(() => undefined)
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.ready).then(task)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
