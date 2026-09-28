import crypto from 'node:crypto'
import { enSegundoPlano } from '../lib/segundo-plano'

// Registro de errores de plataforma.
//
// Nació del apagón de julio de 2026: el canal estuvo cinco días caído y la
// única pista vivía en los logs de Railway, que se rotan y nadie mira. Aquí
// queda rastro consultable y descargable desde el panel del superadmin.
//
// DOS REGLAS QUE NO SE NEGOCIAN:
//  1. Nunca rompe al que lo llama. Un logger que tumba el servidor es peor que
//     no tener logger, así que todo va envuelto y los fallos se tragan.
//  2. Nunca guarda datos personales ni credenciales. El log está pensado para
//     descargarse y compartirse, así que sale saneado de fábrica.

export type ErrorCategory = 'canal' | 'ia' | 'envio' | 'servidor' | 'pagos'

export interface RecordErrorInput {
  businessId?: string | null
  category: ErrorCategory
  code?: string | number | null
  message: unknown
  context?: Record<string, unknown>
}

export interface ErrorLogDatabase {
  recordPlatformError(input: {
    businessId: string | null
    category: string
    code: string | null
    message: string
    context: Record<string, unknown>
    fingerprint: string
  }): Promise<unknown>
}

const MAX_MESSAGE_LENGTH = 2000
const MAX_CONTEXT_KEYS = 12
const MAX_CONTEXT_VALUE_LENGTH = 300

/** Como mucho un registro por huella cada este tiempo, pase lo que pase. */
const THROTTLE_MS = 10_000

// ── Saneado ─────────────────────────────────────────────────────────────────
// El orden importa: primero lo más específico (credenciales) y luego lo general.

const REDACTIONS: Array<[RegExp, string]> = [
  // Credenciales antes que nada: nunca deben salir del servidor.
  [/\b(sk|pk|whsec|xoxb|ghp)[-_][A-Za-z0-9_-]{8,}/gi, '[credencial]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[clave]'],
  // Datos personales del cliente final.
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[correo]'],
  [/\+?\d[\d\s()-]{7,}\d/g, '[telefono]'],
]

/** Quita credenciales y datos personales, y recorta a un tamaño manejable. */
export function sanitizeErrorText(value: unknown, maxLength = MAX_MESSAGE_LENGTH): string {
  const raw = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : (() => {
        try {
          return JSON.stringify(value)
        } catch {
          return String(value)
        }
      })()

  const redacted = REDACTIONS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    String(raw ?? ''),
  )
  const collapsed = redacted.replace(/\s+/g, ' ').trim()
  return (collapsed || 'Error sin detalle').slice(0, maxLength)
}

/** Contexto saneado: pocas claves, valores cortos y sin datos personales. */
export function sanitizeContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!context || typeof context !== 'object') return {}
  const entries = Object.entries(context).slice(0, MAX_CONTEXT_KEYS)
  return Object.fromEntries(entries.map(([key, value]) => {
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return [key, value]
    }
    return [key, sanitizeErrorText(value, MAX_CONTEXT_VALUE_LENGTH)]
  }))
}

/**
 * Huella que agrupa el mismo error repetido. Se calcula aquí, en Node, y NO con
 * digest() en SQL: esa función fuera del search_path es exactamente lo que dejó
 * el canal mudo cinco días, y no vuelve al camino crítico.
 *
 * Los números del mensaje se normalizan para que "falló tras 3 intentos" y
 * "falló tras 7 intentos" cuenten como el mismo problema.
 */
export function errorFingerprint(input: {
  businessId?: string | null
  category: string
  code?: string | null
  message: string
}): string {
  const normalized = input.message.toLowerCase().replace(/\d+/g, '#')
  return crypto
    .createHash('sha256')
    .update([
      input.businessId || 'global',
      input.category,
      input.code || '',
      normalized,
    ].join('|'))
    .digest('hex')
}

// ── Limitador ───────────────────────────────────────────────────────────────
// Una tormenta de errores idénticos no debe convertirse en una tormenta de
// escrituras. La base ya agrupa por huella; esto evita incluso ir a pedirlo.

const lastRecordedAt = new Map<string, number>()

const shouldSkip = (fingerprint: string, now: number): boolean => {
  const previous = lastRecordedAt.get(fingerprint)
  if (previous !== undefined && now - previous < THROTTLE_MS) return true
  lastRecordedAt.set(fingerprint, now)
  // Limpieza barata para que el mapa no crezca sin control.
  if (lastRecordedAt.size > 500) {
    for (const [key, at] of lastRecordedAt) {
      if (now - at > THROTTLE_MS) lastRecordedAt.delete(key)
    }
  }
  return false
}

/** Solo para pruebas: olvida el limitador. */
export function resetErrorLogThrottle(): void {
  lastRecordedAt.clear()
}

// ── Registro ────────────────────────────────────────────────────────────────

export function createErrorLogger(database: ErrorLogDatabase) {
  // Casi todos lo llaman con `void`, sin esperar: queda en `enSegundoPlano`
  // para que las pruebas lo esperen antes de cerrar (ver lib/segundo-plano).
  return function recordError(input: RecordErrorInput): Promise<void> {
    return enSegundoPlano(registrar(input))
  }

  async function registrar(input: RecordErrorInput): Promise<void> {
    try {
      const message = sanitizeErrorText(input.message)
      const code = input.code === null || input.code === undefined
        ? null
        : String(input.code).slice(0, 120)
      const businessId = input.businessId || null
      const fingerprint = errorFingerprint({
        businessId,
        category: input.category,
        code,
        message,
      })
      if (shouldSkip(fingerprint, Date.now())) return

      await database.recordPlatformError({
        businessId,
        category: input.category,
        code,
        message,
        context: sanitizeContext(input.context),
        fingerprint,
      })
    } catch (error) {
      // Deliberado: registrar un error jamás puede provocar otro que rompa el
      // flujo real. Se queda en la consola y la vida sigue.
      console.error(
        '⚠️  No se pudo registrar el error en la plataforma:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

const db: ErrorLogDatabase = require('../db') as typeof import('../db')

export const recordError = createErrorLogger(db)
