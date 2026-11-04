import type { SandboxMessageReaction } from '../../src/types'
import { SandboxAvatar } from '../shared/avatar'
import { getSandboxEmojiFace } from '../webqq/emoji-catalog'
import { useWorkspace } from '../workspace/context'

const MAX_VISIBLE_AVATARS = 3

/**
 * 表情回应条：每个表情一枚胶囊，带最多三位回应者头像；点一下切换当前操作者自己的回应。
 * 样式在 `messages.css`，胶囊底色取所在气泡的派生色。
 */
export function MessageReactions({ reactions, readonly, onToggle }: {
  reactions: SandboxMessageReaction[]
  readonly: boolean
  onToggle(emojiId: string): void
}) {
  const { participants } = useWorkspace()
  return (
    <div className="sandbox-message-reactions">
      {reactions.map((reaction) => {
        const face = getSandboxEmojiFace(reaction.emojiId)
        const visible = reaction.participantIds.slice(0, MAX_VISIBLE_AVATARS)
        return (
          <button
            key={reaction.emojiId}
            type="button"
            className="sandbox-message-reaction"
            disabled={readonly}
            aria-label={`${face?.label ?? reaction.emojiId} ${reaction.participantIds.length}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggle(reaction.emojiId)
            }}
          >
            {face?.url
              ? <img src={face.url} alt={face.label} className="sandbox-message-reaction-emoji" />
              : <span>{face?.label ?? reaction.emojiId}</span>}
            {visible.length > 0 && (
              <span className="sandbox-message-reaction-users">
                {visible.map((id, index) => (
                  <span key={id} title={participants[id]?.name ?? id} className="sandbox-message-reaction-avatar" style={{ zIndex: visible.length - index }}>
                    <SandboxAvatar kind={participants[id]?.isBot ? 'bot' : 'user'} name={participants[id]?.name ?? id} src={participants[id]?.avatar} className="size-full text-[9px]" badge={false} />
                  </span>
                ))}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
