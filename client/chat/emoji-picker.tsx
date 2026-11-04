import * as React from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, Input } from '@chatluna/ui-kit'
import { useT } from '../i18n'
import {
  getCommonSandboxEmojiFaces,
  getSandboxEmojiFace,
  loadRecentSandboxEmojiIds,
  rememberSandboxEmojiId,
  searchSandboxEmojiFaces,
  type SandboxEmojiFace,
} from '../webqq/emoji-catalog'

/** 贴表情面板：常用（最近 24 个）、推荐与全部表情，支持按名称、拼音或 ID 搜索。 */
export function EmojiPicker({ open, onOpenChange, onSelect }: {
  open: boolean
  onOpenChange(open: boolean): void
  onSelect(emojiId: string): void
}) {
  const t = useT()
  const [query, setQuery] = React.useState('')
  const [recentIds, setRecentIds] = React.useState<string[]>([])
  React.useEffect(() => {
    if (!open) return
    setQuery('')
    setRecentIds(loadRecentSandboxEmojiIds())
  }, [open])
  const searching = !!query.trim()
  const recent = recentIds.map(getSandboxEmojiFace).filter((face): face is SandboxEmojiFace => !!face)
  const visible = React.useMemo(() => searchSandboxEmojiFaces(query), [query])
  const select = (id: string) => {
    setRecentIds(rememberSandboxEmojiId(id))
    onSelect(id)
    onOpenChange(false)
  }
  const grid = (faces: SandboxEmojiFace[], prefix: string) => (
    <div className="grid grid-cols-8 gap-1">
      {faces.map((face) => (
        <button
          key={`${prefix}:${face.id}`}
          type="button"
          title={face.label}
          className="flex aspect-square items-center justify-center rounded-md transition-colors hover:bg-accent"
          onClick={() => select(face.id)}
        >
          {face.url ? <img src={face.url} alt={face.label} className="size-6" /> : <span className="text-[10px]">{face.label}</span>}
        </button>
      ))}
    </div>
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sandbox-glass flex flex-col overflow-hidden sm:max-w-md">
        <DialogHeader><DialogTitle>{t('sandbox.emoji.title')}</DialogTitle></DialogHeader>
        <Input type="search" className="sandbox-search-input" value={query} autoFocus placeholder={t('sandbox.emoji.search')} aria-label={t('sandbox.emoji.search')} onChange={(event) => setQuery(event.target.value)} />
        <div className="-mx-5 flex max-h-[55vh] min-h-0 flex-col gap-4 overflow-y-auto px-5">
          {!searching && recent.length > 0 && (
            <section className="flex flex-col gap-2"><h3 className="text-xs text-muted-foreground">{t('sandbox.emoji.recent')}</h3>{grid(recent, 'recent')}</section>
          )}
          {!searching && (
            <section className="flex flex-col gap-2"><h3 className="text-xs text-muted-foreground">{t('sandbox.emoji.common')}</h3>{grid(getCommonSandboxEmojiFaces(), 'common')}</section>
          )}
          <section className="flex flex-col gap-2">
            <h3 className="text-xs text-muted-foreground">{t(searching ? 'sandbox.emoji.results' : 'sandbox.emoji.all')}</h3>
            {visible.length ? grid(visible, 'all') : <p className="py-6 text-center text-xs text-muted-foreground">{t('sandbox.emoji.empty')}</p>}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
