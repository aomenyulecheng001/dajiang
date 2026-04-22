'use client'

import { useState } from 'react'
import { cn, getAvatarColor } from '@/lib/utils'

interface BotAvatarProps {
  botId: string
  emoji?: string
  customIcon?: string
  /** Size preset: sm (32px), md (40px), lg (48px), xl (64px) */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

const sizeMap = {
  sm: { wrapper: 'size-7', emoji: 'text-xs', img: 'size-5' },
  md: { wrapper: 'size-10', emoji: 'text-xl', img: 'size-7' },
  lg: { wrapper: 'size-12', emoji: 'text-2xl', img: 'size-8' },
  xl: { wrapper: 'size-16', emoji: 'text-3xl', img: 'size-11' },
}

export function BotAvatar({ botId, emoji, customIcon, size = 'md', className }: BotAvatarProps) {
  const s = sizeMap[size]
  const [imgErrorKey, setImgErrorKey] = useState('')

  // BUG FIX: imgError is now derived from both the errored key and current customIcon.
  // When customIcon changes, the old imgErrorKey no longer matches, so imgError resets.
  const imgError = imgErrorKey !== '' && imgErrorKey === customIcon

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-lg overflow-hidden',
        getAvatarColor(botId),
        s.wrapper,
        className,
      )}
    >
      {customIcon && !imgError ? (
        <img
          src={customIcon}
          alt="Bot icon"
          className={cn('rounded-lg object-cover', s.img)}
          draggable={false}
          onError={() => setImgErrorKey(customIcon || 'error')}
        />
      ) : (
        <span className={s.emoji}>{emoji || '🤖'}</span>
      )}
    </div>
  )
}
