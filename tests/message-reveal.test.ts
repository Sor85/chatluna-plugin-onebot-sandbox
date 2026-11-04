import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureMessageLoaded,
  findMessageElement,
  highlightMessageElement,
  MESSAGE_HIGHLIGHT_MS,
  scrollMessageIntoView,
} from '../client/webqq/message-reveal'

function createMessageRoot(ids: string[]) {
  const nodes = new Map(ids.map((id) => {
    const element = {
      id,
      scrollIntoView: vi.fn(),
    } as unknown as HTMLElement & { scrollIntoView: ReturnType<typeof vi.fn> }
    return [id, element]
  }))
  const root = {
    querySelector(selector: string) {
      const match = selector.match(/^\[data-message-id="(.+)"\]$/)
      if (!match) return null
      return nodes.get(match[1]) ?? null
    },
  } as unknown as ParentNode
  return { root, nodes }
}

describe('消息定位与高亮', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('按 data-message-id 查找消息节点', () => {
    const { root, nodes } = createMessageRoot(['msg:1', 'msg:2'])
    expect(findMessageElement('msg:2', root)).toBe(nodes.get('msg:2'))
    expect(findMessageElement('missing', root)).toBeNull()
  })

  it('高亮命中消息并在超时后清理', () => {
    vi.useFakeTimers()
    const { root, nodes } = createMessageRoot(['msg:9'])
    const element = nodes.get('msg:9')!
    const onHighlight = vi.fn()
    const onClear = vi.fn()
    const result = highlightMessageElement({
      messageId: 'msg:9',
      root,
      onHighlight,
      onClear,
    })

    expect(result.highlighted).toBe(true)
    expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(onHighlight).toHaveBeenCalledWith('msg:9')
    vi.advanceTimersByTime(MESSAGE_HIGHLIGHT_MS)
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('直接滚动元素到视口中心', () => {
    const element = { scrollIntoView: vi.fn() } as unknown as HTMLElement
    scrollMessageIntoView(element)
    expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
  })

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
