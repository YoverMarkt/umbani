import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(`${serverDir}/migration-preparacion-produccion.sql`, 'utf8')
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const indexSource = readFileSync(`${serverDir}/src/index.ts`, 'utf8')
const dbSource = readFileSync(`${serverDir}/src/db/index.ts`, 'utf8')

describe('preparación transaccional para producción', () => {
  it('se detiene antes de borrar si encuentra datos financieros heredados', () => {
    expect(migration).toContain("where payment_link is not null")
    expect(migration).toContain("column_name in ('payment_provider', 'payment_link', 'payment_ref', 'paid_at')")
    expect(migration).toContain("raise exception using errcode = '23514'")
    expect(migration.indexOf('raise exception using')).toBeLessThan(
      migration.indexOf('drop table if exists public.payment_webhook_events'),
    )
  })

  it('retira tablas y columnas del flujo automático dentro de una transacción', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*?begin;/)
    expect(migration.trimEnd()).toMatch(/commit;$/)
    for (const table of [
      'payment_provider_accounts', 'payment_intents', 'payment_attempts',
      'payment_transactions', 'payment_webhook_events',
    ]) {
      expect(migration).toContain(`drop table if exists public.${table} cascade`)
    }
    expect(migration).toContain('drop column if exists payment_provider')
    expect(migration).toContain('drop column if exists payment_status')
  })

  it('deja pedidos manuales con transiciones atómicas y estados finales', () => {
    expect(migration).toContain("set status = 'completado'")
    expect(migration).toContain('create or replace function public.set_order_status')
    expect(migration).toContain("v_order.status = 'pendiente'")
    expect(migration).toContain("v_order.status = 'confirmado'")
    expect(schema).not.toContain("'pagado','cancelado'")
    expect(schema).toContain("'completado','cancelado'")
  })

  it('crea siete días editables para cualquier negocio nuevo', () => {
    expect(migration).toContain('create trigger businesses_default_schedule')
    expect(migration).toContain('on conflict (business_id, day_of_week) do nothing')
    expect(schema).toContain('create trigger businesses_default_schedule')
  })

  // ⚠️ CAMBIÓ el 2026-09-27, por decisión del dueño: se cobra con TARJETA por
  // PayPhone y la regla «cobro manual» dejó de ser absoluta. Aquí se prohibía
  // CUALQUIER repositorio de pagos; ahora existe UNO, `payments`, con su
  // propia batería (`pago-con-tarjeta.test.js` y el bloque «PAGO CON TARJETA»
  // de `verificar-esquema.sql`).
  //
  // Lo que este guardián sigue impidiendo es lo que retiró esta migración: el
  // flujo viejo de PayPal y sus cinco tablas. Si alguno vuelve, falla.
  it('no resucita el flujo financiero retirado (PayPal y sus tablas)', () => {
    expect(indexSource).not.toMatch(/paypal|payments\.routes/i)
    expect(dbSource).not.toMatch(/paypal/i)
    for (const table of [
      'payment_provider_accounts', 'payment_intents', 'payment_attempts',
      'payment_transactions', 'payment_webhook_events',
    ]) {
      expect(schema).not.toMatch(new RegExp(`create table (if not exists )?public\\.${table}\\b`))
    }
  })
})
