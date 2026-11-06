export type ThinkingDurationTranslate = (key: string, params?: Record<string, unknown>) => string

/** 折叠按钮上的时长文案。没有时长时退回「思考过程」，负值兜底到 0。 */
export function formatThinkingDuration(t: ThinkingDurationTranslate, durationMs?: number): string {
  if (durationMs === undefined) return t('sandbox.chat.thinkingProcess')
  return t('sandbox.chat.thoughtFor', { seconds: Math.max(0, Math.round(durationMs / 1000)) })
}
