import rateLimit from 'express-rate-limit'
import type { Response } from 'express'
import { createRouter } from '../middleware/async'
import { cooperativaDe, cooperativaGuard, firmarSesionDeCooperativa } from '../middleware/auth-cooperativa'
import { telefonoDelRepartidor } from '../lib/telefono-del-repartidor'

// ═══════════════════════════════════════════════════════════════════════════
// EL PANEL DE UNA COOPERATIVA DE REPARTO (`/cooperativa`, 2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como los «socios de flota» de las grandes: la cooperativa registra a SUS
// motorizados, ve sus carreras semana a semana (y las descarga para calcular
// su comisión, que queda entre ellos) y sus problemas.
//
// ⚠️ El id de la cooperativa sale SIEMPRE de la sesión (`cooperativaDe`),
// nunca de la petición; cada consulta va filtrada por él.
// ⚠️ Sin datos de clientes: de un pedido solo se ve su número y el local.
// ⚠️ El dinero no se calcula aquí: carreras, efectivo y saldos vienen de la
// base (`courier_balance`, `courier_settlements`), en centavos.

interface ModuloBcrypt { compare(valor: string, hash: string): Promise<boolean> }
const bcrypt: ModuloBcrypt = require('bcryptjs') as typeof import('bcryptjs')
const db = require('../db') as typeof import('../db')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEMANA = /^\d{4}-\d{2}-\d{2}$/
const router = createRouter()

// Los mismos frenos que el inicio de sesión del local.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos fallidos. Espera 15 minutos.' },
})
const limiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, espera un momento' },
})

const NO_ENTRA = 'Correo o contraseña incorrectos'

router.post('/api/cooperativa/login', loginLimiter, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const clave = typeof body.password === 'string' ? body.password : ''
  if (!email || !clave) return res.status(401).json({ error: NO_ENTRA })

  const usuario = await db.getCooperativeUserByEmail(email)
  if (!usuario || !await bcrypt.compare(clave, usuario.password_hash)) {
    return res.status(401).json({ error: NO_ENTRA })
  }
  const cooperativa = await db.getCooperative(usuario.cooperative_id)
  if (!usuario.active || !cooperativa?.active) {
    return res.status(403).json({ error: 'Tu acceso no está activo. Habla con Umbani.' })
  }
  return res.json({
    token: firmarSesionDeCooperativa({ cooperativeId: usuario.cooperative_id, userId: usuario.id, email: usuario.email }),
    usuario: { nombre: usuario.name || '', email: usuario.email },
    cooperativa: { nombre: cooperativa.name, ciudad: cooperativa.cities?.name ?? null },
  })
})

// Todo lo demás, con su sesión: en CADA ruta, a la vista (no en un `use` que
// una prueba de ruta no ve si alguien lo borra).
const puerta = [limiter, cooperativaGuard]

router.get('/api/cooperativa/yo', ...puerta, async (req, res) => {
  const sesion = cooperativaDe(req)
  const cooperativa = await db.getCooperative(sesion.cooperativeId)
  return res.json({
    cooperativa: { nombre: cooperativa?.name ?? '', ciudad: cooperativa?.cities?.name ?? null, telefono: cooperativa?.contact_phone ?? null },
    usuario: { email: sesion.email },
  })
})

// ── Sus motorizados ────────────────────────────────────────────────────────

router.get('/api/cooperativa/repartidores', ...puerta, async (req, res) => {
  const lista = await db.listCooperativeCouriers(cooperativaDe(req).cooperativeId)
  const semanas = await Promise.all(lista.map(m => db.getCourierBalance(m.id).catch(() => null)))
  return res.json({
    repartidores: lista.map((m, i) => ({
      id: m.id,
      nombre: m.name,
      telefono: m.phone,
      vehiculo: m.vehicle,
      placa: m.plate,
      cedula: m.id_number,
      licencia: m.license_number,
      activo: m.active,
      disponible: m.available,
      topeEfectivoCents: m.cash_limit_cents,
      // Lo que lleva encima AHORA (lo que cobró y aún no liquida + lo que va a cobrar).
      efectivoEncimaCents: Number(semanas[i]?.efectivoEncimaCents) || 0,
    })),
  })
})

const texto = (valor: unknown, maximo: number) => String(valor ?? '').trim().replace(/\s+/g, ' ').slice(0, maximo + 1)

router.post('/api/cooperativa/repartidores', ...puerta, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const telefono = telefonoDelRepartidor(body.telefono)
  const nombre = texto(body.nombre, 80)
  const vehiculo = texto(body.vehiculo, 60)
  const cedula = texto(body.cedula, 20).replace(/\s/g, '')
  const placa = texto(body.placa, 12).toUpperCase()
  const licencia = texto(body.licencia, 30) || null
  if (!telefono) return res.status(400).json({ error: 'Escribe su WhatsApp, por ejemplo 0991234567' })
  if (nombre.length < 2 || nombre.length > 80) return res.status(400).json({ error: 'Escribe su nombre' })
  if (vehiculo.length < 2 || vehiculo.length > 60) return res.status(400).json({ error: 'Escribe su vehículo, por ejemplo «Moto»' })
  if (!/^[0-9A-Za-z-]{5,20}$/.test(cedula)) return res.status(400).json({ error: 'Escribe su cédula o pasaporte' })
  if (placa.length < 3 || placa.length > 12) return res.status(400).json({ error: 'Escribe la placa' })
  if (licencia && (licencia.length < 3 || licencia.length > 30)) return res.status(400).json({ error: 'La licencia no es válida' })
  try {
    const creado = await db.createCooperativeCourier(cooperativaDe(req).cooperativeId, {
      phone: telefono, name: nombre, vehicle: vehiculo, idNumber: cedula, plate: placa, licenseNumber: licencia,
    })
    return res.status(201).json({ id: creado.id, nombre: creado.name, telefono: creado.phone, activo: creado.active })
  } catch (error) {
    // El mismo texto sea de quien sea el número: no se dice de quién es.
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Ese teléfono ya está registrado como repartidor' })
    }
    throw error
  }
})

router.put('/api/cooperativa/repartidores/:id/activo', ...puerta, async (req, res) => {
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos ese repartidor' })
  const activo = (req.body as Record<string, unknown> | undefined)?.activo === true
  // El mismo 404 si no existe o es de otra flota: no se confirma qué ids hay.
  if (!await db.setCooperativeCourierActive(cooperativaDe(req).cooperativeId, id, activo)) {
    return res.status(404).json({ error: 'No encontramos ese repartidor' })
  }
  return res.json({ activo })
})

// ── Sus carreras ───────────────────────────────────────────────────────────

/** La semana EN CURSO de cada uno (lo que aún no se liquida), de la base. */
async function semanaEnCurso(cooperativeId: string) {
  const lista = await db.listCooperativeCouriers(cooperativeId)
  const semanas = await Promise.all(lista.map(m => db.getCourierBalance(m.id)))
  return lista.map((m, i) => {
    const s = semanas[i] || {}
    return {
      id: m.id,
      nombre: m.name,
      telefono: m.phone,
      pedidos: Number(s.pedidos) || 0,
      carrerasCents: Number(s.carrerasCents) || 0,
      retenidasCents: Number(s.retenidasCents) || 0,
      efectivoCobradoCents: Number(s.efectivoCobradoCents) || 0,
      efectivoEncimaCents: Number(s.efectivoEncimaCents) || 0,
    }
  })
}

/** Una semana ya CERRADA: la liquidación de cada uno, tal como la hizo la base. */
async function semanaCerrada(cooperativeId: string, semana: string) {
  const filas = await db.cooperativeWeek(cooperativeId, semana)
  return filas.map(f => ({
    id: f.courier_id,
    nombre: f.couriers?.name ?? '',
    telefono: f.couriers?.phone ?? '',
    desde: f.period_start,
    hasta: f.period_end,
    pedidos: f.orders_count,
    carrerasCents: f.derecho_cents,
    efectivoCobradoCents: f.en_mano_cents,
    arrastreCents: f.arrastre_cents,
    // > 0: Umbani le paga · < 0: él entrega ese efectivo.
    saldoCents: f.neto_cents,
    estado: f.status,
    pagadaEl: f.paid_at,
  }))
}

router.get('/api/cooperativa/carreras', ...puerta, async (req, res) => {
  const cooperativeId = cooperativaDe(req).cooperativeId
  const [semanas, enCurso] = await Promise.all([db.cooperativeWeeks(cooperativeId), semanaEnCurso(cooperativeId)])
  return res.json({ semanas, enCurso })
})

router.get('/api/cooperativa/carreras/semana/:semana', ...puerta, async (req, res) => {
  const semana = String(req.params.semana || '')
  if (!SEMANA.test(semana)) return res.status(400).json({ error: 'Semana no válida' })
  return res.json({ semana, filas: await semanaCerrada(cooperativaDe(req).cooperativeId, semana) })
})

// ── Descargar para Excel ───────────────────────────────────────────────────
// Como la exportación del panel del local: «;» y la marca BOM para que Excel
// en español respete las tildes. Los importes con coma decimal («12,50»): así
// Excel en español los lee como NÚMEROS y la cooperativa puede sumarlos.

const dolares = (centavos: number) => (centavos / 100).toFixed(2).replace('.', ',')
const csv = (filas: (string | number)[][]) => `﻿${filas
  .map(fila => fila.map(celda => `"${String(celda ?? '').replace(/"/g, '""')}"`).join(';'))
  .join('\n')}`

const ESTADO: Record<string, string> = {
  por_pagar: 'Umbani le paga', pagada: 'Pagada', por_cobrar: 'Debe entregarlo', cobrada: 'Entregado',
  en_cero: 'En cero', compensada: 'Pasó a la semana siguiente',
}

const descargar = (res: Response, nombre: string, contenido: string) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`)
  return res.send(contenido)
}

router.get('/api/cooperativa/carreras.csv', ...puerta, async (req, res) => {
  const cooperativeId = cooperativaDe(req).cooperativeId
  const semana = String(req.query.semana || 'en-curso')
  if (semana === 'en-curso') {
    const filas = await semanaEnCurso(cooperativeId)
    return descargar(res, 'carreras-semana-en-curso.csv', csv([
      ['Repartidor', 'WhatsApp', 'Pedidos', 'Carreras', 'Carreras retenidas', 'Efectivo cobrado', 'Efectivo encima'],
      ...filas.map(f => [f.nombre, f.telefono, f.pedidos, dolares(f.carrerasCents), dolares(f.retenidasCents),
        dolares(f.efectivoCobradoCents), dolares(f.efectivoEncimaCents)]),
    ]))
  }
  if (!SEMANA.test(semana)) return res.status(400).json({ error: 'Semana no válida' })
  const filas = await semanaCerrada(cooperativeId, semana)
  return descargar(res, `carreras-${semana}.csv`, csv([
    ['Semana', 'Repartidor', 'WhatsApp', 'Pedidos', 'Carreras', 'Efectivo cobrado', 'Saldo (+ Umbani le paga, - debe)', 'Estado'],
    ...filas.map(f => [`${f.desde} a ${f.hasta}`, f.nombre, f.telefono, f.pedidos, dolares(f.carrerasCents),
      dolares(f.efectivoCobradoCents), dolares(f.saldoCents), ESTADO[f.estado] ?? f.estado]),
  ]))
})

// ── Sus problemas ──────────────────────────────────────────────────────────
// Las carreras retenidas (se le cayó la comida) y, desde el 2026-10-06, las
// incidencias de los pedidos que llevaban sus motorizados: qué pasó y quién
// respondió. ⚠️ Sin datos del cliente: ni su nombre, ni su nota.

router.get('/api/cooperativa/problemas', ...puerta, async (req, res) => {
  const cooperativeId = cooperativaDe(req).cooperativeId
  const [retenidas, lista] = await Promise.all([
    db.cooperativeRetainedRuns(cooperativeId),
    db.listCooperativeCouriers(cooperativeId),
  ])
  const nombreDe = new Map(lista.map(m => [m.id, m.name]))
  const incidencias = await db.cooperativeIncidents(lista.map(m => m.id))
  return res.json({
    incidencias: incidencias.map(i => ({
      pedido: i.orders?.order_number ?? null,
      local: i.businesses?.name ?? null,
      fecha: i.created_at,
      repartidor: nombreDe.get(String(i.courier_id)) ?? '',
      tipo: i.kind,
      estado: i.status,
      responsable: i.responsible,
    })),
    retenidas: retenidas.map(r => ({
      pedido: r.orders?.order_number ?? null,
      local: r.businesses?.name ?? null,
      fecha: r.sold_at,
      repartidor: nombreDe.get(String(r.courier_id)) ?? '',
      carreraCents: r.reparto_cents,
      motivo: r.retenido_motivo,
      // Ya liquidada: salió de su pago de esa semana.
      liquidada: r.courier_settlement_id != null,
    })),
  })
})

export = router
