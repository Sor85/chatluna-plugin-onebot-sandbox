import * as React from 'react'
import { invoke } from './store'
import type { SandboxTestSpaceSummary } from '../../src/test-spaces'

/** AI 测试空间列表（含各自快照）；环境管理与 OneBot 调试按它合成跨空间的机器人目录。 */
export function useTestSpaces() {
  const [spaces, setSpaces] = React.useState<SandboxTestSpaceSummary[]>([])
  const [error, setError] = React.useState('')
  const reload = React.useCallback(async () => {
    try {
      setSpaces(await invoke('onebot-sandbox.test-spaces', undefined))
      setError('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])
  React.useEffect(() => {
    void reload()
  }, [reload])
  return { spaces, error, reload }
}
