'use client'

import { useState } from 'react'
import { toast } from 'sonner'
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
import { cn } from '@/lib/utils'
import { useBotStore } from '@/store/bot-store'
import { useT } from '@/lib/i18n'
import { BotIconPicker } from '@/components/bot-factory/bot-icon-picker'
import type { Bot } from '@/types/bot'

/** Inner form that re-mounts on every bot change via key={bot.id} */
function EditBotForm({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const updateBot = useBotStore(s => s.updateBot)
  const updateBotEmoji = useBotStore(s => s.updateBotEmoji)
  const t = useT()

  // These useState initializers run on mount, so they get the correct bot data
  const [name, setName] = useState(bot.name)
  const [description, setDescription] = useState(bot.description)
  const [emoji, setEmoji] = useState(bot.emoji)
  const [customIcon, setCustomIcon] = useState<string | undefined>(bot.customIcon)
  const [errors, setErrors] = useState<{ name?: string }>({})

  function validate() {
    const newErrors: { name?: string } = {}
    if (!name.trim()) {
      newErrors.name = t('editBot.nameRequired')
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  function handleSubmit() {
    if (!validate()) return

    updateBot(bot.id, {
      name: name.trim(),
      description: description.trim(),
    })

    // Update emoji/customIcon if changed
    if (emoji !== bot.emoji || customIcon !== bot.customIcon) {
      updateBotEmoji(bot.id, emoji, customIcon)
    }

    toast.success(t('editBot.updated', { name }), { description: t('editBot.updatedDesc') })
    onClose()
  }


  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 text-sm shadow-md shadow-cyan-500/25 overflow-hidden">
            {customIcon ? (
              <img src={customIcon} alt="" className="size-5 rounded object-cover" draggable={false} />
            ) : (
              emoji || '🤖'
            )}
          </div>
          {t('editBot.title')}
        </DialogTitle>
        <DialogDescription>
          {t('editBot.desc')}
        </DialogDescription>
      </DialogHeader>

      <div className="overflow-y-auto -mx-6 px-6 py-1">
        <div className="space-y-5 py-2 pb-4">
          {/* Icon Picker + Bot Name merged row */}
          <div className="space-y-2">
            <Label htmlFor="edit-bot-name">
              {t('editBot.botName')}
            </Label>
            <div className="flex items-center gap-2">
              <BotIconPicker
                emoji={emoji}
                customIcon={customIcon}
                onEmojiChange={setEmoji}
                onCustomIconChange={setCustomIcon}
                size="sm"
              />
              <Input
                id="edit-bot-name"
                placeholder={t('editBot.botNamePlaceholder')}
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (errors.name) setErrors({})
                }}
                className={cn('flex-1', errors.name && 'border-destructive focus-visible:ring-destructive/30')}
              />
            </div>
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="edit-bot-description">{t('editBot.descField')}</Label>
            <Textarea
              id="edit-bot-description"
              placeholder={t('editBot.descPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="resize-none"
            />
          </div>

        </div>
      </div>

      <DialogFooter className="gap-3 sm:gap-3 pt-2 border-t">
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          onClick={handleSubmit}
          className="gap-1.5 bg-gradient-to-r from-cyan-600 to-blue-600 shadow-md shadow-cyan-500/25 hover:from-cyan-700 hover:to-blue-700"
        >
          {t('editBot.saveButton')}
        </Button>
      </DialogFooter>
    </>
  )
}

export function EditBotDialog() {
  const editBotId = useBotStore(s => s.editBotId)
  const setEditBotId = useBotStore(s => s.setEditBotId)
  // PERF FIX: Use targeted selector instead of subscribing to entire s.bots array.
  // Previously: const bots = useBotStore(s => s.bots) + bots.find() — re-rendered on ANY bot change.
  // Now: selector returns the specific bot object; Zustand's Object.is comparison skips
  // re-renders when other bots change (same reference returned by .find() for unchanged bot).
  const bot = useBotStore(s => editBotId ? s.bots.find((b) => b.id === editBotId) : undefined)
  const isOpen = editBotId !== null
  const t = useT()

  function handleClose() {
    setEditBotId(null)
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) handleClose() }}>
      <DialogContent className="sm:max-w-[480px] max-h-[90vh] grid grid-rows-[auto_1fr_auto] overflow-hidden [&>button]:hidden">
        {!bot && (
          <DialogHeader>
            <DialogTitle>{t('editBot.title')}</DialogTitle>
            <DialogDescription>{t('editBot.desc')}</DialogDescription>
          </DialogHeader>
        )}
        {bot && <EditBotForm key={bot.id} bot={bot} onClose={handleClose} />}
      </DialogContent>
    </Dialog>
  )
}
