'use client'

import { useState } from 'react'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuthStore } from '@/store/auth-store'
import { useT } from '@/lib/i18n'

interface PasswordChangeFormProps {
  onSuccess?: () => void
  submitLabel?: string
}

export function PasswordChangeForm({ onSuccess, submitLabel }: PasswordChangeFormProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const { logout } = useAuthStore()
  const t = useT()

  const resetForm = () => {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setShowCurrent(false)
    setShowNew(false)
    setShowConfirm(false)
    setError('')
    setIsSaving(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!currentPassword) {
      setError(t('common.currentPassword'))
      return
    }
    if (newPassword.length < 8) {
      setError(t('common.passwordTooShort'))
      return
    }
    // SECURITY FIX (SEC-86): Client-side validation aligned with server-side requirements
    if (newPassword.length > 128) {
      setError(t('common.passwordTooLong'))
      return
    }
    if (!/[a-zA-Z]/.test(newPassword)) {
      setError(t('common.passwordNeedsLetter'))
      return
    }
    if (!/[0-9]/.test(newPassword)) {
      setError(t('common.passwordNeedsDigit'))
      return
    }
    if (!/[A-Z]/.test(newPassword)) {
      setError(t('common.passwordNeedsUppercase'))
      return
    }
    if (!/[^a-zA-Z0-9]/.test(newPassword)) {
      setError(t('common.passwordNeedsSpecial'))
      return
    }
    if (newPassword !== confirmPassword) {
      setError(t('common.passwordMismatch'))
      return
    }
    if (currentPassword === newPassword) {
      setError(t('common.passwordChangeFailed'))
      return
    }

    setIsSaving(true)

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword }),
      })

      const data = await res.json()

      if (res.ok && data.success) {
        toast.success(t('common.passwordChanged'))
        resetForm()
        onSuccess?.()
        setTimeout(() => { logout() }, 1500)
      } else {
        if (data.error?.toLowerCase().includes('current') || data.error?.toLowerCase().includes('incorrect') || data.error?.toLowerCase().includes('invalid')) {
          setError(t('common.currentPasswordWrong'))
        } else {
          setError(data.error || t('common.passwordChangeFailed'))
        }
      }
    } catch {
      setError(t('common.passwordChangeFailed'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="current-password">{t('common.currentPassword')}</Label>
        <div className="relative">
          <Input
            id="current-password"
            type={showCurrent ? 'text' : 'password'}
            value={currentPassword}
            onChange={(e) => { setCurrentPassword(e.target.value); setError('') }}
            placeholder={t('common.currentPassword')}
            className="pr-10"
            autoComplete="current-password"
            disabled={isSaving}
          />
          <button
            type="button"
            onClick={() => setShowCurrent(!showCurrent)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            tabIndex={-1}
          >
            {showCurrent ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-password">{t('common.newPassword')}</Label>
        <div className="relative">
          <Input
            id="new-password"
            type={showNew ? 'text' : 'password'}
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); setError('') }}
            placeholder={t('common.newPassword')}
            className="pr-10"
            autoComplete="new-password"
            disabled={isSaving}
          />
          <button
            type="button"
            onClick={() => setShowNew(!showNew)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            tabIndex={-1}
          >
            {showNew ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">{t('common.confirmPassword')}</Label>
        <div className="relative">
          <Input
            id="confirm-password"
            type={showConfirm ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setError('') }}
            placeholder={t('common.confirmPassword')}
            className="pr-10"
            autoComplete="new-password"
            disabled={isSaving}
          />
          <button
            type="button"
            onClick={() => setShowConfirm(!showConfirm)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            tabIndex={-1}
          >
            {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400 border border-red-500/20">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="submit"
          disabled={isSaving || !currentPassword || !newPassword || !confirmPassword}
          className="bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700"
        >
          {isSaving ? (
            <>
              <Loader2 className="size-4 animate-spin mr-1.5" />
              {t('common.saving')}
            </>
          ) : (
            submitLabel || t('common.save')
          )}
        </Button>
      </div>
    </form>
  )
}
