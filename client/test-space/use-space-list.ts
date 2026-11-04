import * as React from 'react'
import type { SandboxTestSpaceSummary } from '../../src/test-spaces'
import { invoke } from '../workspace/store'

const POLL_INTERVAL = 1500

/**
 * AI 测试空间列表的轮询：标签页上的 AI 控制态、总览卡片与被控覆盖层都依赖空间 status，而状态变化
 * 不经实时信号推送，所以不论当前在哪个工作区都每 1.5 秒重读一次。只有空间、状态或快照修订号变化时
 * 才替换列表，避免每次轮询都让缩略图重渲染。
 */
export function useSpaceList() {
  const [spaces, setSpaces] = React.useState<SandboxTestSpaceSummary[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const signature = React.useRef('')

  const reload = React.useCallback(async () => {
    const next = await invoke('onebot-sandbox.test-spaces', undefined)
    const key = next.map(({ id, name, status, snapshot }) => `${id}:${name}:${status}:${snapshot.revision}`).join('|')
    setLoaded(true)
    if (key === signature.current) return
    signature.current = key
    setSpaces(next)
  }, [])

  React.useEffect(() => {
    // 轮询失败不打断界面：下一轮会重试，操作类请求的失败另有 Toast。
    const poll = () => void reload().catch(() => {})
    poll()
    const timer = setInterval(poll, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [reload])

  return { spaces, loaded, reload }
}
