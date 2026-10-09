// ═══════════════════════════════════════════════════════════════════════════
// LA APP WEB DE CLIENTES (`/u`) HABLA CON LA MISMA API QUE LA APP FLUTTER
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño (2026-10-05): Umbani sale como APP. Esta web es la app de
// clientes para probar lo que se construye y la REFERENCIA de la app Flutter:
// cada llamada de aquí es una de `docs/apps/API-UMBANI.md`, y si algo falla
// aquí, fallaría allí. Por eso no hay atajos: nada que la app Flutter no
// pudiera hacer igual.
//
// La tienda de cada local es la mini app de siempre (`/t/<slug>`): al tocar un
// local se pide su sesión con el token de la app y se abre la tienda con ella.

import { deviceId } from '../lib/session'

let TOKEN = 'umbani_app_token'
const CIUDAD = 'umbani_ciudad'

/**
 * La app de repartidores (`/r`) guarda su sesión APARTE: es otra app, como lo
 * serán las dos de Flutter. Comparten dominio, y con una sola llave entrar
 * como repartidor cerraba la sesión de cliente — y en un mismo teléfono no se
 * podía probar a la vez quien pide y quien reparte con números distintos.
 */
export function usarLlaveDeSesion(llave: string): void { TOKEN = llave }

export interface Ciudad { id: string; nombre: string }

export interface LocalDelMenu {
  slug: string
  nombre: string
  tipo: string | null
  minutos: number | null
  /** null = no se sabe: se pinta abierto, como en el chat. */
  abierto: boolean | null
  conCarta: boolean | null
  cartaDesde: string | null
}

export interface CategoriaDelMenu {
  codigo: string
  nombre: string
  emoji: string | null
  locales: LocalDelMenu[]
}

export interface PedidoDeLaApp {
  id: string
  order_number: number | null
  status: string
  total: number
  created_at: string
  local: { nombre: string | null; slug: string | null }
}

export class ErrorDeLaApp extends Error {
  readonly status: number
  /** Lo que el servidor dice que falta (`telefono`), para llevar a la pantalla que lo pide. */
  readonly falta: string | null
  constructor(status: number, message: string, falta: string | null = null) {
    super(message)
    this.name = 'ErrorDeLaApp'
    this.status = status
    this.falta = falta
  }
}

/** Lo que se le dice a la persona cuando algo falla: el mensaje del servidor, o uno genérico. */
export const mensaje = (error: unknown) => (error instanceof Error ? error.message : 'Algo salió mal. Inténtalo de nuevo.')

// ── Lo que se guarda en el teléfono ────────────────────────────────────────
// ⚠️ Cada lectura y escritura va con `try`: en una ventana privada el
// almacenamiento puede lanzar, y la app tiene que seguir funcionando.

export function tokenDeLaApp(): string {
  try { return localStorage.getItem(TOKEN) || '' } catch { return '' }
}

export function guardarToken(token: string): void {
  try { localStorage.setItem(TOKEN, token) } catch { /* sin almacenamiento, vive en la pestaña */ }
}

export function salir(): void {
  try { localStorage.removeItem(TOKEN) } catch { /* nada que borrar */ }
}

export function ciudadGuardada(): Ciudad | null {
  try {
    const guardada = JSON.parse(localStorage.getItem(CIUDAD) || 'null') as Ciudad | null
    return guardada?.id && guardada.nombre ? guardada : null
  } catch {
    return null
  }
}

export function recordarCiudad(ciudad: Ciudad): void {
  try { localStorage.setItem(CIUDAD, JSON.stringify(ciudad)) } catch { /* se vuelve a preguntar */ }
}

// ── Las llamadas ───────────────────────────────────────────────────────────

export async function pedir<T>(ruta: string, opciones: {
  metodo?: 'GET' | 'POST' | 'PUT'
  cuerpo?: unknown
  conSesion?: boolean
  cabeceras?: Record<string, string>
} = {}): Promise<{ status: number; datos: T }> {
  const cabeceras: Record<string, string> = {
    'Content-Type': 'application/json',
    // El id de instalación: la API lo guarda RESUMIDO, nunca tal cual.
    'x-umbani-dispositivo': deviceId(),
    ...(opciones.cabeceras || {}),
  }
  const token = tokenDeLaApp()
  if (opciones.conSesion && token) cabeceras.Authorization = `Bearer ${token}`
  let respuesta: Response
  try {
    respuesta = await fetch(ruta, {
      method: opciones.metodo || 'GET',
      headers: cabeceras,
      body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
    })
  } catch {
    throw new ErrorDeLaApp(0, 'Sin conexión. Revisa tus datos o tu Wi-Fi e inténtalo de nuevo.')
  }
  const datos = await respuesta.json().catch(() => ({})) as T & { error?: string; falta?: string }
  // La sesión venció o se cerró (CERRAR SESIÓN por WhatsApp): se olvida.
  if (respuesta.status === 401 && opciones.conSesion) salir()
  if (!respuesta.ok) {
    throw new ErrorDeLaApp(respuesta.status, datos?.error || 'Algo salió mal. Inténtalo de nuevo.', datos?.falta ?? null)
  }
  return { status: respuesta.status, datos }
}

// ── Entrar con el correo (2026-10-06) ─────────────────────────────────────
// Las apps ya no entran por WhatsApp. La puerta de WhatsApp sigue en el
// servidor, en espera, pero aquí no se usa.

/** Lo que necesita la pantalla de entrar: la clave del captcha, si el servidor lo tiene encendido. */
export const configDeEntrada = async () =>
  (await pedir<{ turnstile: { claveDeSitio: string } | null }>('/api/v1/auth/config')).datos

/**
 * El código llega al correo. En el servidor de PRUEBAS, sin proveedor de correo, vuelve aquí.
 * Con el captcha encendido va con su ficha (`lib/turnstile.ts`); sin ella, 403 `falta: 'turnstile'`.
 */
export const pedirCodigoPorCorreo = async (correo: string, turnstile?: string) => (await pedir<{
  enviado: boolean
  expiraEn: string
  codigoDePruebas?: string
}>('/api/v1/auth/correo', { metodo: 'POST', cuerpo: { correo, ...(turnstile ? { turnstile } : {}) } })).datos

/** 401 = código incorrecto (gasta un intento); 410 = ya no vale, hay que pedir otro. */
export const canjearCodigoDeCorreo = async (correo: string, codigo: string) =>
  (await pedir<{ token: string; correo: string }>('/api/v1/auth/correo/verificar', { metodo: 'POST', cuerpo: { correo, codigo } })).datos

/** El número al que le llama el repartidor: una vez, antes del primer pedido. */
export const ponerMiTelefono = async (telefono: string) =>
  (await pedir<{ telefono: string }>('/api/v1/yo/telefono', { metodo: 'PUT', cuerpo: { telefono }, conSesion: true })).datos

/** La ciudad del GPS. Fuera de todas, la más cercana (y queda anotado). */
export const ciudadAqui = async (lat: number, lng: number) => (await pedir<{
  ciudad: Ciudad | null
  conLocales?: boolean
  cercana?: { nombre: string; km: number } | null
}>(`/api/v1/ciudades/aqui?lat=${lat}&lng=${lng}`)).datos

/** Las ciudades con locales, para quien no da permiso de ubicación. */
export const ciudades = async () => (await pedir<{ ciudades: Ciudad[] }>('/api/v1/ciudades')).datos.ciudades

/** La misma ciudad que usa el chat. Sin sesión no se guarda en Umbani (sí aquí). */
export async function guardarCiudad(ciudad: Ciudad): Promise<void> {
  recordarCiudad(ciudad)
  if (!tokenDeLaApp()) return
  await pedir('/api/v1/yo/ciudad', { metodo: 'PUT', cuerpo: { ciudadId: ciudad.id }, conSesion: true }).catch(() => {})
}

export const menuDeLaCiudad = async (ciudadId: string) =>
  (await pedir<{ categorias: CategoriaDelMenu[] }>(`/api/v1/marketplace?ciudad=${encodeURIComponent(ciudadId)}`)).datos.categorias

/**
 * Entrar a un local: su sesión de tienda, atada a ESTE navegador (el mismo
 * `x-storefront-device` que usa la tienda). Devuelve la dirección de la tienda.
 */
export async function abrirLocal(slug: string): Promise<string> {
  const { datos } = await pedir<{ token: string }>(`/api/v1/locales/${encodeURIComponent(slug)}/sesion`, {
    metodo: 'POST', conSesion: true, cabeceras: { 'x-storefront-device': deviceId() },
  })
  return `/t/${encodeURIComponent(slug)}?s=${encodeURIComponent(datos.token)}`
}

export const misPedidos = async () =>
  (await pedir<{ pedidos: PedidoDeLaApp[] }>('/api/v1/pedidos', { conSesion: true })).datos.pedidos
