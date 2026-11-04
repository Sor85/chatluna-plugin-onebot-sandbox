import { App } from './helpers/app'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControlService } from '../src/control-service'
import { seedDevelopmentModelRequestErrors } from '../src/model-request-error-preview'

const runningApps: App[] = []
const previousNodeEnv = process.env.NODE_ENV

afterEach(async () => {
  process.env.NODE_ENV = previousNodeEnv
  await Promise.all(runningApps.splice(0).map(app => app.stop()))
})

describe('开发环境 ChatLuna 错误预览', () => {
  it('只在开发环境生成全部错误码，并保持幂等', async () => {
    process.env.NODE_ENV = 'development'
    const app = new App()
    runningApps.push(app)
    const control = new SandboxControlService(app)
    await app.start()

    expect(await seedDevelopmentModelRequestErrors(control.getModelRequestStore())).toBe(11)
    expect(await seedDevelopmentModelRequestErrors(control.getModelRequestStore())).toBe(0)

    const records = (await control.getModelRequestStore().getRecords({ status: 'error', limit: 50 })).records
    expect(records.map(record => record.chatlunaError?.code).sort((a, b) => Number(a) - Number(b))).toEqual([
      1, 2, 100, 101, 102, 103, 104, 301, 303, 307, 309,
    ])
    expect(records.find(record => record.chatlunaError?.code === 102)).toMatchObject({
      provider: 'ChatLuna 102',
      responseStatus: 504,
      chatlunaError: { isTimeout: true },
    })
  })

  it('生产环境不生成模拟证据', async () => {
    process.env.NODE_ENV = 'production'
    const app = new App()
    runningApps.push(app)
    const control = new SandboxControlService(app)
    await app.start()

    expect(await seedDevelopmentModelRequestErrors(control.getModelRequestStore())).toBe(0)
    expect((await control.getModelRequestStore().getRecords()).records).toEqual([])
  })
})
