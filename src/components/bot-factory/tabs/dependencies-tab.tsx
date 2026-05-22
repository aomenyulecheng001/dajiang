'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2, Check, X, Pencil } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useBotStore } from '@/store/bot-store'
import { useT } from '@/lib/i18n'
import { ConfirmDialog } from '@/components/bot-factory/confirm-dialog'

export function DependenciesTab() {
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => s.bots.find((b) => b.id === selectedBotId))
  const addDependency = useBotStore((s) => s.addDependency)
  const updateDependency = useBotStore((s) => s.updateDependency)
  const removeDependency = useBotStore((s) => s.removeDependency)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [isRequired, setIsRequired] = useState(true)
  const [description, setDescription] = useState('')

  // Inline editing state
  const [editingDepId, setEditingDepId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editVersion, setEditVersion] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editRequired, setEditRequired] = useState(true)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  const [pendingRemoveName, setPendingRemoveName] = useState('')

  const t = useT()
  const editNameRef = useRef<HTMLInputElement>(null)

  const cancelInlineEdit = useCallback(() => {
    setEditingDepId(null)
    setEditName('')
    setEditVersion('')
    setEditDesc('')
    setEditRequired(true)
  }, [])

  // Focus input when editing starts
  useEffect(() => {
    if (editingDepId && editNameRef.current) {
      editNameRef.current.focus()
      editNameRef.current.select()
    }
  }, [editingDepId, cancelInlineEdit])

  // Click-outside handler for inline editing
  useEffect(() => {
    if (!editingDepId) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (
        editNameRef.current &&
        !editNameRef.current.contains(target) &&
        !target.closest('[data-edit-actions]') &&
        !target.closest('[data-edit-row]')
      ) {
        cancelInlineEdit()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelInlineEdit()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [editingDepId, cancelInlineEdit])

  if (!bot) return null

  const handleAdd = () => {
    if (!name.trim()) {
      toast.error(t('depsTab.nameRequired'))
      return
    }
    // FIX: Validate dependency name matches backend rules — reject names starting with . / \
    const trimmedName = name.trim()
    if (/^[./\\]/.test(trimmedName)) {
      toast.error(t('depsTab.invalidDepName', { name: trimmedName }))
      return
    }
    // Check for duplicate dependency name
    const existing = bot.dependencies.find((d) => d.name.toLowerCase() === trimmedName.toLowerCase())
    if (existing) {
      toast.error(t('depsTab.duplicateDep', { name: trimmedName }))
      return
    }
    addDependency(bot.id, {
      name: trimmedName,
      version: version.trim() || 'latest',
      isRequired,
      description: description.trim() || undefined,
    })
    toast.success(t('depsTab.added', { name: trimmedName }))
    setName('')
    setVersion('')
    setIsRequired(true)
    setDescription('')
    setDialogOpen(false)
  }

  const handleRemoveClick = (depId: string, depName: string) => {
    setPendingRemove(depId)
    setPendingRemoveName(depName)
    setConfirmOpen(true)
  }

  const handleConfirmRemove = () => {
    if (pendingRemove) {
      removeDependency(bot.id, pendingRemove)
      toast.success(t('depsTab.removed', { name: pendingRemoveName }))
    }
    setConfirmOpen(false)
    setPendingRemove(null)
    setPendingRemoveName('')
  }

  const startInlineEdit = (depId: string) => {
    const dep = bot.dependencies.find((d) => d.id === depId)
    if (!dep) return
    setEditingDepId(depId)
    setEditName(dep.name)
    setEditVersion(dep.version)
    setEditDesc(dep.description || '')
    setEditRequired(dep.isRequired)
  }

  const saveInlineEdit = (depId: string) => {
    if (!editName.trim()) {
      toast.error(t('depsTab.nameRequired'))
      return
    }
    const oldDep = bot.dependencies.find((d) => d.id === depId)
    if (!oldDep) return

    // FIX: Check for duplicate name (excluding current dependency)
    const existing = bot.dependencies.find((d) => d.id !== depId && d.name.toLowerCase() === editName.trim().toLowerCase())
    if (existing) {
      toast.error(t('depsTab.duplicateDep', { name: editName.trim() }))
      return
    }

    // Update dependency in-place, preserving the same ID
    updateDependency(bot.id, depId, {
      name: editName.trim(),
      version: editVersion.trim() || 'latest',
      isRequired: editRequired,
      description: editDesc.trim() || undefined,
    })
    toast.success(t('depsTab.updated', { name: editName.trim() }))
    setEditingDepId(null)
  }

  const requiredCount = bot.dependencies.filter((d) => d.isRequired).length
  const optionalCount = bot.dependencies.filter((d) => !d.isRequired).length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="pb-0">
          <h3 className="text-base font-semibold tracking-tight text-foreground">{t('depsTab.title')}</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('depsTab.desc')}
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialogOpen(true)}>
          <Plus className="size-3.5" />
          {t('depsTab.addButton')}
        </Button>
      </div>

      <div className="rounded-lg border border-border/20 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="font-semibold pl-5">{t('depsTab.colName')}</TableHead>
              <TableHead className="font-semibold">{t('depsTab.colVersion')}</TableHead>
              <TableHead className="font-semibold">{t('depsTab.colRequired')}</TableHead>
              <TableHead className="font-semibold hidden sm:table-cell">{t('depsTab.colDescription')}</TableHead>
              <TableHead className="w-16 pr-5"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bot.dependencies.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  {t('depsTab.noDeps')}
                </TableCell>
              </TableRow>
            ) : (
              bot.dependencies.map((dep) => {
                const isEditing = editingDepId === dep.id
                return (
                  <TableRow
                    key={dep.id}
                    data-edit-row
                  >
                    {isEditing ? (
                      <>
                        <TableCell className="pl-5">
                          <Input
                            ref={editNameRef}
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                saveInlineEdit(dep.id)
                              }
                            }}
                            className="h-7 text-[15px] font-mono"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={editVersion}
                            onChange={(e) => setEditVersion(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                saveInlineEdit(dep.id)
                              }
                            }}
                            className="h-7 text-[15px] font-mono w-24"
                            placeholder={t('depsTab.versionPlaceholder')}
                          />
                        </TableCell>
                        <TableCell>
                          <Checkbox
                            checked={editRequired}
                            onCheckedChange={(checked) => setEditRequired(checked === true)}
                          />
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <Input
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                saveInlineEdit(dep.id)
                              }
                            }}
                            className="h-7 text-[15px] max-w-xs"
                            placeholder={t('depsTab.colDescription')}
                          />
                        </TableCell>
                        <TableCell className="pr-5">
                          <div className="flex items-center gap-0.5" data-edit-actions>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/10"
                              onClick={(e) => {
                                e.stopPropagation()
                                saveInlineEdit(dep.id)
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
                                cancelInlineEdit()
                              }}
                              aria-label={t('common.cancel')}
                            >
                              <X className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell className="font-medium font-mono text-[15px] pl-5">
                          {dep.name}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-[13px] font-mono">
                            {dep.version}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={
                              dep.isRequired
                                ? 'text-[13px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
                                : 'text-[13px] bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 border-zinc-500/20'
                            }
                          >
                            {dep.isRequired ? t('common.required') : t('common.optional')}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-[15px] text-muted-foreground hidden sm:table-cell max-w-xs truncate">
                          {dep.description || '—'}
                        </TableCell>
                        <TableCell className="pr-5">
                          <div className="flex items-center gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-muted-foreground hover:text-foreground"
                              onClick={() => startInlineEdit(dep.id)}
                              aria-label={t('depsTab.editItem', { name: dep.name })}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-muted-foreground hover:text-destructive"
                              onClick={() => handleRemoveClick(dep.id, dep.name)}
                              aria-label={t('depsTab.removeItem', { name: dep.name })}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center gap-4 text-[13px] text-muted-foreground">
        <span>{t('depsTab.totalPackages', { n: bot.dependencies.length })}</span>
        <span>{t('depsTab.totalRequired', { n: requiredCount })}</span>
        <span>{t('depsTab.totalOptional', { n: optionalCount })}</span>
      </div>

      {/* Add Dependency Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        if (!open) { setName(''); setVersion(''); setIsRequired(true); setDescription('') }
        setDialogOpen(open)
      }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('depsTab.addDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('depsTab.addDialogDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="dep-name">{t('depsTab.packageName')}</Label>
              <Input
                id="dep-name"
                placeholder={t('depsTab.packagePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dep-version">{t('depsTab.colVersion')}</Label>
              <Input
                id="dep-version"
                placeholder={t('depsTab.versionPlaceholder')}
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dep-desc">{t('depsTab.colDescription')}</Label>
              <Input
                id="dep-desc"
                placeholder={t('depsTab.descPlaceholder')}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="dep-required"
                checked={isRequired}
                onCheckedChange={(checked) => setIsRequired(checked === true)}
              />
              <Label htmlFor="dep-required" className="text-[15px] font-normal">
                {t('depsTab.requiredDep')}
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

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('depsTab.removeConfirmTitle')}
        description={t('depsTab.removeConfirmDesc', { name: pendingRemoveName })}
        confirmText={t('common.delete')}
        variant="destructive"
        onConfirm={handleConfirmRemove}
      />
    </div>
  )
}
