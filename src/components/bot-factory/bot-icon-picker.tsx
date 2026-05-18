'use client'

import { useRef, useCallback } from 'react'
import { Upload, X, ImageIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { EMOJI_OPTIONS } from '@/lib/bot-constants'
import { useT } from '@/lib/i18n'
import { toast } from 'sonner'

// Max file size for custom icon upload: 512KB
const MAX_ICON_SIZE = 512 * 1024

interface BotIconPickerProps {
  emoji: string
  customIcon?: string
  onEmojiChange: (_emoji: string) => void
  onCustomIconChange: (_dataUrl: string | undefined) => void
  /** Render size of the trigger button */
  size?: 'sm' | 'md'
}

export function BotIconPicker({
  emoji,
  customIcon,
  onEmojiChange,
  onCustomIconChange,
  size = 'md',
}: BotIconPickerProps) {
  const t = useT()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      // Validate file type
      if (!file.type.startsWith('image/')) {
        toast.error(t('createBot.invalidFileType'))
        return
      }

      if (file.type === 'image/svg+xml') {
        toast.error(t('createBot.svgNotAllowed'))
        return
      }

      if (file.size > MAX_ICON_SIZE) {
        toast.error(t('createBot.fileTooLarge'))
        return
      }

      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        onCustomIconChange(dataUrl)
      }
      reader.readAsDataURL(file)

      // Reset input
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [onCustomIconChange],
  )

  const handleRemoveCustomIcon = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onCustomIconChange(undefined)
    },
    [onCustomIconChange],
  )

  const isSm = size === 'sm'
  const triggerSize = isSm ? 'size-9' : 'size-10'
  const triggerEmoji = isSm ? 'text-lg' : 'text-2xl'
  const triggerImg = isSm ? 'size-6' : 'size-7'

  return (
    <div className="flex items-center gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'relative rounded-lg border hover:bg-accent transition-colors cursor-pointer overflow-hidden',
              triggerSize,
              'flex items-center justify-center',
            )}
          >
            {customIcon ? (
              <img
                src={customIcon}
                alt="Bot icon"
                className={cn('rounded object-cover', triggerImg)}
                draggable={false}
              />
            ) : (
              <span className={triggerEmoji}>{emoji}</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3" align="start">
          <div className="space-y-3">
            {/* Emoji section */}
            <div>
              <p className="text-[11px] font-medium text-muted-foreground mb-2">
                {t('createBot.emojiLabel')}
              </p>
              <div className="grid grid-cols-5 gap-1">
                {EMOJI_OPTIONS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className={cn(
                      'size-8 text-lg rounded-md hover:bg-accent transition-colors cursor-pointer',
                      emoji === e && !customIcon && 'ring-2 ring-primary ring-offset-1 ring-offset-background bg-accent',
                    )}
                    onClick={() => {
                      onEmojiChange(e)
                      onCustomIconChange(undefined)
                    }}
                    aria-label={`Select ${e} emoji`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            {/* Upload section */}
            <div className="border-t pt-2">
              <p className="text-[11px] font-medium text-muted-foreground mb-2">
                {t('createBot.customIconLabel')}
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-dashed',
                  'text-xs text-muted-foreground hover:bg-accent hover:border-foreground/20 transition-colors cursor-pointer',
                  customIcon && 'border-primary/30 bg-primary/5 text-primary',
                )}
              >
                <ImageIcon className="size-3.5 shrink-0" />
                {customIcon ? t('createBot.changeCustomIcon') : t('createBot.uploadCustomIcon')}
              </button>
              <p className="text-[10px] text-muted-foreground/60 mt-1">
                {t('createBot.customIconHint')}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleFileChange}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Remove custom icon button */}
      {customIcon && (
        <button
          type="button"
          onClick={handleRemoveCustomIcon}
          className="size-5 inline-flex items-center justify-center rounded-full hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
          aria-label={t('createBot.removeCustomIcon')}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}
