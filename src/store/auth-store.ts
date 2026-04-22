import { create } from 'zustand'

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
  logout: () => {
    fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    }).catch(() => {})

    set({ isAuthenticated: false, username: null, token: null, isLoading: false })
    import('@/store/bot-store').then(({ useBotStore, resetHydration }) => {
      useBotStore.setState({ bots: [], selectedBotId: null })
      resetHydration()
    }).catch(() => {})
  },
}))

export async function verifySession(_token?: string, signal?: AbortSignal): Promise<{ valid: boolean; username?: string }> {
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
