'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardHeader, CardContent } from '@/components/ui/card'

export function BotListSkeleton({ viewMode = 'grid' }: { viewMode?: 'grid' | 'list' }) {
  if (viewMode === 'list') {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="rounded-xl border py-4">
            <CardContent className="flex items-center gap-4 px-5 py-0">
              {/* Avatar */}
              <Skeleton className="size-10 shrink-0 rounded-xl" />

              {/* Name & Description */}
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-60" />
              </div>

              {/* Stats (hidden on small) */}

              {/* Action buttons */}
              <div className="flex items-center gap-1 shrink-0">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="rounded-xl border overflow-hidden">
          <CardHeader className="gap-3 pb-0">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3 min-w-0">
                {/* Avatar */}
                <Skeleton className="size-12 shrink-0 rounded-xl" />
                {/* Title & Badge */}
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-5 w-14 rounded-md" />
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="gap-3 pt-2 pb-0">
            {/* Description lines */}
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>

          </CardContent>
        </Card>
      ))}
    </div>
  )
}
