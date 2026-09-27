import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  CORTE_QUE_SE_REGISTRA_MS,
  WEBHOOK_INBOX_ERROR_MAX_LENGTH,
  createWebhookInboxWorker,
  fallaQueSeRegistra,
  sanitizeWebhookInboxError,
} = require('../dist/services/webhook-inbox-worker')
const serverDir = fileURLToPath(new URL('..', import.meta.url))
const workerSource = readFileSync(
  `${serverDir}/src/services/webhook-inbox-worker.ts`,
  'utf8',
)

const ok = data => ({ data, error: null })

function lease(index, provider = 'meta') {
  return {
    id: `event-${index}`,
    business_id: 'business-a',
    provider,
    payload: { index },
    lease_token: `lease-${index}`,
    attempts: 1,
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function repository(overrides = {}) {
  return {
    leaseWebhookEvents: vi.fn(async () => ok([])),
    renewWebhookEventLease: vi.fn(async () => ok(true)),
    completeWebhookEvent: vi.fn(async () => ok(true)),
    failWebhookEvent: vi.fn(async () => ok('pending')),
    ...overrides,
  }
}

function manualScheduler() {
  let sequence = 0
  const jobs = new Map()
  return {
    scheduler: {
      setTimeout(callback, delay) {
        sequence += 1
        jobs.set(sequence, { callback, delay })
        return sequence
      },
      clearTimeout(handle) {
        jobs.delete(handle)
      },
    },
    runByDelay(delay) {
      const entry = [...jobs.entries()].find(([, job]) => job.delay === delay)
      if (!entry) throw new Error(`No existe un timer de ${delay} ms`)
      const [handle, job] = entry
      jobs.delete(handle)
      job.callback()
    },
    countByDelay(delay) {
      return [...jobs.values()].filter(job => job.delay === delay).length
    },
    size() {
      return jobs.size
    },
  }
}

/**
 * Dispara un temporizador en cuanto exista, sin depender del orden de las
 * microtareas: los reintentos se programan dentro de una cadena de promesas.
 */
const correrCuandoExista = async (scheduler, runByDelay, countByDelay, delay) => {
  for (let intento = 0; intento < 60; intento += 1) {
    if (countByDelay(delay) > 0) { runByDelay(delay); return }
    await Promise.resolve()
    await new Promise(seguir => process.nextTick(seguir))
  }
  throw new Error(`El temporizador de ${delay} ms nunca se programó`)
}

describe('worker del inbox durable de webhooks', () => {
  it('no reserva más leases que su concurrencia y completa cada fila', async () => {
    const gate = deferred()
    const rows = Array.from({ length: 5 }, (_, index) => lease(index))
    const repo = repository({
      leaseWebhookEvents: vi.fn(async (_workerId, limit) => ok(rows.slice(0, limit))),
    })
    let active = 0
    let maximumActive = 0
    const worker = createWebhookInboxWorker({
      workerId: 'worker-concurrency',
      repository: repo,
      batchSize: 5,
      concurrency: 2,
      processEvent: vi.fn(async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await gate.promise
        active -= 1
      }),
    })

    const polling = worker.pollOnce()
    await vi.waitFor(() => expect(active).toBe(2))
    expect(worker.inFlightCount()).toBe(2)
    gate.resolve()

    await expect(polling).resolves.toBe(2)
    expect(maximumActive).toBe(2)
    expect(repo.leaseWebhookEvents)
      .toHaveBeenCalledWith('worker-concurrency', 2, 180)
    expect(repo.completeWebhookEvent).toHaveBeenCalledTimes(2)
    expect(repo.failWebhookEvent).not.toHaveBeenCalled()
    expect(worker.inFlightCount()).toBe(0)
  })

  it('reutiliza el mismo poll activo y nunca reserva dos lotes superpuestos', async () => {
    const reservation = deferred()
    const repo = repository({ leaseWebhookEvents: vi.fn(() => reservation.promise) })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-single-poll',
      repository: repo,
      processEvent: async () => {},
    })

    const first = worker.pollOnce()
    const second = worker.pollOnce()

    expect(second).toBe(first)
    expect(repo.leaseWebhookEvents).toHaveBeenCalledTimes(1)
    reservation.resolve(ok([]))
    await expect(first).resolves.toBe(0)
  })

  it('registra fallos sanitizados y truncados sin completar el evento', async () => {
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1, 'ycloud')])),
    })
    const reports = []
    const jwt = `${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`
    const secret = 'super-secret-value'
    const worker = createWebhookInboxWorker({
      workerId: 'worker-failure',
      repository: repo,
      baseDelaySeconds: 20,
      processEvent: async () => {
        throw new Error(`token=${secret}\nBearer abc.def.ghi ${jwt} ${'x'.repeat(3_000)}`)
      },
      onError(error, context) {
        reports.push({ message: error.message, context })
      },
    })

    await expect(worker.pollOnce()).resolves.toBe(1)

    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()
    expect(repo.failWebhookEvent).toHaveBeenCalledTimes(1)
    const [eventId, leaseToken, safeError, baseDelay] = (
      repo.failWebhookEvent.mock.calls[0]
    )
    expect([eventId, leaseToken, baseDelay]).toEqual(['event-1', 'lease-1', 20])
    expect(safeError.length).toBeLessThanOrEqual(WEBHOOK_INBOX_ERROR_MAX_LENGTH)
    expect(safeError).not.toContain(secret)
    expect(safeError).not.toContain(jwt)
    expect(safeError).not.toContain('\n')
    expect(reports.some(report => report.context.phase === 'process')).toBe(true)
  })

  it('trata fail=stale como lease perdido sin intentar ningún ACK adicional', async () => {
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(7)])),
      failWebhookEvent: vi.fn(async () => ok('stale')),
    })
    const reports = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-stale-failure',
      repository: repo,
      processEvent: async () => {
        throw new Error('fallo esperado')
      },
      onError(error, context) {
        reports.push({ error, context })
      },
    })

    await expect(worker.pollOnce()).resolves.toBe(1)

    expect(repo.failWebhookEvent).toHaveBeenCalledTimes(1)
    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()
    expect(reports.some(report => report.context.phase === 'fail')).toBe(true)
  })

  it('emite una señal explícita cuando un evento llega a dead-letter', async () => {
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(8)])),
      failWebhookEvent: vi.fn(async () => ok('dead')),
    })
    const reports = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-dead-letter',
      repository: repo,
      processEvent: async () => { throw new Error('proveedor no disponible') },
      onError(error, context) {
        reports.push({ error, context })
      },
    })

    await expect(worker.pollOnce()).resolves.toBe(1)
    expect(reports).toEqual(expect.arrayContaining([
      expect.objectContaining({ context: expect.objectContaining({ phase: 'dead' }) }),
    ]))
  })

  it('renueva leases largos y no confirma si el fencing indica pérdida', async () => {
    const processing = deferred()
    const timers = manualScheduler()
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(2)])),
      renewWebhookEventLease: vi.fn(async () => ok(false)),
    })
    const reports = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-heartbeat',
      repository: repo,
      scheduler: timers.scheduler,
      heartbeatIntervalMilliseconds: 45_000,
      leaseSeconds: 180,
      processEvent: () => processing.promise,
      onError(error, context) {
        reports.push({ error, context })
      },
    })

    const polling = worker.pollOnce()
    await vi.waitFor(() => expect(timers.countByDelay(45_000)).toBe(1))
    timers.runByDelay(45_000)
    await vi.waitFor(() => expect(repo.renewWebhookEventLease).toHaveBeenCalledTimes(1))
    processing.resolve()
    await expect(polling).resolves.toBe(1)

    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()
    expect(repo.failWebhookEvent).not.toHaveBeenCalled()
    expect(reports.some(report => report.context.phase === 'renew')).toBe(true)
  })

  it('espera un heartbeat activo antes de completar con el mismo token', async () => {
    const processing = deferred()
    const renewal = deferred()
    const timers = manualScheduler()
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(3)])),
      renewWebhookEventLease: vi.fn(() => renewal.promise),
    })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-heartbeat-race',
      repository: repo,
      scheduler: timers.scheduler,
      heartbeatIntervalMilliseconds: 45_000,
      leaseSeconds: 180,
      processEvent: () => processing.promise,
    })

    const polling = worker.pollOnce()
    await vi.waitFor(() => expect(timers.countByDelay(45_000)).toBe(1))
    timers.runByDelay(45_000)
    await vi.waitFor(() => expect(repo.renewWebhookEventLease).toHaveBeenCalledTimes(1))
    processing.resolve()
    await Promise.resolve()
    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()

    renewal.resolve(ok(true))
    await expect(polling).resolves.toBe(1)
    expect(repo.completeWebhookEvent).toHaveBeenCalledWith('event-3', 'lease-3')
  })

  it('start es idempotente y stop cancela nuevos polls mientras drena el activo', async () => {
    const reservation = deferred()
    const timers = manualScheduler()
    const repo = repository({ leaseWebhookEvents: vi.fn(() => reservation.promise) })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-lifecycle',
      repository: repo,
      scheduler: timers.scheduler,
      processEvent: async () => {},
    })

    worker.start()
    worker.start()
    expect(worker.isRunning()).toBe(true)
    expect(timers.countByDelay(0)).toBe(1)
    timers.runByDelay(0)
    await vi.waitFor(() => expect(repo.leaseWebhookEvents).toHaveBeenCalledTimes(1))

    let stopped = false
    const stopping = worker.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(worker.isRunning()).toBe(false)

    reservation.resolve(ok([]))
    await stopping
    expect(stopped).toBe(true)
    expect(timers.size()).toBe(0)
    expect(repo.leaseWebhookEvents).toHaveBeenCalledTimes(1)
  })

  it('propaga errores del lease al poll manual y los reporta en el ciclo automático', async () => {
    const timers = manualScheduler()
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ({
        data: null,
        error: { message: 'PostgreSQL no disponible' },
      })),
    })
    const reports = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-rpc-error',
      repository: repo,
      scheduler: timers.scheduler,
      processEvent: async () => {},
      onError(error, context) {
        reports.push({ error, context })
      },
    })

    await expect(worker.pollOnce()).rejects.toThrow('PostgreSQL no disponible')
    worker.start()
    timers.runByDelay(0)
    await vi.waitFor(() => expect(reports.some(
      report => report.context.phase === 'poll',
    )).toBe(true))
    await worker.stop()
  })

  // ── Un sondeo suelto no es un corte (2026-09-27) ────────────────────────
  //
  // Cada sondeo fallido iba al registro, y el vigía avisa de cualquier entrada
  // de las últimas 24 h: 11 «fetch failed» de un segundo en un mes —todos
  // recuperados en el sondeo siguiente— le costaron al dueño días de correos.
  it('mide cuánto lleva la base sin contestar al fallar el sondeo', async () => {
    const timers = manualScheduler()
    let reloj = 10_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => reloj)
    let falla = false
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => (falla
        ? { data: null, error: { message: 'TypeError: fetch failed' } }
        : ok([]))),
    })
    const reports = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-silencio',
      repository: repo,
      scheduler: timers.scheduler,
      processEvent: async () => {},
      onError(error, context) { reports.push(context) },
    })

    worker.start()
    timers.runByDelay(0) // la base contesta a los 10 s
    // Que termine esa vuelta —deja programada la siguiente— antes de mover nada.
    await vi.waitFor(() => expect(timers.countByDelay(1_000)).toBe(1))
    falla = true
    reloj = 11_000
    // La vuelta siguiente ya falla: un segundo después de la última respuesta.
    await correrCuandoExista(timers.scheduler, timers.runByDelay, timers.countByDelay, 1_000)
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports[0]).toMatchObject({ phase: 'poll', silencioDeLaBaseMs: 1_000 })

    reloj = 75_000
    await correrCuandoExista(timers.scheduler, timers.runByDelay, timers.countByDelay, 1_000)
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    expect(reports[1].silencioDeLaBaseMs).toBe(65_000)

    now.mockRestore()
    await worker.stop()
  })

  it('solo el corte que DURA va al registro; lo demás, siempre', () => {
    // Un segundo: ruido. Un minuto sin base: los clientes ya esperan.
    expect(fallaQueSeRegistra({ phase: 'poll', silencioDeLaBaseMs: 1_000 })).toBe(false)
    expect(fallaQueSeRegistra({ phase: 'poll', silencioDeLaBaseMs: 31_000 })).toBe(false)
    expect(fallaQueSeRegistra({ phase: 'poll', silencioDeLaBaseMs: CORTE_QUE_SE_REGISTRA_MS })).toBe(true)
    // Sin medida no se adivina: se registra, como antes.
    expect(fallaQueSeRegistra({ phase: 'poll' })).toBe(true)
    // Un mensaje concreto que no se pudo procesar o cerrar nunca es ruido.
    expect(fallaQueSeRegistra({ phase: 'process', silencioDeLaBaseMs: 0 })).toBe(true)
    expect(fallaQueSeRegistra({ phase: 'complete' })).toBe(true)
  })

  it('el arranque decide con esa regla ANTES de registrar', () => {
    // Construido y desconectado es el fallo que más se repite aquí: la regla
    // no sirve de nada si `index.ts` registra sin preguntarle.
    const indice = readFileSync(`${serverDir}/src/index.ts`, 'utf8')
    const alFallar = indice.slice(indice.indexOf('onError: (error, context) =>'))
    expect(alFallar.indexOf('if (!fallaQueSeRegistra(context)) return')).toBeGreaterThan(-1)
    expect(alFallar.indexOf('if (!fallaQueSeRegistra(context)) return'))
      .toBeLessThan(alFallar.indexOf('recordError('))
  })

  it('solo queda ready tras una operación SQL reciente y válida', async () => {
    const timers = manualScheduler()
    const repo = repository()
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const worker = createWebhookInboxWorker({
      workerId: 'worker-readiness',
      repository: repo,
      scheduler: timers.scheduler,
      readinessTimeoutMilliseconds: 1_000,
      processEvent: async () => {},
    })

    expect(worker.isReady()).toBe(false)
    expect(worker.lastSuccessfulDatabaseOperationAt()).toBeNull()
    worker.start()
    expect(worker.isReady()).toBe(false)
    timers.runByDelay(0)
    await vi.waitFor(() => expect(repo.leaseWebhookEvents).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(worker.isReady()).toBe(true))
    expect(worker.lastSuccessfulDatabaseOperationAt()).toBe(10_000)

    now.mockReturnValue(11_001)
    expect(worker.isReady()).toBe(false)
    await worker.stop()
    now.mockRestore()
  })

  it('rechaza opciones y leases inválidos antes de procesar', async () => {
    expect(() => createWebhookInboxWorker({
      workerId: '',
      processEvent: async () => {},
    })).toThrow('workerId')
    expect(() => createWebhookInboxWorker({
      workerId: 'w'.repeat(129),
      processEvent: async () => {},
    })).toThrow('entre 1 y 128')
    expect(() => createWebhookInboxWorker({
      workerId: 'worker-invalid-heartbeat',
      leaseSeconds: 30,
      heartbeatIntervalMilliseconds: 30_000,
      processEvent: async () => {},
    })).toThrow('heartbeatIntervalMilliseconds')

    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([{ id: 'incompleto' }])),
    })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-invalid-row',
      repository: repo,
      processEvent: async () => {},
    })
    await expect(worker.pollOnce()).rejects.toThrow('filas inválidas')

    const oversizedRepo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1), lease(2)])),
    })
    const oversizedWorker = createWebhookInboxWorker({
      workerId: 'worker-too-many-rows',
      repository: oversizedRepo,
      batchSize: 5,
      concurrency: 1,
      processEvent: async () => {},
    })
    await expect(oversizedWorker.pollOnce()).rejects.toThrow('filas inválidas')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // EL MENSAJE SIN LOCAL: EL MARKETPLACE SE QUEDÓ MUDO POR ESTO
  // ═══════════════════════════════════════════════════════════════════════
  //
  // ⚠️ Fallo REAL del 2026-08-23, y en producción. Un mensaje al número de la
  // plataforma llega con `business_id` NULO —el número no es de ningún local—.
  // `isLease` exigía `typeof business_id === 'string'`, así que lo daba por
  // fila inválida y `executePoll` lanzaba antes de procesar nada.
  //
  // Lo peor era el SÍNTOMA, porque no parecía un error: el evento se quedaba
  // en `processing` con el lease tomado, sin `last_error` en su fila, sin
  // aparecer en `in_flight`, y con los intentos subiendo cada vez que vencía
  // el lease. El cliente escribía al número y no recibía absolutamente nada.
  //
  // ⚠️ La migración del canal de plataforma arregló este MISMO fallo en SQL
  // —índices parciales, `is not distinct from` en el FIFO, el disparador de
  // consumo— y este guardián de TypeScript se quedó atrás. Dos NULL no son
  // iguales en SQL; `null` no es `string` en TypeScript.
  it('acepta un lease SIN local: es el mensaje al número de la plataforma', async () => {
    const sinLocal = { ...lease(1, 'ycloud'), business_id: null }
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([sinLocal])),
    })
    const procesados = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-sin-local',
      repository: repo,
      processEvent: async event => { procesados.push(event.business_id) },
    })

    await expect(worker.pollOnce()).resolves.toBe(1)
    // Se procesa, y llega con el nulo intacto: aguas abajo eso significa
    // «todavía no hay local elegido», no «falta un dato».
    expect(procesados).toEqual([null])
    expect(repo.completeWebhookEvent).toHaveBeenCalledOnce()
  })

  // ⚠️ La consecuencia que multiplicaba el daño: `leased.every(isLease)` tira
  // el LOTE ENTERO. Un solo mensaje al número de la plataforma dejaba sin
  // procesar también los de los negocios con número propio que vinieran con
  // él — un fallo del marketplace se llevaba por delante a todos los demás.
  it('y no arrastra a los mensajes de los negocios que vengan en el mismo lote', async () => {
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([
        { ...lease(1, 'ycloud'), business_id: null },
        lease(2, 'ycloud'),
      ])),
    })
    const procesados = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-lote-mixto',
      repository: repo,
      concurrency: 2,
      processEvent: async event => { procesados.push(event.business_id) },
    })

    await expect(worker.pollOnce()).resolves.toBe(2)
    // Sin depender del orden: lo que importa es que se procesen LOS DOS.
    expect(procesados).toHaveLength(2)
    expect(procesados).toContain(null)
    expect(procesados).toContain('business-a')
  })

  // Y lo que SÍ tiene que seguir rechazando: una fila a la que le falta el
  // identificador no es un mensaje de plataforma, es una fila rota.
  it('pero una fila sin id sigue siendo inválida', async () => {
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([
        { ...lease(1, 'ycloud'), id: undefined, business_id: null },
      ])),
    })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-fila-rota',
      repository: repo,
      processEvent: async () => {},
    })
    await expect(worker.pollOnce()).rejects.toThrow('filas inválidas')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // UN MANEJADOR QUE NO VUELVE
  // ═══════════════════════════════════════════════════════════════════════
  //
  // ⚠️ Incidente REAL del 2026-08-23. Un evento se quedaba en `processing` sin
  // volver jamás: el lease vencía, se reservaba otra vez, se colgaba otra
  // vez… y como el fallo nunca llegaba a ocurrir, la fila **no guardaba ningún
  // error**, el evento no aparecía en `in_flight`, y `/api/health` seguía en
  // verde. Ocho intentos después moría con «lease vencido», que dice cuándo se
  // rindió pero no QUÉ pasó.
  //
  // Y como la cola es FIFO por conversación, ese evento bloqueaba TODOS los
  // mensajes siguientes de ese cliente.
  it('da por fallido al manejador que se cuelga, en vez de esperarlo para siempre', async () => {
    const nuncaVuelve = new Promise(() => {})
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1, 'ycloud')])),
    })
    const { scheduler, runByDelay } = manualScheduler()
    const worker = createWebhookInboxWorker({
      workerId: 'worker-colgado',
      repository: repo,
      scheduler,
      leaseSeconds: 30,
      heartbeatIntervalMilliseconds: 5_000,
      processTimeoutMilliseconds: 1_000,
      processEvent: () => nuncaVuelve,
    })

    const poll = worker.pollOnce()
    // Se dispara el temporizador del límite, que es el único de 1.000 ms.
    await Promise.resolve()
    runByDelay(1_000)
    await poll

    // Se registra el FALLO —con su motivo— en vez de completarlo o de
    // quedarse esperando. A partir de ahí, backoff y dead-letter normales.
    expect(repo.failWebhookEvent).toHaveBeenCalledOnce()
    expect(repo.failWebhookEvent.mock.calls[0][2]).toMatch(/no respondió en 1000 ms/)
    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()
  })

  it('y el manejador que sí responde no deja temporizadores vivos', async () => {
    // Sin limpiar el timer, cada evento rápido dejaría uno colgando y el
    // proceso no podría cerrarse limpio.
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1, 'ycloud')])),
    })
    const { scheduler, size } = manualScheduler()
    const worker = createWebhookInboxWorker({
      workerId: 'worker-rapido',
      repository: repo,
      scheduler,
      leaseSeconds: 30,
      heartbeatIntervalMilliseconds: 5_000,
      // Tiene que caber DENTRO del lease: la validación lo exige, para poder
      // registrar el fallo con el token todavía válido.
      processTimeoutMilliseconds: 20_000,
      processEvent: async () => {},
    })

    await worker.pollOnce()
    expect(repo.completeWebhookEvent).toHaveBeenCalledOnce()
    expect(repo.failWebhookEvent).not.toHaveBeenCalled()
    // Ni un temporizador vivo: ni el del límite ni el del heartbeat.
    expect(size()).toBe(0)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // UN FALLO PASAJERO AL RECONOCER NO PUEDE COSTAR EL EVENTO
  // ═══════════════════════════════════════════════════════════════════════
  //
  // ⚠️ Incidente REAL del 2026-08-23, y el que dejó al marketplace sin
  // entregar el enlace de la mini app. El mensaje se procesaba bien —el
  // cliente recibía su respuesta— pero CERRAR el evento fallaba con «upstream
  // request timeout». Un solo fallo pasajero costaba carísimo:
  //
  //   · el evento se quedaba en `processing` hasta que venciera el lease
  //   · la cola es FIFO por conversación, así que TODOS los mensajes
  //     siguientes de ese cliente se quedaban esperando
  //   · y al reintentarlo se REPROCESABA: el cliente recibía la misma
  //     respuesta cada tres minutos
  //
  // Medido: la función tarda ~180 ms por conexión directa. 37 s no es la
  // función siendo lenta, es la capa de en medio teniendo un mal momento.
  it('reintenta completar si la primera llamada falla', async () => {
    const completeWebhookEvent = vi.fn()
      .mockRejectedValueOnce(new Error('upstream request timeout'))
      .mockResolvedValueOnce(ok(true))
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1, 'ycloud')])),
      completeWebhookEvent,
    })
    const { scheduler, runByDelay, countByDelay } = manualScheduler()
    const worker = createWebhookInboxWorker({
      workerId: 'worker-ack-reintento',
      repository: repo,
      scheduler,
      leaseSeconds: 30,
      heartbeatIntervalMilliseconds: 5_000,
      processEvent: async () => {},
    })

    const poll = worker.pollOnce()
    // La espera entre intentos: 500 ms el primero.
    await correrCuandoExista(scheduler, runByDelay, countByDelay, 500)
    await poll

    expect(completeWebhookEvent).toHaveBeenCalledTimes(2)
    // Y con el MISMO token: reintentar es seguro porque el fencing decide.
    expect(completeWebhookEvent.mock.calls[1]).toEqual(completeWebhookEvent.mock.calls[0])
  })

  it('reintenta también al registrar un fallo', async () => {
    // Perder el registro del fallo deja el evento igual de atascado que
    // perder el completado.
    const failWebhookEvent = vi.fn()
      .mockRejectedValueOnce(new Error('upstream request timeout'))
      .mockResolvedValueOnce(ok('pending'))
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1, 'ycloud')])),
      failWebhookEvent,
    })
    const { scheduler, runByDelay, countByDelay } = manualScheduler()
    const worker = createWebhookInboxWorker({
      workerId: 'worker-fail-reintento',
      repository: repo,
      scheduler,
      leaseSeconds: 30,
      heartbeatIntervalMilliseconds: 5_000,
      processEvent: async () => { throw new Error('el manejador falló') },
    })

    const poll = worker.pollOnce()
    await correrCuandoExista(scheduler, runByDelay, countByDelay, 500)
    await poll

    expect(failWebhookEvent).toHaveBeenCalledTimes(2)
  })

  // ⚠️ Lo que NO puede pasar: reintentar para siempre. El lease dura 180 s y
  // reintentar más allá sería trabajar sobre un evento que ya es de otro.
  it('se rinde tras tres intentos y lo REGISTRA', async () => {
    const completeWebhookEvent = vi.fn()
      .mockRejectedValue(new Error('upstream request timeout'))
    const errores = []
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1, 'ycloud')])),
      completeWebhookEvent,
    })
    const { scheduler, runByDelay, countByDelay } = manualScheduler()
    const worker = createWebhookInboxWorker({
      workerId: 'worker-ack-rendido',
      repository: repo,
      scheduler,
      leaseSeconds: 30,
      heartbeatIntervalMilliseconds: 5_000,
      processEvent: async () => {},
      onError: (error, contexto) => errores.push({ error, contexto }),
    })

    const poll = worker.pollOnce()
    await correrCuandoExista(scheduler, runByDelay, countByDelay, 500)
    await correrCuandoExista(scheduler, runByDelay, countByDelay, 1_000)
    await poll

    expect(completeWebhookEvent).toHaveBeenCalledTimes(3)
    expect(errores.some(e => e.contexto.phase === 'complete')).toBe(true)
  })

  // ⚠️ El `return` silencioso que escondió el fallo durante horas: el evento
  // se quedaba en `processing` sin `last_error`, sin salir en `in_flight` y
  // con `/api/health` en verde. No había NADA que mirar.
  it('perder el lease a mitad del proceso deja rastro, no silencio', async () => {
    const errores = []
    const puerta = deferred()
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1, 'ycloud')])),
      renewWebhookEventLease: vi.fn(async () => ok(false)),
    })
    const { scheduler, runByDelay, countByDelay } = manualScheduler()
    const worker = createWebhookInboxWorker({
      workerId: 'worker-lease-perdido',
      repository: repo,
      scheduler,
      leaseSeconds: 30,
      heartbeatIntervalMilliseconds: 5_000,
      processEvent: () => puerta.promise,
      onError: (error, contexto) => errores.push({ error, contexto }),
    })

    // El proceso tiene que durar lo suficiente para que lata el heartbeat:
    // es ahí donde se descubre que el lease ya no es nuestro.
    const poll = worker.pollOnce()
    await correrCuandoExista(scheduler, runByDelay, countByDelay, 5_000)
    puerta.resolve()
    await poll

    expect(errores.some(e => e.contexto.phase === 'lease-perdido')).toBe(true)
    // Y no se toca la fila: el lease ya es de otro worker.
    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()
    expect(repo.failWebhookEvent).not.toHaveBeenCalled()
  })

  it('sanitiza valores no Error y no usa unref en ningún timer', () => {
    expect(sanitizeWebhookInboxError({ token: 'should-not-be-read' }))
      .toBe('Error interno durante el procesamiento del webhook')
    expect(workerSource).not.toContain('.unref(')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NO ESPERAR AL SONDEO CUANDO HAY TRABAJO (2026-09-25)
// ═══════════════════════════════════════════════════════════════════════════
//
// Medido en producción: una ráfaga de 12 toques de un cliente esperó 50 s el
// último — cada toque pagaba su segundo de sondeo — y el mensaje de un cliente
// esperaba entero el lote del anterior aunque sobraran manos libres.
describe('el worker no hace esperar a nadie cuando hay trabajo', () => {
  it('atiende a otro cliente mientras el anterior sigue procesándose', async () => {
    const timers = manualScheduler()
    const primero = deferred()
    const lotes = [[lease(1)], [lease(2)]]
    const repo = repository({ leaseWebhookEvents: vi.fn(async () => ok(lotes.shift() ?? [])) })
    const terminados = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-sin-turnos',
      repository: repo,
      scheduler: timers.scheduler,
      processEvent: async (event) => {
        if (event.id === 'event-1') await primero.promise
        terminados.push(event.id)
      },
    })

    worker.start()
    timers.runByDelay(0)
    await vi.waitFor(() => expect(worker.inFlightCount()).toBe(1))
    // Trajo trabajo: vuelve a mirar YA, sin esperar a que el primero acabe.
    await vi.waitFor(() => expect(timers.countByDelay(0)).toBe(1))
    timers.runByDelay(0)

    await vi.waitFor(() => expect(terminados).toEqual(['event-2']))
    // Y solo reservó el hueco que quedaba libre (4 de concurrencia, 1 ocupado).
    expect(repo.leaseWebhookEvents).toHaveBeenLastCalledWith('worker-sin-turnos', 3, 180)

    primero.resolve()
    await vi.waitFor(() => expect(terminados).toEqual(['event-2', 'event-1']))
    await worker.stop()
  })

  it('al terminar un mensaje vuelve a mirar al instante: el siguiente del cliente espera a ese', async () => {
    const timers = manualScheduler()
    const puerta = deferred()
    const lotes = [[lease(1)]]
    const repo = repository({ leaseWebhookEvents: vi.fn(async () => ok(lotes.shift() ?? [])) })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-rafaga',
      repository: repo,
      scheduler: timers.scheduler,
      processEvent: () => puerta.promise,
    })

    worker.start()
    timers.runByDelay(0)
    await vi.waitFor(() => expect(timers.countByDelay(0)).toBe(1))
    timers.runByDelay(0)
    // La cola está vacía por ahora: toca el sondeo de siempre.
    await vi.waitFor(() => expect(timers.countByDelay(1_000)).toBe(1))

    puerta.resolve()
    await vi.waitFor(() => expect(repo.completeWebhookEvent).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(timers.countByDelay(0)).toBe(1))
    expect(timers.countByDelay(1_000)).toBe(0)
    await worker.stop()
  })

  it('despertar adelanta un sondeo lejano, pero nunca atrasa uno cercano', async () => {
    const timers = manualScheduler()
    const worker = createWebhookInboxWorker({
      workerId: 'worker-despertador',
      repository: repository(),
      scheduler: timers.scheduler,
      processEvent: async () => {},
    })

    worker.start()
    timers.runByDelay(0)
    await vi.waitFor(() => expect(timers.countByDelay(1_000)).toBe(1))

    worker.despertar(350)
    expect(timers.countByDelay(350)).toBe(1)
    expect(timers.countByDelay(1_000)).toBe(0)

    worker.despertar(800)
    expect(timers.countByDelay(350)).toBe(1)
    expect(timers.countByDelay(800)).toBe(0)

    worker.despertar()
    expect(timers.countByDelay(0)).toBe(1)
    expect(timers.size()).toBe(1)
    await worker.stop()
  })

  it('un aviso que llega con la reserva en vuelo no se pierde', async () => {
    // Esa reserva pudo leer la cola ANTES de que el mensaje nuevo existiera.
    const timers = manualScheduler()
    const reserva = deferred()
    const repo = repository({ leaseWebhookEvents: vi.fn(() => reserva.promise) })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-aviso-en-vuelo',
      repository: repo,
      scheduler: timers.scheduler,
      processEvent: async () => {},
    })

    worker.start()
    timers.runByDelay(0)
    await vi.waitFor(() => expect(repo.leaseWebhookEvents).toHaveBeenCalledOnce())
    worker.despertar(350)
    expect(timers.size()).toBe(0)

    reserva.resolve(ok([]))
    await vi.waitFor(() => expect(timers.countByDelay(350)).toBe(1))
    expect(timers.countByDelay(1_000)).toBe(0)
    await worker.stop()
  })

  it('nunca pasa de su concurrencia, por mucho que lo despierten', async () => {
    const timers = manualScheduler()
    const puerta = deferred()
    const repo = repository({
      leaseWebhookEvents: vi.fn(async (_worker, limit) => ok(
        Array.from({ length: limit }, (_, index) => lease(index)),
      )),
    })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-lleno',
      repository: repo,
      scheduler: timers.scheduler,
      concurrency: 2,
      processEvent: () => puerta.promise,
    })

    worker.start()
    timers.runByDelay(0)
    await vi.waitFor(() => expect(worker.inFlightCount()).toBe(2))
    await vi.waitFor(() => expect(timers.countByDelay(0)).toBe(1))
    timers.runByDelay(0)
    worker.despertar(0)
    await vi.waitFor(() => expect(timers.countByDelay(1_000) + timers.countByDelay(0)).toBe(1))
    if (timers.countByDelay(0)) timers.runByDelay(0)

    // Lleno: ni siquiera pregunta a la base.
    await Promise.resolve()
    expect(repo.leaseWebhookEvents).toHaveBeenCalledOnce()
    expect(worker.inFlightCount()).toBe(2)

    puerta.resolve()
    await worker.stop()
  })

  it('si la base falla, vuelve al sondeo de siempre en vez de insistir en bucle', async () => {
    const timers = manualScheduler()
    const worker = createWebhookInboxWorker({
      workerId: 'worker-base-caida',
      repository: repository({
        leaseWebhookEvents: vi.fn(async () => ({ data: null, error: { message: 'caída' } })),
      }),
      scheduler: timers.scheduler,
      processEvent: async () => {},
      onError: () => {},
    })

    worker.start()
    timers.runByDelay(0)
    await vi.waitFor(() => expect(timers.countByDelay(1_000)).toBe(1))
    expect(timers.countByDelay(0)).toBe(0)
    await worker.stop()
  })

  it('sin arrancar, o ya parado, despertar no deja temporizadores', async () => {
    const timers = manualScheduler()
    const worker = createWebhookInboxWorker({
      workerId: 'worker-dormido',
      repository: repository(),
      scheduler: timers.scheduler,
      processEvent: async () => {},
    })

    worker.despertar(0)
    expect(timers.size()).toBe(0)

    worker.start()
    await worker.stop()
    worker.despertar(0)
    expect(timers.size()).toBe(0)
  })
})
