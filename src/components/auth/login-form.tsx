'use client'

import { useState } from 'react'
import { useAuthStore } from '@/store/auth-store'
import { motion } from 'framer-motion'
import { Loader2, LogIn, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import { useT } from '@/lib/i18n'

export function LoginForm() {
  const { setAuth } = useAuthStore()
  const t = useT()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!username.trim() || !password.trim()) {
      toast.error(t('auth.loginEmptyFields'))
      return
    }

    setIsSubmitting(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: username.trim(), password }),
      })

      let data: { success?: boolean; username?: string; error?: string }
      try {
        data = await res.json()
      } catch {
        toast.error(res.status >= 500 ? t('auth.loginServerError') : t('auth.loginNetworkRetry'))
        return
      }

      if (!res.ok) {
        toast.error(data.error || t('auth.loginFailed'))
        return
      }

      setAuth(true, data.username || username.trim(), null)

      fetch('/api/bots/runner/start-service', {
        method: 'POST',
        credentials: 'include',
      }).catch(() => {})

      toast.success(t('auth.loginWelcome', { username: data.username || username.trim() }))
    } catch {
      // P0 FIX: Differentiate network errors from server errors
      toast.error(t('auth.loginNetworkError'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gradient-to-br from-stone-50 via-background to-cyan-50/30 dark:from-stone-950 dark:via-stone-900 dark:to-cyan-950/10">
      {/* Background decoration */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 size-80 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 size-80 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-96 rounded-full bg-indigo-500/5 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-md"
      >
        {/* Logo & Title */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mb-8 flex flex-col items-center text-center"
        >
          <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 text-3xl shadow-lg shadow-cyan-500/25">
            🤖
          </div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">
            {t('auth.appTitle')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('auth.subtitle')}
          </p>
        </motion.div>

        {/* Login Card */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          <Card className="border-border/50 shadow-xl shadow-teal-500/5 backdrop-blur-sm bg-card/80">
            <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-xl text-center">{t('auth.signIn')}</CardTitle>
            <CardDescription className="text-center">
              {t('auth.enterCredentials')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">{t('common.name')}</Label>
                <Input
                  id="username"
                  type="text"
                  placeholder={t('auth.enterUsername')}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="h-11 bg-background"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t('auth.password')}</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder={t('auth.enterPassword')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="h-11 bg-background pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 size-11 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                    <span className="sr-only">
                      {showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                    </span>
                  </Button>
                </div>
              </div>

              <Button
                type="submit"
                disabled={isSubmitting}
                className="w-full h-11 bg-gradient-to-r from-cyan-600 to-blue-600 shadow-md shadow-cyan-500/25 hover:from-cyan-700 hover:to-blue-700 hover:shadow-lg hover:shadow-cyan-500/30 transition-all text-white font-medium"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin mr-2" />
                    {t('auth.signingIn')}
                  </>
                ) : (
                  <>
                    <LogIn className="size-4 mr-2" />
                    {t('auth.signIn')}
                  </>
                )}
              </Button>
            </form>
          </CardContent>
          </Card>
        </motion.div>

        {/* Footer branding */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.4 }}
          className="mt-6 text-center"
        >
          <p className="text-xs text-muted-foreground/60">
            © {new Date().getFullYear()} Bot Factory. All rights reserved.
          </p>
        </motion.div>
      </motion.div>
    </div>
  )
}
