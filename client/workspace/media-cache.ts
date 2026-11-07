/**
 * 媒体 Data URL 的页面级缓存，各空间的 `WorkspaceStore` 与每次挂载共用。
 *
 * store 跟着沙盒页面挂载、卸载，缓存放在 store 里时，从别的页面回来每个头像都要重新请求一遍，
 * 先闪名字首字再出图片。媒体 ID 是内容的 sha256（`src/media-storage.ts`），同一个 ID 的内容不变，
 * 所以缓存不会过期，插件重启、切换空间与操作者都照用。只在内存里，刷新页面后重新拉取。
 *
 * 头像是几 KB 的 SVG，数量有限，长期保留；消息里的图片可能有几 MB，只保留最近用到的
 * {@link MESSAGE_MEDIA_LIMIT} 张，按最近使用淘汰。
 */

const MESSAGE_MEDIA_LIMIT = 64

const avatars = new Map<string, string>()
/** Map 的插入顺序即使用顺序：命中时删掉重插，淘汰时取第一项。 */
const messageMedia = new Map<string, string>()

export function readCachedMedia(id: string): string | undefined {
  const avatar = avatars.get(id)
  if (avatar !== undefined) return avatar
  const url = messageMedia.get(id)
  if (url === undefined) return undefined
  messageMedia.delete(id)
  messageMedia.set(id, url)
  return url
}

export function rememberMedia(id: string, url: string, avatar: boolean) {
  if (avatar) {
    avatars.set(id, url)
    messageMedia.delete(id)
    return
  }
  if (avatars.has(id)) return
  messageMedia.delete(id)
  messageMedia.set(id, url)
  while (messageMedia.size > MESSAGE_MEDIA_LIMIT) messageMedia.delete(messageMedia.keys().next().value!)
}
