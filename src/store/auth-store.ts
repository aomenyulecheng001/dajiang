import { create } from 'zustand'

// SECURITY NOTE: Login credentials (username/password) exist briefly in JavaScript
// memory during form submission. This is standard for SPAs but means an XSS
// vulnerability could expose them. Mitigate by: (1) strict CSP headers,
// (2) sanitizing all user-rendered content, (3) avoiding innerHTML.

interface AuthState {
  isAuthenticated: boolean
  isLoading: boolean
  username: string | null
  token: string | null
  setAuth: (isAuthenticated: boolean, username: string | null, token: string | null) => void
  setLoading: (loading: boolean) => void
  updateUsername: (newUsername: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  isLoading: true,
  username: null,
  token: null,
  setAuth: (isAuthenticated, username, token) => {
    set({ isAuthenticated, username, token, isLoading: false })
  },
  setLoading: (loading) => set({ isLoading: loading }),
  updateUsername: (newUsername: string) => set({ username: newUsername }),
  logout: async () => {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    }).catch(() => {})

    // FIX (M1): Clear bot-store BEFORE setting isAuthenticated=false.
    // Previously, isAuthenticated was set to false first, which triggered
    // bot-runner-context to disconnect Socket.IO, but bot-store cleanup
    // was async and might not complete before the UI re-rendered — causing
    // a brief state where the UI showed an empty bot list but still had
    // a connected Socket status. Now we clean up bot-store synchronously
    // first, then update auth state.
    try {
      const { useBotStore, resetHydration } = await import('@/store/bot-store')
      useBotStore.setState({ bots: [], selectedBotId: null })
      resetHydration()
    } catch { /* non-critical */ }

    set({ isAuthenticated: false, username: null, token: null, isLoading: false })
  },
}))

export async function verifySession(signal?: AbortSignal): Promise<{ valid: boolean; username?: string }> {
  try {
    const res = await fetch('/api/auth/session', {
      credentials: 'include',
      signal,
    })
    if (res.ok) {
      const data = await res.json()
      return { valid: data.valid, username: data.username }
    }
    return { valid: false }
  } catch {
    return { valid: false }
  }
}
