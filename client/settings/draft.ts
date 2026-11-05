import * as React from 'react'

type Values = Record<string, unknown>

interface SettingsDraftState {
  value?: Values
  /** 草稿与已保存值不同；页面卸载后仍保留，供页头标签标出未保存修改。 */
  dirty: boolean
}

/**
 * 设置页的未保存草稿，放在模块里而不是组件状态里：宿主用 BrowserRouter，没有 `useBlocker` 能拦住
 * 侧栏导航，离开设置页时页面直接卸载。草稿留在这里，回到设置页原样还原；刷新或关闭标签页时由
 * `beforeunload` 提示。
 */
let state: SettingsDraftState = { dirty: false }
const listeners = new Set<() => void>()

const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault()
}

function update(next: SettingsDraftState) {
  if (next.dirty !== state.dirty) {
    if (next.dirty) window.addEventListener('beforeunload', warnBeforeUnload)
    else window.removeEventListener('beforeunload', warnBeforeUnload)
  }
  state = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const getState = () => state

export const settingsDraft = {
  setValue: (value: Values | undefined) => update({ value, dirty: value === undefined ? false : state.dirty }),
  setDirty: (dirty: boolean) => {
    if (dirty !== state.dirty) update({ ...state, dirty })
  },
}

export function useSettingsDraft() {
  return React.useSyncExternalStore(subscribe, getState, getState)
}
