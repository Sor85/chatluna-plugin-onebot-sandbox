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
import { useRetained } from './use-retained'

export interface ConfirmRequest {
  title: string
  description: string
  action: string
  onConfirm(): void
}

/**
 * 不可撤销操作（删除公告、删除测试空间）的确认框。`request` 为空时关闭；关闭后保留最后一份文案播完退场动画。
 */
export function ConfirmDialog({ request, onClose }: { request?: ConfirmRequest, onClose(): void }) {
  const t = useT()
  const shown = useRetained(request)
  return (
    <AlertDialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.title}</AlertDialogTitle>
          <AlertDialogDescription>{shown?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('sandbox.common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => {
            onClose()
            request?.onConfirm()
          }}>{shown?.action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
