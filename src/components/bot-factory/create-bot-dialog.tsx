'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Upload,
  FileCode2,
  FileText,
  Check,
  AlertCircle,
  Eye,
  Trash2,
  Package,
  Plus,
  XIcon,
  ChevronRight,
  Folder,
  FolderOpen,
  File,
  Settings,
  Archive,
  Play,
  GitBranch,
  Loader2,
  Globe,
} from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn, generateUUID } from '@/lib/utils'
import type { BotLanguage, ProjectFile } from '@/types/bot'
import { useBotStore } from '@/store/bot-store'
import { useT } from '@/lib/i18n'
import { BotIconPicker } from '@/components/bot-factory/bot-icon-picker'
import {
  type ImportFile,
  shouldSkipFile,
  MAX_ZIP_SIZE,
  MAX_FILE_COUNT,
  MAX_SINGLE_FILE_SIZE,
  MAX_TOTAL_EXTRACTED_SIZE,
  isBinaryExtension,
  normalizeZipPath,
  parseEnvFile,
  detectDependencies,
  detectBotName,
  detectLanguage,
  formatFileSize,
  detectLanguageFromFiles,
  parsePackageJson,
  parseRequirementsTxt,
  detectEntryPoint,
  detectBotNameFromPackage,
  detectDescriptionFromPackage,
} from '@/lib/import-utils'

// ─── Local getFileIcon (returns actual Lucide React components) ─────────────

function getFileIcon(fileName: string): { icon: typeof File; className: string } {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  if (['json', 'lock'].includes(ext)) return { icon: Settings, className: 'text-amber-500' }
  if (['js', 'mjs', 'cjs'].includes(ext)) return { icon: FileCode2, className: 'text-yellow-500' }
  if (['ts', 'tsx', 'mts'].includes(ext)) return { icon: FileCode2, className: 'text-blue-500' }
  if (ext === 'py') return { icon: FileCode2, className: 'text-emerald-500' }
  if (['env', 'env.local', 'env.production'].includes(fileName) || fileName.includes('env')) return { icon: Settings, className: 'text-orange-500' }
  if (['md', 'txt', 'readme'].includes(ext)) return { icon: FileText, className: 'text-zinc-400' }
  if (['yaml', 'yml', 'toml'].includes(ext)) return { icon: Settings, className: 'text-emerald-500' }
  return { icon: File, className: 'text-zinc-400' }
}

// ─── Language cards ────────────────────────────────────────────────────────

const languageCards = [
  { id: 'javascript' as BotLanguage, label: 'JavaScript', color: 'amber' },
  { id: 'typescript' as BotLanguage, label: 'TypeScript', color: 'blue' },
  { id: 'python' as BotLanguage, label: 'Python', color: 'emerald' },
]

// ─── ProjectFileTree Component ──────────────────────────────────────────────

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  children: TreeNode[]
  file?: ProjectFile
}

function buildTree(files: ProjectFile[]): TreeNode[] {
  const root: TreeNode[] = []

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isFile = i === parts.length - 1
      const fullPath = parts.slice(0, i + 1).join('/')

      let existing = current.find((n) => n.name === part)
      if (!existing) {
        existing = {
          name: part,
          path: fullPath,
          isDir: !isFile,
          children: [],
          file: isFile ? file : undefined,
        }
        current.push(existing)
      }
      if (!isFile) {
        current = existing.children
      }
    }
  }

  // Sort: directories first, then files alphabetically
  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    }).map((n) => ({ ...n, children: sortNodes(n.children) }))
  }

  return sortNodes(root)
}

function ProjectFileTree({
  files,
  entryPoint,
  onEntryPointChange,
  previewFile,
  onPreviewFile,
  collapsedDirs,
  onToggleDir,
  t,
}: {
  files: ProjectFile[]
  entryPoint: string
  onEntryPointChange: (_path: string) => void
  previewFile: string | null
  onPreviewFile: (_path: string | null) => void
  collapsedDirs: Set<string>
  onToggleDir: (_path: string) => void
  t: (_key: string, _params?: Record<string, string | number>) => string
}) {
  const tree = useMemo(() => buildTree(files), [files])
  const entryCandidates = useMemo(
    () => files
      .filter((f) => {
        const ext = f.path.split('.').pop()?.toLowerCase()
        return ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.py'].includes(`.${ext}`)
      })
      .map((f) => f.path)
      .sort(),
    [files],
  )

  function renderNode(node: TreeNode, depth: number) {
    if (node.isDir) {
      const isCollapsed = collapsedDirs.has(node.path)
      const DirIcon = isCollapsed ? Folder : FolderOpen
      return (
        <div key={node.path}>
          <button
            type="button"
            className="flex items-center gap-1.5 w-full px-2 py-1 text-left text-xs hover:bg-accent/50 rounded transition-colors group"
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => onToggleDir(node.path)}
          >
            <ChevronRight className={cn(
              'size-3 text-muted-foreground shrink-0 transition-transform duration-150',
              !isCollapsed && 'rotate-90',
            )} />
            <DirIcon className="size-3.5 text-amber-400 shrink-0" />
            <span className="truncate font-medium text-muted-foreground">{node.name}</span>
          </button>
          {!isCollapsed && (
            <div>
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      )
    }

    // File node
    const isEntry = node.path === entryPoint
    const isPreview = node.path === previewFile
    const { icon: FileIcon, className: iconClass } = getFileIcon(node.name)

    return (
      <div
        key={node.path}
        className={cn(
          'flex items-center gap-1.5 w-full px-2 py-1 text-left text-xs rounded transition-colors group',
          isPreview ? 'bg-accent' : 'hover:bg-accent/50',
          isEntry && 'bg-teal-500/10 hover:bg-teal-500/15',
        )}
        style={{ paddingLeft: `${depth * 16 + 24}px` }}
      >
        <button
          type="button"
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          onClick={() => onPreviewFile(isPreview ? null : node.path)}
        >
          <FileIcon className={cn('size-3.5 shrink-0', iconClass)} />
          <span className={cn('truncate', isEntry && 'text-teal-600 dark:text-teal-400 font-medium')}>
            {node.name}
          </span>
          {isEntry && (
            <Badge className="shrink-0 text-[9px] px-1 py-0 h-4 bg-teal-100 text-teal-600 dark:bg-teal-500/20 dark:text-teal-400 border-0 gap-0.5">
              <Play className="size-2" />
              {t('importBot.entryPoint')}
            </Badge>
          )}
        </button>
        <span className="shrink-0 text-[10px] text-muted-foreground/50 font-mono mr-1">
          {node.file ? formatFileSize(node.file.size) : ''}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Entry point selector */}
      {entryCandidates.length > 1 && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Play className="size-3" />
            {t('importBot.entryPoint')}
            <span className="text-muted-foreground/60">— {t('importBot.entryPointDesc')}</span>
          </Label>
          <Select value={entryPoint} onValueChange={onEntryPointChange}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={t('importBot.selectEntryPoint')} />
            </SelectTrigger>
            <SelectContent>
              {entryCandidates.map((path) => (
                <SelectItem key={path} value={path} className="text-xs">
                  {path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* File tree */}
      <div className="rounded-lg border bg-background overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
          <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
            <FolderOpen className="size-3" />
            {t('importBot.fileTree')}
          </span>
          <span className="text-[10px] text-muted-foreground/60">
            {t('importBot.fileCount', { n: String(files.length) })}
          </span>
        </div>
        <ScrollArea className="max-h-48 w-full">
          <div className="py-1">
            {tree.map((node) => renderNode(node, 0))}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function CreateBotDialog() {
  const createBotDialogOpen = useBotStore(s => s.createBotDialogOpen)
  const createBotDialogMode = useBotStore(s => s.createBotDialogMode)
  const setCreateBotDialogOpen = useBotStore(s => s.setCreateBotDialogOpen)
  const addBot = useBotStore(s => s.addBot)
  const [activeTab, setActiveTab] = useState<'create' | 'import' | 'git'>('create')
  const [isCreating, setIsCreating] = useState(false)
  const t = useT()

  // ── Sync external mode changes ──────────────────────────────────────────
  useEffect(() => {
    setActiveTab(createBotDialogMode)
  }, [createBotDialogMode])

  // ── Cleanup git branch debounce timer and nav poll on unmount ────────────
  useEffect(() => {
    return () => {
      if (gitUrlTimerRef.current) {
        clearTimeout(gitUrlTimerRef.current)
        gitUrlTimerRef.current = null
      }
      if (navPollRef.current) {
        clearInterval(navPollRef.current)
        navPollRef.current = null
      }
    }
  }, [])

  // ── Create mode state ───────────────────────────────────────────────────
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [language, setLanguage] = useState<BotLanguage>('typescript')
  const [emoji, setEmoji] = useState('🤖')
  const [customIcon, setCustomIcon] = useState<string | undefined>()
  const [errors, setErrors] = useState<{ name?: string }>({})
  const [isDescFocused, setIsDescFocused] = useState(false)


  // ── Git clone mode state ─────────────────────────────────────────────
  const [gitUrl, setGitUrl] = useState('')
  const [gitBranch, setGitBranch] = useState<string>('')
  const [gitBranches, setGitBranches] = useState<string[]>([])
  const [gitBranchLoading, setGitBranchLoading] = useState(false)
  const [gitCloning, setGitCloning] = useState(false)
  const [gitCloned, setGitCloned] = useState(false)

  // ── Git clone handlers ───────────────────────────────────────────────────

  // ── Import mode state ───────────────────────────────────────────────────
  const [importName, setImportName] = useState('')
  const [importDesc, setImportDesc] = useState('')
  const [importEmoji, setImportEmoji] = useState('📦')
  const [importCustomIcon, setImportCustomIcon] = useState<string | undefined>()
  const [files, setFiles] = useState<ImportFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ZIP / project files state
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([])
  const [entryPoint, setEntryPoint] = useState<string>('')
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  const [isExtracting, setIsExtracting] = useState(false)
  const [zipDetectedLang, setZipDetectedLang] = useState<'javascript' | 'typescript' | 'python' | null>(null)

  // BUG FIX: Track navigation polling interval so it can be cleared on dialog close.
  // Without this, if the dialog closes before the poll finds the bot, the interval
  // keeps running and unexpectedly navigates the user away from the list view.
  const navPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Git clone handlers (now safe — all referenced state is declared above) ──
  const isValidGitUrl = useCallback((url: string): boolean => {
    if (!url.trim()) return false
    const trimmed = url.trim()
    // HTTPS URLs on known hosts (with or without .git suffix)
    const httpsShortPattern = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?(\.git)?$/
    // Any HTTPS URL ending with .git
    const httpsGenericPattern = /^https:\/\/[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)+\/[^\s]+\.git\/?$/
    // SSH URLs: git@host:user/repo.git
    const sshPattern = /^git@[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)+:[^\s]+\.git$/
    return httpsShortPattern.test(trimmed) || httpsGenericPattern.test(trimmed) || sshPattern.test(trimmed)
  }, [])

  const fetchBranches = useCallback(async (url: string) => {
    if (!isValidGitUrl(url)) {
      setGitBranches([])
      return
    }
    setGitBranchLoading(true)
    try {
      const res = await fetch(`/api/git-import?url=${encodeURIComponent(url.trim())}`, {
        credentials: 'include',
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          setGitBranches(data.branches || [])
        } else {
          setGitBranches([])
        }
      } else {
        setGitBranches([])
      }
    } catch {
      setGitBranches([])
    } finally {
      setGitBranchLoading(false)
    }
  }, [isValidGitUrl])

  const gitUrlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleGitUrlChange = useCallback((value: string) => {
    setGitUrl(value)
    setGitCloned(false)
    setProjectFiles([])
    setEntryPoint('')
    setZipDetectedLang(null)
    setCollapsedDirs(new Set())
    setPreviewFile(null)
    if (gitUrlTimerRef.current) clearTimeout(gitUrlTimerRef.current)
    if (value.trim()) {
      gitUrlTimerRef.current = setTimeout(() => {
        fetchBranches(value)
      }, 600)
    } else {
      setGitBranches([])
    }
  }, [fetchBranches])

  const handleGitClone = useCallback(async () => {
    if (!isValidGitUrl(gitUrl)) {
      toast.error(t('gitImport.invalidUrl'))
      return
    }
    setGitCloning(true)
    try {
      const res = await fetch('/api/git-import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          url: gitUrl.trim(),
          branch: gitBranch || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        const errorMsg = data.error || t('gitImport.cloneError')
        toast.error(errorMsg)
        return
      }

      const clonedFiles: ProjectFile[] = (data.files || []).map((f: { path: string; content: string; size: number }) => ({
        path: f.path,
        content: f.content,
        size: f.size || new TextEncoder().encode(f.content).length,
      }))

      if (clonedFiles.length === 0) {
        toast.error(t('gitImport.emptyRepo'))
        return
      }

      setProjectFiles(clonedFiles)
      setGitBranches(data.branches || gitBranches)
      setGitCloned(true)

      const pkgFile = clonedFiles.find((f: ProjectFile) => f.path === 'package.json')
      setEntryPoint(detectEntryPoint(clonedFiles, pkgFile))

      const lang = detectLanguageFromFiles(clonedFiles)
      setZipDetectedLang(lang)

      if (!importName) {
        const botName = detectBotNameFromPackage(pkgFile)
        if (botName) setImportName(botName)
      }

      if (!importDesc) {
        const desc = detectDescriptionFromPackage(pkgFile)
        if (desc) setImportDesc(desc)
      }

      setFiles([])
      setPreviewFile(null)

      toast.success(t('gitImport.cloneSuccess'))
    } catch {
      toast.error(t('gitImport.cloneError'))
    } finally {
      setGitCloning(false)
    }
  }, [gitUrl, gitBranch, isValidGitUrl, gitBranches, importName, importDesc, t])

  // Derived state for single-file import
  const parsedEnvVars = files.filter((f) => f.type === 'env').flatMap((f) => parseEnvFile(f.content))
  const codeFile = files.find((f) => f.type === 'code')
  const envFile = files.find((f) => f.type === 'env')
  const detectedDeps = codeFile ? detectDependencies(codeFile.content) : []
  const detectedName = codeFile ? detectBotName(codeFile.content, codeFile.name) : ''

  // For ZIP mode: derive deps from package.json/requirements.txt
  const zipDeps = useMemo(() => {
    const pkgFile = projectFiles.find((f) => f.path === 'package.json')
    if (pkgFile) {
      const parsed = parsePackageJson(pkgFile.content)
      if (parsed?.dependencies) {
        return Object.entries(parsed.dependencies).map(([depName, ver]) => ({
          id: generateUUID(),
          name: depName,
          version: ver || 'latest',
          isRequired: true,
          description: `${depName} package`,
        }))
      }
    }
    const reqFile = projectFiles.find((f) => f.path === 'requirements.txt')
    if (reqFile) {
      return parseRequirementsTxt(reqFile.content).map((d) => ({
        id: generateUUID(),
        ...d,
      }))
    }
    return []
  }, [projectFiles])

  // ZIP env vars
  const zipEnvVars = useMemo(() => {
    const envFiles = projectFiles.filter((f) =>
      f.path === '.env' || f.path === '.env.example' || f.path === '.env.local',
    )
    return envFiles.flatMap((f) => parseEnvFile(f.content)).map((v) => ({
      id: generateUUID(),
      key: v.key,
      value: v.value,
      isEncrypted: false,
      description: v.description || '',
    }))
  }, [projectFiles])

  // canImport: either has single files or has project files from ZIP
  const isZipMode = projectFiles.length > 0
  const canImport = importName.trim() !== '' && (files.length > 0 || projectFiles.length > 0)

  // ── Dynamic tab titles (Optimization #3) ────────────────────────────────
  const tabTitles: Record<string, string> = {
    create: t('createBot.titleCreate'),
    import: t('createBot.titleImport'),
    git: t('createBot.titleGit'),
  }

  // ── ZIP handling ────────────────────────────────────────────────────────
  const processZipFile = useCallback(async (file: File) => {
    if (file.size > MAX_ZIP_SIZE) {
      toast.error(t('importBot.zipTooLarge'))
      return
    }

    setIsExtracting(true)
    try {
      const buffer = await file.arrayBuffer()
      const JSZipModule = await import('jszip')
      const zip = await JSZipModule.default.loadAsync(buffer)

      const extractedFiles: ProjectFile[] = []
      let totalExtractedSize = 0
      const skippedReasons: string[] = []

      // Collect entries first to check count before extracting
      const entries: { path: string; zipEntry: import('jszip').JSZipObject }[] = []
      zip.forEach((relativePath, zipEntry) => {
        if (zipEntry.dir) return
        // BUG FIX: Normalize path (handle Windows backslashes, leading slashes, ./ prefix)
        const normalizedPath = normalizeZipPath(relativePath)
        if (!normalizedPath) return
        if (shouldSkipFile(normalizedPath)) return

        // Skip hidden files (except .env)
        const fileName = normalizedPath.split('/').pop() || ''
        if (fileName.startsWith('.') && !fileName.includes('env')) return

        // BUG FIX: Use comprehensive binary extension list instead of hardcoded short list
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        if (isBinaryExtension(ext)) {
          skippedReasons.push(`${fileName} (binary)`)
          return
        }

        entries.push({ path: normalizedPath, zipEntry })
      })

      // BUG FIX: Check file count limit BEFORE extracting (prevent memory exhaustion)
      if (entries.length > MAX_FILE_COUNT) {
        toast.error(t('importBot.zipExtractError', { error: `Too many files (${entries.length}). Maximum ${MAX_FILE_COUNT} files allowed.` }))
        setIsExtracting(false)
        return
      }

      // Extract files with size limits
      for (const { path, zipEntry } of entries) {
        const content = await zipEntry.async('string')
        const contentSize = new TextEncoder().encode(content).length

        // BUG FIX: Check single file size limit (prevent browser memory exhaustion)
        if (contentSize > MAX_SINGLE_FILE_SIZE) {
          skippedReasons.push(`${path} (${formatFileSize(contentSize)}, exceeds ${formatFileSize(MAX_SINGLE_FILE_SIZE)})`)
          continue
        }

        // BUG FIX: Check total extracted size limit
        if (totalExtractedSize + contentSize > MAX_TOTAL_EXTRACTED_SIZE) {
          skippedReasons.push(`${path} (total size limit exceeded)`)
          continue
        }

        totalExtractedSize += contentSize
        extractedFiles.push({
          path,
          content,
          size: contentSize,
        })
      }

      if (extractedFiles.length === 0) {
        const detail = skippedReasons.length > 0
          ? `Skipped: ${skippedReasons.slice(0, 5).join(', ')}${skippedReasons.length > 5 ? ` and ${skippedReasons.length - 5} more` : ''}`
          : 'No extractable files found'
        toast.error(t('importBot.zipExtractError', { error: detail }))
        setIsExtracting(false)
        return
      }

      // Log skipped files for user awareness
      if (skippedReasons.length > 0) {
        console.info(`[ZIP Import] Skipped ${skippedReasons.length} files:`, skippedReasons.slice(0, 10))
      }

      setProjectFiles(extractedFiles)

      // Auto-detect entry point and language
      const pkgFile = extractedFiles.find((f) => f.path === 'package.json')
      setEntryPoint(detectEntryPoint(extractedFiles, pkgFile))

      // Detect language
      const lang = detectLanguageFromFiles(extractedFiles)
      setZipDetectedLang(lang)

      // BUG FIX: Use functional state updates to avoid stale closure values.
      // Previously, importName/importDesc were captured in the useCallback closure,
      // causing the auto-detect check to use stale values when the user had
      // already typed something between ZIP upload and processing completion.
      setImportName(prev => {
        if (prev) return prev // User already typed a name — don't overwrite
        const botName = detectBotNameFromPackage(pkgFile)
        return botName || prev
      })
      setImportDesc(prev => {
        if (prev) return prev // User already typed a description — don't overwrite
        const desc = detectDescriptionFromPackage(pkgFile)
        return desc || prev
      })

      // Clear single-file imports when ZIP is loaded
      setFiles([])
      setPreviewFile(null)

      toast.success(t('importBot.zipExtractSuccess'))
    } catch (err) {
      toast.error(t('importBot.zipExtractError', { error: err instanceof Error ? err.message : String('Unknown error') }))
    } finally {
      setIsExtracting(false)
    }
  }, [t])

  // ── File handling ───────────────────────────────────────────────────────
  const processFiles = useCallback((fileList: FileList | File[]) => {
    const allowedCode = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.py']
    const allowedEnv = ['.env', '.env.local', '.env.production', '.env.development', '.env.staging']
    // FIX: Single file size limit — same as ZIP's MAX_SINGLE_FILE_SIZE (1MB)
    const MAX_SINGLE_IMPORT_SIZE = 1 * 1024 * 1024

    Array.from(fileList).forEach((file) => {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase()

      // Handle ZIP files
      if (ext === '.zip') {
        processZipFile(file)
        return
      }

      const isCode = allowedCode.includes(ext)
      const isEnv = allowedEnv.includes(ext) || (file.name.startsWith('.') && file.name.includes('env'))

      if (isCode || isEnv) {
        // FIX: Check file size before reading to prevent browser OOM
        if (file.size > MAX_SINGLE_IMPORT_SIZE) {
          toast.error(t('importBot.zipExtractError', { error: `File "${file.name}" is too large (${formatFileSize(file.size)}). Maximum ${formatFileSize(MAX_SINGLE_IMPORT_SIZE)}.` }))
          return
        }

        const reader = new FileReader()
        // FIX: Handle FileReader errors — previously silent on read failure
        reader.onerror = () => {
          toast.error(t('importBot.zipExtractError', { error: `Failed to read file "${file.name}"` }))
        }
        reader.onload = () => {
          const content = reader.result as string
          const type = isCode ? 'code' as const : 'env' as const
          setFiles((prev) => {
            const filtered = prev.filter((f) => f.type !== type)
            return [...filtered, { name: file.name, size: file.size, type, content }]
          })
          // FIX: Use functional update to avoid stale closure over importName
          if (isCode) {
            setImportName(prev => prev || detectBotName(content, file.name))
          }
        }
        reader.readAsText(file)
      }
    })
  }, [processZipFile, t])

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragging(true) }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragging(false) }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false)
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files)
  }, [processFiles])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) processFiles(e.target.files)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [processFiles])

  const removeFile = useCallback((fileName: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== fileName))
    if (previewFile === fileName) setPreviewFile(null)
  }, [previewFile])

  const clearZipImport = useCallback(() => {
    setProjectFiles([])
    setEntryPoint('')
    setZipDetectedLang(null)
    setCollapsedDirs(new Set())
  }, [])

  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Preview file content (for both single-file and ZIP modes)
  const previewContent = useMemo(() => {
    // ZIP mode
    if (isZipMode && previewFile) {
      const pf = projectFiles.find((f) => f.path === previewFile)
      return pf?.content || null
    }
    // Single-file mode
    if (previewFile) {
      const f = files.find((file) => file.name === previewFile)
      return f?.content || null
    }
    return null
  }, [isZipMode, previewFile, projectFiles, files])

  // ── Create action ───────────────────────────────────────────────────────
  function handleCreate() {
    if (isCreating) return
    const newErrors: { name?: string } = {}
    if (!name.trim()) newErrors.name = t('createBot.nameRequired')
    setErrors(newErrors)
    if (Object.keys(newErrors).length > 0) return

    setIsCreating(true)
    const botName = name.trim()
    try {
      addBot({
        name: botName,
        description: description.trim(),
        language,
        template: 'custom',
        emoji,
        customIcon,
      })
    } catch {
      toast.error(t('createBot.createFailed'))
      setIsCreating(false)
      return
    }

    toast.success(t('createBot.created', { name: botName }), { description: t('createBot.createdDesc') })
    setIsCreating(false)
    // Capture the createdAt timestamp before resetAll clears the name
    const createdAt = new Date().toISOString()
    resetAll()

    // BUG FIX: Robust navigation after bot creation.
    // addBot() generates a client UUID, then persistNewBot() sends POST and may
    // receive a different server-assigned ID. We must wait for the ID swap before
    // navigating. Previous approach: setTimeout(500) + name+createdAt matching
    // was fragile (slow networks, duplicate names within 5s).
    // New approach: Poll the store every 200ms for up to 5 seconds, looking for
    // a bot matching name+createdAt. Once found, navigate immediately.
    // BUG FIX: Also wait for the bot to be persisted to the server (dbBotIds check)
    // before navigating, to avoid 404 errors on the stats/details API calls.
    // BUG FIX: Store the interval ID in a ref so it can be cleared on dialog close.
    let attempts = 0
    const maxAttempts = 25 // 25 × 200ms = 5 seconds
    // Clear any previous navigation poll
    if (navPollRef.current) clearInterval(navPollRef.current)
    navPollRef.current = setInterval(() => {
      attempts++
      const store = useBotStore.getState()
      const bot = store.bots.find(b =>
        b.name === botName && Math.abs(new Date(b.createdAt).getTime() - new Date(createdAt).getTime()) < 2000
      )
      // Only navigate once the bot exists AND its ID is known to be persisted on the server
      if (bot && store.isBotPersisted(bot.id)) {
        if (navPollRef.current) clearInterval(navPollRef.current)
        navPollRef.current = null
        useBotStore.getState().setSelectedBotId(bot.id)
        setTimeout(() => {
          const runtimeEl = document.getElementById('runtime-control')
          if (runtimeEl) runtimeEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 400)
      } else if (attempts >= maxAttempts) {
        if (navPollRef.current) clearInterval(navPollRef.current)
        navPollRef.current = null
      }
    }, 200)
  }

  // ── Import action ───────────────────────────────────────────────────────
  async function handleImport() {
    if (!canImport) return
    setIsImporting(true)
    // BUG FIX: Removed artificial 500ms delay — no functional benefit

    if (isZipMode) {
      // ZIP import
      const lang = zipDetectedLang || detectLanguageFromFiles(projectFiles)

      // Build codeBlocks from project files
      const codeFiles = projectFiles.filter((f) => {
        const ext = f.path.split('.').pop()?.toLowerCase()
        return ['js', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'py'].includes(ext || '')
      })

      // If entryPoint is specified, put it first and mark as active
      const sortedFiles = entryPoint
        ? [
            ...codeFiles.filter((f) => f.path === entryPoint),
            ...codeFiles.filter((f) => f.path !== entryPoint),
          ]
        : codeFiles

      const codeBlocks = sortedFiles.length > 0
        ? sortedFiles.map((f, i) => {
            const ext = f.path.split('.').pop()?.toLowerCase()
            const blockLang = ext === 'py' ? 'python' : ext === 'ts' || ext === 'tsx' ? 'typescript' : 'javascript'
            return {
              id: generateUUID(),
              name: f.path.split('/').pop() || f.path,
              type: 'handler' as const,
              code: f.content,
              language: blockLang as BotLanguage | 'json',
              isActive: i === 0,
              lastModified: new Date().toISOString(),
              description: f.path,
            }
          })
        : []

      try {
        addBot({
          name: importName.trim(),
          description: importDesc.trim() || t('importBot.importedBot'),
          language: lang,
          template: 'custom',
          emoji: importEmoji,
          customIcon: importCustomIcon,
          codeBlocks,
          dependencies: zipDeps.length > 0 ? zipDeps : undefined,
          envVars: zipEnvVars.length > 0 ? zipEnvVars : undefined,
          projectFiles,
          entryPoint: entryPoint || undefined,
        })
      } catch {
        toast.error(t('createBot.createFailed'))
        setIsImporting(false)
        return
      }

      toast.success(t('importBot.importSuccess', { name: importName.trim() }), {
        description: t('importBot.importSuccessDesc', {
          files: projectFiles.length,
          envVars: zipEnvVars.length,
          deps: zipDeps.length,
        }),
      })
    } else {
      // Single-file import (existing logic)
      const lang = codeFile ? detectLanguage(codeFile.name) : 'javascript'

      const codeBlocks = codeFile ? [{
        id: generateUUID(),
        name: codeFile.name,
        type: 'handler' as const,
        code: codeFile.content,
        language: lang,
        isActive: true,
        lastModified: new Date().toISOString(),
        description: '',
      }] : []

      const envVars = parsedEnvVars.map((v) => ({
        id: generateUUID(),
        key: v.key, value: v.value, isEncrypted: false, description: v.description || '',
      }))

      const dependencies = detectedDeps.map((d) => ({
        id: generateUUID(),
        name: d.name, version: d.version, isRequired: d.isRequired, description: d.description,
      }))

      try {
        addBot({
          name: importName.trim(),
          description: importDesc.trim() || t('importBot.importedBot'),
          language: lang,
          template: 'custom',
          emoji: importEmoji,
          customIcon: importCustomIcon,
          codeBlocks, dependencies, envVars,
        })
      } catch {
        toast.error(t('createBot.createFailed'))
        setIsImporting(false)
        return
      }

      toast.success(t('importBot.importSuccess', { name: importName.trim() }), {
        description: t('importBot.importSuccessDesc', { files: files.length, envVars: parsedEnvVars.length, deps: detectedDeps.length }),
      })
    }

    // BUG FIX: Navigate to the newly imported bot (same robust polling as Create flow)
    const importedName = importName.trim()
    const importedAt = new Date().toISOString()
    resetAll()

    if (importedName) {
      let attempts = 0
      const maxAttempts = 25
      // Clear any previous navigation poll
      if (navPollRef.current) clearInterval(navPollRef.current)
      navPollRef.current = setInterval(() => {
        attempts++
        const store = useBotStore.getState()
        const bot = store.bots.find(b =>
          b.name === importedName && Math.abs(new Date(b.createdAt).getTime() - new Date(importedAt).getTime()) < 2000
        )
        if (bot && store.isBotPersisted(bot.id)) {
          if (navPollRef.current) clearInterval(navPollRef.current)
          navPollRef.current = null
          store.setSelectedBotId(bot.id)
          setTimeout(() => {
            const runtimeEl = document.getElementById('runtime-control')
            if (runtimeEl) runtimeEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }, 400)
        } else if (attempts >= maxAttempts) {
          if (navPollRef.current) clearInterval(navPollRef.current)
          navPollRef.current = null
        }
      }, 200)
    }
  }

  // ── Reset ───────────────────────────────────────────────────────────────
  function resetAll() {
    // BUG FIX: Clear any navigation polling interval to prevent unexpected
    // navigation after dialog closes
    if (navPollRef.current) {
      clearInterval(navPollRef.current)
      navPollRef.current = null
    }
    setName(''); setDescription(''); setLanguage('typescript'); setErrors({})
    setEmoji('🤖'); setCustomIcon(undefined)
    setIsDescFocused(false)
    setImportName(''); setImportDesc(''); setImportEmoji('📦'); setImportCustomIcon(undefined); setFiles([]); setPreviewFile(null); setIsImporting(false)
    setProjectFiles([]); setEntryPoint(''); setZipDetectedLang(null); setCollapsedDirs(new Set())
    setIsExtracting(false)
    setGitUrl(''); setGitBranch(''); setGitBranches([]); setGitBranchLoading(false); setGitCloning(false); setGitCloned(false)
    setCreateBotDialogOpen(false)
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      resetAll()
    } else {
      // Reset form state but keep dialog open
      setName(''); setDescription(''); setLanguage('typescript'); setErrors({})
      setEmoji('🤖'); setCustomIcon(undefined)
      setIsDescFocused(false)
      setImportName(''); setImportDesc(''); setImportEmoji('📦'); setImportCustomIcon(undefined); setFiles([]); setPreviewFile(null); setIsImporting(false)
      setProjectFiles([]); setEntryPoint(''); setZipDetectedLang(null); setCollapsedDirs(new Set())
      setIsExtracting(false)
      setGitUrl(''); setGitBranch(''); setGitBranches([]); setGitBranchLoading(false); setGitCloning(false); setGitCloned(false)
      // Switch to the mode from store
      setActiveTab(createBotDialogMode)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Dialog open={createBotDialogOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[580px] max-h-[80vh] grid grid-rows-[auto_1fr_auto] overflow-hidden [&>button]:hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 text-sm shadow-md shadow-cyan-500/25">
              {activeTab === 'git' ? <GitBranch className="size-4 text-white" /> : activeTab === 'import' ? <Upload className="size-4 text-white" /> : <span>🤖</span>}
            </div>
            {tabTitles[activeTab] || t('createBot.title')}
          </DialogTitle>
          <DialogDescription>{t('createBot.desc')}</DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto -mx-6 px-6 py-1">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'create' | 'import' | 'git')} className="flex flex-col">
          <TabsList className="grid w-full grid-cols-3 mb-4 h-auto p-1">
            <TabsTrigger value="create" className="text-sm gap-1.5 py-2">
              <Plus className="size-4" />
              <span>{t('createBot.tabCreate')}</span>
            </TabsTrigger>
            <TabsTrigger value="import" className="text-sm gap-1.5 py-2">
              <Upload className="size-4" />
              <span>{t('createBot.tabImport')}</span>
            </TabsTrigger>
            <TabsTrigger value="git" className="text-sm gap-1.5 py-2">
              <GitBranch className="size-4" />
              <span>{t('gitImport.tab')}</span>
            </TabsTrigger>
          </TabsList>

          {/* ─── Create Tab ────────────────────────────────────────────── */}
          <TabsContent value="create" className="flex-1 mt-0">
            <div className="space-y-3 pb-2">
              {/* Emoji + Name merged row (Optimization #1) */}
              <div className="space-y-2">
                <Label htmlFor="bot-name">{t('createBot.botName')}</Label>
                <div className="flex items-center gap-2">
                  <BotIconPicker
                    emoji={emoji}
                    customIcon={customIcon}
                    onEmojiChange={setEmoji}
                    onCustomIconChange={setCustomIcon}
                    size="md"
                  />
                  <Input
                    id="bot-name"
                    placeholder={t('createBot.botNamePlaceholder')}
                    value={name}
                    onChange={(e) => { setName(e.target.value); if (errors.name) setErrors({}) }}
                    className={cn('flex-1', errors.name && 'border-destructive focus-visible:ring-destructive/30')}
                  />
                </div>
                {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
              </div>

              {/* Description with collapse (Optimization #8) */}
              <div className="space-y-2">
                <Label htmlFor="bot-description">{t('createBot.descField')}</Label>
                <Textarea
                  id="bot-description"
                  placeholder={t('createBot.descPlaceholder')}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={isDescFocused ? 3 : 1}
                  onFocus={() => setIsDescFocused(true)}
                  onBlur={() => { if (!description) setIsDescFocused(false) }}
                  className="resize-none transition-[height] duration-200"
                />
              </div>

              {/* Language card picker (Optimization #4) */}
              <div className="space-y-2">
                <Label>{t('createBot.languageField')}</Label>
                <div className="grid grid-cols-3 gap-2">
                  {languageCards.map((lang) => (
                    <button
                      key={lang.id}
                      type="button"
                      className={cn(
                        'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all cursor-pointer',
                        language === lang.id
                          ? lang.color === 'amber' ? 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/50'
                            : lang.color === 'blue' ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/50'
                            : 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/50'
                          : 'border-muted hover:bg-accent text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => setLanguage(lang.id)}
                    >
                      <span className={cn(
                        'size-2 rounded-full shrink-0',
                        lang.color === 'amber' ? 'bg-amber-500' : lang.color === 'blue' ? 'bg-blue-500' : 'bg-emerald-500'
                      )} />
                      <span>{lang.label}</span>
                    </button>
                  ))}
                </div>
              </div>

            </div>
          </TabsContent>

          {/* ─── Import Tab ────────────────────────────────────────────── */}
          <TabsContent value="import" className="flex-1 mt-0">
            <div className="space-y-3 pb-2">
              {/* Drag & Drop Upload Area */}
              <div
                className={cn(
                  'relative border-2 border-dashed rounded-xl p-4 text-center transition-all duration-200 cursor-pointer',
                  'hover:border-teal-400/60 hover:bg-teal-50/30 dark:hover:bg-teal-500/5',
                  isDragging
                    ? 'border-teal-500 bg-teal-50/50 dark:bg-teal-500/10 scale-[1.02]'
                    : 'border-muted-foreground/25',
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".js,.mjs,.cjs,.ts,.tsx,.mts,.py,.env,.env.local,.env.production,.env.development,.zip"
                  multiple
                  onChange={handleFileInput}
                />
                {files.length === 0 && projectFiles.length === 0 ? (
                  <>
                    <div className="flex size-8 items-center justify-center rounded-xl bg-muted/50 mx-auto mb-2">
                      <Upload className="size-4 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium text-foreground">{t('importBot.dropzoneTitle')}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t('importBot.dropzoneDescZip')}</p>
                    <div className="flex items-center justify-center gap-2 mt-3">
                      <Badge variant="secondary" className="text-[10px] gap-1"><Archive className="size-3" />{t('importBot.zipBadge')}</Badge>
                      <Badge variant="secondary" className="text-[10px] gap-1"><FileCode2 className="size-3" />.js .ts .py</Badge>
                      <Badge variant="secondary" className="text-[10px] gap-1"><FileText className="size-3" />.env</Badge>
                    </div>
                  </>
                ) : isZipMode ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 rounded-lg bg-background border p-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm bg-teal-100 dark:bg-teal-500/10 text-teal-600 dark:text-teal-400">
                        <Archive className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">{t('importBot.projectFiles')}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {t('importBot.fileCount', { n: String(projectFiles.length) })}
                          {entryPoint && ` · ${t('importBot.entryPoint')}: ${entryPoint}`}
                        </p>
                      </div>
                      <Button variant="ghost" size="icon" className="size-7 opacity-60 hover:opacity-100 text-destructive hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); clearZipImport() }}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <Button variant="ghost" size="sm" className="w-full text-xs gap-1.5 text-muted-foreground mt-2"
                      onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click() }}>
                      <Upload className="size-3" />{t('importBot.addMoreFiles')}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {files.map((file) => (
                      <div key={file.name} className="flex items-center gap-3 rounded-lg bg-background border p-3 group">
                        <div className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-lg text-sm',
                          file.type === 'code'
                            ? 'bg-teal-100 dark:bg-teal-500/10 text-teal-600 dark:text-teal-400'
                            : 'bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        )}>
                          {file.type === 'code' ? <FileCode2 className="size-4" /> : <FileText className="size-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {formatFileSize(file.size)}
                            {file.type === 'env' && parsedEnvVars.length > 0 && ` · ${parsedEnvVars.length} ${t('importBot.variables')}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon" className="size-7 opacity-60 hover:opacity-100"
                            onClick={(e) => { e.stopPropagation(); setPreviewFile(previewFile === file.name ? null : file.name) }}>
                            <Eye className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="size-7 opacity-60 hover:opacity-100 text-destructive hover:text-destructive"
                            onClick={(e) => { e.stopPropagation(); removeFile(file.name) }}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    <Button variant="ghost" size="sm" className="w-full text-xs gap-1.5 text-muted-foreground mt-2"
                      onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click() }}>
                      <Upload className="size-3" />{t('importBot.addMoreFiles')}
                    </Button>
                  </div>
                )}
              </div>

              {/* Extracting indicator */}
              {isExtracting && (
                <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                  <div className="size-3.5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
                  {t('importBot.zipExtracting')}
                </div>
              )}

              {/* ZIP File Tree */}
              {isZipMode && !isExtracting && (
                <ProjectFileTree
                  files={projectFiles}
                  entryPoint={entryPoint}
                  onEntryPointChange={setEntryPoint}
                  previewFile={previewFile}
                  onPreviewFile={setPreviewFile}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={toggleDir}
                  t={t as (_key: string, _params?: Record<string, string | number>) => string}
                />
              )}

              {/* Code Preview */}
              {previewContent && previewFile && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Eye className="size-3" />{t('importBot.preview')}: {previewFile}
                    </Label>
                    <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={() => setPreviewFile(null)}>
                      {t('common.close')}
                    </Button>
                  </div>
                  <ScrollArea className="max-h-48 w-full">
                    <pre className="rounded-lg bg-zinc-950 dark:bg-zinc-900 p-3 text-xs text-zinc-300 dark:text-zinc-200 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">
                      {previewContent}
                    </pre>
                  </ScrollArea>
                </div>
              )}

              {/* Bot Name */}
              <div className="space-y-2">
                <Label htmlFor="import-bot-name">{t('importBot.botName')}</Label>
                <div className="flex items-center gap-2">
                  <BotIconPicker
                    emoji={importEmoji}
                    customIcon={importCustomIcon}
                    onEmojiChange={setImportEmoji}
                    onCustomIconChange={setImportCustomIcon}
                    size="md"
                  />
                  <Input
                    id="import-bot-name"
                    placeholder={detectedName || t('importBot.botNamePlaceholder')}
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    className="flex-1"
                  />
                  {(detectedName && importName === detectedName && !isZipMode) && (
                    <Badge variant="secondary" className="shrink-0 text-[10px] gap-1 text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3" />{t('importBot.autoDetected')}
                    </Badge>
                  )}
                  {isZipMode && projectFiles.some((f) => f.path === 'package.json') && (
                    <Badge variant="secondary" className="shrink-0 text-[10px] gap-1 text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3" />{t('importBot.autoDetected')}
                    </Badge>
                  )}
                </div>
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="import-bot-desc">{t('importBot.description')}</Label>
                <Textarea
                  id="import-bot-desc"
                  placeholder={t('importBot.descPlaceholder')}
                  value={importDesc}
                  onChange={(e) => setImportDesc(e.target.value)}
                  rows={2}
                  className="resize-none"
                />
              </div>

              {/* Auto-detected language badge for ZIP */}
              {isZipMode && zipDetectedLang && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" className="text-[10px] h-5 gap-1">
                    <Check className="size-2.5 text-emerald-500" />
                    {t('importBot.autoDetectedLanguage', { lang: zipDetectedLang.charAt(0).toUpperCase() + zipDetectedLang.slice(1) })}
                  </Badge>
                </div>
              )}

              {/* Import Summary */}
              {!isZipMode && files.length > 0 && (
                <div className="rounded-xl border bg-muted/20 p-4 space-y-3">
                  <h4 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Package className="size-3.5" />{t('importBot.importSummary')}
                  </h4>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    {/* Code File */}
                    <div className="space-y-1">
                      <span className="text-muted-foreground">{t('importBot.codeFile')}</span>
                      <div className="flex items-center gap-1.5">
                        {codeFile ? (
                          <><Check className="size-3 text-emerald-500" /><span className="text-foreground font-medium">{codeFile.name}</span></>
                        ) : (
                          <><AlertCircle className="size-3 text-amber-500" /><span className="text-amber-600 dark:text-amber-400">{t('importBot.noCodeFile')}</span></>
                        )}
                      </div>
                    </div>

                    {/* Env File */}
                    <div className="space-y-1">
                      <span className="text-muted-foreground">{t('importBot.envFile')}</span>
                      <div className="flex items-center gap-1.5">
                        {envFile ? (
                          <><Check className="size-3 text-emerald-500" /><span className="text-foreground font-medium">{parsedEnvVars.length} {t('importBot.variables')}</span></>
                        ) : (
                          <><span className="text-muted-foreground">—</span><span className="text-muted-foreground/60">{t('importBot.optional')}</span></>
                        )}
                      </div>
                    </div>

                    {/* Dependencies */}
                    {detectedDeps.length > 0 && (
                      <div className="space-y-1 col-span-2">
                        <span className="text-muted-foreground">{t('importBot.detectedDeps')}</span>
                        <div className="flex flex-wrap gap-1.5">
                          {detectedDeps.map((dep) => (
                            <Badge key={dep.name} variant="secondary" className="text-[10px] px-1.5 py-0 h-5">{dep.name}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Parsed Env Vars Preview */}
                  {parsedEnvVars.length > 0 && (
                    <div className="space-y-1.5 pt-2 border-t">
                      <span className="text-[11px] text-muted-foreground">{t('importBot.envVarsPreview')}</span>
                      <div className="flex flex-wrap gap-1.5">
                        {parsedEnvVars.map((env) => (
                          <Badge key={env.key} variant="outline" className="text-[10px] px-1.5 py-0 h-5 font-mono gap-1">
                            <span className="text-amber-500">K</span>{env.key}
                            <span className="text-muted-foreground/50">=</span>
                            <span className="text-muted-foreground/70 truncate max-w-[100px]">
                              {env.value.length > 20 ? env.value.slice(0, 20) + '...' : env.value}
                            </span>
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </TabsContent>
          {/* ─── Git Clone Tab ─────────────────────────────────────────── */}
          <TabsContent value="git" className="flex-1 mt-0">
            <div className="space-y-3 pb-2">
              {/* URL Input */}
              <div className="space-y-2">
                <Label htmlFor="git-url">{t('gitImport.urlLabel')}</Label>
                <div className="relative">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="git-url"
                    placeholder={t('gitImport.urlPlaceholder')}
                    value={gitUrl}
                    onChange={(e) => handleGitUrlChange(e.target.value)}
                    className="pl-9"
                  />
                </div>
                {gitUrl && !isValidGitUrl(gitUrl) && (
                  <p className="text-xs text-destructive">{t('gitImport.invalidUrl')}</p>
                )}
              </div>

              {/* Branch Selector */}
              {(gitBranches.length > 0 || gitBranchLoading) && (
                <div className="space-y-2">
                  <Label>{t('gitImport.branchLabel')}</Label>
                  <Select value={gitBranch} onValueChange={setGitBranch}>
                    <SelectTrigger className="w-full">
                      {gitBranchLoading ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="size-3.5 animate-spin" />
                          {t('gitImport.fetchBranches')}
                        </span>
                      ) : (
                        <SelectValue placeholder={t('gitImport.branchDefault')} />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {gitBranches.map((b) => (
                        <SelectItem key={b} value={b} className="text-xs">{b}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Clone Button */}
              <Button
                onClick={handleGitClone}
                disabled={!isValidGitUrl(gitUrl) || gitCloning || gitCloned}
                className="w-full gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 shadow-md shadow-cyan-500/25 hover:from-cyan-700 hover:to-blue-700 disabled:opacity-50"
              >
                {gitCloning ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('gitImport.cloning')}
                  </>
                ) : gitCloned ? (
                  <>
                    <Check className="size-4" />
                    {t('gitImport.cloneSuccess')}
                  </>
                ) : (
                  <>
                    <GitBranch className="size-4" />
                    {t('gitImport.cloneButton')}
                  </>
                )}
              </Button>

              {/* File Tree & Preview (after clone) */}
              {gitCloned && isZipMode && !gitCloning && (
                <>
                  <ProjectFileTree
                    files={projectFiles}
                    entryPoint={entryPoint}
                    onEntryPointChange={setEntryPoint}
                    previewFile={previewFile}
                    onPreviewFile={setPreviewFile}
                    collapsedDirs={collapsedDirs}
                    onToggleDir={toggleDir}
                    t={t as (_key: string, _params?: Record<string, string | number>) => string}
                  />

                  {/* Code Preview */}
                  {previewContent && previewFile && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <Eye className="size-3" />{t('importBot.preview')}: {previewFile}
                        </Label>
                        <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={() => setPreviewFile(null)}>
                          {t('common.close')}
                        </Button>
                      </div>
                      <ScrollArea className="max-h-48 w-full">
                        <pre className="rounded-lg bg-zinc-950 dark:bg-zinc-900 p-3 text-xs text-zinc-300 dark:text-zinc-200 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">
                          {previewContent}
                        </pre>
                      </ScrollArea>
                    </div>
                  )}

                  {/* Auto-detected language badge */}
                  {zipDetectedLang && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px] h-5 gap-1">
                        <Check className="size-2.5 text-emerald-500" />
                        {t('importBot.autoDetectedLanguage', { lang: zipDetectedLang.charAt(0).toUpperCase() + zipDetectedLang.slice(1) })}
                      </Badge>
                    </div>
                  )}
                </>
              )}

              {/* Bot Name — always visible */}
              <div className="space-y-2">
                <Label htmlFor="git-import-name">{t('importBot.botName')}</Label>
                <div className="flex items-center gap-2">
                  <BotIconPicker
                    emoji={importEmoji}
                    customIcon={importCustomIcon}
                    onEmojiChange={setImportEmoji}
                    onCustomIconChange={setImportCustomIcon}
                    size="md"
                  />
                  <Input
                    id="git-import-name"
                    placeholder={t('importBot.botNamePlaceholder')}
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    className="flex-1"
                  />
                  {gitCloned && isZipMode && projectFiles.some((f: ProjectFile) => f.path === 'package.json') && (
                    <Badge variant="secondary" className="shrink-0 text-[10px] gap-1 text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3" />{t('importBot.autoDetected')}
                    </Badge>
                  )}
                </div>
              </div>

              {/* Description — always visible */}
              <div className="space-y-2">
                <Label htmlFor="git-import-desc">{t('importBot.description')}</Label>
                <Textarea
                  id="git-import-desc"
                  placeholder={t('importBot.descPlaceholder')}
                  value={importDesc}
                  onChange={(e) => setImportDesc(e.target.value)}
                  rows={2}
                  className="resize-none"
                />
              </div>

            </div>
          </TabsContent>
        </Tabs>
        </div>

        {/* Footer */}
        <DialogFooter className="gap-3 sm:gap-4 pt-4">
          <Button variant="outline" onClick={resetAll}>{t('common.cancel')}</Button>
          {activeTab === 'create' ? (
            <Button
              onClick={handleCreate}
              disabled={isCreating}
              className="gap-1.5 bg-gradient-to-r from-cyan-600 to-blue-600 shadow-md shadow-cyan-500/25 hover:from-cyan-700 hover:to-blue-700"
            >
              {isCreating && <Loader2 className="size-4 animate-spin" />}
              {t('createBot.createButton')}
            </Button>
          ) : (
            <Button
              onClick={handleImport}
              disabled={!canImport || isImporting || isExtracting || gitCloning}
              className="gap-1.5 bg-gradient-to-r from-cyan-600 to-blue-600 shadow-md shadow-cyan-500/25 hover:from-cyan-700 hover:to-blue-700 disabled:opacity-50"
            >
              {isImporting ? (
                <><div className="size-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />{t('importBot.importing')}</>
              ) : (
                <><Upload className="size-4" />{t('importBot.importButton')}</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
