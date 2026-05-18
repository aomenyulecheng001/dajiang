'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useBotStore } from '@/store/bot-store'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { BotAvatar } from './bot-avatar'
import {
  Search, Plus, Sun, Moon, Grid2X2, List, Globe,
  Bot, ArrowLeft,
} from 'lucide-react'
import { setLocale } from '@/lib/i18n'
import { useTheme } from 'next-themes'

interface CommandItem {
  id: string
  icon: React.ElementType
  label: string
  group: string
  action: () => void
  keywords: string[]
  botId?: string
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const t = useT()
  const { theme, setTheme } = useTheme()

  const bots = useBotStore(s => s.bots)
  const setSelectedBotId = useBotStore(s => s.setSelectedBotId)
  const selectedBotId = useBotStore(s => s.selectedBotId)
  const setCreateBotDialogOpen = useBotStore(s => s.setCreateBotDialogOpen)
  const setCreateBotDialogMode = useBotStore(s => s.setCreateBotDialogMode)
  const viewMode = useBotStore(s => s.viewMode)
  const setViewMode = useBotStore(s => s.setViewMode)
  const setStatusFilter = useBotStore(s => s.setStatusFilter)

  // Handle dialog open/close
  const handleOpenChange = useCallback((newOpen: boolean) => {
    setOpen(newOpen)
    if (newOpen) {
      setQuery('')
      setSelectedIndex(0)
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>('[data-command-input]')?.focus()
      })
    }
  }, [])

  // Build command list
  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: 'create-bot',
        icon: Plus,
        label: t('commandPalette.createBot'),
        group: t('commandPalette.actions'),
        action: () => { setCreateBotDialogMode('create'); setCreateBotDialogOpen(true); handleOpenChange(false) },
        keywords: ['new', 'create', 'add', '创建', '新建'],
      },
      {
        id: 'import-bot',
        icon: Plus,
        label: t('createBot.tabImport'),
        group: t('commandPalette.actions'),
        action: () => { setCreateBotDialogMode('import'); setCreateBotDialogOpen(true); handleOpenChange(false) },
        keywords: ['import', 'upload', '导入', '导入机器人'],
      },
      ...bots.map((bot) => ({
        id: `bot-${bot.id}`,
        icon: Bot,
        label: bot.name,
        group: t('commandPalette.bots'),
        action: () => { setSelectedBotId(bot.id); handleOpenChange(false) },
        keywords: [bot.name, bot.description || ''],
        botId: bot.id,
      })),
      ...(selectedBotId ? [{
        id: 'go-back',
        icon: ArrowLeft,
        label: t('commandPalette.goBack'),
        group: t('commandPalette.navigation'),
        action: () => { setSelectedBotId(null); handleOpenChange(false) },
        keywords: ['back', 'return', '返回'],
      }] : []),
      {
        id: 'toggle-view',
        icon: viewMode === 'grid' ? List : Grid2X2,
        label: viewMode === 'grid' ? t('commandPalette.listView') : t('commandPalette.gridView'),
        group: t('commandPalette.settings'),
        action: () => { setViewMode(viewMode === 'grid' ? 'list' : 'grid'); handleOpenChange(false) },
        keywords: ['view', 'grid', 'list', '切换', '视图'],
      },
      {
        id: 'toggle-theme',
        icon: theme === 'dark' ? Sun : Moon,
        label: theme === 'dark' ? t('commandPalette.lightMode') : t('commandPalette.darkMode'),
        group: t('commandPalette.settings'),
        action: () => { setTheme(theme === 'dark' ? 'light' : 'dark'); handleOpenChange(false) },
        keywords: ['theme', 'dark', 'light', '主题', '暗色', '亮色'],
      },
      {
        id: 'switch-lang-zh',
        icon: Globe,
        label: t('commandPalette.switchZh'),
        group: t('commandPalette.settings'),
        action: () => { setLocale('zh'); handleOpenChange(false) },
        keywords: ['language', 'chinese', '中文', '语言'],
      },
      {
        id: 'switch-lang-en',
        icon: Globe,
        label: t('commandPalette.switchEn'),
        group: t('commandPalette.settings'),
        action: () => { setLocale('en'); handleOpenChange(false) },
        keywords: ['language', 'english', '英文', '语言'],
      },
      {
        id: 'filter-all',
        icon: Bot,
        label: t('commandPalette.filterAll'),
        group: t('commandPalette.filters'),
        action: () => { setStatusFilter('all'); handleOpenChange(false) },
        keywords: ['all', 'filter', '全部', '筛选'],
      },
      {
        id: 'filter-active',
        icon: Bot,
        label: t('commandPalette.filterActive'),
        group: t('commandPalette.filters'),
        action: () => { setStatusFilter('active'); handleOpenChange(false) },
        keywords: ['active', 'running', '活跃', '运行'],
      },
      {
        id: 'filter-inactive',
        icon: Bot,
        label: t('commandPalette.filterInactive'),
        group: t('commandPalette.filters'),
        action: () => { setStatusFilter('inactive'); handleOpenChange(false) },
        keywords: ['inactive', 'stopped', '停用', '停止'],
      },
      {
        id: 'filter-error',
        icon: Bot,
        label: t('commandPalette.filterError'),
        group: t('commandPalette.filters'),
        action: () => { setStatusFilter('error'); handleOpenChange(false) },
        keywords: ['error', '异常', '错误'],
      },
    ]
    return items
  }, [bots, selectedBotId, viewMode, theme, t, setCreateBotDialogOpen, setCreateBotDialogMode, setViewMode, setSelectedBotId, setTheme, setStatusFilter, handleOpenChange])

  // Filter commands
  const filtered = useMemo(() => {
    if (!query.trim()) return commands
    const q = query.toLowerCase().trim()
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(q) ||
        cmd.keywords.some((kw) => kw.toLowerCase().includes(q))
    )
  }, [commands, query])

  // Clamp selectedIndex when filtered changes
  const clampedIndex = Math.min(selectedIndex, Math.max(filtered.length - 1, 0))

  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(filtered.length - 1, 0)))
  }, [filtered.length])

  // Keyboard shortcut to open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Reset selection on query change
  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value)
    setSelectedIndex(0)
  }, [])

  // Keyboard navigation within palette
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filtered[clampedIndex]) {
          filtered[clampedIndex].action()
        }
      }
    },
    [filtered, clampedIndex]
  )

  // Group filtered items
  const grouped = useMemo(() => {
    const groups: Record<string, CommandItem[]> = {}
    for (const cmd of filtered) {
      if (!groups[cmd.group]) groups[cmd.group] = []
      groups[cmd.group].push(cmd)
    }
    return groups
  }, [filtered])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="p-0 gap-0 sm:max-w-[560px] overflow-hidden rounded-2xl border shadow-2xl">
        <DialogTitle className="sr-only">{t('commandPalette.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('commandPalette.placeholder')}</DialogDescription>
        {/* Search Input */}
        <div className="flex items-center border-b px-4">
          <Search className="size-5 shrink-0 text-muted-foreground" />
          <Input
            data-command-input
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleInputKeyDown}
            placeholder={t('commandPalette.placeholder')}
            className="h-12 border-0 bg-transparent px-3 text-sm focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/60"
          />
          {query && (
            <kbd className="shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              ESC
            </kbd>
          )}
        </div>

        {/* Results List */}
        <div className="max-h-[360px] overflow-y-auto px-2 py-2">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-sm text-muted-foreground">
              <Search className="size-8 mb-2 opacity-30" />
              <span>{t('commandPalette.noResults')}</span>
            </div>
          ) : (
            Object.entries(grouped).map(([group, items]) => (
              <div key={group} className="mb-2 last:mb-0">
                <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                  {group}
                </div>
                {items.map((item) => {
                  const index = filtered.indexOf(item)
                  const Icon = item.icon
                  const bot = item.botId ? bots.find((b) => b.id === item.botId) : null
                  return (
                    <button
                      key={item.id}
                      data-index={index}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors cursor-pointer',
                        index === clampedIndex
                          ? 'bg-accent text-accent-foreground'
                          : 'text-foreground hover:bg-accent/50'
                      )}
                      onClick={() => item.action()}
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      {/* Icon */}
                      {bot ? (
                        <BotAvatar
                          botId={bot.id}
                          emoji={bot.emoji}
                          customIcon={bot.customIcon}
                          size="sm"
                        />
                      ) : (
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
                          <Icon className="size-3.5 text-muted-foreground" />
                        </div>
                      )}

                      {/* Label */}
                      <div className="flex-1 min-w-0">
                        <span className="truncate block">{item.label}</span>
                        {bot?.description && (
                          <span className="text-[11px] text-muted-foreground truncate block">
                            {bot.description}
                          </span>
                        )}
                      </div>

                      {/* Status badge for bots */}
                      {bot && (
                        <span className={cn(
                          'shrink-0 size-2 rounded-full',
                          bot.status === 'active' && bot.lastRunnerStatus !== 'stopped' ? 'bg-emerald-500' :
                          bot.status === 'inactive' && bot.lastRunnerStatus === 'stopped' ? 'bg-amber-500' :
                          bot.status === 'error' ? 'bg-red-500' :
                          bot.status === 'deploying' ? 'bg-amber-500' :
                          'bg-zinc-400'
                        )} />
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground/60">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↑↓</kbd>
              {t('commandPalette.navigate')}
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">↵</kbd>
              {t('commandPalette.select')}
            </span>
          </div>
          <span>{filtered.length} {t('commandPalette.results')}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
