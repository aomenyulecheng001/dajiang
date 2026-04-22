'use client'

import { EnvVarsTab } from './env-vars-tab'
import { ConfigTab } from './config-tab'

export function ConfigCombinedTab() {
  return (
    <div className="space-y-8">
      <EnvVarsTab />
      <div className="border-t border-border/40" />
      <ConfigTab />
    </div>
  )
}
