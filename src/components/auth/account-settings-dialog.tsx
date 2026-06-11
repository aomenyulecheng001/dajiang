'use client'

import { useState } from 'react'
import { UserCircle, KeyRound, Loader2, Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuthStore } from '@/store/auth-store'
import { useT } from '@/lib/i18n'
import { PasswordChangeForm } from './password-change-form'

interface AccountSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AccountSettingsDialog({ open, onOpenChange }: AccountSettingsDialogProps) {
  // PERF FIX: Use selective subscriptions to avoid unnecessary re-renders.
  // Previously, destructuring the entire store caused re-renders whenever
  // isAuthenticated or isLoading changed — fields this component doesn't use.
  const username = useAuthStore((s) => s.username)
  const updateUsername = useAuthStore((s) => s.updateUsername)
  const t = useT()

  const [newUsername, setNewUsername] = useState('')
  const [isSavingUsername, setIsSavingUsername] = useState(false)
  const [usernameError, setUsernameError] = useState('')

  const resetAllForms = () => {
    setNewUsername('')
    setUsernameError('')
    setIsSavingUsername(false)
  }

  // ─── Handle username change ──────────────────────────────────────────────
  const handleUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setUsernameError('')

    if (!newUsername || newUsername.length < 3) {
      setUsernameError(t('auth.usernameTooShort'))
      return
    }

    if (newUsername.length > 30) {
      setUsernameError(t('auth.usernameTooLong'))
      return
    }

    if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) {
      setUsernameError(t('auth.usernameInvalidChars'))
      return
    }

    if (newUsername === username) {
      setUsernameError(t('auth.usernameSameAsCurrent'))
      return
    }

    setIsSavingUsername(true)

    try {
      const res = await fetch('/api/auth/update-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({ newUsername }),
      })

      const data = await res.json()

      if (res.ok && data.success) {
        toast.success(t('auth.usernameChanged'))
        updateUsername(data.username)
        setNewUsername('')
        onOpenChange(false)
      } else {
        // NOTE: Error matching depends on server English error messages.
        // If i18n is needed, server should return error codes instead.
        if (data.error?.toLowerCase().includes('taken') || data.error?.toLowerCase().includes('already')) {
          setUsernameError(t('auth.usernameTaken'))
        } else {
          setUsernameError(data.error || t('auth.usernameChangeFailed'))
        }
      }
    } catch {
      setUsernameError(t('auth.usernameChangeFailed'))
    } finally {
      setIsSavingUsername(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      resetAllForms()
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCircle className="size-5 text-teal-600" />
            {t('auth.accountSettings')}
          </DialogTitle>
          <DialogDescription>
            {t('auth.accountSettingsDesc')}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="account" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="account" className="gap-1.5">
              <UserCircle className="size-3.5" />
              {t('auth.accountTab')}
            </TabsTrigger>
            <TabsTrigger value="password" className="gap-1.5">
              <KeyRound className="size-3.5" />
              {t('auth.passwordTab')}
            </TabsTrigger>
          </TabsList>

          {/* ─── Account Tab ──────────────────────────────────────── */}
          <TabsContent value="account" className="mt-4">
            <form onSubmit={handleUsernameSubmit} className="space-y-4">
              {/* Current username display */}
              <div className="space-y-2">
                <Label>{t('auth.currentUsername')}</Label>
                <div className="flex items-center gap-2 h-10 px-3 rounded-md border bg-muted/50 text-sm font-medium">
                  <UserCircle className="size-4 text-muted-foreground" />
                  {username}
                  <span className="ml-auto">
                    <Badge label={t('common.admin')} />
                  </span>
                </div>
              </div>

              {/* New username input */}
              <div className="space-y-2">
                <Label htmlFor="new-username">{t('auth.newUsername')}</Label>
                <Input
                  id="new-username"
                  type="text"
                  value={newUsername}
                  onChange={(e) => { setNewUsername(e.target.value); setUsernameError('') }}
                  placeholder={t('auth.newUsernamePlaceholder')}
                  autoComplete="off"
                  disabled={isSavingUsername}
                  maxLength={30}
                />
                <p className="text-xs text-muted-foreground">
                  {t('auth.usernameRequirements')}
                </p>
              </div>

              {/* Error message */}
              {usernameError && (
                <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400 border border-red-500/20">
                  {usernameError}
                </div>
              )}

              <DialogFooter className="gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={isSavingUsername}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={isSavingUsername || !newUsername || newUsername === username}
                  className="bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700"
                >
                  {isSavingUsername ? (
                    <>
                      <Loader2 className="size-4 animate-spin mr-1.5" />
                      {t('common.saving')}
                    </>
                  ) : (
                    t('common.save')
                  )}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>

          {/* ─── Password Tab ──────────────────────────────────────── */}
          <TabsContent value="password" className="mt-4">
            <PasswordChangeForm onSuccess={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// Simple inline badge component for the account tab
function Badge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 dark:bg-teal-900/30 px-2 py-0.5 text-[10px] font-medium text-teal-700 dark:text-teal-300">
      <Check className="size-2.5" />
      {label}
    </span>
  )
}
