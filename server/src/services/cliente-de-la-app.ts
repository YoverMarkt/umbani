import type { Request } from 'express'
import { correoDe, telefonoDe } from './sesion-app'

// ═══════════════════════════════════════════════════════════════════════════
// LA PERSONA DE LA SESIÓN DE LA APP (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Una sesión prueba un TELÉFONO (la puerta de WhatsApp, que queda en espera)
// o un CORREO (la de las apps desde hoy). Las rutas del cliente no deberían
// tener que saber cuál: piden la persona, o el teléfono del que cuelgan sus
// pedidos, y esto lo resuelve.

const db = require('../db') as typeof import('../db')

export interface ClienteDeLaApp {
  id: string
  telefono: string | null
  correo: string | null
  ciudadId: string | null
}

/** La persona de la sesión. Si es la primera vez que entra, nace. */
export async function clienteDeLaSesion(req: Request): Promise<ClienteDeLaApp> {
  const correo = correoDe(req)
  if (correo) {
    const cuenta = await db.cuentaPorCorreo(correo)
    return { id: cuenta.id, telefono: cuenta.phone, correo: cuenta.email, ciudadId: cuenta.city_id }
  }
  const cliente = await db.resolveMarketplaceCustomer(telefonoDe(req))
  return { id: cliente.id, telefono: cliente.phone, correo: null, ciudadId: cliente.city_id ?? null }
}

/**
 * El teléfono del que cuelgan sus pedidos, o '' si todavía no puso uno.
 *
 * ⚠️ Con correo, es el que la cuenta RECLAMÓ en exclusiva
 * (`db.reclamarTelefono`): por eso puede seguir siendo la frontera de «Mis
 * pedidos», los reclamos y la tienda, igual que el que probaba WhatsApp.
 */
export async function telefonoDelCliente(req: Request): Promise<string> {
  return telefonoDe(req) || (await clienteDeLaSesion(req)).telefono || ''
}
