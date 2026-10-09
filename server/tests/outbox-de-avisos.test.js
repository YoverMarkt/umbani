import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { crearWorkerDeAvisos } from '../dist/services/outbox-worker.js'

// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO QUE FALLA SE REINTENTA
//
// Hoy el aviso se RECLAMA antes de enviarse. El reclamo es atómico y existe
// para que dos toques no manden —ni cobren— dos mensajes. La consecuencia que
// no se veía: si el envío falla, el reclamo ya se consumió y ese aviso no sale
// nunca más.
//
// Cada mensaje cuesta dinero desde el 1 de octubre, así que lo que más se
// vigila aquí es lo contrario del reintento: que NUNCA se mande dos veces.
// ═══════════════════════════════════════════════════════════════════════════

const SQL = readFileSync(
  fileURLToPath(new URL('../migration-2026-08-21-outbox-de-avisos.sql', import.meta.url)),
  'utf8',
)
// ⚠️ El aviso vivía dentro de `routes/orders.routes.ts` y se movió a su
// propio servicio el 2026-08-28, sin tocar su cuerpo: ahora también lo usa el
// barrido que expira los pedidos sin pagar, y duplicarlo daría dos sitios
// donde arreglar cada fallo de lo que se paga. Estas comprobaciones siguen
// vigilando exactamente lo mismo, solo que en su archivo nuevo.
const RUTA = readFileSync(
  fileURLToPath(new URL('../src/services/order-status-notice.ts', import.meta.url)),
  'utf8',
)

// ⚠️ Este archivo prueba el aviso DORMIDO: desde el 2026-10-09 no se le
// escribe al cliente por WhatsApp (`config/avisos-al-cliente.ts`), pero el
// código sigue entero para el día que se vuelva a encender. Aquí se enciende;
// que por defecto esté APAGADO lo vigila `avisos-al-cliente.test.js`.
let antes
beforeAll(() => {
  antes = process.env.AVISOS_WHATSAPP_AL_CLIENTE
  process.env.AVISOS_WHATSAPP_AL_CLIENTE = 'si'
})
afterAll(() => {
  if (antes === undefined) delete process.env.AVISOS_WHATSAPP_AL_CLIENTE
  else process.env.AVISOS_WHATSAPP_AL_CLIENTE = antes
})

const evento = (extra = {}) => ({
  id: 'ev-1', business_id: 'biz-1', aggregate_id: 'ord-1',
  payload: { status: 'preparacion' }, lease_token: 'tok-1', ...extra,
})

const deps = (over = {}) => ({
  lease: vi.fn().mockResolvedValue([evento()]),
  complete: vi.fn().mockResolvedValue(true),
  fail: vi.fn().mockResolvedValue('reintentar'),
  pedido: vi.fn().mockResolvedValue({ id: 'ord-1', contact_phone: '+593999000001' }),
  negocio: vi.fn().mockResolvedValue({ id: 'biz-1', name: 'Local' }),
  enviar: vi.fn().mockResolvedValue(true),
  registrar: vi.fn(),
  ...over,
})

describe('el worker de avisos', () => {
  it('envía lo que quedó pendiente y lo cierra', async () => {
    const d = deps()
    expect(await crearWorkerDeAvisos(d)()).toEqual({ enviados: 1, fallidos: 0, muertos: 0, apagados: 0 })
    expect(d.enviar).toHaveBeenCalledOnce()
    expect(d.complete).toHaveBeenCalledWith('ev-1', 'tok-1')
    expect(d.fail).not.toHaveBeenCalled()
  })

  it('si vuelve a fallar, lo devuelve a la cola en vez de perderlo', async () => {
    const d = deps({ enviar: vi.fn().mockResolvedValue(false) })
    expect(await crearWorkerDeAvisos(d)()).toEqual({ enviados: 0, fallidos: 1, muertos: 0, apagados: 0 })
    expect(d.complete).not.toHaveBeenCalled()
    expect(d.fail).toHaveBeenCalledOnce()
  })

  it('cuenta como muerto lo que ya no puede salir, sin gastar seis intentos', async () => {
    // Un pedido borrado no va a reaparecer: reintentarlo solo retrasa el resto
    // de la cola.
    const d = deps({ pedido: vi.fn().mockResolvedValue(null) })
    expect(await crearWorkerDeAvisos(d)()).toEqual({ enviados: 0, fallidos: 0, muertos: 1, apagados: 0 })
    expect(d.enviar).not.toHaveBeenCalled()
    expect(d.fail).toHaveBeenCalledOnce()
  })

  it('NO reclama nada: el reclamo se gastó cuando cambió el estado', async () => {
    // Volver a reclamar impediría el reintento, que es justo para lo que este
    // worker existe.
    const d = deps()
    await crearWorkerDeAvisos(d)()
    expect(d.pedido).toHaveBeenCalledWith('biz-1', 'ord-1')
    const fuente = readFileSync(
      fileURLToPath(new URL('../src/services/outbox-worker.ts', import.meta.url)), 'utf8',
    )
    expect(fuente).not.toMatch(/claimOrderNotification/)
  })

  it('un evento sin lease se salta: sin token no se puede cerrar ni fallar', async () => {
    const d = deps({ lease: vi.fn().mockResolvedValue([evento({ lease_token: null })]) })
    expect(await crearWorkerDeAvisos(d)()).toEqual({ enviados: 0, fallidos: 0, muertos: 0, apagados: 0 })
    expect(d.enviar).not.toHaveBeenCalled()
  })

  it('un fallo al enviar no tumba el resto de la tanda', async () => {
    const d = deps({
      lease: vi.fn().mockResolvedValue([evento(), evento({ id: 'ev-2', lease_token: 'tok-2' })]),
      enviar: vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(true),
    })
    const r = await crearWorkerDeAvisos(d)()
    expect(r.enviados).toBe(1)
    expect(r.fallidos).toBe(1)
    expect(d.registrar).toHaveBeenCalledOnce()
  })
})

describe('nunca se manda el mismo aviso dos veces', () => {
  it('el mismo hito solo se encola una vez, y lo impide la BASE', () => {
    expect(SQL).toContain('uq_outbox_hito')
    expect(SQL).toMatch(/aggregate_id, event_type, \(payload ->> 'status'\)/)
    expect(SQL).toContain('on conflict do nothing')
  })

  it('el evento nace con ventana de gracia', () => {
    // ⚠️ Sin ella el worker podría tomarlo mientras el envío inmediato está en
    // vuelo, y el cliente recibiría —y el negocio pagaría— dos mensajes.
    expect(SQL).toMatch(/p_espera_s\s+integer default 60/)
    expect(SQL).toMatch(/available_at.*make_interval/s)
  })

  it('la ruta encola ANTES de enviar y solo cierra si salió', () => {
    const cuerpo = RUTA.slice(RUTA.indexOf('const avisarAlCliente'))
    const encolar = cuerpo.indexOf('enqueueOutboxEvent')
    const enviar = cuerpo.indexOf('notificarCambioDePedido(negocio')
    const cerrar = cuerpo.indexOf('completeOutboxEvent')
    expect(encolar).toBeGreaterThan(0)
    expect(enviar, 'encolar va antes de enviar').toBeGreaterThan(encolar)
    expect(cerrar, 'cerrar va después de enviar').toBeGreaterThan(enviar)
    expect(cuerpo).toMatch(/if \(enviado && evento\)/)
  })

  it('encolar no puede impedir el aviso', () => {
    // Si la cola falla, el mensaje sale igual: el pedido ya está en la cocina.
    expect(RUTA).toMatch(/enqueueOutboxEvent\([\s\S]{0,260}?\}\)\.catch\(\(\) => null\)/)
  })
})

describe('la cola no se atasca sola', () => {
  it('dos workers no se pelean por el mismo evento', () => {
    expect(SQL).toContain('for update skip locked')
  })

  it('recupera lo que dejó tomado un worker que murió', () => {
    expect(SQL).toMatch(/status = 'processing' and e\.leased_until < now\(\)/)
  })

  it('la espera entre intentos crece, y tiene techo', () => {
    // Reintentar cada segundo contra un canal caído no lo arregla y sí gasta.
    expect(SQL).toMatch(/least\(3600, 60 \* power\(2/)
  })

  it('lo que no sale en varios intentos muere en vez de girar para siempre', () => {
    expect(SQL).toContain("status = 'dead'")
    expect(SQL).toMatch(/attempts >= v_fila\.max_attempts/)
  })

  it('la tabla lleva business_id y RLS, como toda tabla de negocio', () => {
    expect(SQL).toMatch(/business_id\s+uuid not null references public\.businesses\(id\) on delete cascade/)
    expect(SQL).toContain('alter table public.outbox_events enable row level security')
    expect(SQL).toMatch(/revoke all on table public\.outbox_events\s+from public, anon, authenticated, service_role/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO, EJECUTADO DE VERDAD
//
// Las comprobaciones de arriba LEEN el archivo: vigilan el orden (encolar
// antes de enviar) porque un refactor puede invertirlo sin romper nada. Estas
// lo EJECUTAN, que es lo único que responde «¿y hace lo que dice?».
//
// Importa desde el 2026-08-28: el aviso ya no lo dispara solo el botón del
// dueño, también el barrido que expira los pedidos sin pagar.
// ═══════════════════════════════════════════════════════════════════════════
describe('avisarAlCliente, ejecutado', () => {
  const req = createRequire(import.meta.url)
  const cargar = () => ({
    notice: req('../dist/services/order-status-notice.js'),
    db: req('../dist/db'),
    notify: req('../dist/services/order-notify.js'),
  })

  const PEDIDO = { id: 'ord-1', order_number: 7, status: 'expirado', total: 10 }

  afterEach(() => { vi.restoreAllMocks() })

  it('reclama, encola, envía y cierra el evento', async () => {
    const { notice, db, notify } = cargar()
    const reclamo = vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(PEDIDO)
    const encolar = vi.spyOn(db, 'enqueueOutboxEvent').mockResolvedValue('ev-1')
    const cerrar = vi.spyOn(db, 'completeOutboxEvent').mockResolvedValue(undefined)
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'biz-1', name: 'Local' })
    vi.spyOn(notify, 'notificarCambioDePedido').mockResolvedValue(true)

    await notice.avisarAlCliente('biz-1', 'ord-1', 'expirado')

    expect(reclamo).toHaveBeenCalledWith('biz-1', 'ord-1', 'expirado')
    expect(encolar).toHaveBeenCalled()
    expect(cerrar).toHaveBeenCalledWith('ev-1', null)
  })

  // Sin reclamo no hay aviso: es lo que impide que dos toques manden —y
  // cobren— dos mensajes.
  it('si el reclamo no es suyo, no manda nada', async () => {
    const { notice, db, notify } = cargar()
    vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(null)
    const encolar = vi.spyOn(db, 'enqueueOutboxEvent')
    const enviar = vi.spyOn(notify, 'notificarCambioDePedido')

    await notice.avisarAlCliente('biz-1', 'ord-1', 'expirado')

    expect(encolar).not.toHaveBeenCalled()
    expect(enviar).not.toHaveBeenCalled()
  })

  // El evento se queda en la cola para que el worker lo reintente: el reclamo
  // ya se gastó, así que sin cola ese aviso no saldría nunca más.
  it('si el envío falla, el evento NO se cierra', async () => {
    const { notice, db, notify } = cargar()
    vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(PEDIDO)
    vi.spyOn(db, 'enqueueOutboxEvent').mockResolvedValue('ev-1')
    const cerrar = vi.spyOn(db, 'completeOutboxEvent').mockResolvedValue(undefined)
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'biz-1', name: 'Local' })
    vi.spyOn(notify, 'notificarCambioDePedido').mockResolvedValue(false)

    await notice.avisarAlCliente('biz-1', 'ord-1', 'expirado')
    expect(cerrar).not.toHaveBeenCalled()
  })

  // Encolar no puede impedir el aviso: si la cola falla, se envía igual.
  it('con la cola caída se envía de todos modos', async () => {
    const { notice, db, notify } = cargar()
    vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(PEDIDO)
    vi.spyOn(db, 'enqueueOutboxEvent').mockRejectedValue(new Error('cola caída'))
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'biz-1', name: 'Local' })
    const enviar = vi.spyOn(notify, 'notificarCambioDePedido').mockResolvedValue(true)

    await notice.avisarAlCliente('biz-1', 'ord-1', 'expirado')
    expect(enviar).toHaveBeenCalled()
  })

  // Nunca lanza: sale sin await desde la ruta y desde el barrido, así que una
  // excepción aquí sería un rechazo sin capturar en el proceso.
  it('nunca lanza, pase lo que pase', async () => {
    const { notice, db } = cargar()
    vi.spyOn(db, 'claimOrderNotification').mockRejectedValue(new Error('base caída'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(notice.avisarAlCliente('biz-1', 'ord-1', 'expirado')).resolves.toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL WORKER REAL ESTÁ ENCHUFADO, NO SOLO CONSTRUIDO
// ═══════════════════════════════════════════════════════════════════════════
//
// Añadido el 2026-09-16. Todo lo de arriba prueba `crearWorkerDeAvisos` con
// dobles: la LÓGICA de reintentar, matar y contar. Ninguna de esas pruebas
// toca la instancia que corre de verdad (`procesarAvisosPendientes`), que es
// la que ata cada dependencia a su función de `db`.
//
// ⚠️ Esa es exactamente la clase de hueco que este proyecto ya pagó siete
// veces: lógica correcta, probada y en verde, conectada a nada. Aquí el precio
// sería que «tu pedido está en camino» dejara de salir sin que fallara nada.

describe('el worker que corre de verdad', () => {
  const pide = createRequire(import.meta.url)
  const cargar = () => ({
    db: pide('../dist/db'),
    notify: pide('../dist/services/order-notify.js'),
    worker: pide('../dist/services/outbox-worker.js'),
  })
  const PEDIDO = { id: 'ord-1', order_number: 7, status: 'en_camino', total: 10 }

  afterEach(() => { vi.restoreAllMocks() })

  it('cada dependencia llama a la función de `db` que le toca', async () => {
    const { db, notify, worker } = cargar()

    const lease = vi.spyOn(db, 'leaseOutboxEvents').mockResolvedValue([{
      id: 'ev-1', lease_token: 'tok', business_id: 'biz-1',
      aggregate_id: 'ord-1', payload: { status: 'en_camino' },
    }])
    const pedido = vi.spyOn(db, 'getOrderForNotice').mockResolvedValue(PEDIDO)
    const negocio = vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'biz-1', name: 'Local' })
    const enviar = vi.spyOn(notify, 'notificarCambioDePedido').mockResolvedValue(true)
    const completar = vi.spyOn(db, 'completeOutboxEvent').mockResolvedValue(undefined)

    const resultado = await worker.procesarAvisosPendientes('prueba', 5, 30)

    // El lease se pide con lo que recibió, no con valores inventados.
    expect(lease).toHaveBeenCalledWith('prueba', 5, 30)
    // Y las dos lecturas van SIEMPRE con el negocio del evento: un aviso que
    // leyera el pedido de otro local lo contaría en la conversación ajena.
    expect(pedido).toHaveBeenCalledWith('biz-1', 'ord-1')
    expect(negocio).toHaveBeenCalledWith('biz-1')
    expect(enviar).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'biz-1' }), PEDIDO, 'en_camino',
    )
    expect(completar).toHaveBeenCalledWith('ev-1', 'tok')
    expect(resultado).toEqual({ enviados: 1, fallidos: 0, muertos: 0, apagados: 0 })
  })

  it('si el envío falla, marca el fallo con el motivo y NO lo da por enviado', async () => {
    const { db, notify, worker } = cargar()

    vi.spyOn(db, 'leaseOutboxEvents').mockResolvedValue([{
      id: 'ev-2', lease_token: 'tok2', business_id: 'biz-1',
      aggregate_id: 'ord-1', payload: { status: 'en_camino' },
    }])
    vi.spyOn(db, 'getOrderForNotice').mockResolvedValue(PEDIDO)
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'biz-1', name: 'Local' })
    vi.spyOn(notify, 'notificarCambioDePedido').mockResolvedValue(false)
    const fallar = vi.spyOn(db, 'failOutboxEvent').mockResolvedValue('reintentar')
    const completar = vi.spyOn(db, 'completeOutboxEvent')

    const resultado = await worker.procesarAvisosPendientes()

    expect(fallar).toHaveBeenCalledWith('ev-2', 'tok2', expect.stringContaining('en_camino'))
    expect(completar).not.toHaveBeenCalled()
    expect(resultado.fallidos).toBe(1)
  })

  it('un pedido que ya no existe se mata, no se reintenta seis veces', async () => {
    const { db, worker } = cargar()

    vi.spyOn(db, 'leaseOutboxEvents').mockResolvedValue([{
      id: 'ev-3', lease_token: 'tok3', business_id: 'biz-1',
      aggregate_id: 'ord-borrado', payload: { status: 'entregado' },
    }])
    vi.spyOn(db, 'getOrderForNotice').mockResolvedValue(null)
    const fallar = vi.spyOn(db, 'failOutboxEvent').mockResolvedValue('muerto')

    const resultado = await worker.procesarAvisosPendientes()

    expect(fallar).toHaveBeenCalledWith('ev-3', 'tok3', expect.stringContaining('ya no existen'))
    expect(resultado).toEqual({ enviados: 0, fallidos: 0, muertos: 1, apagados: 0 })
  })
})
