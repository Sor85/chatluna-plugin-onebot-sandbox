import { cn } from '@chatluna/ui-kit'
import type { SandboxMessageReaction } from '../../src/types'
import { SandboxAvatar } from '../shared/avatar'
import { getSandboxEmojiFace } from '../webqq/emoji-catalog'
import { useWorkspace } from '../workspace/context'

const MAX_VISIBLE_AVATARS = 3

/** 表情回应条：每个表情一枚胶囊，带最多三位回应者头像；点一下切换当前操作者自己的回应。 */
export function MessageReactions({ reactions, readonly, onToggle }: {
  reactions: SandboxMessageReaction[]
  readonly: boolean
  onToggle(emojiId: string): void
}) {
  const { participants, operatorId } = useWorkspace()
  return (
    <div className="flex flex-wrap gap-1">
      {reactions.map((reaction) => {
        const face = getSandboxEmojiFace(reaction.emojiId)
        const mine = !!operatorId && reaction.participantIds.includes(operatorId)
        return (
          <button
            key={reaction.emojiId}
            type="button"
            disabled={readonly}
            aria-label={`${face?.label ?? reaction.emojiId} ${reaction.participantIds.length}`}
            className={cn(
              'flex h-6 items-center gap-1 rounded-full bg-background/80 px-1.5 text-foreground ring-1 ring-border transition-colors disabled:opacity-70',
              mine && 'ring-primary/60',
              !readonly && 'hover:bg-background',
            )}
            onClick={(event) => {
              event.stopPropagation()
              onToggle(reaction.emojiId)
            }}
          >
            {face?.url ? <img src={face.url} alt={face.label} className="size-4" /> : <span className="text-[11px]">{face?.label ?? reaction.emojiId}</span>}
            <span className="flex -space-x-1.5">
              {reaction.participantIds.slice(0, MAX_VISIBLE_AVATARS).map((id) => (
                <span key={id} title={participants[id]?.name ?? id} className="rounded-full ring-2 ring-background">
                  <SandboxAvatar kind={participants[id]?.isBot ? 'bot' : 'user'} name={participants[id]?.name ?? id} src={participants[id]?.avatar} className="size-4 text-[8px]" badge={false} />
                </span>
              ))}
            </span>
          </button>
        )
      })}
    </div>
  )
}
