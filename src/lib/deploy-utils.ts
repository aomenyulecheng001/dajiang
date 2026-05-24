import type { Bot, Dependency, ProjectFile } from '@/types/bot'
import type { DeployConfig } from '@/lib/bot-runner-context'
import { useI18nStore, getTranslation } from '@/lib/i18n'
import { logger } from '@/lib/logger'

interface PrepareDeployResult {
  config: DeployConfig['config']
  realEnvVarsMap: Record<string, string>
  realBotToken: string
}

export async function fetchRevealEnvVars(botId: string): Promise<{ envVarsMap: Record<string, string>; botToken: string } | null> {
  const locale = useI18nStore.getState().locale
  const t = (key: string) => getTranslation(locale, key as any)
  try {
    const { authFetch } = await import('@/store/bot-store')
    const res = await authFetch(`/api/bots/${botId}/env-vars/reveal`)
    if (res.status === 429) {
      import('sonner').then(({ toast }) => {
        toast.error(t('common.tooManyRequests'))
      }).catch(() => {})
      return null
    }
    if (res.ok) {
      const data = await res.json()
      const envVarsMap: Record<string, string> = {}
      for (const v of data.envVars || []) {
        envVarsMap[v.key] = v.value
      }
      const botToken = [envVarsMap.BOT_TOKEN, envVarsMap.TELEGRAM_BOT_TOKEN].filter(Boolean).slice(-1)[0] || ''
      return { envVarsMap, botToken }
    }
  } catch (err) {
    logger.warn('deploy-utils', 'fetchRevealEnvVars failed.', err instanceof Error ? err.message : err)
  }
  return null
}

export function hasMaskedEnvVars(envVars: { isEncrypted?: boolean; value: string }[]): boolean {
  return envVars.some(v => v.isEncrypted && v.value.includes('\u2022'))
}

export function buildEnvVarsFallback(envVars: { key: string; value: string }[]): Record<string, string> {
  const map: Record<string, string> = {}
  envVars.forEach(v => { map[v.key] = v.value })
  return map
}

export function buildDeployConfig(
  botId: string,
  bot: Bot,
  realEnvVarsMap: Record<string, string>,
  realBotToken: string,
): DeployConfig {
  const depsList = (bot.dependencies || []).map((d: Dependency) => d.version ? `${d.name}@${d.version}` : d.name)

  // BUG FIX: When projectFiles exist, codeBlocks edits must be synced back to projectFiles.
  // Previously, codeBlocks were generated from projectFiles at import time but never synced.
  // When the user edited code in the code tab, only codeBlocks was updated — projectFiles
  // (which is what actually gets deployed) remained unchanged, causing edits to be silently lost.
  // Now we merge codeBlocks changes back into projectFiles before building the deploy config.
  let projectFilesForDeploy = bot.projectFiles
  if (bot.projectFiles?.length && bot.codeBlocks?.length) {
    const codeBlockMap = new Map<string, string>()
    for (const cb of bot.codeBlocks) {
      if (cb.description && cb.code) {
        // codeBlocks from ZIP import have description = file path
        codeBlockMap.set(cb.description, cb.code)
      }
    }
    if (codeBlockMap.size > 0) {
      projectFilesForDeploy = bot.projectFiles.map(f => {
        const updatedCode = codeBlockMap.get(f.path)
        if (updatedCode !== undefined) {
          return { ...f, content: updatedCode, size: new TextEncoder().encode(updatedCode).length }
        }
        return f
      })
    }
  }

  return {
    botId,
    config: {
      name: bot.name || '',
      botToken: realBotToken,
      language: (bot.language || 'javascript') as 'javascript' | 'typescript' | 'python',
      templateId: bot.template || 'custom',
      envVars: realEnvVarsMap,
      customCode: projectFilesForDeploy?.length ? undefined : (bot.codeBlocks?.filter(b => b.isActive !== false).map(b => b.code).join('\n\n') || bot.code || undefined),
      dependencies: depsList.length > 0 ? depsList : undefined,
      projectFiles: projectFilesForDeploy?.length
        ? projectFilesForDeploy.map((f: ProjectFile) => ({ path: f.path, content: f.content }))
        : undefined,
      entryPoint: bot.entryPoint || undefined,
    },
  }
}
