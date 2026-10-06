// ── Cliente HTTP del panel de la COOPERATIVA (2026-10-06) ────────────────
// Su propia sesión (`cooperativa_token`): el token es de rol «cooperativa» y
// ningún otro panel lo acepta, ni este acepta los suyos.

const LLAVE = 'cooperativa_token'
const LLAVE_NOMBRE = 'cooperativa_nombre'

export const session = {
  get token(): string | null {
    try { return localStorage.getItem(LLAVE) } catch { return null }
  },
  get nombre(): string {
    try { return localStorage.getItem(LLAVE_NOMBRE) || '' } catch { return '' }
  },
  save(token: string, nombre: string) {
    try {
      localStorage.setItem(LLAVE, token)
      localStorage.setItem(LLAVE_NOMBRE, nombre)
    } catch { /* sin almacenamiento: la sesión vive en la pestaña */ }
  },
  clear() {
    try {
      localStorage.removeItem(LLAVE)
      localStorage.removeItem(LLAVE_NOMBRE)
    } catch { /* nada que borrar */ }
  },
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const cabeceras = (extra: HeadersInit = {}): HeadersInit => ({
  'Content-Type': 'application/json',
  ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
  ...extra,
})

/** La sesión venció o la cooperativa se apagó: de vuelta al login. */
function fuera(): never {
  session.clear()
  window.location.hash = '#/login'
  throw new ApiError(401, 'Tu sesión venció. Entra de nuevo.')
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...options, headers: cabeceras(options.headers) })
  if (res.status === 401 && session.token) fuera()
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Error ${res.status}`)
  return data as T
}

/**
 * Descarga un archivo que exige la sesión (la de Excel): un enlace normal no
 * lleva el token, así que se pide con `fetch` y se guarda como archivo.
 */
export async function descargar(path: string, nombre: string): Promise<void> {
  const res = await fetch(path, { headers: cabeceras() })
  if (res.status === 401) fuera()
  if (!res.ok) throw new ApiError(res.status, 'No se pudo descargar. Inténtalo de nuevo.')
  const url = URL.createObjectURL(await res.blob())
  const enlace = document.createElement('a')
  enlace.href = url
  enlace.download = nombre
  enlace.click()
  URL.revokeObjectURL(url)
}

/**
 * Los centavos del servidor, dichos en dólares. Solo para enseñar: aquí no se
 * calcula nada. Sin signo: quién le debe a quién se dice con palabras.
 */
export const dolares = (centavos: number | null | undefined) => `$${(Math.abs(centavos ?? 0) / 100).toFixed(2)}`
