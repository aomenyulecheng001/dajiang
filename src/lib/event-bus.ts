/**
 * In-memory event bus for SSE push notifications.
 *
 * P1 OPT: Replaces DB polling in the SSE log stream endpoint.
 * Instead of querying BotLog + Bot tables every 2 seconds per botId,
 * the SSE endpoint subscribes to this bus and receives events instantly
 * when logs are created or bot status changes.
 *
 * Event flow:
 *   POST /api/bots/[id]/logs  →  eventBus.emit(`bot:${id}`, 'log', {...})
 *   PUT/PATCH /api/bots/[id]  →  eventBus.emit(`bot:${id}`, 'status', {...})
 *   SSE endpoint              →  eventBus.subscribe(`bot:${id}`, handler)
 */

type EventHandler = (event: string, data: unknown) => void

interface Subscription {
  unsubscribe: () => void
  active: boolean
}

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>()
  private static MAX_SUBSCRIBERS_PER_CHANNEL = 50
  private static MAX_CHANNELS = 500

  /**
   * Emit an event to all subscribers of a channel.
   * Called from API routes after DB writes (log create, status update).
   */
  emit(channel: string, event: string, data: unknown): void {
    const handlers = this.handlers.get(channel)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(event, data)
      } catch {
        // Subscriber may be closed; will be cleaned up by the subscriber
      }
    }
  }

  /**
   * Subscribe to events on a channel.
   * Returns an unsubscribe function.
   */
  subscribe(channel: string, handler: EventHandler): Subscription {
    let handlers = this.handlers.get(channel)
    if (!handlers) {
      if (this.handlers.size >= EventBus.MAX_CHANNELS) {
        console.warn(`[EventBus] Max channels (${EventBus.MAX_CHANNELS}) reached, rejecting subscription to "${channel}"`)
        return { unsubscribe: () => {}, active: false }
      }
      handlers = new Set()
      this.handlers.set(channel, handlers)
    }
    if (handlers.size >= EventBus.MAX_SUBSCRIBERS_PER_CHANNEL) {
      console.warn(`[EventBus] Max subscribers (${EventBus.MAX_SUBSCRIBERS_PER_CHANNEL}) reached for channel "${channel}"`)
      return { unsubscribe: () => {}, active: false }
    }
    handlers.add(handler)

    return {
      active: true,
      unsubscribe: () => {
        const h = this.handlers.get(channel)
        if (h) {
          h.delete(handler)
          // Clean up empty channels to prevent memory leaks
          if (h.size === 0) {
            this.handlers.delete(channel)
          }
        }
      },
    }
  }

  /**
   * Get the number of active subscribers for a channel.
   * Useful for debugging and monitoring.
   */
  subscriberCount(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0
  }

  /**
   * Get the total number of active channels.
   * Useful for monitoring memory usage.
   */
  get channelCount(): number {
    return this.handlers.size
  }
}

/** Singleton event bus — shared across all API routes in the same process */
export const eventBus = new EventBus()
