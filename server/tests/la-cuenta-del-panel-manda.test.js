import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fuenteDeLaTienda } from './fuente-de-rutas.mjs'
import path from 'node:path'

// ═══════════════════════════════════════════════════════════════════════════
// LA CUENTA DEL PANEL MANDA SOBRE TODO
// ═══════════════════════════════════════════════════════════════════════════
//
// Regla del dueño (2026-09-01): «la cuenta que siempre va por encima de todas
// es la que el dueño configura en su panel; todo comprobante tiene que ir al
// pago de la cuenta del dueño».
//
// Salió de una auditoría incómoda: los 7 comprobantes que habían llegado a
// producción iban a una cuenta distinta de la que la mini app le pedía al
// cliente. Con el rechazo automático encendido, esos 7 se rechazan solos — y
// eso es lo CORRECTO, porque la cuenta del panel es la autoridad.
//
// Pero esa autoridad se sostenía sola: seis sitios llamaban por convención a
// la misma función, y nada impedía que mañana alguien leyera la tabla por su
// cuenta. Entonces la app podría decirle al cliente «paga a X» mientras
// rechaza los pagos a X, que es la peor forma de perder una venta: culpando al
// cliente de hacer exactamente lo que se le pidió.

const RAIZ = path.resolve('src')

const archivos = (dir) => readdirSync(dir).flatMap((entrada) => {
  const completa = path.join(dir, entrada)
  if (statSync(completa).isDirectory()) return archivos(completa)
  return completa.endsWith('.ts') ? [completa] : []
})

// ⚠️ `db/tipos-generados.ts` también queda fuera, y no es una excepción
// cómoda: es un archivo GENERADO que nombra las 57 tablas por definición, sin
// leer ninguna. Contarlo como infractor convertiría este guardián en ruido
// permanente el día que se añadieron los tipos (2026-09-19).
const fuera = (ruta) => !ruta.includes(path.join('db', 'repositories'))
  && !ruta.endsWith('tipos-generados.ts')

describe('una sola puerta a la cuenta del dueño', () => {
  it('nadie lee `business_bank_accounts` fuera del repositorio', () => {
    // Es la misma regla que ya rige todo el acceso a Supabase, pero aquí el
    // coste de romperla es distinto: no es un dato mal leído, es dinero
    // enviado a una cuenta que la plataforma después no reconoce.
    const infractores = archivos(RAIZ)
      .filter(fuera)
      .filter(ruta => readFileSync(ruta, 'utf8').includes('business_bank_accounts'))
      .map(ruta => path.relative(RAIZ, ruta))

    expect(infractores, 'leen la tabla sin pasar por getBusinessBankAccount').toEqual([])
  })

  it('la cuenta que se ENSEÑA y la que se COMPARA salen de la misma función', () => {
    // `/payment-info` es lo que el cliente ve en la mini app; `receipt-ingest`
    // es lo que decide si su comprobante cuadra. Si esos dos se separaran, la
    // app pediría pagar a una cuenta y rechazaría los pagos a esa cuenta.
    const enseña = fuenteDeLaTienda()
    const compara = readFileSync('src/services/receipt-ingest.ts', 'utf8')
    expect(enseña).toContain('getBusinessBankAccount')
    expect(compara).toContain('getBusinessBankAccount')
  })

  it('los dos sitios que le dicen al cliente dónde pagar usan la misma', () => {
    // La mini app y el aviso por WhatsApp. Los dos tienen que nombrar la MISMA
    // cuenta, o el cliente recibe una instrucción distinta según por dónde
    // entró. Eran TRES hasta que el checkout del chat se retiró (2026-09-15).
    for (const [sitio, fuente] of [
      ['la mini app', fuenteDeLaTienda()],
      ['el aviso al cliente', readFileSync('src/routes/orders.routes.ts', 'utf8')],
    ]) {
      expect(fuente, sitio).toContain('getBusinessBankAccount')
    }
  })

  it('el repositorio devuelve la cuenta ACTIVA, no la primera que encuentre', () => {
    // «La que el dueño configura» es la que tiene puesta HOY. Sin el filtro,
    // una cuenta vieja desactivada podría ganarle a la buena y la plataforma
    // rechazaría los pagos correctos.
    const repo = readFileSync('src/db/repositories/catalog.ts', 'utf8')
    // Hasta el cierre de la consulta, no hasta la primera llave: el cuerpo
    // lleva llaves dentro (el destructuring de `data`), y cortar ahí dejaba
    // fuera justo el filtro que se comprueba.
    const fn = repo.slice(repo.indexOf('const getBusinessBankAccount'))
    const cuerpo = fn.slice(0, fn.indexOf('return data'))
    expect(cuerpo).toContain("from('business_bank_accounts')")
    expect(cuerpo).toMatch(/\.eq\('active', true\)/)
  })
})
