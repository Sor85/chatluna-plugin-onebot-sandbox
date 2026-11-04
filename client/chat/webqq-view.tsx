import * as React from 'react'
import { cn } from '@chatluna/ui-kit'
import { useMediaQuery } from '../shared/use-media-query'
import { useSandbox, useWorkspace } from '../workspace/context'
import { ChatPane } from './chat-pane'
import { DetailsPanel } from './details-panel'
import { ChatSidebar } from './sidebar'

type Region = 'contacts' | 'chat' | 'details'

/**
 * WebQQ 三栏：会话列表、聊天区与会话信息。宽屏（≥1180px）默认展开信息栏；窄屏（<768px）三个区域
 * 互斥显示，聊天区提供返回会话列表的入口。
 */
export function WebqqView() {
  const { store } = useSandbox()
  const { workspace } = useWorkspace()
  const wide = useMediaQuery('(min-width: 1180px)')
  const narrow = useMediaQuery('(max-width: 767px)')
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
    <div className="sandbox-webqq flex min-h-0 flex-1" style={{ '--sandbox-accent': workspace.appearance.sandboxAccentColor } as React.CSSProperties}>
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
