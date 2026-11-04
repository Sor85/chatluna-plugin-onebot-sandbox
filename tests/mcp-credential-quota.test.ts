import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from './helpers/app'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SandboxControlService, SandboxRuntimeBotRegistry } from '../src/control-service'
import { SandboxMcpService, type SandboxMcpQuotaConfig } from '../src/mcp/service'
import type { SandboxMcpError } from '../src/mcp/types'

const apps: App[] = []

type QuotaOverrides = Partial<SandboxMcpQuotaConfig>

// 不注入 AI 测试空间服务：此时状态修改与等待类工具落在主场景上，
// 不必先创建空间就能驱动配额判定（配额按凭证与档位计算，与空间无关）。
function createService(quota: QuotaOverrides = {}) {
  const app = new App()
  apps.push(app)
  const directory = mkdtempSync(join(tmpdir(), 'chatluna-sandbox-mcp-quota-'))
  const runtimeBots = new SandboxRuntimeBotRegistry()
  const control = new SandboxControlService(app, { mediaDirectory: join(directory, 'media'), runtimeBots })
  const service = new SandboxMcpService(app, control, { dataDirectory: directory, ...quota })
  // 配额按档位而非能力范围区分，同一凭证需要覆盖四档才能验证互不串用。
  const credential = service.createCredential('配额凭证', ['read', 'interact', 'manage', 'debug'])
  return { app, control, service, credential }
}

function callQuery(service: SandboxMcpService, token: string) {
  return service.callTool(token, 'get_server_info', {})
}

function callMutation(service: SandboxMcpService, control: SandboxControlService, token: string, userId: string) {
  return service.callTool(token, 'apply_environment_changes', {
    expectedRevision: control.getSnapshot().revision,
    // 每位用户一把幂等键：配额用例要的是每次调用都真的执行，不能被幂等缓存挡回去。
    idempotencyKey: `quota-mutation-${userId}`,
    changes: [{ action: 'create-user', data: { id: userId, name: `配额用户 ${userId}` } }],
  })
}

// 等待类调用的配额在等待之前判定，与是否命中事件无关；这里用已存在的事件让
// 调用立刻返回，避免频率用例真的挂到超时。
function callSettledWait(service: SandboxMcpService, token: string, cursor: unknown) {
  return service.callTool(token, 'wait_for_event', { cursor, type: 'scene.changed' })
}

function callBlockingWait(service: SandboxMcpService, token: string) {
  return service.callTool(token, 'wait_for_event', {
    cursor: service.currentCursor(),
    // 事件类型是封闭词汇，因此「等不到」要靠挑一个本用例里不会发生的合法类型，
    // 而不是编一个不存在的名字——后者现在会被判成参数错误。
    type: 'test-space.deleted',
    timeoutSeconds: 1,
  })
}

function callUpload(service: SandboxMcpService, token: string, seed: string) {
  return service.callTool(token, 'upload_media', {
    fileName: `${seed}.txt`,
    mimeType: 'text/plain',
    dataBase64: Buffer.from(`quota-${seed}`).toString('base64'),
  })
}

async function rejection(promise: Promise<unknown>): Promise<SandboxMcpError> {
  return await promise.then(
    () => { throw new Error('调用本应被配额拒绝，但成功返回了') },
    (error: SandboxMcpError) => error,
  )
}

beforeEach(() => {
  // 频率窗口读系统时钟；按 ADR-0066 用测试运行器的假时钟固定基准时刻并推进时间，
  // 不真的等待一分钟，也不注入时钟。shouldAdvanceTime 是必需的：等待类工具与
  // 场景提交都依赖真实排队的定时器。
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-08-28T09:00:00.000Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(apps.splice(0).map((app) => app.stop()))
})

describe('测试凭证调用频率上限', () => {
  it('查询档达到上限后拒绝下一次查询', async () => {
    const { service, credential } = createService({ readPerMinute: 1 })

    await expect(callQuery(service, credential.token)).resolves.toMatchObject({ testApiVersion: 1 })
    expect(await rejection(callQuery(service, credential.token))).toMatchObject({ code: 'rate_limited' })
  })

  it('状态修改档达到上限后拒绝下一次状态修改', async () => {
    const { service, control, credential } = createService({ mutationPerMinute: 1 })

    await expect(callMutation(service, control, credential.token, '10501')).resolves.toMatchObject({ affected: ['create-user'] })
    expect(await rejection(callMutation(service, control, credential.token, '10502'))).toMatchObject({ code: 'rate_limited' })
    expect(control.getSnapshot().participants.some(({ id }) => id === '10502')).toBe(false)
  })

  it('等待档达到上限后拒绝下一次等待', async () => {
    const { service, control, credential } = createService({ waitPerMinute: 1 })
    const cursor = service.currentCursor()
    control.createUser({ id: '10503', name: '事件用户' })

    await expect(callSettledWait(service, credential.token, cursor)).resolves.toMatchObject({ outcome: 'matched' })
    expect(await rejection(callSettledWait(service, credential.token, cursor))).toMatchObject({ code: 'rate_limited' })
  })

  it('媒体上传档达到上限后拒绝下一次上传', async () => {
    const { service, credential } = createService({ uploadPerMinute: 1 })

    await expect(callUpload(service, credential.token, 'first')).resolves.toMatchObject({ mediaId: expect.any(String) })
    expect(await rejection(callUpload(service, credential.token, 'second'))).toMatchObject({ code: 'rate_limited' })
  })

  it('超限拒绝携带可用于重试的结构化等待时间', async () => {
    const { service, credential } = createService({ readPerMinute: 1 })
    await callQuery(service, credential.token)

    const error = await rejection(callQuery(service, credential.token))
    expect(error.retryable).toBe(true)
    expect(error.recovery).toContain('retryAfterMs')
    expect(error.retryAfterMs).toBeGreaterThan(0)
    expect(error.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  it('各档额度互不串用：查询耗尽不影响状态修改、等待与上传', async () => {
    const { service, control, credential } = createService({
      readPerMinute: 1,
      mutationPerMinute: 1,
      waitPerMinute: 1,
      uploadPerMinute: 1,
    })
    const cursor = service.currentCursor()
    control.createUser({ id: '10504', name: '事件用户' })

    await callQuery(service, credential.token)
    expect(await rejection(callQuery(service, credential.token))).toMatchObject({ code: 'rate_limited' })

    await expect(callMutation(service, control, credential.token, '10505')).resolves.toMatchObject({ affected: ['create-user'] })
    await expect(callSettledWait(service, credential.token, cursor)).resolves.toMatchObject({ outcome: 'matched' })
    await expect(callUpload(service, credential.token, 'cross')).resolves.toMatchObject({ mediaId: expect.any(String) })
  })

  it('不同测试凭证的额度互相独立', async () => {
    const { service, credential } = createService({ readPerMinute: 1 })
    const other = service.createCredential('另一个配额凭证', ['read'])

    await callQuery(service, credential.token)
    expect(await rejection(callQuery(service, credential.token))).toMatchObject({ code: 'rate_limited' })

    await expect(callQuery(service, other.token)).resolves.toMatchObject({ testApiVersion: 1 })
  })

  it('时间推进一分钟后额度恢复，调用重新被接受', async () => {
    const { service, credential } = createService({ readPerMinute: 1 })
    await callQuery(service, credential.token)
    const error = await rejection(callQuery(service, credential.token))

    vi.advanceTimersByTime((error.retryAfterMs ?? 60_000) + 1)

    await expect(callQuery(service, credential.token)).resolves.toMatchObject({ testApiVersion: 1 })
  })
})

describe('测试凭证并发上限', () => {
  it('并发状态修改超出上限时以并发超限错误码拒绝', async () => {
    const { service, control, credential } = createService({ maxConcurrentMutations: 1 })
    const revision = control.getSnapshot().revision

    const inFlight = service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision: revision,
      idempotencyKey: 'concurrency-mutation-1',
      changes: [{ action: 'create-user', data: { id: '10601', name: '并发用户甲' } }],
    })
    const error = await rejection(service.callTool(credential.token, 'apply_environment_changes', {
      expectedRevision: revision,
      idempotencyKey: 'concurrency-mutation-2',
      changes: [{ action: 'create-user', data: { id: '10602', name: '并发用户乙' } }],
    }))

    expect(error.code).toBe('concurrency_limited')
    expect(error.code).not.toBe('rate_limited')
    await expect(inFlight).resolves.toMatchObject({ affected: ['create-user'] })
    expect(control.getSnapshot().participants.some(({ id }) => id === '10602')).toBe(false)
  })

  it('并发等待超出上限时被拒绝', async () => {
    const { service, credential } = createService({ maxConcurrentWaits: 1 })

    const inFlight = callBlockingWait(service, credential.token)
    const error = await rejection(callBlockingWait(service, credential.token))

    expect(error.code).toBe('concurrency_limited')
    vi.advanceTimersByTime(1_000)
    await expect(inFlight).resolves.toMatchObject({ outcome: 'timeout', reason: 'timeout' })
  })

  it('并发上传超出上限时被拒绝', async () => {
    const { service, credential } = createService({ maxConcurrentUploads: 1 })

    const inFlight = callUpload(service, credential.token, 'concurrent-a')
    const error = await rejection(callUpload(service, credential.token, 'concurrent-b'))

    expect(error.code).toBe('concurrency_limited')
    await expect(inFlight).resolves.toMatchObject({ mediaId: expect.any(String) })
  })

  it('并发调用结束后额度释放，后续调用重新被接受', async () => {
    const { service, credential } = createService({ maxConcurrentUploads: 1 })

    const inFlight = callUpload(service, credential.token, 'release-a')
    expect(await rejection(callUpload(service, credential.token, 'release-b'))).toMatchObject({ code: 'concurrency_limited' })
    await inFlight

    await expect(callUpload(service, credential.token, 'release-c')).resolves.toMatchObject({ mediaId: expect.any(String) })
  })
})
