'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Eye, EyeOff, Plus, Shield, Key, Trash2, Check, X, Pencil, FileUp, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useBotStore, authFetch } from '@/store/bot-store'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { SENSITIVE_KEY_PATTERNS } from '@/lib/bot-constants'
import { ConfirmDialog } from '@/components/bot-factory/confirm-dialog'

// Client-side heuristic matching the server-side isSensitiveKey in crypto.ts
// Uses shared SENSITIVE_KEY_PATTERNS from bot-constants.ts (single source of truth)
function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_KEY_PATTERNS.some(pattern => lower.includes(pattern))
}

export function EnvVarsTab() {
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => s.bots.find((b) => b.id === selectedBotId))
  const addEnvVar = useBotStore((s) => s.addEnvVar)
  const updateEnvVar = useBotStore((s) => s.updateEnvVar)
  const removeEnvVar = useBotStore((s) => s.removeEnvVar)
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null)
  const [editKey, setEditKey] = useState('')
  const editKeyInputRef = useRef<HTMLInputElement>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [isEncrypted, setIsEncrypted] = useState(false)
  const [description, setDescription] = useState('')
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const t = useT()
  const editInputRef = useRef<HTMLInputElement>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [pendingRemoveKey, setPendingRemoveKey] = useState('')
  const [pendingRemoveIsSensitive, setPendingRemoveIsSensitive] = useState(false)

  // Revealed (decrypted) values fetched from the server-side reveal API
  // Keyed by envVar.id → plaintext value
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({})
  const [revealingIds, setRevealingIds] = useState<Set<string>>(new Set())

  const cancelEditing = () => {
    setEditingId(null)
    setEditValue('')
  }

  const cancelKeyEditing = () => {
    setEditingKeyId(null)
    setEditKey('')
  }

  // Focus the input when editing starts
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // Focus key input when editing
  useEffect(() => {
    if (editingKeyId && editKeyInputRef.current) {
      editKeyInputRef.current.focus()
      editKeyInputRef.current.select()
    }
  }, [editingKeyId])

  // Click-outside handler: if editing value or key, cancel when clicking outside
  useEffect(() => {
    if (!editingId && !editingKeyId) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // If click is outside the editing area, cancel value editing
      if (editingId && editInputRef.current &&
        !editInputRef.current.contains(target) &&
        !target.closest('[data-edit-actions]')
      ) {
        cancelEditing()
      }
      // If click is outside the key editing area, cancel key editing
      if (editingKeyId && editKeyInputRef.current &&
        !editKeyInputRef.current.contains(target) &&
        !target.closest('[data-edit-actions]')
      ) {
        cancelKeyEditing()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingId) cancelEditing()
        if (editingKeyId) cancelKeyEditing()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [editingId, editingKeyId])

  /** Fetch decrypted env vars from the reveal API and cache the result */
  const fetchRevealedValues = useCallback(async () => {
    if (!bot) return
    try {
      const res = await authFetch(`/api/bots/${bot.id}/env-vars/reveal`)
      if (!res.ok) throw new Error('Failed to reveal')
      const data = await res.json()
      const vars: Record<string, string> = {}
      for (const v of data.envVars || []) {
        vars[v.id] = v.value
      }
      setRevealedValues(vars)
    } catch {
      toast.error(t('envTab.revealFailed') || 'Failed to reveal values')
      throw new Error('Reveal failed')
    }
  }, [bot?.id, t])

  // Auto-reveal edit state — must be declared before early return (rules-of-hooks)
  const [autoRevealEditId, setAutoRevealEditId] = useState<string | null>(null)

  // Auto-enter edit mode after auto-reveal completes
  // BUG FIX: Also clear autoRevealEditId if the reveal fails (id set but never added to revealedIds).
  // Without this, clicking a masked value when reveal fails leaves the UI stuck —
  // the user clicks but nothing happens because autoRevealEditId is still set from the failed attempt.
  useEffect(() => {
    if (!autoRevealEditId) return
    if (revealedIds.has(autoRevealEditId)) {
      const envVar = bot?.envVars.find(v => v.id === autoRevealEditId)
      if (envVar) {
        const realValue = revealedValues[autoRevealEditId] ?? envVar.value
        setEditingId(autoRevealEditId)
        setEditValue(realValue)
      }
      setAutoRevealEditId(null)
    }
  }, [autoRevealEditId, revealedIds, revealedValues, bot?.envVars])

  // BUG FIX: Clear stale autoRevealEditId after 10 seconds if reveal never completed.
  // This handles network errors or API failures where the reveal never fires.
  useEffect(() => {
    if (!autoRevealEditId) return
    const timer = setTimeout(() => {
      setAutoRevealEditId(null)
    }, 10_000)
    return () => clearTimeout(timer)
  }, [autoRevealEditId])

  if (!bot) return null

  const toggleReveal = async (id: string) => {
    const isCurrentlyRevealed = revealedIds.has(id)

    if (isCurrentlyRevealed) {
      // Just hide — no API call needed
      setRevealedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    } else {
      // Show — need the real decrypted value
      // If we already have it cached, just reveal
      if (revealedValues[id] !== undefined) {
        setRevealedIds((prev) => {
          const next = new Set(prev)
          next.add(id)
          return next
        })
      } else {
        // Fetch from reveal API
        setRevealingIds((prev) => new Set(prev).add(id))
        try {
          await fetchRevealedValues()
          setRevealedIds((prev) => new Set(prev).add(id))
        } catch {
          setAutoRevealEditId(null)
        } finally {
          setRevealingIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
        }
      }
    }
  }

  const maskValue = () => '••••••••••••'

  /** Get the display value for an env var, using the server-revealed plaintext when available */
  const getDisplayValue = (envVar: { id: string; value: string; isEncrypted: boolean; key: string }, isRevealed: boolean) => {
    const sensitive = isSensitiveKey(envVar.key)
    const shouldMask = envVar.isEncrypted || sensitive

    if (shouldMask && !isRevealed) {
      return maskValue()
    }

    // If revealed, use the server-decrypted value (accurate) rather than the
    // local store value (which may be the placeholder ••••••••••••)
    if (isRevealed && revealedValues[envVar.id] !== undefined) {
      return revealedValues[envVar.id]
    }

    return envVar.value
  }

  /** Get the actual plaintext value for editing — uses revealed value if available */
  const getEditValue = (envVar: { id: string; value: string; isEncrypted: boolean; key: string }): string => {
    const sensitive = isSensitiveKey(envVar.key)
    const shouldMask = envVar.isEncrypted || sensitive
    // For encrypted/sensitive vars, use the revealed value if available
    if (shouldMask && revealedValues[envVar.id] !== undefined) {
      return revealedValues[envVar.id]
    }
    // If we don't have the revealed value and it's masked, we can't edit properly
    // The user needs to reveal first — but we still return the stored value
    return envVar.value
  }

  const startEditing = (envVarId: string, currentValue: string) => {
    // FIX: If the current value is the masked placeholder, auto-reveal first.
    // Editing a masked value would save "••••••••••••" as the real value.
    if (currentValue === maskValue()) {
      // Set flag so we auto-enter edit mode after reveal completes
      setAutoRevealEditId(envVarId)
      toggleReveal(envVarId)
      return
    }
    setEditingId(envVarId)
    setEditValue(currentValue)
  }

  const saveEditing = (envVarId: string) => {
    const envVar = bot.envVars.find(v => v.id === envVarId)
    if (editValue === '' && envVar && isSensitiveKey(envVar.key)) {
      toast.error(t('envTab.valueRequired'))
      return
    }
    updateEnvVar(bot.id, envVarId, { value: editValue.trim() })
    toast.success(t('envTab.valueUpdated'))
    setEditingId(null)
    setEditValue('')
    // BUG FIX: Clear both revealedValues and revealedIds caches so the UI
    // doesn't show "revealed but displaying masked value" after fetchBotDetail
    // overwrites the plaintext with the masked placeholder.
    setRevealedValues((prev) => {
      const next = { ...prev }
      delete next[envVarId]
      return next
    })
    setRevealedIds((prev) => {
      const next = new Set(prev)
      next.delete(envVarId)
      return next
    })
  }

  const startKeyEditing = (envVarId: string, currentKey: string) => {
    setEditingKeyId(envVarId)
    setEditKey(currentKey)
  }

  const saveKeyEditing = (envVarId: string) => {
    if (!editKey.trim()) {
      toast.error(t('envTab.nameRequired'))
      return
    }
    const upperKey = editKey.trim().toUpperCase()
    // Check for duplicate key (excluding current)
    const existing = bot.envVars.find((v) => v.key === upperKey && v.id !== envVarId)
    if (existing) {
      toast.error(t('envTab.duplicateKey', { key: upperKey }))
      return
    }
    updateEnvVar(bot.id, envVarId, { key: upperKey })
    toast.success(t('envTab.keyUpdated', { key: upperKey }))
    setEditingKeyId(null)
    setEditKey('')
  }

  const handleAdd = () => {
    if (!key.trim()) {
      toast.error(t('envTab.nameRequired'))
      return
    }
    if (value === '' && isSensitiveKey(key.trim().toUpperCase())) {
      toast.error(t('envTab.valueRequired'))
      return
    }
    const upperKey = key.trim().toUpperCase()
    // Check for duplicate key — update existing instead of adding a new one
    const existing = bot.envVars.find((v) => v.key === upperKey)
    if (existing) {
      updateEnvVar(bot.id, existing.id, {
        value: value.trim(),
        isEncrypted,
        description: description.trim() || existing.description,
      })
      toast.success(t('envTab.updated', { key: upperKey }))
    } else {
      addEnvVar(bot.id, {
        key: upperKey,
        value: value.trim(),
        isEncrypted,
        description: description.trim() || undefined,
      })
      toast.success(t('envTab.added', { key: upperKey }))
    }
    setKey('')
    setValue('')
    setIsEncrypted(false)
    setDescription('')
    setDialogOpen(false)
  }

  const handleRemoveClick = (envVarId: string, envKey: string, isSensitive: boolean) => {
    setPendingRemoveId(envVarId)
    setPendingRemoveKey(envKey)
    setPendingRemoveIsSensitive(isSensitive)
    setConfirmOpen(true)
  }

  const handleConfirmRemove = () => {
    if (pendingRemoveId) {
      removeEnvVar(bot.id, pendingRemoveId)
      toast.success(t('envTab.removed', { key: pendingRemoveKey }))
    }
    setConfirmOpen(false)
    setPendingRemoveId(null)
    setPendingRemoveKey('')
    setPendingRemoveIsSensitive(false)
  }

  function parseEnvText(text: string): { key: string; value: string }[] {
    return text.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const eqIndex = line.indexOf('=')
        if (eqIndex === -1) return null
        return { key: line.slice(0, eqIndex).trim().toUpperCase(), value: line.slice(eqIndex + 1).trim() }
      })
      .filter((item): item is { key: string; value: string } => item !== null)
  }

  const handleBulkImport = () => {
    if (!bulkText.trim()) {
      toast.error(t('envTab.valueRequired'))
      return
    }
    const parsed = parseEnvText(bulkText)
    if (parsed.length === 0) {
      toast.error(t('envTab.valueRequired'))
      return
    }
    const validEntries = parsed.filter(({ value }) => value.trim())
    if (validEntries.length === 0) {
      toast.error(t('envTab.valueRequired'))
      return
    }
    let imported = 0
    validEntries.forEach(({ key: parsedKey, value: parsedValue }) => {
      const existing = bot.envVars.find((v) => v.key === parsedKey)
      if (existing) {
        updateEnvVar(bot.id, existing.id, { value: parsedValue })
      } else {
        addEnvVar(bot.id, {
          key: parsedKey,
          value: parsedValue,
          isEncrypted: false,
        })
      }
      imported++
    })
    toast.success(t('envTab.bulkImportSuccess', { n: imported }))
    setBulkText('')
    setBulkDialogOpen(false)
  }

  const encryptedCount = bot.envVars.filter((v) => v.isEncrypted).length
  const sensitiveCount = bot.envVars.filter((v) => isSensitiveKey(v.key)).length

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between pb-2">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-foreground">{t('envTab.title')}</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('envTab.desc')}
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-1.5">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setBulkDialogOpen(true)}>
            <FileUp className="size-3.5" />
            {t('envTab.bulkImport')}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialogOpen(true)}>
            <Plus className="size-3.5" />
            {t('envTab.addButton')}
          </Button>
        </div>
      </div>

      {bot.envVars.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center rounded-lg border border-dashed border-border/40">
          <Key className="size-10 text-muted-foreground/40 mb-3" />
          <p className="text-[15px] font-medium text-muted-foreground">{t('envTab.noVars')}</p>
          <p className="text-[13px] text-muted-foreground/60 mt-1">
            {t('envTab.noVarsDesc')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {bot.envVars.map((envVar) => {
            const isRevealed = revealedIds.has(envVar.id)
            const isRevealing = revealingIds.has(envVar.id)
            const isEditing = editingId === envVar.id
            const sensitive = isSensitiveKey(envVar.key)
            const shouldMask = envVar.isEncrypted || sensitive
            const displayValue = getDisplayValue(envVar, isRevealed)

            return (
              <Card key={envVar.id} className={cn('gap-0 py-0 shadow-none group border-border/20')}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted mt-0.5">
                      {envVar.isEncrypted ? (
                        <Shield className="size-4 text-amber-500" />
                      ) : sensitive ? (
                        <Shield className="size-4 text-blue-500" />
                      ) : (
                        <Key className="size-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        {editingKeyId === envVar.id ? (
                          <div className="flex items-center gap-1">
                            <Input
                              ref={editKeyInputRef}
                              value={editKey}
                              onChange={(e) => setEditKey(e.target.value.toUpperCase())}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  saveKeyEditing(envVar.id)
                                }
                                if (e.key === 'Escape') {
                                  cancelKeyEditing()
                                }
                              }}
                              className="h-6 text-[13px] font-mono w-36"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-5 text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400"
                              onClick={() => saveKeyEditing(envVar.id)}
                            >
                              <Check className="size-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-5 text-muted-foreground"
                              onClick={() => cancelKeyEditing()}
                            >
                              <X className="size-3" />
                            </Button>
                          </div>
                        ) : (
                          <span className="text-[15px] font-mono font-semibold text-foreground">
                            {envVar.key}
                          </span>
                        )}
                        {!editingKeyId && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-5 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => startKeyEditing(envVar.id, envVar.key)}
                            aria-label={t('common.editItem', { name: envVar.key })}
                          >
                            <Pencil className="size-3" />
                          </Button>
                        )}
                        {envVar.isEncrypted && (
                          <Badge
                            variant="outline"
                            className="text-[13px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"
                          >
                            {t('common.encrypted')}
                          </Badge>
                        )}
                        {!envVar.isEncrypted && sensitive && (
                          <Badge
                            variant="outline"
                            className="text-[13px] bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20"
                          >
                            {t('envTab.sensitive')}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {isEditing ? (
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <Input
                              ref={editInputRef}
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  saveEditing(envVar.id)
                                }
                              }}
                              className="text-[15px] font-mono h-8"
                              type={shouldMask && !isRevealed ? 'password' : 'text'}
                            />
                            <div className="flex items-center gap-1 shrink-0" data-edit-actions>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/10"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  saveEditing(envVar.id)
                                }}
                                aria-label={t('common.save')}
                              >
                                <Check className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-muted-foreground hover:text-foreground"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  cancelEditing()
                                }}
                                aria-label={t('common.cancel')}
                              >
                                <X className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <code
                            className="text-[15px] bg-muted px-2.5 py-1 rounded-md font-mono text-foreground/80 break-all cursor-pointer hover:bg-muted/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1"
                            onClick={() => startEditing(envVar.id, getEditValue(envVar))}
                            title={t('envTab.clickToEdit')}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                startEditing(envVar.id, getEditValue(envVar))
                              }
                            }}
                          >
                            {displayValue}
                          </code>
                        )}
                        {!isEditing && shouldMask && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleReveal(envVar.id)}
                            className="h-8 w-8 p-0 shrink-0"
                            disabled={isRevealing}
                            aria-label={isRevealed ? t('common.hideValue') : t('common.revealValue')}
                          >
                            {isRevealing ? (
                              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                            ) : isRevealed ? (
                              <EyeOff className="size-3.5 text-foreground" />
                            ) : (
                              <Eye className="size-3.5 text-muted-foreground" />
                            )}
                          </Button>
                        )}
                      </div>
                      {envVar.description && (
                        <p className="text-[13px] text-muted-foreground">
                          {envVar.description}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive shrink-0 mt-0.5"
                      onClick={() => handleRemoveClick(envVar.id, envVar.key, shouldMask)}
                      aria-label={t('common.removeItem', { name: envVar.key })}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-4 text-[13px] text-muted-foreground">
        <span>{t('envTab.totalVars', { n: bot.envVars.length })}</span>
        <span>{t('envTab.encryptedVars', { n: encryptedCount })}</span>
        {sensitiveCount > encryptedCount && (
          <span>{t('envTab.sensitiveVars', { n: sensitiveCount - encryptedCount })}</span>
        )}
      </div>

      {/* Add Variable Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        if (!open) { setKey(''); setValue(''); setIsEncrypted(false); setDescription('') }
        setDialogOpen(open)
      }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('envTab.addDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('envTab.addDialogDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="env-key">{t('envTab.varName')}</Label>
              <Input
                id="env-key"
                placeholder={t('envTab.varNamePlaceholder')}
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="env-value">{t('envTab.varValue')}</Label>
              <Input
                id="env-value"
                placeholder={t('envTab.varValuePlaceholder')}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                type={isEncrypted ? 'password' : 'text'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="env-desc">{t('envTab.varDesc')}</Label>
              <Input
                id="env-desc"
                placeholder={t('envTab.varDescPlaceholder')}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="env-encrypted"
                checked={isEncrypted}
                onCheckedChange={(checked) => setIsEncrypted(checked === true)}
              />
              <Label htmlFor="env-encrypted" className="text-[15px] font-normal">
                <Shield className="size-3.5 inline mr-1 text-amber-500" />
                {t('envTab.encryptValue')}
              </Label>
            </div>
          </div>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleAdd} className="gap-1.5 bg-gradient-to-r from-cyan-600 to-blue-600">
              {t('common.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Import Dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={(open) => {
        if (!open) { setBulkText('') }
        setBulkDialogOpen(open)
      }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t('envTab.bulkImportTitle')}</DialogTitle>
            <DialogDescription>
              {t('envTab.bulkImportDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={t('envTab.bulkImportPlaceholder')}
              className="font-mono text-sm min-h-[200px] resize-y"
              spellCheck={false}
            />
            {bulkText.trim() && (
              <p className="text-xs text-muted-foreground">
                {t('envTab.bulkImportPreview', { n: parseEnvText(bulkText).length })}
              </p>
            )}
          </div>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button variant="outline" onClick={() => { setBulkText(''); setBulkDialogOpen(false) }}>{t('common.cancel')}</Button>
            <Button
              onClick={handleBulkImport}
              disabled={!bulkText.trim()}
              className="gap-1.5 bg-gradient-to-r from-cyan-600 to-blue-600"
            >
              <FileUp className="size-3.5" />
              {t('envTab.bulkImport')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('envTab.removeConfirmTitle')}
        description={t(pendingRemoveIsSensitive ? 'envTab.removeConfirmDescSensitive' : 'envTab.removeConfirmDesc', { key: pendingRemoveKey })}
        confirmText={t('common.delete')}
        variant="destructive"
        onConfirm={handleConfirmRemove}
      />
    </div>
  )
}
