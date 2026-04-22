'use client'

import { KeyRound } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useT } from '@/lib/i18n'
import { PasswordChangeForm } from './password-change-form'

interface ChangePasswordDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const t = useT()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-teal-600" />
            {t('auth.changePasswordTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('auth.changePasswordDesc')}
          </DialogDescription>
        </DialogHeader>
        <div className="pt-2">
          <PasswordChangeForm onSuccess={() => onOpenChange(false)} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
