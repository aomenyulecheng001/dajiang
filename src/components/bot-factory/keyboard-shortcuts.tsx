'use client'

import { useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useBotStore } from '@/store/bot-store'
import { useT } from '@/lib/i18n'
import { Search, ArrowLeft, Plus, LayoutGrid } from 'lucide-react'

interface KeyboardShortcutsProps {
  open: boolean
  onOpenChange: (_open: boolean) => void
}

export function KeyboardShortcutsDialog({ open, onOpenChange }: KeyboardShortcutsProps) {
  const t = useT()

  const shortcuts = [
    { icon: Search, label: t('commandPalette.title'), key: t('shortcuts.keys.search') },
    { icon: ArrowLeft, label: t('shortcuts.back'), key: t('shortcuts.keys.back') },
    { icon: Plus, label: t('shortcuts.create'), key: t('shortcuts.keys.create') },
    { icon: LayoutGrid, label: t('shortcuts.toggle'), key: t('shortcuts.keys.toggle') },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {shortcuts.map((shortcut) => (
            <div
              key={shortcut.key}
              className="flex items-center justify-between rounded-lg border px-3 py-2.5"
            >
              <div className="flex items-center gap-3">
                <shortcut.icon className="size-4 text-muted-foreground" />
                <span className="text-sm text-foreground">{shortcut.label}</span>
              </div>
              <kbd className="pointer-events-none select-none rounded-md border bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                {shortcut.key}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function KeyboardShortcuts({
  searchInputRef,
}: {
  searchInputRef?: React.RefObject<HTMLInputElement | null>
}) {
  const selectedBotId = useBotStore(s => s.selectedBotId)
  const setSelectedBotId = useBotStore(s => s.setSelectedBotId)
  const setCreateBotDialogOpen = useBotStore(s => s.setCreateBotDialogOpen)
  const setViewMode = useBotStore(s => s.setViewMode)
  const viewMode = useBotStore(s => s.viewMode)
  const setSearchQuery = useBotStore(s => s.setSearchQuery)
  const t = useT()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable

      // Ctrl+K: Now handled by CommandPalette component — no duplicate
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        return // Let CommandPalette handle it
      }

      // Don't handle shortcuts when typing in inputs (except Escape)
      if (isInput && e.key !== 'Escape') return

      // /: Focus search (only when not in input)
      if (e.key === '/' && !isInput) {
        e.preventDefault()
        if (searchInputRef?.current) {
          searchInputRef.current.focus()
        }
        return
      }

      // Escape: Go back / clear search
      if (e.key === 'Escape') {
        if (selectedBotId) {
          setSelectedBotId(null)
        } else {
          setSearchQuery('')
          if (searchInputRef?.current) {
            searchInputRef.current.blur()
          }
        }
        return
      }

      // N: Open create dialog (only when not in input)
      if (e.key === 'n' && !isInput) {
        e.preventDefault()
        setCreateBotDialogOpen(true)
        toast.info(t('shortcuts.create'))
        return
      }

      // G: Toggle grid/list
      if (e.key === 'g' && !isInput) {
        e.preventDefault()
        setViewMode(viewMode === 'grid' ? 'list' : 'grid')
        return
      }
    },
    [
      selectedBotId,
      setSelectedBotId,
      setCreateBotDialogOpen,
      setViewMode,
      viewMode,
      setSearchQuery,
      searchInputRef,
      t,
    ]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return null
}
