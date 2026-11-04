import type { SandboxControlService } from './control-service'
import { MAIN_MODEL_REQUEST_SCOPE_ID, UNATTRIBUTED_MODEL_REQUEST_SCOPE_ID, type SandboxModelRequestStore } from './model-request'
import type { SandboxOneBotDebugStore } from './onebot-debug'
import type { SandboxTestSpaceService } from './test-spaces'

/**
 * 记录域目录：谁是全部记录域，以及怎么跨记录域读一次。
 *
 * 在此之前「主模拟 QQ 环境 + 全部 AI 测试空间」这件事没有拥有者，`listSpaces().map(getControl)`
 * 在 Console、MCP 与插件装配里各写一遍，分页合并写了两份（一份是导出的函数，一份内联在
 * Console 里），而「测试空间服务可能不存在」的判空散在十一处。本模块把这三件事收成一处。
 *
 * 它是服务端专用：客户端始终带显式 spaceId 定域，联邦是服务端把多个记录域揉成一页之后才
 * 发给前端的，前端没有「全部记录域」这个概念。因此本模块可以自由依赖 Koishi 运行时。
 */

/** 名字取自 Console 现有出参，两者必须一致，否则前端的来源标注会跟着变。 */
export const MAIN_SCOPE_NAME = '主环境'
export const UNATTRIBUTED_SCOPE_NAME = '未归属'

/**
 * 一份沙盒场景对应的记录域：主模拟 QQ 环境或某个 AI 测试空间，两者都有控制服务。
 *
 * 也带两种证据的记录库：跨记录域读一页或读一条原先要写成「取记录域 → 取控制服务 → 取记录库」，
 * 穿两层只为拿到一个字段。两种记录同时带上而不是只带一种——它们的封装程度不该取决于哪一种先写。
 * `control` 仍然留着，读取之外的事（等就绪、清场景）还归它。
 */
export interface SceneScope {
  readonly kind: 'main' | 'test-space'
  readonly id: string
  readonly name: string
  readonly control: SandboxControlService
  readonly records: SandboxModelRequestStore
  readonly debugRecords: SandboxOneBotDebugStore
}

/**
 * 未归属记录域：只有一个模型请求库，没有控制服务，也没有沙盒场景。
 *
 * 用可辨识联合而不是可选的 `control` 字段：后者会把判空从调用点搬进类型，
 * 每个消费方仍要写一次 `scope.control?`，等于换个地方保留同一个坑。
 */
export interface UnattributedScope {
  readonly kind: 'unattributed'
  readonly id: string
  readonly name: string
  readonly records: SandboxModelRequestStore
}

export type RecordScope = SceneScope | UnattributedScope

/** 容量摘要。调试记录页与模型请求页的这四个字段同名同义，因此联邦可以直接相加。 */
export interface FederatableCapacity {
  recordCount: number
  totalBytes: number
  maxRecords: number
  maxBytes: number
}

/**
 * 可被联邦的一页。
 *
 * 只要求四个字段，恰好是调试记录页与模型请求页共有的那四个。续页游标字段刻意不在其中：
 * 模型请求页有 `nextCreatedAt`/`nextId`、调试记录页有 `nextCursor`，形状不同，是否能跨记录域
 * 续页也不同，因此交给调用方按 `FederateOptions.nextCursor` 声明。
 */
export interface FederatablePage<T> {
  readonly records: readonly T[]
  readonly hasMore: boolean
  readonly earliestCursor?: number
  readonly capacity: FederatableCapacity
}

export interface FederatedPage<T, C> {
  readonly records: T[]
  readonly hasMore: boolean
  readonly earliestCursor?: number
  readonly capacity: FederatableCapacity
  /** 续页游标。仅当调用方提供了 `nextCursor` 且确实还有下一页时出现。 */
  readonly next?: C
}

export interface FederateOptions<T, C> {
  /**
   * 每页条数。调用方必须先按自己的记录种类夹紧上限再传进来——调试记录与模型请求的上限不同，
   * 由本模块统一夹会把某一种的上限强加给另一种。
   */
  readonly limit: number
  readonly order: 'asc' | 'desc'
  /**
   * 第二排序键：`createdAt` 相同时用它破平。
   *
   * 模型请求用 `id`，调试记录用 `sequence`。这是两种页唯一的实质差异，用取值函数表达，
   * 而不是把其中一种的键名写进本模块。
   */
  readonly tieBreak: (record: T) => string | number
  /**
   * 续页游标的产出方式。**只在第二排序键跨记录域全局可比时提供。**
   *
   * 模型请求的 `createdAt + id` 全局可比，因此它给得出续页游标，WebQQ 的「加载更多」也确实
   * 在用；调试记录的 `sequence` 是每个记录域各自独立的计数，跨记录域比较没有意义，因此它
   * 不提供本项，联邦页也就没有续页游标——精确游标分页必须带显式 spaceId。
   */
  readonly nextCursor?: (last: T) => C
}

/** 在某个记录域上命中的结果。带回 `scope` 是因为调用方要用它拼来源标注。 */
export interface ScopeHit<T> {
  readonly scope: SceneScope
  readonly value: T
}

export interface ScopeDirectory {
  /**
   * 全部记录域，顺序固定：主模拟 QQ 环境 → 各 AI 测试空间（创建序）→ 未归属。
   *
   * 顺序是接口的一部分而不是实现细节：`findFirst` 的「先查主场景」语义就是靠它表达的，
   * 未归属排在末尾则读起来就是「它不参与联邦」。
   */
  listScopes(): RecordScope[]
  /** 只要有沙盒场景的那些记录域。归属查找与联邦读取都只看这一批。 */
  listScenes(): SceneScope[]
  /**
   * 按记录域标识取模型请求库；标识不属于任何记录域时返回 undefined。
   *
   * 「主模拟 QQ 环境、AI 测试空间、未归属各自的记录库在哪」只有这一处答案。原先它写成按记录
   * 来路三层嵌套的三元表达式，每加一种来路就多一层；现在换一种来路只是换一个标识。
   */
  getModelRequests(scopeId: string): SandboxModelRequestStore | undefined
  /**
   * 跨全部沙盒场景读一次并合并成一页。未归属永不参与——这条规则由本模块拥有，
   * 而不是由每个调用点各写一次 `filter`。
   */
  federate<T extends { readonly createdAt: string }, C>(
    read: (scope: SceneScope) => Promise<FederatablePage<T>>,
    options: FederateOptions<T, C>,
  ): Promise<FederatedPage<T, C>>
  /**
   * 按 `listScenes()` 的顺序找第一个命中的记录域。
   *
   * 未命中用返回 `undefined` 表达，而不是抛错：原先两处实现都用 try/catch 遍历，把「这个
   * 记录域里没有这条记录」和「这个记录域的持久化坏了」混成同一件事，一次真实故障会被当成
   * 未命中静默跳过。现在故障照原样抛出。
   */
  findFirst<T>(read: (scope: SceneScope) => Promise<T | undefined>): Promise<ScopeHit<T> | undefined>
  /**
   * 对每个沙盒场景各执行一次，按 `listScenes()` 的顺序返回结果，供调用方汇总。
   *
   * 只负责遍历。「这个操作要不要先接管空间」是权限策略，留在调用点显式写着——把它藏进
   * 遍历模块，会让读代码的人以为该操作天然不需要接管。
   */
  forEachScene<T>(action: (scope: SceneScope) => Promise<T>): Promise<T[]>
}

export interface ScopeDirectoryInput {
  readonly control: SandboxControlService
  /**
   * 两者都可选，缺席就是目录里少一个成员，而不是目录里有个空洞。
   *
   * 插件装配两条路都传真实例，可选只服务于测试。判空在这里被吸收一次，之后代码里再也
   * 见不到它——这是十一处 `testSpaces?.` / `testSpaces!.` 的去处。
   */
  readonly testSpaces?: SandboxTestSpaceService
  readonly unattributedModelRequests?: SandboxModelRequestStore
}

export function createScopeDirectory({ control, testSpaces, unattributedModelRequests }: ScopeDirectoryInput): ScopeDirectory {
  const listScenes = (): SceneScope[] => [
    {
      kind: 'main',
      id: MAIN_MODEL_REQUEST_SCOPE_ID,
      name: MAIN_SCOPE_NAME,
      control,
      records: control.getModelRequestStore(),
      debugRecords: control.getOneBotDebugStore(),
    },
    ...(testSpaces?.listSpaces() ?? []).map(({ id, name }): SceneScope => {
      const spaceControl = testSpaces!.getControl(id)
      return {
        kind: 'test-space',
        id,
        name,
        control: spaceControl,
        records: spaceControl.getModelRequestStore(),
        debugRecords: spaceControl.getOneBotDebugStore(),
      }
    }),
  ]

  /** 全部记录域，未归属排在末尾；缺席的成员不出现，而不是留一个空洞。 */
  const listScopes = (): RecordScope[] => [
    ...listScenes(),
    ...(unattributedModelRequests
      ? [{
          kind: 'unattributed' as const,
          id: UNATTRIBUTED_MODEL_REQUEST_SCOPE_ID,
          name: UNATTRIBUTED_SCOPE_NAME,
          records: unattributedModelRequests,
        }]
      : []),
  ]

  /**
   * 读取前等全部成员就绪。
   *
   * 记录库自己的读取路径已经各自等过自己的就绪，这里额外等到的是场景就绪与场景待写队列。
   * 原先只有调试记录那条路等，模型请求那条完全不等；两条路必须一致，而在两个方向里选保守
   * 的那个——多等一次已就绪的 Promise 成本接近零，漏等的后果是静默返回空列表，用户会以为
   * 记录丢了。
   */
  const awaitReady = async (scopes: readonly SceneScope[]): Promise<void> => {
    await Promise.all(scopes.map(({ control: scopeControl }) => scopeControl.waitForPersistence()))
  }

  return {
    listScenes,
    listScopes,
    getModelRequests: (scopeId) => listScopes().find(({ id }) => id === scopeId)?.records,

    async federate(read, options) {
      const scenes = listScenes()
      await awaitReady(scenes)
      return mergeFederatedPages(await Promise.all(scenes.map((scope) => read(scope))), options)
    },

    async findFirst(read) {
      const scenes = listScenes()
      await awaitReady(scenes)
      for (const scope of scenes) {
        const value = await read(scope)
        if (value !== undefined) return { scope, value }
      }
      return undefined
    },

    async forEachScene(action) {
      const scenes = listScenes()
      await awaitReady(scenes)
      const results = []
      // 顺序执行而不是 Promise.all：调用方用它做清理这类写操作，逐个完成比并发更容易复盘。
      for (const scope of scenes) results.push(await action(scope))
      return results
    },
  }
}

/**
 * 合并多个记录域各自的一页。
 *
 * 语义逐条对齐收拢前的两份实现：先按 `createdAt` 排序、相同再按第二排序键破平，切到 limit，
 * `hasMore` 取「切掉了东西」或「任一记录域自己还有更多」，`earliestCursor` 取全部记录域里最小
 * 的那个（游标过期恢复要能回到最早一条），`capacity` 四字段逐项相加。
 */
function mergeFederatedPages<T extends { readonly createdAt: string }, C>(
  pages: readonly FederatablePage<T>[],
  { limit, order, tieBreak, nextCursor }: FederateOptions<T, C>,
): FederatedPage<T, C> {
  const sign = order === 'asc' ? 1 : -1
  const merged = pages
    .flatMap(({ records }) => [...records])
    .sort((left, right) => sign * (left.createdAt.localeCompare(right.createdAt) || compareTieBreak(tieBreak(left), tieBreak(right))))
  const records = merged.slice(0, Math.max(1, limit))
  const last = records[records.length - 1]
  const hasMore = merged.length > records.length || pages.some(({ hasMore: pageHasMore }) => pageHasMore)
  const next = hasMore && last && nextCursor ? nextCursor(last) : undefined
  return {
    records,
    hasMore,
    ...(next === undefined ? {} : { next }),
    earliestCursor: pages
      .map(({ earliestCursor }) => earliestCursor)
      .filter((value): value is number => typeof value === 'number')
      .sort((left, right) => left - right)[0],
    capacity: pages.reduce<FederatableCapacity>((summary, { capacity }) => ({
      recordCount: summary.recordCount + capacity.recordCount,
      totalBytes: summary.totalBytes + capacity.totalBytes,
      maxRecords: summary.maxRecords + capacity.maxRecords,
      maxBytes: summary.maxBytes + capacity.maxBytes,
    }), { recordCount: 0, totalBytes: 0, maxRecords: 0, maxBytes: 0 }),
  }
}

/** 第二排序键可以是字符串（模型请求的 id）或数字（调试记录的 sequence），各按自己的序比较。 */
function compareTieBreak(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left).localeCompare(String(right))
}
