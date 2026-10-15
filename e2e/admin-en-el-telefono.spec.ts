import { expect, test } from './fixtures'
import { mockAdminApi, seedAdminSession } from './helpers'

// ═══════════════════════════════════════════════════════════════════════════
// EL SUPERADMIN EN EL TELÉFONO: LAS CABECERAS (2026-10-14)
// ═══════════════════════════════════════════════════════════════════════════
// En Incidencias y Pagos el bloque del título era `flex-1` (empieza en ancho
// cero): los botones nunca bajaban de línea y, a 390 px, la explicación
// quedaba en una columna de una palabra por renglón. Lo vio el dueño en las
// fotos del ejemplo de «no estaba el cliente». Con el arreglo, la explicación
// ocupa el ancho y los botones van DEBAJO.

const adminUrl = 'http://127.0.0.1:4174/app-admin/'

async function cabecera(page: import('@playwright/test').Page, explicacion: RegExp, boton: RegExp) {
  const texto = await page.getByText(explicacion).first().boundingBox()
  const accion = await page.getByRole('button', { name: boton }).first().boundingBox()
  return { texto: texto!, accion: accion! }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedAdminSession(page)
  await mockAdminApi(page)
})

test('Incidencias: en el teléfono la explicación ocupa el ancho y los botones van debajo', async ({ page }) => {
  await page.route('**/api/admin/incidencias?estado=*', route => route.fulfill({ json: { incidencias: [] } }))
  await page.goto(`${adminUrl}#/incidencias`)
  await expect(page.getByRole('heading', { name: 'Incidencias' })).toBeVisible()
  const { texto, accion } = await cabecera(page, /^Lo que el cliente reporta/, /^Abiertas$/)
  expect(texto.width).toBeGreaterThan(280)
  expect(accion.y).toBeGreaterThanOrEqual(texto.y + texto.height - 1)
})

test('Pagos: en el teléfono la explicación ocupa el ancho y «Anular una venta» va debajo', async ({ page }) => {
  await page.route('**/api/admin/pagos', route => route.fulfill({
    json: { saldos: [], liquidaciones: [], cobros: [], cuentas: {} },
  }))
  await page.goto(`${adminUrl}#/pagos`)
  await expect(page.getByRole('heading', { name: 'Pagos' })).toBeVisible()
  const { texto, accion } = await cabecera(page, /^Lo que Umbani cobró con tarjeta/, /Anular una venta/)
  expect(texto.width).toBeGreaterThan(280)
  expect(accion.y).toBeGreaterThanOrEqual(texto.y + texto.height - 1)
})
