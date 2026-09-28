import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { ultimaSemanaCerrada, hoyEnEcuador, crearCierreSemanal } = require('../dist/services/liquidacion')

// ═══════════════════════════════════════════════════════════════════════════
// EL CIERRE SEMANAL
// ═══════════════════════════════════════════════════════════════════════════
//
// El dinero (el libro por pedido, el neto, la cuota, la deuda que se arrastra)
// se prueba en PostgreSQL real: bloque «CUENTAS Y LIQUIDACIÓN SEMANAL» de
// `tests/sql/verificar-esquema.sql`. Aquí, que se cierre la semana CORRECTA y
// que la tarea esté enchufada.

describe('qué semana toca cerrar', () => {
  it('el lunes se cierra la semana que acaba de terminar', () => {
    // Lunes 5 de octubre, 09:00 en Ecuador.
    expect(ultimaSemanaCerrada(new Date('2026-10-05T14:00:00Z'))).toBe('2026-09-28')
  })

  it('cualquier otro día de esa semana apunta a la misma (repetir no hace nada)', () => {
    expect(ultimaSemanaCerrada(new Date('2026-10-07T14:00:00Z'))).toBe('2026-09-28')
    expect(ultimaSemanaCerrada(new Date('2026-10-11T14:00:00Z'))).toBe('2026-09-28')
  })

  it('⚠️ el domingo por la noche en Ecuador (ya lunes en UTC) NO cierra la semana en curso', () => {
    // Domingo 4 de octubre, 22:00 en Quito = lunes 5, 03:00 UTC.
    const domingoNoche = new Date('2026-10-05T03:00:00Z')
    expect(hoyEnEcuador(domingoNoche)).toBe('2026-10-04')
    expect(ultimaSemanaCerrada(domingoNoche)).toBe('2026-09-21')
  })

  it('siempre devuelve un lunes', () => {
    for (let dia = 0; dia < 30; dia++) {
      const fecha = ultimaSemanaCerrada(new Date(Date.UTC(2026, 9, 1 + dia, 15)))
      expect(new Date(`${fecha}T12:00:00Z`).getUTCDay(), fecha).toBe(1)
    }
  })
})

describe('la tarea del cierre', () => {
  it('cierra la semana calculada y avisa si creó liquidaciones', async () => {
    const pedidas = []
    const lineas = []
    const cerrar = crearCierreSemanal({
      cerrar: async (semana) => { pedidas.push(semana); return { creadas: 3 } },
      alertar: async () => {},
      registrar: linea => lineas.push(linea),
      ahora: () => new Date('2026-10-05T14:00:00Z'),
    })
    expect(await cerrar()).toEqual({ semana: '2026-09-28', creadas: 3 })
    expect(pedidas).toEqual(['2026-09-28'])
    expect(lineas[0]).toMatch(/3 local/)
  })

  it('si la base falla, alerta en «Pagos» y no lanza', async () => {
    const alertas = []
    const cerrar = crearCierreSemanal({
      cerrar: async () => { throw new Error('conexión perdida') },
      alertar: async (m) => { alertas.push(m) },
      registrar: () => {},
      ahora: () => new Date('2026-10-05T14:00:00Z'),
    })
    expect(await cerrar()).toBeNull()
    expect(alertas[0]).toMatch(/2026-09-28.*conexión perdida/)
  })
})

describe('el camino real', () => {
  const arranque = fs.readFileSync('src/index.ts', 'utf8')

  it('la tarea del cierre arranca con el servidor, dentro del freno de tareas', () => {
    const permitido = arranque.indexOf('if (tareas.permitido)')
    const tarea = arranque.indexOf('void cerrarSemanaAnterior()')
    expect(permitido).toBeGreaterThan(-1)
    expect(tarea).toBeGreaterThan(permitido)
  })

  it('las rutas de Pagos están montadas y TODAS exigen superadmin', () => {
    const admin = require('../dist/routes/admin.routes')
    const pagos = require('../dist/routes/admin-pagos.routes')
    const rutas = pagos.stack.filter(l => l.route)
    expect(rutas.map(l => l.route.path).sort()).toEqual([
      '/api/admin/pagos',
      '/api/admin/pagos/liquidaciones/:id/marcar',
    ])
    for (const layer of rutas) expect(layer.route.stack.length, layer.route.path).toBeGreaterThanOrEqual(2)
    const fuente = fs.readFileSync('src/routes/admin-pagos.routes.ts', 'utf8')
    expect(fuente.match(/router\.(get|post)\([^)]*auth\.authAdmin/g)).toHaveLength(2)
    expect(admin.stack.some(l => l.handle === pagos)).toBe(true)
  })

  it('la cuenta del local se lee con la ÚNICA función que lee esa tabla', () => {
    const fuente = fs.readFileSync('src/routes/admin-pagos.routes.ts', 'utf8')
    expect(fuente).toMatch(/db\.getBusinessBankAccount\(/)
    expect(fuente).not.toMatch(/business_bank_accounts/)
  })
})
