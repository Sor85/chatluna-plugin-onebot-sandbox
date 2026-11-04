import * as React from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@chatluna/ui-kit'
import { useT } from '../i18n'

/**
 * 有未保存修改的弹窗：关闭按钮、取消、Esc 与点遮罩都先确认放弃，没有改动直接关闭。
 *
 * 返回的 `confirm` 要渲染在弹窗的 `DialogContent` 里面：嵌在同一棵 Base UI 弹窗树中，
 * Esc 与点外部只作用于最上层的确认框，不会同时再触发一次底下弹窗的关闭请求。
 */
export function useDiscardConfirm(dirty: boolean, close: () => void) {
  const t = useT()
  const [asking, setAsking] = React.useState(false)
  const requestClose = () => {
    if (dirty) setAsking(true)
    else close()
  }
  const confirm = (
    <AlertDialog open={asking} onOpenChange={setAsking}>
      <AlertDialogContent className="sandbox-glass">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('sandbox.discard.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('sandbox.discard.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('sandbox.discard.keep')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => {
            setAsking(false)
            close()
          }}>{t('sandbox.discard.confirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
  return { requestClose, confirm }
}
