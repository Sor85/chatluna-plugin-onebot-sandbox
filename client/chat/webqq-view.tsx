import * as React from 'react'
import { cn } from '@chatluna/ui-kit'
import { useElementWidth } from '../shared/use-element-width'
import { useSandbox, useWorkspace } from '../workspace/context'
import { ChatPane } from './chat-pane'
import { DetailsPanel } from './details-panel'
import { ChatSidebar } from './sidebar'

type Region = 'contacts' | 'chat' | 'details'

/** 会话列表与信息栏各 288px（w-72）。 */
const COLUMN_WIDTH = 288
/** 信息栏自动展开时聊天区至少保留的宽度：发送框 460px 两侧各留 48px 才能完整居中。 */
const CHAT_MIN_WIDTH = 556
/** 窄于此宽度时三个区域互斥显示。 */
const NARROW_WIDTH = 640

/**
 * WebQQ 三栏：会话列表、聊天区与会话信息。按沙盒自身宽度而不是视口宽度分档（左侧还有 v2 外壳侧栏）：
 * 三栏都放下且聊天区不窄于 {@link CHAT_MIN_WIDTH} 时默认展开信息栏；窄于 {@link NARROW_WIDTH} 时三个区域
 * 互斥显示，聊天区提供返回会话列表的入口。
 */
export function WebqqView() {
  const { store } = useSandbox()
  const { workspace } = useWorkspace()
  const [root, width] = useElementWidth<HTMLDivElement>()
  const wide = width >= COLUMN_WIDTH * 2 + CHAT_MIN_WIDTH
  const narrow = width > 0 && width < NARROW_WIDTH
  const [detailsPreference, setDetailsPreference] = React.useState<'auto' | 'open' | 'closed'>('auto')
  const [region, setRegion] = React.useState<Region>('chat')
  const detailsVisible = detailsPreference === 'auto' ? wide : detailsPreference === 'open'

  // 跨过宽窄断点时回到该宽度下的默认展开态。
  React.useEffect(() => setDetailsPreference('auto'), [wide])

  const toggleDetails = () => {
    if (narrow) return setRegion((value) => value === 'details' ? 'chat' : 'details')
    setDetailsPreference(detailsVisible ? 'closed' : 'open')
  }
  const mention = React.useRef<(participantId: string) => void>(() => {})

  return (
    // 强调色由插件设置决定，消息气泡与发送框（`messages.css`、`composer.css`）都从这里继承。
    <div ref={root} className="sandbox-webqq flex min-h-0 flex-1 border-t border-border" style={{ '--sandbox-accent': workspace.appearance.sandboxAccentColor } as React.CSSProperties}>
      <ChatSidebar
        className={cn(narrow && region !== 'contacts' && 'hidden', narrow && 'w-full')}
        onSelectConversation={(conversationId) => {
          store.selectConversation(conversationId)
          if (narrow) setRegion('chat')
        }}
      />
      <ChatPane
        className={cn(narrow && region !== 'chat' && 'hidden', !narrow && !wide && detailsVisible && 'hidden')}
        detailsVisible={narrow ? region === 'details' : detailsVisible}
        onToggleDetails={toggleDetails}
        onBack={narrow ? () => setRegion('contacts') : undefined}
        mentionBridge={mention}
      />
      {(narrow ? region === 'details' : detailsVisible) && (
        <DetailsPanel
          className={cn(narrow && 'w-full border-l-0', !narrow && !wide && 'flex-1')}
          onClose={narrow ? () => setRegion('chat') : () => setDetailsPreference('closed')}
          onMention={(participantId) => mention.current(participantId)}
        />
      )}
    </div>
  )
}
