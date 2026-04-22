'use client'

import { useMemo } from 'react'
import { useT } from '@/lib/i18n'

/**
 * HourlyChart — Shared 24-hour bar chart component.
 *
 * Used by:
 * - MonitoringTab (teal color)
 * - StatsTab (primary color)
 *
 * Displays hourly activity as 24 vertical bars with hover tooltips.
 */
interface HourlyChartProps {
  data: number[]
  colorClass?: string
  height?: number
}

export function HourlyChart({ data, colorClass = 'bg-primary/80', height = 120 }: HourlyChartProps) {
  const maxVal = useMemo(() => Math.max(...data, 1), [data])
  const t = useT()

  return (
    <div className="flex items-end gap-0.5" style={{ height }}>
      {Array.from({ length: 24 }).map((_, i) => {
        const val = data[i] || 0
        const pct = maxVal > 0 ? (val / maxVal) * 100 : 0
        const hourLabel = `${i.toString().padStart(2, '0')}:00`

        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 group relative">
            <div
              className={`w-full rounded-t-sm transition-all duration-200 ${colorClass} opacity-80 group-hover:opacity-100 min-h-[2px]`}
              style={{ height: `${Math.max(pct, val > 0 ? 2 : 0)}%` }}
            />
            <span className="text-[9px] text-muted-foreground/50 -rotate-45 origin-top-left translate-y-[2px]">
              {hourLabel}
            </span>
            {/* Tooltip */}
            <div className="absolute bottom-full mb-1 hidden group-hover:block z-10">
              <div className="bg-popover text-popover-foreground text-xs rounded-md px-2 py-1 shadow-lg border whitespace-nowrap">
                {hourLabel}: {t('charts.messages', { count: val })}
                <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-popover" />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
