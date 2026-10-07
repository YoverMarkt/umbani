import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// ═══════════════════════════════════════════════════════════════════════════
// EL PANEL DE UNA COOPERATIVA DE REPARTO (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
// La API se simula: lo que se prueba aquí es la PANTALLA — que entra, que lo
// que manda es lo que el servidor espera, que la descarga lleva la sesión y
// que una sesión vencida vuelve al login. La API real la recorre
// `server/tests/recorridos/08-cooperativas.recorrido.js`.

const url = 'http://127.0.0.1:4175/cooperativa/'

const repartidores = [
  { id: 'm1', nombre: 'Andrés Mera', telefono: '593991234567', vehiculo: 'Moto', placa: 'MB123A', cedula: '1312345678', licencia: null,
    activo: true, disponible: true, topeEfectivoCents: 15000, efectivoEncimaCents: 2350 },
]

async function simularApi(page: Page) {
  const registro: { altas: unknown[]; descarga: string | null } = { altas: [], descarga: null }
  await page.route('**/api/cooperativa/**', async route => {
    const ruta = new URL(route.request().url()).pathname
    const metodo = route.request().method()
    if (ruta === '/api/cooperativa/login') {
      return route.fulfill({ json: { token: 'tok-coop', usuario: { nombre: 'Rosa', email: 'coop@chone.ec' }, cooperativa: { nombre: 'Cooperativa Chone', ciudad: 'Chone' } } })
    }
    if (ruta === '/api/cooperativa/repartidores' && metodo === 'POST') {
      registro.altas.push(route.request().postDataJSON())
      return route.fulfill({ status: 201, json: { id: 'm2', nombre: 'Nuevo', telefono: '593990000555', activo: true } })
    }
    if (ruta === '/api/cooperativa/repartidores') return route.fulfill({ json: { repartidores } })
    if (ruta === '/api/cooperativa/carreras') {
      return route.fulfill({ json: { semanas: ['2026-09-28'], enCurso: [{ id: 'm1', nombre: 'Andrés Mera', telefono: '593991234567', pedidos: 3, carrerasCents: 450, retenidasCents: 0, efectivoCobradoCents: 3790, efectivoEncimaCents: 2350 }] } })
    }
    if (ruta === '/api/cooperativa/carreras/semana/2026-09-28') {
      return route.fulfill({ json: { semana: '2026-09-28', filas: [{ id: 'm1', nombre: 'Andrés Mera', telefono: '593991234567', desde: '2026-09-28', hasta: '2026-10-04', pedidos: 2, carrerasCents: 300, efectivoCobradoCents: 842, arrastreCents: 0, saldoCents: -542, estado: 'por_cobrar', pagadaEl: null }] } })
    }
    if (ruta === '/api/cooperativa/carreras.csv') {
      registro.descarga = route.request().headers().authorization ?? null
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' }, body: '﻿"Repartidor";"WhatsApp"\n' })
    }
    if (ruta === '/api/cooperativa/problemas') return route.fulfill({ json: { retenidas: [], incidencias: [] } })
    return route.fulfill({ json: {} })
  })
  return registro
}

test('entra con su correo, ve a sus repartidores y registra uno nuevo', async ({ page }) => {
  const registro = await simularApi(page)
  await page.goto(url)
  await expect(page).toHaveURL(/#\/login$/)
  await page.getByLabel('Correo').fill('coop@chone.ec')
  await page.getByLabel('Contraseña').fill('una-clave-de-12+')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page.getByRole('heading', { name: 'Repartidores' })).toBeVisible()
  const fila = page.getByRole('row', { name: /Andrés Mera/ })
  await expect(fila).toContainText('$23.50')
  await expect(fila).toContainText('Disponible')

  await page.getByRole('button', { name: 'Nuevo repartidor' }).click()
  const ventana = page.getByRole('dialog', { name: 'Nuevo repartidor' })
  const registrar = ventana.getByRole('button', { name: 'Registrar repartidor' })
  await ventana.getByLabel('Nombre').fill('Carla Vera')
  await ventana.getByLabel('WhatsApp').fill('099 000 0555')
  await expect(registrar).toBeDisabled() // sin cédula ni placa
  await ventana.getByLabel('Cédula o pasaporte').fill('1312345679')
  await ventana.getByLabel('Placa').fill('mb124a')
  // Sin correo no podría entrar a su app (2026-10-06): no se deja registrar.
  await expect(registrar).toBeDisabled()
  await ventana.getByLabel('Correo').fill('carla@correo.com')
  await registrar.click()
  await expect.poll(() => registro.altas.length).toBe(1)
  await expect(ventana).toBeHidden()
  expect(registro.altas[0]).toMatchObject({ nombre: 'Carla Vera', telefono: '099 000 0555', correo: 'carla@correo.com', cedula: '1312345679', placa: 'mb124a', vehiculo: 'Moto' })
})

test('sus carreras: la semana en curso, una cerrada dicha con palabras, y la descarga lleva su sesión', async ({ page }) => {
  const registro = await simularApi(page)
  await page.addInitScript(() => {
    localStorage.setItem('cooperativa_token', 'tok-coop')
    localStorage.setItem('cooperativa_nombre', 'Cooperativa Chone')
  })
  await page.goto(`${url}#/carreras`)
  await expect(page.getByRole('heading', { name: 'Carreras' })).toBeVisible()
  await expect(page.getByRole('row', { name: /Andrés Mera/ })).toContainText('$37.90')

  await page.getByLabel('Semana').click()
  await page.getByRole('option', { name: /sept|sep/ }).click()
  // El saldo, con palabras: ni «-$5.42» ni «$-5.42».
  await expect(page.getByRole('row', { name: /Andrés Mera/ })).toContainText('Entrega $5.42')

  const descarga = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Descargar para Excel' }).click()
  expect((await descarga).suggestedFilename()).toBe('carreras-2026-09-28.csv')
  expect(registro.descarga).toBe('Bearer tok-coop')
})

test('una sesión vencida (o la cooperativa apagada) vuelve al login', async ({ page }) => {
  await page.route('**/api/cooperativa/**', route => route.fulfill({ status: 401, json: { error: 'Tu acceso ya no está activo. Habla con Umbani.' } }))
  await page.addInitScript(() => localStorage.setItem('cooperativa_token', 'vencido'))
  await page.goto(url)
  await expect(page).toHaveURL(/#\/login$/)
  expect(await page.evaluate(() => localStorage.getItem('cooperativa_token'))).toBeNull()
})

test('la guía «Cómo funciona» explica el dinero y no promete lo que aún no existe', async ({ page }) => {
  await simularApi(page)
  await page.addInitScript(() => localStorage.setItem('cooperativa_token', 'tok-coop'))
  await page.goto(`${url}#/como-funciona`)
  await expect(page.getByRole('heading', { name: 'Cómo funciona' })).toBeVisible()
  await expect(page.getByText('Cada lunes Umbani cierra su semana')).toBeVisible()
  await expect(page.getByText(/Umbani lo revisa y decide\s+quién responde/)).toBeVisible()
})

// En el teléfono, donde la cooperativa lo usa durante el turno: las tablas se
// cortaban por la derecha justo en el saldo y el estado (2026-10-06).
test('en el teléfono, cada repartidor es una tarjeta con todo a la vista y sin desplazar de lado', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await simularApi(page)
  await page.addInitScript(() => localStorage.setItem('cooperativa_token', 'tok-coop'))
  await page.goto(`${url}#/carreras`)
  await page.getByLabel('Semana').click()
  await page.getByRole('option', { name: /sept|sep/ }).click()
  // La tabla del escritorio sigue en la página, escondida: se mira lo VISIBLE.
  const saldo = page.getByText('Entrega $5.42').filter({ visible: true })
  await expect(saldo).toBeVisible()
  // DENTRO del ancho del teléfono: en la tabla cortada quedaba más allá del borde.
  const caja = await saldo.boundingBox()
  expect((caja?.x ?? 0) + (caja?.width ?? 0)).toBeLessThanOrEqual(390)
  await expect(page.getByText('Debe entregarlo').filter({ visible: true })).toBeVisible()
  const ancho = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(ancho).toBeLessThanOrEqual(390)
})
