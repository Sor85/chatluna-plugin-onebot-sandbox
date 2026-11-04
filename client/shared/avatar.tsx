import * as React from 'react'
import { BotIcon, UsersIcon } from 'lucide-react'
import { cn } from '@chatluna/ui-kit'

export type AvatarKind = 'user' | 'bot' | 'group'

/**
 * 沙盒身份头像：图片可用时显示图片，否则显示名字首字。机器人与群组在角上带一个类型标记，
 * 让同名的用户、机器人与群在列表里一眼可分。`sandbox-media://` 引用必须先由调用方解析成 Data URL。
 */
export function SandboxAvatar({ kind, name = '', src, className, badge = true }: {
  kind: AvatarKind
  name?: string
  src?: string
  className?: string
  badge?: boolean
}) {
  const [failed, setFailed] = React.useState(false)
  const usable = src && !src.startsWith('sandbox-media:') ? src : ''
  React.useEffect(() => setFailed(false), [usable])
  return (
    <span className={cn('relative inline-flex size-9 shrink-0 select-none', className)}>
      <span
        className={cn(
          'flex size-full items-center justify-center overflow-hidden rounded-full bg-muted text-[13px] font-medium text-muted-foreground',
          kind === 'group' && 'rounded-[30%]',
        )}
      >
        {usable && !failed
          ? <img src={usable} alt={name} className="size-full object-cover" onError={() => setFailed(true)} />
          : name.trim().slice(0, 1).toUpperCase() || '?'}
      </span>
      {badge && kind !== 'user' && (
        <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-background ring-1 ring-border">
          {kind === 'bot' ? <BotIcon className="size-2.5 text-primary" /> : <UsersIcon className="size-2.5 text-muted-foreground" />}
        </span>
      )}
    </span>
  )
}
