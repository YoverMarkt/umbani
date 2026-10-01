// ── Cliente HTTP del panel ───────────────────────────────────────────
import { queryClient } from '../lib/queryClient'

// Usa las MISMAS claves de localStorage que el panel viejo (client_token,
// client_biz, client_user): la sesión se comparte entre ambos paneles
// durante la migración (patrón estrangulador).

export type Business = {
  id: string
  name: string
  type: string | null
  suspended?: boolean
  bot_active?: boolean
  /** Local de demostración: sus pedidos y montos son de prueba (2026-09-30). */
  demo?: boolean
}

export type PanelUser = {
  name: string
  role: 'owner' | 'employee'
  permissions: string[]
}

export const session = {
  get token(): string | null { return localStorage.getItem('client_token') },
  get business(): Business | null {
    try { return JSON.parse(localStorage.getItem('client_biz') || 'null') } catch { return null }
  },
  get user(): PanelUser | null {
    try { return JSON.parse(localStorage.getItem('client_user') || 'null') } catch { return null }
  },
  save(token: string, business: Business, user: PanelUser) {
    localStorage.setItem('client_token', token)
    localStorage.setItem('client_biz', JSON.stringify(business))
    localStorage.setItem('client_user', JSON.stringify(user))
  },
  clear() {
    localStorage.removeItem('client_token')
    localStorage.removeItem('client_biz')
    localStorage.removeItem('client_user')
  },
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// fetch con token + manejo de errores uniforme. Sesión vencida → volver al login.
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(options.headers || {}),
    },
  })
  if (res.status === 401) {
    session.clear()
    // Igual que en logout: el caché no puede sobrevivir a la sesión
    queryClient.clear()
    window.location.hash = '#/login'
    throw new ApiError(401, 'Sesión vencida. Inicia sesión de nuevo.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Error ${res.status}`)
  return data as T
}
