import { describe, expect, it, vi } from 'vitest'
import { ensureMessageLoaded } from '../client/webqq/message-reveal'

describe('引用跳转与搜索定位', () => {
  it('循环加载历史直到消息出现或无法继续', async () => {
    const loaded = new Set<string>(['m3', 'm4'])
    const loadMore = vi.fn(async () => {
      if (!loaded.has('m2')) {
        loaded.add('m2')
        return
      }
      loaded.add('m1')
    })

    const found = await ensureMessageLoaded({
      messageId: 'm1',
      isLoaded: () => loaded.has('m1'),
      canLoadMore: () => !loaded.has('m1'),
      getOldestLoadedMessageId: () => [...loaded].sort()[0],
      loadMore,
    })

    expect(found).toBe(true)
    expect(loadMore).toHaveBeenCalledTimes(2)

    const missing = await ensureMessageLoaded({
      messageId: 'ghost',
      isLoaded: () => false,
      canLoadMore: () => false,
      loadMore: vi.fn(),
    })
    expect(missing).toBe(false)

    const stalledLoad = vi.fn(async () => undefined)
    const stalled = await ensureMessageLoaded({
      messageId: 'ghost',
      isLoaded: () => false,
      canLoadMore: () => true,
      getOldestLoadedMessageId: () => 'm-oldest',
      loadMore: stalledLoad,
      maxAttempts: 5,
    })
    expect(stalled).toBe(false)
    expect(stalledLoad).toHaveBeenCalledTimes(1)
  })
})
