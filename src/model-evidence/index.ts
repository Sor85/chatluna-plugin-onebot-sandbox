import { projectRequestEvidence } from './request'
import { projectResponseEvidence } from './response'
import type {
  ModelEvidenceProjection,
  ModelEvidenceSlice,
} from './types'

export * from './types'
export {
  countMessageCharacters,
  countToolCallCharacters,
  countToolDefinitionCharacters,
} from './metrics'

/**
 * 模型证据投影的唯一对外入口。也是唯一从请求体读取协议结构的地方。
 *
 * 输入只有一条模型请求记录的证据切片（请求体、响应原文、响应 transport 格式）。
 * provider、URL、生命周期状态、HTTP 状态、空间归属、耗时、最终用量、模型名称
 * 与原始请求体的字段数都不参与协议识别，它们继续由模型请求记录与现有读取 module 拥有：
 * 模型名称是采集那一刻观察到的记录事实，字段数是原始 JSON 事实，两者都不是协议事实。
 *
 * 协议识别完全由内部 shape-driven adapter 完成；调用方不注册也不选择具体 adapter。
 * 投影每次处理当前可用证据，不做全局缓存，也不深拷贝原始子树。
 */
export function projectModelEvidence(slice: ModelEvidenceSlice): ModelEvidenceProjection {
  const request = projectRequestEvidence(slice.requestBody)
  const response = projectResponseEvidence(slice.responseBodyRaw, slice.responseBodyFormat)
  return {
    requestMessages: request.messages,
    toolDefinitions: request.toolDefinitions,
    responseEvents: response.events,
    responseTransport: response.transport,
    diagnostics: [...request.diagnostics, ...response.diagnostics],
  }
}
