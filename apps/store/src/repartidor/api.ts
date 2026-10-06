// ═══════════════════════════════════════════════════════════════════════════
// LA APP WEB DE REPARTIDORES (`/r`) HABLA CON LA MISMA API QUE LA APP FLUTTER
// ═══════════════════════════════════════════════════════════════════════════
//
// La referencia viva de `docs/apps/APP-MOTORIZADO.md`, para probar lo que se
// construye (la cooperativa, las incidencias) y para quien hace la app
// Flutter del motorizado. Cada llamada es una de esa guía.
//
// ⚠️ Todo importe llega en CENTAVOS y aquí no se suma ni se resta nada: el
// servidor decide cuánto es la carrera, cuánto efectivo lleva y su semana.

import { pedir, usarLlaveDeSesion } from '../umbani/api'

// Su sesión, aparte de la de cliente (ver `usarLlaveDeSesion`). Al cargar este
// módulo, antes de pintar nada: el login compartido la lee al guardar el token.
usarLlaveDeSesion('umbani_repartidor_token')

export interface SemanaDelRepartidor {
  pedidos: number
  carrerasCents: number
  retenidasCents: number
  efectivoCobradoCents: number
  /** Netos de semanas ya cerradas que aún no se cobran (< 0: los debe). */
  deAntesCents: number
  efectivoEncimaCents: number
}

export interface Yo {
  nombre: string
  vehiculo: string | null
  flota: 'umbani' | 'local'
  disponible: boolean
  topeEfectivoCents: number
  semana: SemanaDelRepartidor | null
}

export interface Punto { lat: number | null; lng: number | null; direccion: string | null }

export interface PedidoDelRepartidor {
  id: string
  numero: number | null
  estado: string
  mio: boolean
  totalCents: number
  carreraCents: number
  cobrarEnEfectivo: boolean
  recoger: Punto & { local: string | null }
  entregar: Punto & { cliente: string | null; referencia: string | null; notas: string | null }
}

export interface Liquidacion {
  id: string
  period_start: string
  period_end: string
  orders_count: number
  derecho_cents: number
  en_mano_cents: number
  neto_cents: number
  status: string
}

export const yo = async () => (await pedir<Yo>('/api/v1/motorizado/yo', { conSesion: true })).datos

export const ponerDisponible = async (disponible: boolean) =>
  (await pedir<{ disponible: boolean }>('/api/v1/motorizado/disponible', { metodo: 'PUT', cuerpo: { disponible }, conSesion: true })).datos

export const pedidos = async () =>
  (await pedir<{ pedidos: PedidoDelRepartidor[] }>('/api/v1/motorizado/pedidos', { conSesion: true })).datos.pedidos

// Cada ruta escrita entera, sin armarla por partes: así la lee la prueba del
// contrato (`apps-web-contrato.test.mjs`) y quien busque cómo se llama.
const paso = async (ruta: string) => { await pedir<{ ok: true }>(ruta, { metodo: 'POST', conSesion: true }) }

/** 409 con su motivo: otro llegó antes, el tope de efectivo, o ya no está disponible. */
export const tomar = (id: string) => paso(`/api/v1/motorizado/pedidos/${encodeURIComponent(id)}/tomar`)
/** 409 si el local aún no termina de empacar: el mensaje dice qué falta. */
export const recogido = (id: string) => paso(`/api/v1/motorizado/pedidos/${encodeURIComponent(id)}/recogido`)
export const entregado = (id: string) => paso(`/api/v1/motorizado/pedidos/${encodeURIComponent(id)}/entregado`)

export const liquidaciones = async () =>
  (await pedir<{ liquidaciones: Liquidacion[] }>('/api/v1/motorizado/liquidaciones', { conSesion: true })).datos.liquidaciones

/** Google Maps con la ruta hasta ese punto (no necesita clave). Sin punto, por la dirección. */
export const comoLlegar = (punto: Punto): string | null => {
  if (punto.lat != null && punto.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${punto.lat},${punto.lng}`
  if (punto.direccion) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(punto.direccion)}`
  return null
}
