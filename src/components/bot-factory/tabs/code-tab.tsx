'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTheme } from 'next-themes'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import {
  Copy, Check, ChevronDown, ChevronRight, Pencil, X, Save,
  Plus, Trash2, Search, FileIcon, ArrowRight, AlertTriangle, Clock,
  FolderOpen,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn, formatDate } from '@/lib/utils'
import { useBotStore } from '@/store/bot-store'
import { useT, useLocale } from '@/lib/i18n'
import { ConfirmDialog } from '@/components/bot-factory/confirm-dialog'
import { DependenciesTab } from './dependencies-tab'

const SyntaxHighlighter = dynamic(
  () => import('react-syntax-highlighter').then(mod => mod.Prism),
  { ssr: false, loading: () => <div className="h-[300px] animate-pulse bg-muted/30 rounded" /> }
)

let _oneDark: Record<string, React.CSSProperties> | null = null
let _oneLight: Record<string, React.CSSProperties> | null = null
async function loadStyles() {
  if (_oneDark && _oneLight) return
  const styles = await import('react-syntax-highlighter/dist/esm/styles/prism')
  _oneDark = styles.oneDark
  _oneLight = styles.oneLight
}
import type { CodeBlock, BotLanguage } from '@/types/bot'

// ─── Constants ──────────────────────────────────────────────────────────────

const languageMap: Record<string, string> = {
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  json: 'json',
}

const typeBadgeColors: Record<string, string> = {
  handler: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
  middleware: 'bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20',
  command: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
  callback: 'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20',
  action: 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20',
  cron: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20',
}

// i18n label map for type filter badge display
const typeFilterLabelMap: Record<string, string> = {
  handler: 'Handler',
  middleware: 'Middleware',
  command: 'Command',
  callback: 'Callback',
  action: 'Action',
  cron: 'Cron',
}

const typeFlowColors: Record<string, string> = {
  middleware: 'bg-sky-100 dark:bg-sky-500/15 border-sky-300 dark:border-sky-500/30 text-sky-700 dark:text-sky-300',
  handler: 'bg-emerald-100 dark:bg-emerald-500/15 border-emerald-300 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
  command: 'bg-amber-100 dark:bg-amber-500/15 border-amber-300 dark:border-amber-500/30 text-amber-700 dark:text-amber-300',
  callback: 'bg-purple-100 dark:bg-purple-500/15 border-purple-300 dark:border-purple-500/30 text-purple-700 dark:text-purple-300',
  action: 'bg-rose-100 dark:bg-rose-500/15 border-rose-300 dark:border-rose-500/30 text-rose-700 dark:text-rose-300',
  cron: 'bg-cyan-100 dark:bg-cyan-500/15 border-cyan-300 dark:border-cyan-500/30 text-cyan-700 dark:text-cyan-300',
}

// typeBorderColors and typeTopColors removed — colored borders and top bars no longer used

const typeFlowBadgeColors: Record<string, string> = {
  middleware: 'bg-sky-200/50 dark:bg-sky-500/20 text-sky-700 dark:text-sky-300',
  handler: 'bg-emerald-200/50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
  command: 'bg-amber-200/50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300',
  callback: 'bg-purple-200/50 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300',
  action: 'bg-rose-200/50 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300',
  cron: 'bg-cyan-200/50 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300',
}

// ─── Code Templates ─────────────────────────────────────────────────────────

function getTemplateCode(type: CodeBlock['type'], language: BotLanguage | 'json', name: string): string {
  const templates: Record<string, Record<string, string>> = {
    typescript: {
      handler: `// Handler: ${name}\nimport { Context } from 'telegraf';\n\nexport default async function handler(ctx: Context) {\n  // Handle incoming messages\n  console.log('Received:', ctx.message);\n}\n`,
      middleware: `// Middleware: ${name}\nimport { Context, NextFunction } from 'telegraf';\n\nexport default async function middleware(ctx: Context, next: NextFunction) {\n  console.log('Middleware executed');\n  await next();\n}\n`,
      command: `// Command: /start\nimport { Context } from 'telegraf';\n\nexport default async function startCommand(ctx: Context) {\n  await ctx.reply('Hello! I am your bot. How can I help you?');\n}\n`,
      callback: `// Callback: ${name}\nimport { Context } from 'telegraf';\n\nexport default async function callbackHandler(ctx: Context) {\n  const data = ctx.callbackQuery?.data;\n  await ctx.answerCbQuery();\n  await ctx.reply(\`You selected: \${data}\`);\n}\n`,
      action: `// Action: ${name}\nimport { Context } from 'telegraf';\n\nexport default async function action(ctx: Context) {\n  // Perform action\n  await ctx.reply('Action executed!');\n}\n`,
      cron: `// Cron Job: ${name}\n// Runs on schedule\n\nexport default async function cronJob() {\n  console.log('Cron job executed at:', new Date().toISOString());\n  // Add your scheduled task here\n}\n`,
    },
    javascript: {
      handler: `// Handler: ${name}\n\nmodule.exports = async function handler(ctx) {\n  // Handle incoming messages\n  console.log('Received:', ctx.message);\n}\n`,
      middleware: `// Middleware: ${name}\n\nmodule.exports = async function middleware(ctx, next) {\n  console.log('Middleware executed');\n  await next();\n}\n`,
      command: `// Command: /start\n\nmodule.exports = async function startCommand(ctx) {\n  await ctx.reply('Hello! I am your bot. How can I help you?');\n}\n`,
      callback: `// Callback: ${name}\n\nmodule.exports = async function callbackHandler(ctx) {\n  const data = ctx.callbackQuery?.data;\n  await ctx.answerCbQuery();\n  await ctx.reply(\`You selected: \${data}\`);\n}\n`,
      action: `// Action: ${name}\n\nmodule.exports = async function action(ctx) {\n  await ctx.reply('Action executed!');\n}\n`,
      cron: `// Cron Job: ${name}\n\nmodule.exports = async function cronJob() {\n  console.log('Cron job executed at:', new Date().toISOString());\n}\n`,
    },
    python: {
      handler: `# Handler: ${name}\nfrom telegram import Update\nfrom telegram.ext import ContextTypes\n\nasync def handler(update: Update, context: ContextTypes.DEFAULT_TYPE):\n    \"\"\"Handle incoming messages\"\"\"\n    print(f"Received: {update.message}")\n`,
      middleware: `# Middleware: ${name}\nfrom telegram import Update\nfrom telegram.ext import ContextTypes\n\nasync def middleware(update: Update, context: ContextTypes.DEFAULT_TYPE):\n    \"\"\"Middleware function\"\"\"\n    print("Middleware executed")\n`,
      command: `# Command: /start\nfrom telegram import Update\nfrom telegram.ext import ContextTypes\n\nasync def start(update: Update, context: ContextTypes.DEFAULT_TYPE):\n    \"\"\"Start command handler\"\"\"\n    await update.message.reply_text("Hello! I am your bot.")\n`,
      callback: `# Callback: ${name}\nfrom telegram import Update\nfrom telegram.ext import ContextTypes\n\nasync def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):\n    \"\"\"Handle callback queries\"\"\"\n    query = update.callback_query\n    await query.answer()\n    await query.edit_message_text(f"Selected: {query.data}")\n`,
      action: `# Action: ${name}\nfrom telegram import Update\nfrom telegram.ext import ContextTypes\n\nasync def action(update: Update, context: ContextTypes.DEFAULT_TYPE):\n    \"\"\"Perform action\"\"\"\n    await update.message.reply_text("Action executed!")\n`,
      cron: `# Cron Job: ${name}\nimport asyncio\nfrom datetime import datetime\n\nasync def cron_job():\n    \"\"\"Scheduled task\"\"\"\n    print(f"Cron job executed at: {datetime.now().isoformat()}")\n`,
    },
    json: {
      handler: `{\n  "name": "${name}",\n  "type": "handler"\n}\n`,
      middleware: `{\n  "name": "${name}",\n  "type": "middleware"\n}\n`,
      command: `{\n  "name": "${name}",\n  "type": "command"\n}\n`,
      callback: `{\n  "name": "${name}",\n  "type": "callback"\n}\n`,
      action: `{\n  "name": "${name}",\n  "type": "action"\n}\n`,
      cron: `{\n  "name": "${name}",\n  "type": "cron"\n}\n`,
    },
  }
  return (templates[language] || templates.typescript)[type] || `// ${name}\n`
}

// ─── CodeDisplay ────────────────────────────────────────────────────────────

function CodeDisplay({
  code,
  language,
  botId,
  blockId,
  isBotRunning,
  onSave,
}: {
  code: string
  language?: string
  botId?: string
  blockId?: string
  isBotRunning?: boolean
  onSave?: (_newCode: string) => void // Custom save handler (used for project files)
}) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editCode, setEditCode] = useState(code)
  const t = useT()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const updateCodeBlock = useBotStore((s) => s.updateCodeBlock)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [stylesLoaded, setStylesLoaded] = useState(false)

  useEffect(() => {
    loadStyles().then(() => setStylesLoaded(true))
  }, [])

  // When not editing, displayCode always reflects the current code prop
  const displayCode = editing ? editCode : code

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  // BUG FIX: Removed global document-level keydown listener for Ctrl+S/Escape.
  // The global listener caused two bugs:
  // 1. When multiple CodeDisplay instances are editing simultaneously, Ctrl+S
  //    triggered ALL of their save handlers at once.
  // 2. When the textarea is focused, both the textarea onKeyDown AND the global
  //    listener fire, causing a double-save.
  // The textarea's handleTextareaKeyDown is sufficient for all editing shortcuts.
  // Kept the Escape handler here only for when editing but textarea is NOT focused
  // (edge case: user clicks outside textarea but is still in "editing" mode).
  useEffect(() => {
    if (!editing) return
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle Escape globally — Ctrl+S is handled by textarea onKeyDown
      if (e.key === 'Escape') {
        // Don't intercept if user is typing in another input (e.g., search bar)
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
        e.preventDefault()
        setEditCode(code)
        setEditing(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [editing, code])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayCode)
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('common.copyFailed'))
    }
  }

  const [editConfirmOpen, setEditConfirmOpen] = useState(false)

  const handleEdit = () => {
    if (isBotRunning) {
      setEditConfirmOpen(true)
      return
    }
    setEditCode(code)
    setEditing(true)
  }

  const handleEditConfirm = () => {
    setEditConfirmOpen(false)
    setEditCode(code)
    setEditing(true)
  }

  const handleCancel = () => {
    setEditCode(code)
    setEditing(false)
  }

  const handleSave = () => {
    if (onSave) {
      // Custom save handler (e.g., for project files)
      onSave(editCode)
      setEditing(false)
      toast.success(t('codeTab.codeSavedRedeploy'), { description: t('codeTab.codeSavedRedeployDesc') })
    } else if (botId && blockId) {
      updateCodeBlock(botId, blockId, editCode)
      setEditing(false)
      toast.success(t('codeTab.codeSavedRedeploy'), { description: t('codeTab.codeSavedRedeployDesc') })
    }
  }

  // Handle Tab key in textarea: insert 2 spaces instead of changing focus
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const target = e.currentTarget
      const start = target.selectionStart
      const end = target.selectionEnd
      const newValue = editCode.substring(0, start) + '  ' + editCode.substring(end)
      setEditCode(newValue)
      // Restore cursor position after state update
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2
      })
    }
    // Ctrl+S / Cmd+S to save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      handleSave()
    }
    // Escape to cancel
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    }
  }

  const prismLanguage = languageMap[language || 'javascript'] || 'javascript'
  const isDirty = editing && editCode !== code

  return (
    <div className="relative rounded-lg overflow-hidden border border-border/30 shadow-sm">
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-border/30 bg-muted/40">
        <div className="flex items-center gap-2">
          {/* macOS-style window dots */}
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-red-400/80" />
            <span className="size-2.5 rounded-full bg-amber-400/80" />
            <span className="size-2.5 rounded-full bg-emerald-400/80" />
          </div>
          <span className="text-[12px] text-muted-foreground font-mono ml-1">{language || 'code'}</span>
          {editing && (
            <Badge variant="outline" className={cn(
              'text-[13px] gap-1',
              isDirty
                ? 'border-amber-500/30 text-amber-500 bg-amber-500/10'
                : 'border-zinc-600 text-zinc-400 bg-zinc-700/50',
            )}>
              <Pencil className="size-3" />
              {t('codeTab.editing')}
              {isDirty && <span className="size-1.5 rounded-full bg-amber-500" />}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                className="h-6 gap-1 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <X className="size-3" />
                {t('codeTab.cancelEdit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSave}
                disabled={!isDirty}
                className={cn(
                  'h-6 gap-1 text-[12px]',
                  isDirty
                    ? 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10'
                    : 'text-muted-foreground/40 cursor-not-allowed',
                )}
              >
                <Save className="size-3" />
                {t('codeTab.saveCode')}
              </Button>
            </>
          ) : (
            <>
              {botId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleEdit}
                  className="h-6 gap-1 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Pencil className="size-3" />
                  {t('codeTab.editCode')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopy}
                className="h-6 gap-1 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {copied ? (
                  <>
                    <Check className="size-3 text-emerald-500" />
                    {t('common.copied')}
                  </>
                ) : (
                  <>
                    <Copy className="size-3" />
                    {t('common.copy')}
                  </>
                )}
              </Button>
            </>
          )}
        </div>
      </div>
      {/* Running bot edit warning — shown when editing and bot is running */}
      {editing && isBotRunning && (
        <div className="flex items-center gap-2 px-3.5 py-2 bg-amber-50/70 dark:bg-amber-500/8 border-b border-amber-200/40 dark:border-amber-500/15 text-amber-600 dark:text-amber-400 text-[12px]">
          <AlertTriangle className="size-3 shrink-0" />
          <span>{t('codeTab.runningEditWarning')}</span>
        </div>
      )}
      {/* Confirm dialog before editing while bot is running */}
      <ConfirmDialog
        open={editConfirmOpen}
        onOpenChange={setEditConfirmOpen}
        title={t('codeTab.runningEditConfirmTitle')}
        description={t('codeTab.runningEditConfirmDesc')}
        confirmText={t('codeTab.runningEditConfirmAction')}
        onConfirm={handleEditConfirm}
      />
      {editing ? (
        <textarea
          ref={textareaRef}
          value={displayCode}
          onChange={(e) => setEditCode(e.target.value)}
          onKeyDown={handleTextareaKeyDown}
          className="w-full min-h-[300px] p-4 text-[15px] leading-relaxed font-mono text-zinc-300 dark:text-zinc-200 bg-zinc-950 dark:bg-zinc-900 resize-y focus:outline-none border-0"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
        />
      ) : stylesLoaded && _oneDark && _oneLight ? (
        <div className={`overflow-auto ${isDark ? 'bg-zinc-950/50 dark:bg-black/20' : 'bg-zinc-50/50'}`}>
          {/* @ts-expect-error - react-syntax-highlighter has incomplete TS types */}
          <SyntaxHighlighter
            language={prismLanguage}
            style={isDark ? _oneDark : _oneLight}
            showLineNumbers
            lineNumberStyle={{
              minWidth: '2.5em',
              paddingRight: '1em',
              color: isDark ? '#4b5563' : '#9ca3af',
              userSelect: 'none',
            }}
            customStyle={{
              margin: 0,
              padding: '0.75rem',
              background: 'transparent',
              fontSize: '0.8125rem',
              lineHeight: '1.625',
            }}
            wrapLines
          >
            {displayCode}
          </SyntaxHighlighter>
        </div>
      ) : (
        <div className="flex items-center justify-center min-h-[300px] bg-muted/20 text-muted-foreground">
          {t('codeTab.loadingHighlighter', 'Loading syntax highlighter...')}
        </div>
      )}
    </div>
  )
}

// ─── ExecutionFlow ──────────────────────────────────────────────────────────

function ExecutionFlow({
  blocks,
  onNodeClick,
}: {
  blocks: CodeBlock[]
  onNodeClick: (type: string) => void
}) {
  const t = useT()

  // BUG FIX: Use b.isActive !== false (not b.isActive truthy check) for consistency
  // with runtime-control.tsx which uses the same filter when deploying code.
  // This ensures blocks with isActive=undefined are treated as active in both places.
  const activeBlocks = useMemo(() => blocks.filter((b) => b.isActive !== false), [blocks])

  const counts = useMemo(() => ({
    middleware: activeBlocks.filter((b) => b.type === 'middleware').length,
    handler: activeBlocks.filter((b) => b.type === 'handler').length,
    command: activeBlocks.filter((b) => b.type === 'command').length,
    callback: activeBlocks.filter((b) => b.type === 'callback').length,
    action: activeBlocks.filter((b) => b.type === 'action').length,
    cron: activeBlocks.filter((b) => b.type === 'cron').length,
  }), [activeBlocks])

  if (activeBlocks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-muted-foreground/25 p-4 text-center">
        <p className="text-[13px] text-muted-foreground">{t('codeTab.noActiveBlocks')}</p>
      </div>
    )
  }

  const flowNodes: { type: string; label: string; count: number }[] = [
    { type: 'middleware', label: t('codeTab.flowMiddleware'), count: counts.middleware },
    { type: 'handler', label: t('codeTab.flowHandlers'), count: counts.handler },
    { type: 'command', label: t('codeTab.flowCommand'), count: counts.command },
    { type: 'callback', label: t('codeTab.flowCallback'), count: counts.callback },
    { type: 'action', label: t('codeTab.flowActions'), count: counts.action },
  ].filter((n) => n.count > 0)

  return (
    <div className="space-y-3 p-3 rounded-lg border border-border/40">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[13px] font-medium text-muted-foreground shrink-0">{t('codeTab.flowTitle')}:</span>
        {flowNodes.map((node, idx) => (
          <div key={node.type} className="flex items-center gap-2">
            {idx > 0 && <ArrowRight className="size-4 text-muted-foreground/40 shrink-0" />}
            <button
              type="button"
              onClick={() => onNodeClick(node.type)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[13px] font-medium transition-opacity hover:opacity-80',
                typeFlowColors[node.type] || 'bg-muted border-muted text-muted-foreground',
              )}
            >
              <span>{node.label}</span>
              <Badge variant="secondary" className={cn('text-[11px] h-4 px-1.5', typeFlowBadgeColors[node.type] || '')}>
                {node.count}
              </Badge>
            </button>
          </div>
        ))}
        {/* Cron (parallel / side) */}
        {counts.cron > 0 && (
          <>
            <span className="text-muted-foreground/40 mx-1">|</span>
            <button
              type="button"
              onClick={() => onNodeClick('cron')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[13px] font-medium transition-opacity hover:opacity-80',
                typeFlowColors.cron,
              )}
            >
              <Clock className="size-3" />
              <span>{t('codeTab.flowCron')}</span>
              <Badge variant="secondary" className={cn('text-[11px] h-4 px-1.5', typeFlowBadgeColors.cron)}>
                {counts.cron}
              </Badge>
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── ProjectFilesSection ────────────────────────────────────────────────────

function ProjectFilesSection({ files, entryPoint, botId, isBotRunning }: { files: { path: string; content: string; size: number }[]; entryPoint?: string; botId?: string; isBotRunning?: boolean }) {
  const t = useT()
  const updateProjectFile = useBotStore((s) => s.updateProjectFile)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState(false)

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Group files by directory for tree view
  const fileTree = useMemo(() => {
    const dirs = new Map<string, typeof files>()
    const rootFiles: typeof files = []

    for (const file of files) {
      const lastSlash = file.path.lastIndexOf('/')
      if (lastSlash > 0) {
        const dir = file.path.substring(0, lastSlash)
        if (!dirs.has(dir)) dirs.set(dir, [])
        dirs.get(dir)!.push(file)
      } else {
        rootFiles.push(file)
      }
    }

    return { dirs, rootFiles }
  }, [files])

  // Infer language from file extension
  const getLanguage = (path: string): string => {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript'
    if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript'
    if (path.endsWith('.py')) return 'python'
    if (path.endsWith('.json')) return 'json'
    return 'javascript'
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left py-1"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? <ChevronRight className="size-3.5 text-muted-foreground" /> : <ChevronDown className="size-3.5 text-muted-foreground" />}
        <span className="text-[13px] font-medium text-foreground">{t('codeTab.projectFiles')}</span>
        <Badge variant="outline" className="text-[11px] h-4">
          {t('codeTab.fileCount', { n: files.length })}
        </Badge>
      </button>
      {!collapsed && (
        <div className="rounded-lg border overflow-hidden divide-y border-border/30">
          {/* Root-level files */}
          {fileTree.rootFiles.map((file) => {
            const isExpanded = expandedFiles.has(file.path)
            const isEntry = file.path === entryPoint
            return (
              <div key={file.path}>
                <button
                  onClick={() => toggleFile(file.path)}
                  className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                >
                  {isExpanded ? <ChevronDown className="size-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />}
                  <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-[13px] font-mono text-foreground truncate flex-1">{file.path}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0">{(file.size / 1024).toFixed(1)}KB</span>
                  {isEntry && (
                    <Badge variant="outline" className="text-[11px] h-4 px-1.5 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20 shrink-0">
                      {t('codeTab.entryPoint')}
                    </Badge>
                  )}
                </button>
                {isExpanded && (
                  <div className="border-t">
                    <CodeDisplay code={file.content} language={getLanguage(file.path)} botId={botId} blockId={`project:${file.path}`} isBotRunning={isBotRunning} onSave={botId ? (newCode) => updateProjectFile(botId, file.path, newCode) : undefined} />
                  </div>
                )}
              </div>
            )
          })}
          {/* Directory groups */}
          {Array.from(fileTree.dirs.entries()).map(([dir, dirFiles]) => (
            <div key={dir}>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30">
                <FolderOpen className="size-3.5 text-muted-foreground shrink-0" />
                <span className="text-[12px] font-mono text-muted-foreground">{dir}/</span>
              </div>
              {dirFiles.map((file) => {
                const isExpanded = expandedFiles.has(file.path)
                const isEntry = file.path === entryPoint
                return (
                  <div key={file.path} className="border-t">
                    <button
                      onClick={() => toggleFile(file.path)}
                      className="flex items-center gap-2 w-full px-3 py-2 pl-8 text-left hover:bg-muted/50 transition-colors"
                    >
                      {isExpanded ? <ChevronDown className="size-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />}
                      <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="text-[13px] font-mono text-foreground truncate flex-1">{file.path.substring(dir.length + 1)}</span>
                      <span className="text-[11px] text-muted-foreground shrink-0">{(file.size / 1024).toFixed(1)}KB</span>
                      {isEntry && (
                        <Badge variant="outline" className="text-[11px] h-4 px-1.5 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20 shrink-0">
                          {t('codeTab.entryPoint')}
                        </Badge>
                      )}
                    </button>
                    {isExpanded && (
                      <div className="border-t">
                        <CodeDisplay code={file.content} language={getLanguage(file.path)} botId={botId} blockId={`project:${file.path}`} isBotRunning={isBotRunning} onSave={botId ? (newCode) => updateProjectFile(botId, file.path, newCode) : undefined} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── CodeBlockItem ──────────────────────────────────────────────────────────

function CodeBlockItem({ botId, block, isBotRunning }: { botId: string; block: CodeBlock; isBotRunning: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const toggleCodeBlock = useBotStore((s) => s.toggleCodeBlock)
  const removeCodeBlock = useBotStore((s) => s.removeCodeBlock)
  const t = useT()
  const locale = useLocale()

  const handleDelete = () => {
    removeCodeBlock(botId, block.id)
    toast.success(t('codeTab.blockDeleted', { name: block.name }))
    setDeleteConfirmOpen(false)
  }

  return (
    <>
      <Card className={cn('gap-0 py-0 shadow-sm border-border/40 overflow-hidden')}>
        <CardContent className="p-3.5">
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-2.5 flex-1 min-w-0 text-left cursor-pointer"
              aria-label={expanded ? 'Collapse code' : 'Expand code'}
              aria-expanded={expanded}
            >
              <div className="text-muted-foreground">
                {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[14px] font-medium text-foreground truncate">
                    {block.name}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn('text-[11px] font-medium capitalize', typeBadgeColors[block.type] || '')}
                  >
                    {block.type}
                  </Badge>
                </div>
                <div className="flex items-center gap-2.5 mt-0.5">
                  <span className="text-[12px] text-muted-foreground">{block.language}</span>
                  <span className="text-[12px] text-muted-foreground">
                    {t('common.modified')} {formatDate(block.lastModified, locale)}
                  </span>
                </div>
              </div>
            </button>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[12px] text-muted-foreground hidden sm:inline">
                {block.isActive !== false ? t('codeTab.active') : t('codeTab.disabled')}
              </span>
              <Switch
                checked={block.isActive !== false}
                onCheckedChange={() => toggleCodeBlock(botId, block.id)}
                aria-label={t('codeTab.toggleAria', { name: block.name })}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-6.5 text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteConfirmOpen(true)}
                aria-label={t('codeTab.deleteBlock')}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>

          {expanded && (
            <div className="mt-3">
              {block.description && (
                <p className="text-[12px] text-muted-foreground mb-2.5">{block.description}</p>
              )}
              <CodeDisplay
                code={block.code}
                language={block.language}
                botId={botId}
                blockId={block.id}
                isBotRunning={isBotRunning}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation using ConfirmDialog */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('codeTab.deleteBlock')}
        description={t('codeTab.deleteConfirm', { name: block.name })}
        confirmText={t('common.delete')}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </>
  )
}

// ─── AddBlockDialog ─────────────────────────────────────────────────────────

function AddBlockDialog({ botId, botLanguage, open, onOpenChange }: {
  botId: string
  botLanguage: BotLanguage
  open: boolean
  onOpenChange: (_open: boolean) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<CodeBlock['type']>('handler')
  const [language, setLanguage] = useState<BotLanguage | 'json'>(botLanguage)
  const [description, setDescription] = useState('')
  const addCodeBlock = useBotStore((s) => s.addCodeBlock)
  const t = useT()

  // Reset form when dialog opens
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setName('')
      setType('handler')
      setLanguage(botLanguage)
      setDescription('')
    }
    onOpenChange(nextOpen)
  }, [botLanguage, onOpenChange])

  const handleAdd = () => {
    if (!name.trim()) {
      toast.error(t('codeTab.nameRequired'))
      return
    }
    const templateCode = getTemplateCode(type, language, name.trim())
    addCodeBlock(botId, {
      name: name.trim(),
      type,
      language,
      code: templateCode,
      description: description.trim() || undefined,
    })
    toast.success(t('codeTab.blockAdded', { name: name.trim() }))
    onOpenChange(false)
  }

  const blockTypeOptions: { value: CodeBlock['type']; color: string; label: string }[] = [
    { value: 'handler', color: 'bg-emerald-500', label: t('codeTab.blockTypeHandler') },
    { value: 'middleware', color: 'bg-sky-500', label: t('codeTab.blockTypeMiddleware') },
    { value: 'command', color: 'bg-amber-500', label: t('codeTab.blockTypeCommand') },
    { value: 'callback', color: 'bg-purple-500', label: t('codeTab.blockTypeCallback') },
    { value: 'action', color: 'bg-rose-500', label: t('codeTab.blockTypeAction') },
    { value: 'cron', color: 'bg-cyan-500', label: t('codeTab.blockTypeCron') },
  ]

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t('codeTab.addBlockTitle')}</DialogTitle>
          <DialogDescription>{t('codeTab.addBlockDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="block-name">{t('codeTab.blockName')}</Label>
            <Input
              id="block-name"
              placeholder={t('codeTab.blockNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd() } }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>{t('codeTab.blockType')}</Label>
              <Select value={type} onValueChange={(v) => setType(v as CodeBlock['type'])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {blockTypeOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className="flex items-center gap-1.5">
                        <span className={cn('size-2 rounded-full', opt.color)} />
                        {opt.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('codeTab.blockLanguage')}</Label>
              <Select value={language} onValueChange={(v) => setLanguage(v as BotLanguage | 'json')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="typescript">TypeScript</SelectItem>
                  <SelectItem value="javascript">JavaScript</SelectItem>
                  <SelectItem value="python">Python</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="block-desc">{t('codeTab.blockDescription')}</Label>
            <Input
              id="block-desc"
              placeholder={t('codeTab.blockDescPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter className="gap-3 sm:gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleAdd} className="gap-1.5 bg-gradient-to-r from-cyan-600 to-blue-600">
            <Plus className="size-3.5" />
            {t('common.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── CodeTab (Main) ─────────────────────────────────────────────────────────

export function CodeTab() {
  const selectedBotId = useBotStore((s) => s.selectedBotId)
  const bot = useBotStore((s) => s.bots.find((b) => b.id === selectedBotId))
  const t = useT()
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  // Is the bot currently running?
  const isBotRunning = bot?.status === 'active' && bot?.lastRunnerStatus !== 'stopped'

  // Filter code blocks
  const codeBlocks = bot?.codeBlocks ?? []
  const filteredBlocks = useMemo(() => {
    let blocks = codeBlocks
    if (typeFilter !== 'all') {
      blocks = blocks.filter((b) => b.type === typeFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      blocks = blocks.filter((b) =>
        b.name.toLowerCase().includes(q) ||
        (b.description && b.description.toLowerCase().includes(q))
      )
    }
    return blocks
  }, [codeBlocks, typeFilter, searchQuery])

  // When a flow diagram node is clicked, set the type filter
  const handleFlowNodeClick = useCallback((type: string) => {
    setTypeFilter((prev) => prev === type ? 'all' : type)
  }, [])

  if (!bot) return null

  const hasBlocks = bot.codeBlocks && bot.codeBlocks.length > 0
  const totalBlocks = bot.codeBlocks?.length || 0

  return (
    <div className="space-y-3">
      <div className="pb-2">
        <h3 className="text-base font-semibold tracking-tight text-foreground">{t('codeTab.title')}</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('codeTab.desc')}
        </p>
      </div>

      {/* Running Edit Warning Banner — always visible when bot is running */}
      {isBotRunning && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-amber-50/70 dark:bg-amber-500/8 border border-amber-200/40 dark:border-amber-500/15 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span className="text-[13px]">{t('codeTab.runningEditWarning')}</span>
        </div>
      )}

      {/* Execution Flow Diagram */}
      {hasBlocks && (
        <ExecutionFlow blocks={bot.codeBlocks} onNodeClick={handleFlowNodeClick} />
      )}
      {bot.projectFiles && bot.projectFiles.length > 0 && (
        <ProjectFilesSection
          files={bot.projectFiles}
          entryPoint={bot.entryPoint}
          botId={bot.id}
          isBotRunning={isBotRunning}
        />
      )}

      {/* Code Blocks */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-medium text-foreground">
            {t('codeTab.codeBlocks')}
          </span>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[11px] h-5">
              {t('codeTab.blocks', { n: totalBlocks })}
            </Badge>
            <Button
              size="sm"
              className="gap-1 h-7 text-[12px] bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm"
              onClick={() => setAddDialogOpen(true)}
            >
              <Plus className="size-3" />
              {t('codeTab.addBlock')}
            </Button>
          </div>
        </div>

        {/* Search & Filter */}
        {hasBlocks && (
          <div className="flex items-center gap-2 rounded-xl bg-background px-2.5 py-1.5 border border-border/40">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
              <Input
                placeholder={t('codeTab.searchBlocks')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 pl-7.5 text-[12px] bg-muted/40 border border-border/30 focus-visible:border-primary/50 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="!h-7 w-[120px] text-[12px] bg-muted/40 border border-border/30 focus:ring-0 focus:ring-offset-0 focus-visible:border-primary/50 !px-2.5 !py-[2px] [&>span]:text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('codeTab.filterAll')}</SelectItem>
                <SelectItem value="handler">{t('codeTab.blockTypeHandler')}</SelectItem>
                <SelectItem value="middleware">{t('codeTab.blockTypeMiddleware')}</SelectItem>
                <SelectItem value="command">{t('codeTab.blockTypeCommand')}</SelectItem>
                <SelectItem value="callback">{t('codeTab.blockTypeCallback')}</SelectItem>
                <SelectItem value="action">{t('codeTab.blockTypeAction')}</SelectItem>
                <SelectItem value="cron">{t('codeTab.blockTypeCron')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Active filter indicator with clear button + filtered count */}
        {(typeFilter !== 'all' || searchQuery.trim()) && (
          <div className="flex items-center gap-2">
            {typeFilter !== 'all' && (
              <Badge
                variant="outline"
                className={cn('text-[13px] gap-1.5 cursor-pointer', typeBadgeColors[typeFilter] || '')}
                onClick={() => setTypeFilter('all')}
              >
                {typeFilterLabelMap[typeFilter] || typeFilter}
                <X className="size-3" />
              </Badge>
            )}
            <span className="text-[13px] text-muted-foreground">
              {t('codeTab.showingBlocks', { shown: filteredBlocks.length, total: totalBlocks })}
            </span>
          </div>
        )}

        {/* Code block list */}
        {filteredBlocks.length > 0 && (
          <div className="space-y-3">
            {filteredBlocks.map((block) => (
              <CodeBlockItem key={block.id} botId={bot.id} block={block} isBotRunning={isBotRunning} />
            ))}
          </div>
        )}

        {/* No blocks (empty or filtered out) */}
        {!hasBlocks && (
          <div className="text-center py-8 space-y-3">
            <p className="text-[15px] text-muted-foreground">{t('codeTab.noCodeBlocks')}</p>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setAddDialogOpen(true)}
            >
              <Plus className="size-3.5" />
              {t('codeTab.addFirst')}
            </Button>
          </div>
        )}

        {hasBlocks && filteredBlocks.length === 0 && (searchQuery.trim() || typeFilter !== 'all') && (
          <div className="text-center py-6">
            <p className="text-[15px] text-muted-foreground">{t('codeTab.noCodeBlocks')}</p>
          </div>
        )}
      </div>

      {/* Dependencies */}
      <div className="border-t pt-6 mt-6">
        <DependenciesTab />
      </div>

      {/* Add Block Dialog */}
      <AddBlockDialog
        botId={bot.id}
        botLanguage={bot.language}
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
      />
    </div>
  )
}
