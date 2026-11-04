/** 将消息正文中的结构化 at 元素格式化为展示文本。 */
export function formatMentionContent(content: string, participantNames: Readonly<Record<string, string>>): string {
  return content.replace(/<at\s+id="([^"]+)"\s*\/>/g, (_, id: string) => `@${participantNames[id] ?? id}`)
}
