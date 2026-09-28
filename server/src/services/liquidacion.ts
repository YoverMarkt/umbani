// ═══════════════════════════════════════════════════════════════════════════
// EL CIERRE SEMANAL: QUÉ SEMANA TOCA, Y CERRARLA
// ═══════════════════════════════════════════════════════════════════════════
//
// Cada lunes se liquida la semana anterior (lunes a domingo, hora de Ecuador).
// La tarea corre varias veces al día y es INOFENSIVA repetida: la base no crea
// dos liquidaciones para la misma semana. Correr de más solo cuesta una
// consulta; correr de menos dejaría a un local sin su depósito.
//
// ⚠️ La semana se cuenta en hora de ECUADOR. En UTC el lunes empieza a las 19:00
// del domingo en Quito: con la fecha de UTC, las últimas horas del domingo —las
// de más pedidos— caerían en la semana equivocada.

/** La fecha de hoy en Ecuador, `YYYY-MM-DD`. */
export function hoyEnEcuador(ahora: Date = new Date()): string {
  return ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' })
}

/**
 * El lunes de la última semana YA TERMINADA.
 *
 * Es el lunes de la semana en la que caía el día de hace siete: el lunes 5
 * devuelve el lunes 28 anterior; el miércoles 7, también.
 */
export function ultimaSemanaCerrada(ahora: Date = new Date()): string {
  const [anio, mes, dia] = hoyEnEcuador(ahora).split('-').map(Number)
  const haceSiete = new Date(Date.UTC(anio, mes - 1, dia - 7))
  // getUTCDay: 0 domingo … 6 sábado. Retroceder hasta el lunes.
  const desdeElLunes = (haceSiete.getUTCDay() + 6) % 7
  haceSiete.setUTCDate(haceSiete.getUTCDate() - desdeElLunes)
  return haceSiete.toISOString().slice(0, 10)
}

export interface DependenciasDelCierre {
  cerrar(semana: string): Promise<{ creadas: number; motivo?: string }>
  alertar(mensaje: string): Promise<void>
  registrar(linea: string): void
  ahora?(): Date
}

export const crearCierreSemanal = (deps: DependenciasDelCierre) =>
  async function cerrarSemanaAnterior(): Promise<{ semana: string; creadas: number } | null> {
    const semana = ultimaSemanaCerrada(deps.ahora ? deps.ahora() : new Date())
    try {
      const { creadas, motivo } = await deps.cerrar(semana)
      if (creadas > 0) deps.registrar(`💰 Liquidación de la semana del ${semana}: ${creadas} local(es)`)
      else if (motivo) deps.registrar(`💰 Liquidación ${semana}: ${motivo}`)
      return { semana, creadas }
    } catch (error) {
      await deps.alertar(`No se pudo cerrar la semana del ${semana}: ${error instanceof Error ? error.message : String(error)}`)
        .catch(() => { /* la alerta no puede tumbar la tarea */ })
      return null
    }
  }

/** La instancia real, perezosa: cargar el módulo no abre la base. */
export async function cerrarSemanaAnterior() {
  const db = require('../db') as typeof import('../db')
  const { recordError } = require('./error-log') as typeof import('./error-log')
  return crearCierreSemanal({
    // Los locales y, con la misma semana, los motorizados.
    cerrar: async (semana) => {
      const locales = await db.closeWeeklySettlements(semana)
      const motorizados = await db.closeWeeklyCourierSettlements(semana)
      return { creadas: locales.creadas + motorizados.creadas, motivo: locales.motivo }
    },
    alertar: mensaje => recordError({ businessId: null, category: 'pagos', code: 'liquidacion_semanal', message: mensaje }),
    registrar: linea => console.log(linea),
  })()
}
