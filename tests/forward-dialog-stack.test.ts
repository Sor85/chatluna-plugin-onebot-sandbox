import { describe, expect, it } from 'vitest'
import {
  closeForwardStack,
  loadForwardDialogFrame,
  pushForwardFrame,
  type ForwardDialogFrame,
} from '../client/webqq/forward-dialog-stack'
import type { SandboxForward, SandboxForwardNode } from '../src/types'

function node(nickname: string, content: string, forwardId?: string): SandboxForwardNode {
  return { userId: '10001', nickname, content, createdAt: '2026-08-30T09:00:00.000Z', ...(forwardId ? { forwardId } : {}) }
}

function forward(id: string, nodes: SandboxForwardNode[]): SandboxForward {
  return { id, authorId: '10001', createdAt: '2026-08-30T09:00:00.000Z', nodes }
}

function frame(title: string): ForwardDialogFrame {
  return { title, items: [], nestedForwards: {} }
}

describe('合并转发对话栈', () => {
  describe('推入', () => {
    /**
     * 从消息气泡打开的是一条新的转发链，把它压在旧链后面会让关掉上层后露出一条无关的转发。
     */
    it('根消息重置整条历史', () => {
      const stack = pushForwardFrame([frame('旧一'), frame('旧二')], frame('新'), 'replace')
      expect(stack.map(({ title }) => title)).toEqual(['新'])
    })

    it('嵌套详情压栈', () => {
      const stack = pushForwardFrame([frame('一')], frame('二'), 'push')
      expect(stack.map(({ title }) => title)).toEqual(['一', '二'])
    })

    it('不就地修改原栈', () => {
      const before = [frame('一')]
      pushForwardFrame(before, frame('二'), 'push')
      expect(before.map(({ title }) => title)).toEqual(['一'])
    })
  })

  describe('关闭', () => {
    it('关闭清空整条历史，弹窗随之关闭', () => {
      expect(closeForwardStack()).toEqual([])
    })
  })

  describe('按入参读一帧', () => {
    const flat = forward('f1', [node('甲', '一'), node('乙', '二')])

    it('按转发资源标识读取', async () => {
      const seen: unknown[] = []
      const result = await loadForwardDialogFrame({
        input: { forwardId: 'f1' },
        load: async (input) => { seen.push(input); return flat },
      })

      expect(seen).toEqual([{ forwardId: 'f1' }])
      expect(result?.items.map(({ content }) => content)).toEqual(['一', '二'])
      expect(result?.title).toBe('群聊的聊天记录')
    })

    it('按消息标识读取', async () => {
      const seen: unknown[] = []
      await loadForwardDialogFrame({
        input: { messageId: 'm1', forwardId: 'f1' },
        load: async (input) => { seen.push(input); return flat },
      })

      expect(seen).toEqual([{ messageId: 'm1', forwardId: 'f1' }])
    })

    it('嵌套节点的转发资源一并预读', async () => {
      const nested = forward('f2', [node('丙', '深一层')])
      const outer = forward('f1', [node('甲', '一'), node('乙', '[合并转发]', 'f2')])
      const result = await loadForwardDialogFrame({
        input: { forwardId: 'f1' },
        load: async (input) => (input.forwardId === 'f2' ? nested : outer),
      })

      expect(Object.keys(result!.nestedForwards)).toEqual(['f2'])
      expect(result!.nestedForwards.f2!.nodes[0]!.content).toBe('深一层')
    })

    /** 嵌套资源失败不算整帧失败：外层弹窗照旧打开，那张卡片回退为占位文案。 */
    it('嵌套资源读取失败时外层仍然打开', async () => {
      const outer = forward('f1', [node('乙', '[合并转发]', 'f2')])
      const result = await loadForwardDialogFrame({
        input: { forwardId: 'f1' },
        load: async (input) => {
          if (input.forwardId === 'f2') throw new Error('资源不存在')
          return outer
        },
      })

      expect(result).toBeDefined()
      expect(result!.nestedForwards).toEqual({})
    })

    it('整帧读取失败时不给出帧，弹窗不打开', async () => {
      const result = await loadForwardDialogFrame({
        input: { forwardId: '不存在' },
        load: async () => { throw new Error('资源不存在') },
      })

      expect(result).toBeUndefined()
    })

    /** 节点做浅拷贝：直接把服务端返回的对象放进帧里，弹窗内的改动会写穿到缓存。 */
    it('节点是拷贝而不是服务端返回的同一个对象', async () => {
      const result = await loadForwardDialogFrame({
        input: { forwardId: 'f1' },
        load: async () => flat,
      })

      expect(result!.items[0]).not.toBe(flat.nodes[0])
      expect(result!.items[0]).toEqual(flat.nodes[0])
    })
  })
})
