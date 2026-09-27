import {
  completeWebhookEvent,
  failWebhookEvent,
  leaseWebhookEvents,
  renewWebhookEventLease,
  type WebhookFailureStatus,
  type WebhookInboxLease,
  type WebhookRpcResponse,
} from '../db/repositories/webhook-events'

type TimerHandle = ReturnType<typeof setTimeout>

/** Lo que trajo una reserva: cuántos eventos, y cuándo terminan todos. */
interface Reserva {
  reservados: number
  procesados: Promise<void>
}

export const WEBHOOK_INBOX_ERROR_MAX_LENGTH = 2_000

export interface WebhookInboxRepository {
  leaseWebhookEvents(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<WebhookRpcResponse<WebhookInboxLease[]>>
  renewWebhookEventLease(
    eventId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<WebhookRpcResponse<boolean>>
  completeWebhookEvent(
    eventId: string,
    leaseToken: string,
  ): Promise<WebhookRpcResponse<boolean>>
  failWebhookEvent(
    eventId: string,
    leaseToken: string,
    error: string,
    baseDelaySeconds: number,
  ): Promise<WebhookRpcResponse<WebhookFailureStatus>>
}

export interface WebhookInboxScheduler {
  setTimeout(callback: () => void, delayMilliseconds: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export type WebhookInboxWorkerPhase =
  | 'poll'
  | 'process'
  | 'renew'
  // El worker perdió el lease a mitad del proceso. No es un fallo suyo,
  // pero SÍ hay que decirlo: ese evento se reprocesará y el cliente va a
  // recibir la misma respuesta otra vez.
  | 'lease-perdido'
  | 'complete'
  | 'fail'
  | 'dead'

export interface WebhookInboxWorkerErrorContext {
  phase: WebhookInboxWorkerPhase
  eventId?: string
  provider?: string
  /**
   * Solo en `poll`: cuánto lleva la base sin contestarle a este worker.
   * Distingue un sondeo suelto que falla —y el siguiente, un segundo después,
   * ya funciona— de un corte de verdad.
   */
  silencioDeLaBaseMs?: number
}

/**
 * Cuánto tiene que durar un corte del sondeo para ir al registro de errores.
 *
 * ⚠️ Nace del 2026-09-27. Cada sondeo fallido se registraba, y el vigía avisa
 * de CUALQUIER entrada de las últimas 24 h: un solo «fetch failed» de un
 * segundo —11 en un mes, todos recuperados en el sondeo siguiente, sin un
 * mensaje perdido— le costaba al dueño un día entero de correos de alarma.
 * Una alarma que suena por nada se acaba ignorando, y entonces no avisa del
 * corte que sí importa.
 *
 * Sesenta segundos: dos esperas seguidas del límite de 30 s de la base, o un
 * minuto de «fetch failed» sin parar. Ahí los clientes ya esperan, y vale la
 * pena enterarse.
 */
export const CORTE_QUE_SE_REGISTRA_MS = 60_000

/**
 * ¿Este fallo va al registro que ve el superadmin (y que lee el vigía)?
 *
 * Todo lo que no sea un sondeo breve, sí: un mensaje que no se pudo procesar
 * o cerrar es de un cliente concreto, y eso nunca es ruido. La consola sigue
 * recibiéndolos TODOS, también los breves.
 */
export function fallaQueSeRegistra(context: WebhookInboxWorkerErrorContext): boolean {
  if (context.phase !== 'poll') return true
  return (context.silencioDeLaBaseMs ?? CORTE_QUE_SE_REGISTRA_MS) >= CORTE_QUE_SE_REGISTRA_MS
}

export interface WebhookInboxWorkerOptions {
  workerId: string
  processEvent(event: WebhookInboxLease): Promise<void>
  repository?: WebhookInboxRepository
  scheduler?: WebhookInboxScheduler
  onError?: (
    error: Error,
    context: WebhookInboxWorkerErrorContext,
  ) => void
  batchSize?: number
  concurrency?: number
  pollIntervalMilliseconds?: number
  leaseSeconds?: number
  /**
   * Cuánto se le da al manejador antes de darlo por colgado.
   *
   * ⚠️ Nace de un incidente real (2026-08-23): un evento se quedaba en
   * `processing` sin volver JAMÁS. El lease vencía, otro worker lo reservaba,
   * volvía a colgarse… y como el fallo nunca ocurría, la fila **no guardaba
   * ningún error**, el evento no aparecía en `in_flight` y `/api/health` seguía
   * en verde. Ocho intentos después moría con «lease vencido», que dice cuándo
   * se rindió pero no QUÉ pasó.
   *
   * Peor: la cola es FIFO por conversación, así que ese evento colgado
   * **bloqueaba todos los mensajes siguientes de ese cliente**.
   *
   * Un manejador que nunca vuelve es peor que uno que falla: el que falla deja
   * rastro, reintenta con backoff y acaba en dead-letter a la vista. Esto
   * convierte el cuelgue en un fallo normal.
   *
   * ⚠️ Tiene que vencer ANTES que el lease: si venciera después, el evento ya
   * no sería nuestro al registrar el fallo y la RPC respondería `stale`, que
   * es justo quedarse otra vez sin explicación. Por defecto, el 60 % del lease.
   */
  processTimeoutMilliseconds?: number
  heartbeatIntervalMilliseconds?: number
  baseDelaySeconds?: number
  readinessTimeoutMilliseconds?: number
}

export interface WebhookInboxWorker {
  start(): void
  stop(): Promise<void>
  drain(): Promise<void>
  pollOnce(): Promise<number>
  /**
   * Adelanta la próxima reserva: la llama el webhook al guardar un mensaje.
   * Ver `lib/despertador-de-la-cola.ts`.
   */
  despertar(esperaMilisegundos?: number): void
  isRunning(): boolean
  isReady(): boolean
  inFlightCount(): number
  lastSuccessfulDatabaseOperationAt(): number | null
}

const defaultRepository: WebhookInboxRepository = {
  leaseWebhookEvents,
  renewWebhookEventLease,
  completeWebhookEvent,
  failWebhookEvent,
}

const defaultScheduler: WebhookInboxScheduler = {
  setTimeout(callback, delayMilliseconds) {
    return setTimeout(callback, delayMilliseconds)
  },
  clearTimeout(handle) {
    clearTimeout(handle)
  },
}

const redactSecrets = (message: string): string => message
  .replace(
    /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    '$1[REDACTADO]',
  )
  .replace(
    /\b(authorization|token|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[^\s,;'"]+/gi,
    '$1=[REDACTADO]',
  )
  .replace(
    /([?&](?:token|secret|api[_-]?key|access[_-]?token)=)[^&\s]+/gi,
    '$1[REDACTADO]',
  )
  .replace(
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    '[JWT REDACTADO]',
  )

export function sanitizeWebhookInboxError(error: unknown): string {
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Error interno durante el procesamiento del webhook'
  const boundedMessage = rawMessage.slice(0, WEBHOOK_INBOX_ERROR_MAX_LENGTH * 2)
  const withoutControlCharacters = [...redactSecrets(boundedMessage)]
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 ? ' ' : character
    })
    .join('')
  const safeMessage = withoutControlCharacters
    .replace(/\s+/g, ' ')
    .trim()
  return (safeMessage || 'Error interno durante el procesamiento del webhook')
    .slice(0, WEBHOOK_INBOX_ERROR_MAX_LENGTH)
}

const positiveInteger = (
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} debe ser un entero entre ${minimum} y ${maximum}`)
  }
  return value
}

const rpcData = <T>(
  response: WebhookRpcResponse<T>,
  operation: string,
): T => {
  if (response.error) {
    throw new Error(`${operation}: ${response.error.message}`)
  }
  if (response.data === null || response.data === undefined) {
    throw new Error(`${operation}: la RPC no devolvió resultado`)
  }
  return response.data
}

const isLease = (value: unknown): value is WebhookInboxLease => {
  if (!value || typeof value !== 'object') return false
  const lease = value as Partial<WebhookInboxLease>
  return typeof lease.id === 'string'
    // ⚠️ `null` ES VÁLIDO, y omitirlo dejó el marketplace MUDO desde que el
    // número de la plataforma empezó a recibir (2026-08-23).
    //
    // Un mensaje al número de Umbani llega sin local —`business_id` nulo,
    // porque el número no es de ningún negocio—. Al exigir `string`, este
    // guardián lo daba por fila inválida, `executePoll` lanzaba «la RPC de
    // leases devolvió filas inválidas», y el evento se quedaba RESERVADO sin
    // procesar: sin error en su fila, sin aparecer en `in_flight`, y con los
    // intentos subiendo cada vez que vencía el lease. El cliente escribía y
    // no recibía nada.
    //
    // ⚠️ Y ARRASTRABA AL RESTO: `leased.every(isLease)` tira el LOTE entero,
    // así que un solo mensaje sin local también dejaba sin procesar los
    // mensajes de los negocios con número propio que vinieran con él.
    //
    // ⚠️ La migración del canal de plataforma arregló esto mismo en SQL —los
    // índices parciales, el `is not distinct from` del FIFO, el disparador de
    // consumo— y este guardián de TypeScript se quedó atrás. Mismo fallo, otro
    // idioma: dos NULL no son iguales en SQL, y `null` no es `string` en TS.
    && (typeof lease.business_id === 'string' || lease.business_id === null)
    && (lease.provider === 'meta' || lease.provider === 'ycloud')
    && Boolean(lease.payload)
    && typeof lease.payload === 'object'
    && !Array.isArray(lease.payload)
    && typeof lease.lease_token === 'string'
    && Number.isInteger(lease.attempts)
}

export function createWebhookInboxWorker(
  options: WebhookInboxWorkerOptions,
): WebhookInboxWorker {
  const workerId = options.workerId.trim()
  if (!workerId || workerId.length > 128) {
    throw new Error('workerId debe contener entre 1 y 128 caracteres')
  }

  const batchSize = positiveInteger(options.batchSize ?? 10, 'batchSize', 1, 50)
  const concurrency = positiveInteger(
    options.concurrency ?? 4,
    'concurrency',
    1,
    50,
  )
  const leaseSeconds = positiveInteger(
    options.leaseSeconds ?? 180,
    'leaseSeconds',
    30,
    900,
  )
  // Por defecto, el 60 % del lease: sobra margen para registrar el fallo con
  // el token todavía válido, y a la vez se le da al manejador mucho más de lo
  // que tarda un mensaje normal (un texto se resuelve en ~3 s).
  const processTimeoutMilliseconds = positiveInteger(
    options.processTimeoutMilliseconds ?? Math.floor(leaseSeconds * 600),
    'processTimeoutMilliseconds',
    1_000,
    leaseSeconds * 1_000,
  )
  const baseDelaySeconds = positiveInteger(
    options.baseDelaySeconds ?? 10,
    'baseDelaySeconds',
    1,
    300,
  )
  const pollIntervalMilliseconds = positiveInteger(
    options.pollIntervalMilliseconds ?? 1_000,
    'pollIntervalMilliseconds',
    0,
    3_600_000,
  )
  const heartbeatIntervalMilliseconds = positiveInteger(
    options.heartbeatIntervalMilliseconds ?? 45_000,
    'heartbeatIntervalMilliseconds',
    1,
    leaseSeconds * 1_000 - 1,
  )
  const readinessTimeoutMilliseconds = positiveInteger(
    options.readinessTimeoutMilliseconds
      ?? Math.max(30_000, heartbeatIntervalMilliseconds * 2),
    'readinessTimeoutMilliseconds',
    1_000,
    3_600_000,
  )
  // No se reservan más filas de las que pueden empezar a procesarse. Así
  // ningún lease queda esperando detrás del semáforo sin heartbeat activo.
  const leaseLimit = Math.min(batchSize, concurrency)

  const repository = options.repository ?? defaultRepository
  const scheduler = options.scheduler ?? defaultScheduler
  const activeEvents = new Set<Promise<void>>()
  let running = false
  let pollTimer: TimerHandle | null = null
  // Cuándo vence `pollTimer`: despertar solo lo reemplaza si es para ANTES.
  let pollTimerVence = 0
  let currentPoll: Promise<number> | null = null
  // La reserva en vuelo. Nunca hay dos: con dos a la vez, las dos calcularían
  // el hueco libre antes de que la otra arrancara lo suyo y se pasarían de la
  // concurrencia.
  let reservaEnCurso: Promise<Reserva> | null = null
  // Un despertar que llegó con una reserva en vuelo: esa reserva pudo no ver
  // el mensaje nuevo, así que al terminar se vuelve a mirar en este plazo.
  let vueltaPedida: number | null = null
  let lastDatabaseSuccessAt: number | null = null
  // Desde cuándo corre: si la base no ha contestado NUNCA, el silencio se mide
  // desde aquí.
  let arrancoEn: number | null = null

  const markDatabaseSuccess = (): void => {
    lastDatabaseSuccessAt = Date.now()
  }

  const report = (
    error: unknown,
    context: WebhookInboxWorkerErrorContext,
  ): void => {
    if (!options.onError) return
    try {
      options.onError(new Error(sanitizeWebhookInboxError(error)), context)
    } catch {
      // El observador nunca debe detener el consumo de la bandeja.
    }
  }

  const startHeartbeat = (event: WebhookInboxLease) => {
    let active = true
    let leaseLost = false
    let timer: TimerHandle | null = null
    let renewal: Promise<void> | null = null

    const schedule = (): void => {
      if (!active || leaseLost) return
      timer = scheduler.setTimeout(() => {
        timer = null
        if (!active || leaseLost) return

        const operation = (async () => {
          try {
            const renewed = rpcData(
              await repository.renewWebhookEventLease(
                event.id,
                event.lease_token,
                leaseSeconds,
              ),
              'No se pudo renovar el lease del webhook',
            )
            if (typeof renewed !== 'boolean') {
              throw new Error('La RPC de renovación devolvió un resultado inválido')
            }
            markDatabaseSuccess()
            if (!renewed) {
              leaseLost = true
              report('El lease del webhook ya no pertenece a este worker', {
                phase: 'renew',
                eventId: event.id,
                provider: event.provider,
              })
            }
          } catch (error) {
            // Un fallo de red no prueba pérdida del lease. Se vuelve a intentar
            // en el próximo heartbeat y la mutación final conserva el fencing.
            report(error, {
              phase: 'renew',
              eventId: event.id,
              provider: event.provider,
            })
          }
        })()
        renewal = operation
        void operation.then(() => {
          if (renewal === operation) renewal = null
          schedule()
        })
      }, heartbeatIntervalMilliseconds)
    }

    schedule()

    return async (): Promise<boolean> => {
      active = false
      if (timer) {
        scheduler.clearTimeout(timer)
        timer = null
      }
      if (renewal) await renewal
      return !leaseLost
    }
  }

  /**
   * Reintenta el RECONOCIMIENTO del evento (completar o marcar fallo).
   *
   * ⚠️ Nace del incidente del 2026-08-23. El mensaje se procesaba bien —el
   * cliente recibía su respuesta— pero cerrar el evento fallaba con «upstream
   * request timeout», y un solo fallo pasajero costaba carísimo:
   *
   *   · el evento se quedaba en `processing` hasta que venciera el lease
   *   · la cola es FIFO por conversación, así que **todos los mensajes
   *     siguientes de ese cliente se quedaban esperando** — por eso elegir un
   *     local nunca llegaba a entregar el enlace
   *   · y al reintentarlo se REPROCESABA, así que el cliente recibía la misma
   *     respuesta una y otra vez cada tres minutos
   *
   * Medido: la función tarda ~180 ms por conexión directa. Un tiempo de
   * respuesta de 37 s no es la función siendo lenta, es la capa de en medio
   * teniendo un mal momento — y eso se pasa reintentando.
   *
   * ⚠️ Reintentar es SEGURO porque las dos RPC llevan el `lease_token`: si el
   * lease ya no es nuestro no hacen nada, y si el primer intento sí llegó a
   * PostgreSQL el segundo es inocuo.
   *
   * ⚠️ Cabe de sobra dentro del lease: dos esperas cortas contra 180 segundos.
   */
  const conReintentos = async <T>(
    operacion: () => Promise<T>,
    intentos = 3,
  ): Promise<T> => {
    let ultimo: unknown
    for (let intento = 0; intento < intentos; intento += 1) {
      try {
        return await operacion()
      } catch (error) {
        ultimo = error
        if (intento === intentos - 1) break
        await new Promise<void>((seguir) => {
          scheduler.setTimeout(() => seguir(), 500 * (intento + 1))
        })
      }
    }
    throw ultimo
  }

  const handleEvent = async (event: WebhookInboxLease): Promise<void> => {
    const stopHeartbeat = startHeartbeat(event)
    let processingFailed = false
    let processingError: unknown

    try {
      // ⚠️ Con TIEMPO LÍMITE. Un manejador que no vuelve deja el evento
      // reservado, sin error en su fila y sin aparecer en `in_flight` — y como
      // la cola es FIFO por conversación, bloquea todos los mensajes que ese
      // cliente mande después. Pasó el 2026-08-23 y costó horas justamente
      // porque no dejaba ni una traza.
      //
      // El timer se limpia SIEMPRE: si no, un manejador rápido dejaría vivo un
      // temporizador por cada evento y el proceso no podría cerrarse limpio.
      let expirar: ReturnType<typeof scheduler.setTimeout> | null = null
      try {
        await Promise.race([
          options.processEvent(event),
          new Promise<never>((_, rechazar) => {
            expirar = scheduler.setTimeout(() => {
              rechazar(new Error(
                `El manejador no respondió en ${processTimeoutMilliseconds} ms`,
              ))
            }, processTimeoutMilliseconds)
          }),
        ])
      } finally {
        if (expirar !== null) scheduler.clearTimeout(expirar)
      }
    } catch (error) {
      processingFailed = true
      processingError = error
    }

    const stillOwnsLease = await stopHeartbeat()
    if (!stillOwnsLease) {
      // ⚠️ ANTES ESTO ERA UN `return` A SECAS, y escondió un fallo durante
      // horas el 2026-08-23: el evento se quedaba en `processing` sin
      // `last_error`, sin salir en `in_flight` y con `/api/health` en verde.
      // No había NADA que mirar.
      //
      // No se puede hacer más que avisar —el lease ya es de otro worker y
      // tocar la fila pisaría su trabajo—, pero avisar es exactamente lo que
      // faltaba. Y no es inocuo: ese evento se reprocesará, así que el cliente
      // va a recibir la misma respuesta otra vez.
      report('Se perdió el lease durante el proceso: el evento se reintentará', {
        phase: 'lease-perdido',
        eventId: event.id,
        provider: event.provider,
      })
      return
    }

    if (processingFailed) {
      const safeError = sanitizeWebhookInboxError(processingError)
      report(processingError, {
        phase: 'process',
        eventId: event.id,
        provider: event.provider,
      })
      try {
        const status = rpcData(
          await conReintentos(() => repository.failWebhookEvent(
            event.id,
            event.lease_token,
            safeError,
            baseDelaySeconds,
          )),
          'No se pudo registrar el fallo del webhook',
        )
        if (status !== 'pending' && status !== 'dead' && status !== 'stale') {
          throw new Error('La RPC de fallo devolvió un estado inválido')
        }
        markDatabaseSuccess()
        if (status === 'stale') {
          report('El lease expiró antes de registrar el fallo del webhook', {
            phase: 'fail',
            eventId: event.id,
            provider: event.provider,
          })
        } else if (status === 'dead') {
          report('El webhook agotó sus reintentos y requiere revisión', {
            phase: 'dead',
            eventId: event.id,
            provider: event.provider,
          })
        }
      } catch (error) {
        report(error, {
          phase: 'fail',
          eventId: event.id,
          provider: event.provider,
        })
      }
      return
    }

    try {
      const completed = rpcData(
        await conReintentos(
          () => repository.completeWebhookEvent(event.id, event.lease_token),
        ),
        'No se pudo completar el webhook',
      )
      if (typeof completed !== 'boolean') {
        throw new Error('La RPC de completado devolvió un resultado inválido')
      }
      markDatabaseSuccess()
      if (!completed) {
        report('El lease expiró antes de completar el webhook', {
          phase: 'complete',
          eventId: event.id,
          provider: event.provider,
        })
      }
    } catch (error) {
      // No se marca como fallo después de procesar: el fencing permite que el
      // evento sea reintentado si la confirmación no llegó a PostgreSQL.
      report(error, {
        phase: 'complete',
        eventId: event.id,
        provider: event.provider,
      })
    }
  }

  const trackEvent = async (event: WebhookInboxLease): Promise<void> => {
    const task = handleEvent(event)
    activeEvents.add(task)
    try {
      await task
    } finally {
      activeEvents.delete(task)
      // ⚠️ Al terminar un mensaje se vuelve a mirar YA: el siguiente de esa
      // misma conversación estaba esperando justo a este (la cola es FIFO por
      // conversación). Antes pagaba el segundo del sondeo, y una ráfaga de 12
      // toques pagaba 12.
      despertar(0)
    }
  }

  /**
   * Reserva lo que CABE y lo pone a procesar, sin esperarlo.
   *
   * ⚠️ Hasta el 2026-09-25 se reservaba un lote y no se volvía a mirar la
   * cola hasta que el lote ENTERO terminaba. Con un solo número para todo el
   * marketplace, eso ponía a cada cliente detrás del anterior: el mensaje de B
   * esperaba los ~3 s que tardaba el de A aunque sobraran manos libres.
   *
   * Ahora se reserva mientras otros se procesan. Es seguro porque el orden NO
   * lo cuida este worker sino `lease_webhook_events`: un evento solo se
   * entrega si ninguno anterior de su conversación sigue `pending` o
   * `processing`. Dos mensajes del mismo cliente nunca corren a la vez.
   *
   * No se reservan más filas de las que pueden empezar a procesarse: así
   * ningún lease queda esperando detrás de otro sin heartbeat activo.
   */
  const reservarYArrancar = async (): Promise<Reserva> => {
    const libres = leaseLimit - activeEvents.size
    if (libres <= 0) return { reservados: 0, procesados: Promise.resolve() }
    const leased = rpcData(
      await repository.leaseWebhookEvents(workerId, libres, leaseSeconds),
      'No se pudieron reservar webhooks',
    )
    if (!Array.isArray(leased)
      || leased.length > libres
      || !leased.every(isLease)) {
      throw new Error('La RPC de leases devolvió filas inválidas')
    }
    markDatabaseSuccess()
    // Caben todos: `trackEvent` apunta cada uno en `activeEvents` antes de
    // devolver, así que la próxima reserva ya cuenta con ellos.
    const procesados = Promise.all(leased.map(trackEvent)).then(() => undefined)
    return { reservados: leased.length, procesados }
  }

  const reservar = (): Promise<Reserva> => {
    if (reservaEnCurso) return reservaEnCurso
    const operation = reservarYArrancar()
    reservaEnCurso = operation
    const soltar = () => {
      if (reservaEnCurso === operation) reservaEnCurso = null
    }
    void operation.then(soltar, soltar)
    return operation
  }

  /** Una vuelta completa: reservar y esperar a que termine lo reservado. */
  const pollOnce = (): Promise<number> => {
    if (currentPoll) return currentPoll
    const operation = (async () => {
      const { reservados, procesados } = await reservar()
      await procesados
      return reservados
    })()
    currentPoll = operation
    void operation.then(
      () => {
        if (currentPoll === operation) currentPoll = null
      },
      () => {
        if (currentPoll === operation) currentPoll = null
      },
    )
    return operation
  }

  /** Programa la próxima vuelta, salvo que ya haya una para antes. */
  const programar = (delayMilliseconds: number): void => {
    if (!running) return
    const vence = Date.now() + delayMilliseconds
    if (pollTimer) {
      if (pollTimerVence <= vence) return
      scheduler.clearTimeout(pollTimer)
      pollTimer = null
    }
    pollTimerVence = vence
    pollTimer = scheduler.setTimeout(() => {
      pollTimer = null
      if (!running) return
      vueltaPedida = null
      // ⚠️ El ciclo automático NO espera a que se procese lo reservado: eso
      // es lo que deja atender a otro cliente mientras tanto.
      void reservar()
        .then(({ reservados, procesados }) => {
          // Aquí nadie espera `procesados`. Hoy no rechaza —`handleEvent` lo
          // atrapa todo—, pero un rechazo sin atender tumba el proceso entero
          // y con él la cola de TODOS los clientes: se escucha igual.
          void procesados.catch(error => report(error, { phase: 'process' }))
          return reservados
        })
        .catch((error) => {
          const ahora = Date.now()
          report(error, {
            phase: 'poll',
            silencioDeLaBaseMs: Math.max(0, ahora - (lastDatabaseSuccessAt ?? arrancoEn ?? ahora)),
          })
          return 0
        })
        .then((reservados) => {
          // Si trajo trabajo, puede haber más esperando; si no, el sondeo de
          // siempre, salvo que alguien haya pedido mirar antes.
          const siguiente = reservados > 0
            ? 0
            : (vueltaPedida ?? pollIntervalMilliseconds)
          vueltaPedida = null
          programar(siguiente)
        })
    }, delayMilliseconds)
  }

  const despertar = (esperaMilisegundos = 0): void => {
    if (!running) return
    const espera = Math.max(0, Math.floor(esperaMilisegundos) || 0)
    if (reservaEnCurso) {
      vueltaPedida = Math.min(vueltaPedida ?? espera, espera)
      return
    }
    programar(espera)
  }

  const drain = async (): Promise<void> => {
    while (currentPoll || reservaEnCurso || activeEvents.size) {
      const pending: Promise<unknown>[] = []
      if (currentPoll) pending.push(currentPoll)
      if (reservaEnCurso) pending.push(reservaEnCurso)
      pending.push(...activeEvents)
      await Promise.allSettled(pending)
    }
  }

  const stop = async (): Promise<void> => {
    running = false
    if (pollTimer) {
      scheduler.clearTimeout(pollTimer)
      pollTimer = null
    }
    await drain()
  }

  return {
    start() {
      if (running) return
      running = true
      arrancoEn = Date.now()
      programar(0)
    },
    stop,
    drain,
    pollOnce,
    despertar,
    isRunning: () => running,
    isReady: () => {
      if (!running || lastDatabaseSuccessAt === null) return false
      const age = Math.max(0, Date.now() - lastDatabaseSuccessAt)
      return age <= readinessTimeoutMilliseconds
    },
    inFlightCount: () => activeEvents.size,
    lastSuccessfulDatabaseOperationAt: () => lastDatabaseSuccessAt,
  }
}
