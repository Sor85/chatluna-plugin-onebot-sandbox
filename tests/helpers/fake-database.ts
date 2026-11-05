import { executeQuery } from '@cordisjs/plugin-database'

/**
 * 记录行适配器测试用的 Minato 替身：行存在内存里，但过滤直接交给 Minato 自己的
 * `executeQuery`，因此「数据库适配器」与「内存适配器」的等价断言落在真实查询语义上，
 * 而不是替身自己重写的一套近似匹配。游标选项只实现本仓库用到的 sort/limit/offset/fields。
 */
export interface FakeDatabaseTable {
  rows: Record<string, unknown>[]
  primary: string[]
}

export interface FakeDatabaseCursor {
  limit?: number
  offset?: number
  fields?: string[]
  sort?: Record<string, 'asc' | 'desc'>
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left).localeCompare(String(right))
}

function matchesQuery(row: Record<string, unknown>, query: Record<string, unknown>): boolean {
  return executeQuery(row, query as never, 'row')
}

export class FakeDatabase {
  private tables = new Map<string, FakeDatabaseTable>()
  /** 每次写操作的目标表与行数，供写放大探针断言。 */
  readonly writes: Array<{ operation: 'upsert' | 'remove', table: string, rows: number, bytes: number }> = []

  constructor(definitions: Record<string, string[]>) {
    for (const [table, primary] of Object.entries(definitions)) {
      this.tables.set(table, { rows: [], primary })
    }
  }

  countRows(table: string): number {
    return this.requireTable(table).rows.length
  }

  async get(table: string, query: Record<string, unknown> = {}, cursor: FakeDatabaseCursor = {}) {
    const { rows } = this.requireTable(table)
    let matched = rows.filter((row) => matchesQuery(row, query))
    const sort = Object.entries(cursor.sort ?? {})
    if (sort.length) {
      matched = [...matched].sort((left, right) => {
        for (const [key, direction] of sort) {
          const delta = compareValues(left[key], right[key])
          if (delta !== 0) return direction === 'desc' ? -delta : delta
        }
        return 0
      })
    }
    if (cursor.offset) matched = matched.slice(cursor.offset)
    if (cursor.limit !== undefined) matched = matched.slice(0, cursor.limit)
    const fields = cursor.fields
    return matched.map((row) => structuredClone(fields
      ? Object.fromEntries(fields.map((field) => [field, row[field]]))
      : row)) as never[]
  }

  async upsert(table: string, incoming: Record<string, unknown>[]) {
    const definition = this.requireTable(table)
    this.writes.push({
      operation: 'upsert',
      table,
      rows: incoming.length,
      bytes: Buffer.byteLength(JSON.stringify(incoming), 'utf8'),
    })
    for (const row of incoming) {
      const index = definition.rows.findIndex((existing) => definition.primary.every((key) => existing[key] === row[key]))
      // Minato 的 Model.format() 会丢弃值为 undefined 的字段，替身沿用同一行为。
      const stored = structuredClone(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)))
      if (index >= 0) definition.rows[index] = { ...definition.rows[index], ...stored }
      else definition.rows.push(stored)
    }
  }

  async remove(table: string, query: Record<string, unknown>) {
    const definition = this.requireTable(table)
    const remaining = definition.rows.filter((row) => !matchesQuery(row, query))
    this.writes.push({
      operation: 'remove',
      table,
      rows: definition.rows.length - remaining.length,
      bytes: 0,
    })
    definition.rows = remaining
  }

  private requireTable(table: string): FakeDatabaseTable {
    const definition = this.tables.get(table)
    if (!definition) throw new Error(`替身数据库未注册表：${table}`)
    return definition
  }
}

export function createEvidenceRecordDatabase(): FakeDatabase {
  return new FakeDatabase({
    'onebot_sandbox_debug_record': ['scopeId', 'sequence'],
    'onebot_sandbox_debug_scope': ['scopeId'],
  })
}
