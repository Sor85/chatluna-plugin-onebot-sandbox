import type { SandboxControlService } from './control-service'
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
export const MAIN_SCOPE_ID = 'main'

/**
 * 一份沙盒场景对应的记录域：主模拟 QQ 环境或某个 AI 测试空间，两者都有控制服务。
 *
 * 也带调试记录库：跨记录域读一页或读一条原先要写成「取记录域 → 取控制服务 → 取记录库」，
 * 穿两层只为拿到一个字段。`control` 仍然留着，读取之外的事（等就绪、清场景）还归它。
 */
export interface SceneScope {
  readonly kind: 'main' | 'test-space'
  readonly id: string
  readonly name: string
  readonly control: SandboxControlService
  readonly debugRecords: SandboxOneBotDebugStore
}

/** 容量摘要。各记录域这四个字段同名同义，因此联邦可以直接相加。 */
export interface FederatableCapacity {
  recordCount: number
  totalBytes: number
  maxRecords: number
  maxBytes: number
}

/**
 * 可被联邦的一页。
 *
 * 续页游标刻意不在其中：调试记录的 `sequence` 是每个记录域各自独立的计数，跨记录域比较没有意义，
 * 联邦页因此没有续页游标——精确游标分页必须带显式 spaceId。
 */
export interface FederatablePage<T> {
  readonly records: readonly T[]
  readonly hasMore: boolean
  readonly earliestCursor?: number
  readonly capacity: FederatableCapacity
}

export interface FederatedPage<T> {
  readonly records: T[]
  readonly hasMore: boolean
  readonly earliestCursor?: number
  readonly capacity: FederatableCapacity
}

export interface FederateOptions<T> {
  /** 每页条数。调用方先按自己的记录种类夹紧上限再传进来。 */
  readonly limit: number
  readonly order: 'asc' | 'desc'
  /** 第二排序键：`createdAt` 相同时用它破平。 */
  readonly tieBreak: (record: T) => number
}

/** 在某个记录域上命中的结果。带回 `scope` 是因为调用方要用它拼来源标注。 */
export interface ScopeHit<T> {
  readonly scope: SceneScope
  readonly value: T
}

export interface ScopeDirectory {
  /**
   * 全部记录域，顺序固定：主模拟 QQ 环境 → 各 AI 测试空间（创建序）。
   *
   * 顺序是接口的一部分而不是实现细节：`findFirst` 的「先查主场景」语义就是靠它表达的。
   */
  listScenes(): SceneScope[]
  /** 跨全部沙盒场景读一次并合并成一页。 */
  federate<T extends { readonly createdAt: string }>(
    read: (scope: SceneScope) => Promise<FederatablePage<T>>,
    options: FederateOptions<T>,
  ): Promise<FederatedPage<T>>
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
   * 可选，缺席就是目录里少一批成员，而不是目录里有个空洞。
   *
   * 插件装配传真实例，可选只服务于测试。判空在这里被吸收一次，之后代码里再也
   * 见不到它——这是十一处 `testSpaces?.` / `testSpaces!.` 的去处。
   */
  readonly testSpaces?: SandboxTestSpaceService
}

export function createScopeDirectory({ control, testSpaces }: ScopeDirectoryInput): ScopeDirectory {
  const listScenes = (): SceneScope[] => [
    {
      kind: 'main',
      id: MAIN_SCOPE_ID,
      name: MAIN_SCOPE_NAME,
      control,
      debugRecords: control.getOneBotDebugStore(),
    },
    ...(testSpaces?.listSpaces() ?? []).map(({ id, name }): SceneScope => {
      const spaceControl = testSpaces!.getControl(id)
      return {
        kind: 'test-space',
        id,
        name,
        control: spaceControl,
        debugRecords: spaceControl.getOneBotDebugStore(),
      }
    }),
  ]

  /**
   * 读取前等全部成员就绪。
   *
   * 记录库自己的读取路径已经各自等过自己的就绪，这里额外等到的是场景就绪与场景待写队列。
   * 多等一次已就绪的 Promise 成本接近零，漏等的后果是静默返回空列表，用户会以为记录丢了。
   */
  const awaitReady = async (scopes: readonly SceneScope[]): Promise<void> => {
    await Promise.all(scopes.map(({ control: scopeControl }) => scopeControl.waitForPersistence()))
  }

  return {
    listScenes,

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
function mergeFederatedPages<T extends { readonly createdAt: string }>(
  pages: readonly FederatablePage<T>[],
  { limit, order, tieBreak }: FederateOptions<T>,
): FederatedPage<T> {
  const sign = order === 'asc' ? 1 : -1
  const merged = pages
    .flatMap(({ records }) => [...records])
    .sort((left, right) => sign * (left.createdAt.localeCompare(right.createdAt) || tieBreak(left) - tieBreak(right)))
  const records = merged.slice(0, Math.max(1, limit))
  return {
    records,
    hasMore: merged.length > records.length || pages.some(({ hasMore }) => hasMore),
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
