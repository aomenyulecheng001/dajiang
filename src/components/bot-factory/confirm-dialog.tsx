'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (_open: boolean) => void
  title: string
  description: string
  confirmText?: string
  cancelText?: string
  variant?: 'default' | 'destructive'
  onConfirm: () => void
  loading?: boolean
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  variant = 'default',
  onConfirm,
  loading = false,
}: ConfirmDialogProps) {
  const t = useT()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-3 sm:gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelText || t('common.cancel')}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={loading}
            className={variant === 'default' ? 'bg-gradient-to-r from-cyan-600 to-blue-600' : ''}
          >
            {loading ? t('common.processing') : (confirmText || t('common.confirm'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
