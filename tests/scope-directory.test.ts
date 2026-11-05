import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import {
  createScopeDirectory,
  type FederatablePage,
  type SceneScope,
} from '../src/scope-directory'
import { SandboxTestSpaceService } from '../src/test-spaces'

const apps: App[] = []
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.stop())))

function createHarness(options: { spaces?: string[] } = {}) {
  const app = new App()
  apps.push(app)
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { runtimeBots })
  const testSpaces = new SandboxTestSpaceService(app, runtimeBots)
  const created = (options.spaces ?? []).map((name) => testSpaces.createSpace({ name }))
  return {
    control,
    testSpaces,
    created,
    directory: createScopeDirectory({ control, testSpaces }),
  }
}

interface Row { readonly id: string, readonly createdAt: string, readonly sequence: number }

function page(records: Row[], extra: Partial<FederatablePage<Row>> = {}): FederatablePage<Row> {
  return {
    records,
    hasMore: false,
    capacity: { recordCount: records.length, totalBytes: 10, maxRecords: 100, maxBytes: 1000 },
    ...extra,
  }
}

const byId = (row: Row) => row.id
const desc = { limit: 10, order: 'desc' as const, tieBreak: (row: Row) => row.sequence }

describe('记录域目录', () => {
  it('清单顺序固定为主环境、各测试空间的创建序', () => {
    const { directory, created } = createHarness({ spaces: ['甲', '乙'] })

    expect(directory.listScenes().map(({ kind, id, name }) => ({ kind, id, name }))).toEqual([
      { kind: 'main', id: 'main', name: '主环境' },
      { kind: 'test-space', id: created[0]!.id, name: '甲' },
      { kind: 'test-space', id: created[1]!.id, name: '乙' },
    ])
  })

  it('缺席的成员不出现在清单里，而不是留一个空洞', () => {
    const app = new App()
    apps.push(app)
    const directory = createScopeDirectory({ control: new SandboxControlService(app) })

    expect(directory.listScenes().map(({ kind }) => kind)).toEqual(['main'])
  })

  it('联邦按清单顺序遍历全部记录域', async () => {
    const { directory } = createHarness({ spaces: ['甲'] })
    const visited: string[] = []

    await directory.federate(async (scope) => {
      visited.push(scope.id)
      return page([])
    }, desc)

    expect(visited).toEqual(directory.listScenes().map(({ id }) => id))
  })

  it('按 createdAt 合并，相同时用第二排序键破平，并跟随排序方向', async () => {
    const { directory } = createHarness({ spaces: ['甲'] })
    const rows: Record<string, Row[]> = {
      main: [{ id: 'a', createdAt: '2026-01-02T00:00:00.000Z', sequence: 1 }, { id: 'c', createdAt: '2026-01-01T00:00:00.000Z', sequence: 2 }],
    }
    const [, space] = directory.listScenes()
    rows[space!.id] = [{ id: 'b', createdAt: '2026-01-01T00:00:00.000Z', sequence: 1 }]
    const read = async (scope: SceneScope) => page(rows[scope.id] ?? [])

    expect((await directory.federate(read, desc)).records.map(byId)).toEqual(['a', 'c', 'b'])
    expect((await directory.federate(read, { ...desc, order: 'asc' })).records.map(byId)).toEqual(['b', 'c', 'a'])
  })

  it('数字第二排序键按数值比较，不按字符串比较', async () => {
    const { directory } = createHarness()
    const same = '2026-01-01T00:00:00.000Z'
    const result = await directory.federate(async () => page([
      { id: 'x', createdAt: same, sequence: 9 },
      { id: 'y', createdAt: same, sequence: 10 },
    ]), { limit: 10, order: 'asc', tieBreak: (row) => row.sequence })

    // 按字符串比较时 '10' < '9'，会把 y 排到前面。
    expect(result.records.map(byId)).toEqual(['x', 'y'])
  })

  it('截断到 limit 时 hasMore 为真，未截断且各记录域都没有更多时为假', async () => {
    const { directory } = createHarness({ spaces: ['甲'] })
    const two = async () => page([
      { id: 'a', createdAt: '2026-01-02T00:00:00.000Z', sequence: 1 },
      { id: 'b', createdAt: '2026-01-01T00:00:00.000Z', sequence: 2 },
    ])

    const truncated = await directory.federate(two, { ...desc, limit: 3 })
    expect(truncated.records.map(byId)).toEqual(['a', 'a', 'b'])
    expect(truncated.hasMore).toBe(true)

    expect((await directory.federate(two, { ...desc, limit: 4 })).hasMore).toBe(false)
  })

  it('任一记录域自己还有更多时，联邦页的 hasMore 也为真', async () => {
    const { directory } = createHarness({ spaces: ['甲'] })
    const [main] = directory.listScenes()

    const result = await directory.federate(async (scope) => page([], { hasMore: scope.id === main!.id }), desc)

    expect(result.records).toEqual([])
    expect(result.hasMore).toBe(true)
  })

  it('容量四字段逐项相加，earliestCursor 取全部记录域里最小的那个', async () => {
    const { directory } = createHarness({ spaces: ['甲', '乙'] })
    const cursors = [7, undefined, 3]
    let index = 0

    const result = await directory.federate(async () => page([], { earliestCursor: cursors[index++] }), desc)

    expect(result.capacity).toEqual({ recordCount: 0, totalBytes: 30, maxRecords: 300, maxBytes: 3000 })
    expect(result.earliestCursor).toBe(3)
  })

  it('全部记录域都没有 earliestCursor 时不编造一个', async () => {
    const { directory } = createHarness({ spaces: ['甲'] })

    expect((await directory.federate(async () => page([]), desc)).earliestCursor).toBeUndefined()
  })

  it('联邦读取前等到全部成员就绪', async () => {
    const { directory, control } = createHarness({ spaces: ['甲'] })
    let released = () => {}
    const gate = new Promise<void>((resolve) => { released = resolve })
    control.waitForPersistence = () => gate
    let read = false

    const federating = directory.federate(async () => { read = true; return page([]) }, desc)
    await Promise.resolve()
    expect(read).toBe(false)

    released()
    await federating
    expect(read).toBe(true)
  })

  it('查找命中主环境后不再读取测试空间', async () => {
    const { directory } = createHarness({ spaces: ['甲', '乙'] })
    const visited: string[] = []

    const hit = await directory.findFirst(async (scope) => {
      visited.push(scope.id)
      return scope.kind === 'main' ? 'main-row' : undefined
    })

    expect(hit).toEqual({ scope: expect.objectContaining({ kind: 'main' }), value: 'main-row' })
    expect(visited).toEqual(['main'])
  })

  it('主环境未命中时继续按顺序找，并带回命中的那个记录域', async () => {
    const { directory, created } = createHarness({ spaces: ['甲', '乙'] })
    const target = created[1]!.id

    const hit = await directory.findFirst(async (scope) => (scope.id === target ? 'space-row' : undefined))

    expect(hit?.value).toBe('space-row')
    expect(hit?.scope).toMatchObject({ kind: 'test-space', id: target, name: '乙' })
  })

  it('全部记录域都未命中时返回 undefined', async () => {
    const { directory } = createHarness({ spaces: ['甲'] })

    expect(await directory.findFirst(async () => undefined)).toBeUndefined()
  })

  /**
   * 收拢前两处实现都用 try/catch 遍历，一个记录域的持久化故障会被当成未命中静默跳过，
   * 最后抛出的是主环境那个错误。现在未命中用 undefined 表达，故障照原样抛出。
   */
  it('读取抛错时原样抛出，不当成未命中继续找', async () => {
    const { directory } = createHarness({ spaces: ['甲'] })
    const visited: string[] = []

    await expect(directory.findFirst(async (scope) => {
      visited.push(scope.id)
      throw new Error('持久化不可用')
    })).rejects.toThrow('持久化不可用')
    expect(visited).toEqual(['main'])
  })

  it('逐个记录域各执行一次，按清单顺序返回结果', async () => {
    const { directory } = createHarness({ spaces: ['甲', '乙'] })

    expect(await directory.forEachScene(async ({ name }) => name)).toEqual(['主环境', '甲', '乙'])
  })
})
