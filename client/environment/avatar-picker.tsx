import * as React from 'react'
import { ArrowLeftIcon, ChevronRightIcon, UploadIcon } from 'lucide-react'
import { Button } from '@chatluna/ui-kit'
import { BUILTIN_AVATARS, type BuiltinAvatar, type BuiltinAvatarKind } from '../../src/builtin-avatar-options'
import { useT } from '../i18n'

function avatarDataUrl(avatar: BuiltinAvatar) {
  const bytes = new TextEncoder().encode(avatar.svg)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

/** 头像选择：内置头像或本地图片，选定后以 Data URL 交回，服务端负责导入成受控媒体。用于浮层内原地切换的二级视图。 */
export function AvatarPicker({ kind, onBack, onSelect }: {
  kind: BuiltinAvatarKind
  onBack(): void
  onSelect(avatar: string): void
}) {
  const t = useT()
  return (
    <section className="flex flex-col gap-4" aria-label={t('sandbox.avatar.title')}>
      <header className="flex items-start gap-2">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('sandbox.avatar.back')} onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <div className="flex flex-col gap-1">
          <strong className="text-sm font-medium">{t('sandbox.avatar.title')}</strong>
          <p className="text-xs text-muted-foreground">{t('sandbox.avatar.description')}</p>
        </div>
      </header>
      <AvatarChoices kind={kind} onSelect={onSelect} />
    </section>
  )
}

/** 头像候选：内置头像网格与本地上传入口。弹窗里作为二级窗口的正文，标题与关闭按钮由弹窗提供。 */
export function AvatarChoices({ kind, onSelect }: {
  kind: BuiltinAvatarKind
  onSelect(avatar: string): void
}) {
  const t = useT()
  const [error, setError] = React.useState('')
  const fileInput = React.useRef<HTMLInputElement>(null)

  const readLocal = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) return setError(t('sandbox.avatar.notImage'))
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result !== 'string') return
      setError('')
      onSelect(reader.result)
    })
    reader.addEventListener('error', () => setError(t('sandbox.avatar.readFailed')))
    reader.readAsDataURL(file)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-2">
        {BUILTIN_AVATARS[kind].map((avatar) => (
          <button
            key={avatar.id}
            type="button"
            className="aspect-square overflow-hidden rounded-full ring-1 ring-border transition-transform duration-150 ease-spring hover:scale-105 focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t('sandbox.avatar.builtin', { id: avatar.id })}
            onClick={() => onSelect(avatarDataUrl(avatar))}
          >
            <img src={avatarDataUrl(avatar)} alt="" className="size-full" />
          </button>
        ))}
      </div>
      <input ref={fileInput} type="file" className="hidden" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={readLocal} />
      <button
        type="button"
        className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent"
        onClick={() => fileInput.current?.click()}
      >
        <span className="flex size-8 items-center justify-center rounded-md bg-muted"><UploadIcon className="size-4" /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <strong className="text-[13px] font-medium">{t('sandbox.avatar.upload')}</strong>
          <small className="text-xs text-muted-foreground">{t('sandbox.avatar.uploadHint')}</small>
        </span>
        <ChevronRightIcon className="size-4 text-muted-foreground" />
      </button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
