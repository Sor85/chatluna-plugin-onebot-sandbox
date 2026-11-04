import { createFakeTestCallRecordPort } from '../../client/test-call/fake-port'
import { createFakeModelRequestPort } from '../../client/model-request/fake-port'
import { createFakeOneBotDebugPort } from '../../client/onebot-debug/fake-port'
import { createFakePresetPort } from '../../client/preset/fake-port'
import { createFakeWorkspacePort } from '../../client/workspace/fake-port'
import {
  createWorkspaceController,
  type WorkspaceControllerPorts,
} from '../../client/workspace/controller'
import type { SandboxWorkspaceState } from '../../src/types'

const emptyWorkspace: SandboxWorkspaceState = {
  snapshot: {
    revision: 0,
    participants: [],
    groups: [],
    conversations: [],
    messages: [],
    forwards: [],
    friendships: [],
    requests: [],
  },
  chatLunaStates: [],
  appearance: {
    enableSandboxFrostedGlass: true,
    sandboxTimBubbleTail: true,
    sandboxColorMode: 'auto',
    sandboxAccentColor: '#2563eb',
    sandboxMarkRecalledMessages: true,
  },
  persistence: { mode: 'memory', available: true, persisted: false },
}

interface Storage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

/**
 * 控制器构造时收若干道按能力拆开的端口。用例只传自己驱动的那几道，其余由这里补一份空假端口——
 * 「只准备自己用到的那几个方法」因此在用例里看得见，而生产代码仍然要求端口齐全。
 */
export function createTestWorkspaceController(
  ports: Partial<WorkspaceControllerPorts> = {},
  storage: Storage = memoryStorage(),
) {
  return createWorkspaceController({
    workspace: ports.workspace ?? createFakeWorkspacePort(emptyWorkspace),
    oneBotDebug: ports.oneBotDebug ?? createFakeOneBotDebugPort(),
    modelRequest: ports.modelRequest ?? createFakeModelRequestPort(),
    preset: ports.preset ?? createFakePresetPort(),
    testCallRecord: ports.testCallRecord ?? createFakeTestCallRecordPort(),
  }, storage)
}
