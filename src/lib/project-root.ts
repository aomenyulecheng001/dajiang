import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

/**
 * In standalone mode (output: "standalone"), the server.js calls process.chdir(__dirname)
 * at startup, making process.cwd() return the .next/standalone/ directory instead of the
 * project root. This breaks all relative path resolutions.
 *
 * This utility provides a reliable way to find the actual project root directory
 * regardless of whether the app runs in standalone or normal mode.
 */

let _projectRoot: string | null = null

/**
 * Get the project root directory.
 *
 * Resolution strategy:
 * 1. PROJECT_ROOT env var (set by PM2 ecosystem in production)
 * 2. Check if process.cwd() is the project root (has mini-services/)
 * 3. If cwd is inside .next/standalone, traverse up to find project root
 * 4. Walk up looking for mini-services/ directory
 * 5. Fallback to process.cwd()
 */
export function getProjectRoot(): string {
  if (_projectRoot) return _projectRoot

  // Strategy 1: Use PROJECT_ROOT env var (most reliable in production)
  const envRoot = process.env.PROJECT_ROOT
  if (envRoot && existsSync(join(envRoot, 'mini-services'))) {
    _projectRoot = envRoot
    return _projectRoot
  }

  // Strategy 2: Check if process.cwd() is already the project root
  const cwd = process.cwd()
  if (existsSync(join(cwd, 'mini-services'))) {
    _projectRoot = cwd
    return _projectRoot
  }

  // Strategy 3: If cwd is inside .next/standalone, go up to project root
  // .next/standalone is always 2 levels deep from the project root
  if (cwd.includes('.next/standalone') || cwd.includes('.next\\standalone')) {
    const parentDir = resolve(cwd, '..', '..')
    if (existsSync(join(parentDir, 'mini-services'))) {
      _projectRoot = parentDir
      return _projectRoot
    }
  }

  // Strategy 4: Walk up from cwd looking for mini-services directory
  let dir = cwd
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'mini-services'))) {
      _projectRoot = dir
      return _projectRoot
    }
    // Also check for package.json with prisma schema (unique to this project)
    const pkgPath = join(dir, 'package.json')
    const prismaPath = join(dir, 'prisma', 'schema.prisma')
    if (existsSync(prismaPath)) {
      _projectRoot = dir
      return _projectRoot
    }
    if (existsSync(pkgPath)) {
      try {
        const content = readFileSync(pkgPath, 'utf-8')
        const pkg = JSON.parse(content)
        if (pkg.name === 'bot-factory' || pkg.name === 'nextjs_tailwind_shadcn_ts') {
          _projectRoot = dir
          return _projectRoot
        }
      } catch {
        // Not a valid package.json, continue
      }
    }
    const parent = resolve(dir, '..')
    if (parent === dir) break // Reached filesystem root
    dir = parent
  }

  // Fallback: use cwd
  console.warn('[project-root] Warning: Could not determine project root, falling back to process.cwd()')
  _projectRoot = cwd
  return _projectRoot
}

/**
 * Resolve a path relative to the project root.
 */
export function resolveFromProjectRoot(...pathSegments: string[]): string {
  return join(getProjectRoot(), ...pathSegments)
}
