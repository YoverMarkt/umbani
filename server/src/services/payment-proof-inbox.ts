// ── EL COMPROBANTE QUE LLEGA POR WHATSAPP ──────────────────────────────────
//
// La mayoría de la gente transfiere desde la app de su banco y manda la
// captura POR EL CHAT, no por la mini app. Hasta ahora esa foto se perdía para
// el pedido: el dueño la veía en su WhatsApp, pero el panel nunca activaba
// «Ver comprobante» y el pedido seguía en `esperando_pago` — con el cliente
// atascado en la pantalla de pago hasta que alguien lo marcara a mano.
//
// Esto la engancha: si quien manda la foto tiene un pedido esperando pago, se
// sube como su comprobante y el pedido pasa a `pago_en_revision`. A partir de
// ahí es EXACTAMENTE igual que subirla desde la app — misma RPC, mismo estado,
// misma alarma en el panel, mismo «Ver comprobante» con firma temporal.
//
// ── Las cuatro decisiones que lo hacen seguro ────────────────────────────
//
// 1. **Solo si hay un pedido esperando pago.** Sin eso no se toca Cloudinary,
//    y el negocio no paga almacenamiento por cada foto que le manden. Es
//    también lo que impide que una foto cualquiera se convierta en nada.
//
// 2. **El más reciente, si hay varios.** Es lo que haría cualquiera
//    mentalmente, y con dos pedidos abiertos el cliente está pensando en el
//    último.
//
// 3. **Si la foto NO es un comprobante, se corta ANTES de subirla** — desde el
//    2026-08-22, y solo cuando el análisis está encendido y la imagen no tiene
//    NADA de un pago: ni banco, ni monto, ni fecha, ni referencia. Al cliente
//    se le pide la captura correcta en el mismo mensaje que ya se iba a pagar.
//
//    ⚠️ Ante cualquier duda se adjunta y decide el dueño, que es lo que se
//    hacía siempre: el pedido queda en `pago_en_revision`, que es precisamente
//    el estado en el que una PERSONA lo mira antes de aceptar. Los dos errores
//    no cuestan lo mismo — rechazar el pago de alguien que sí pagó lo deja
//    tirado, y aceptar una foto de un perro solo le hace sonreír al dueño.
//
// 4. **Privado, como en la app.** `uploadPrivateMedia` sube como
//    `authenticated`: un movimiento bancario con el nombre y la cuenta de una
//    persona no puede quedar en una URL pública que se adivine.
//
// ⚠️ NUNCA lanza. Esto corre dentro del camino de un mensaje entrante: si
// Cloudinary está caído o la RPC falla, el cliente tiene que recibir su
// respuesta igual. Un fallo va al registro de errores y la conversación sigue.

import type { ResultadoVision } from './receipt-vision'
import { porCobrar } from '../lib/por-cobrar'

/**
 * Lo justo que hace falta del pedido. Se declara aquí en vez de importar el
 * tipo del repositorio —que es `Record<string, unknown>`— para que el
 * compilador compruebe de verdad los campos que se miran.
 */
export interface PedidoEsperandoPago {
  id?: unknown
  status?: unknown
  order_number?: number | null
  payment_proof_url?: unknown
  payment_confirmed_at?: unknown
  /**
   * El teléfono TAL COMO lo guardó el pedido.
   *
   * ⚠️ Se usa este y no el que llega por el canal: la RPC que adjunta compara
   * `contact_phone = btrim(p_contact_phone)`, exacto. Un pedido de la mini app
   * guarda `593990978367` y el mismo cliente por WhatsApp llega
   * `+593990978367` — buscar ya contempla las dos formas, pero al adjuntar hay
   * que devolverle a la base la que ella tiene escrita.
   */
  contact_phone?: unknown
  /** Con quién se pidió. Se compara contra el ordenante del comprobante. */
  contact_name?: string | null
}

/** Los estados en los que una foto es, casi con seguridad, el comprobante. */
const ESPERANDO_PAGO = 'esperando_pago'

/**
 * Lo que se sabe del comprobante DESPUÉS de compararlo con el pedido.
 *
 * `critica` solo viaja cuando hay una señal de las que no admiten duda —el
 * dinero fue a otra cuenta, o es menos de lo que cuesta—. `limpio` significa
 * que no salió ninguna señal preocupante, y es lo único que autoriza a
 * decirle al cliente que sus datos cuadran.
 */
export interface CuadreDelComprobante {
  critica: { flag_type: string; description: string } | null
  limpio: boolean
}

export interface ComprobanteDependencias {
  /** El último pedido de ese contacto en ese negocio. */
  /**
   * Los pedidos del CLIENTE que esperan comprobante.
   *
   * ⚠️ El local sale del pedido, nunca del número al que llegó la foto. Con un
   * solo número para todo el marketplace, ese número no dice de quién es el
   * pago — y el mismo cliente puede tener pedidos abiertos en dos locales.
   */
  pedidosEsperando(
    contactPhone: string,
    businessId?: string | null,
  ): Promise<Array<{
    id: string
    business_id: string
    /** A quién se le cuenta un rechazo de comprobante. */
    customer_id?: string | null
    order_number: number | null
    contact_phone: string | null
    /**
     * Con quién se pidió. Se compara contra el ORDENANTE del comprobante.
     *
     * ⚠️ Que no coincida NO rechaza: pagar desde la cuenta de la pareja, de la
     * madre o del negocio es lo normal. Se marca para que el dueño lo vea.
     */
    contact_name?: string | null
    /** El precio del pedido. Lo que se transfiere es esto menos `credit_cents`. */
    total?: number | null
    /** Lo pagado con saldo Umbani (2026-10-10): no se transfiere. */
    credit_cents?: number | null
    /** Cuándo se pidió: con esto se detecta una captura vieja reciclada. */
    created_at?: string | null
    businesses?: { name?: string | null } | null
  }>>
  /**
   * Lee la imagen antes de subirla: ¿esto es siquiera un comprobante?
   *
   * ⚠️ Opcional a propósito. Sin ella el buzón se comporta EXACTAMENTE como
   * antes de que el análisis existiera —se adjunta todo y decide el dueño—,
   * que es también lo que pasa con el análisis apagado. Falla abierto.
   */
  /**
   * ¿Lo leído CUADRA con este pedido y con la cuenta del local?
   *
   * ⚠️ Es una segunda pregunta, distinta de `analizarImagen`. Aquella responde
   * «¿esto es siquiera un pago?» —la portería—; esta responde «¿es ESTE pago?».
   * Un comprobante perfecto de una transferencia a otra persona pasa la
   * primera y falla la segunda.
   *
   * ⚠️ Opcional y falla ABIERTO, como todo aquí: sin ella, o si revienta, se
   * adjunta y decide el dueño, que es lo que se hacía antes.
   */
  comprobarCuadre?(input: {
    businessId: string
    analisis: unknown
    esperado: {
      total: number
      createdAt: string | null
      clienteNombre?: string | null
    }
  }): Promise<CuadreDelComprobante | undefined>
  analizarImagen?(imagen: Buffer, mimeType?: string | null): Promise<ResultadoVision>
  /**
   * Anota que la imagen NO era un comprobante y dice si eso ya bloqueó.
   *
   * Opcional como el resto: sin ella la compuerta sigue funcionando igual,
   * solo que insistir no cuesta nada.
   */
  contarRechazo?(businessId: string, customerId: string): Promise<{
    strikes: number
    blocked: boolean
    limit: number
    minutes?: number | null
  }>
  /** Pone a cero los rechazos porque llegó uno bueno. */
  olvidarRechazos?(businessId: string, customerId: string): Promise<void>
  // `phash` es la huella perceptual que calcula Cloudinary al subir: caza la
  // misma imagen recortada o recomprimida, que es lo que hace WhatsApp al
  // reenviarla. Opcional porque un fallo calculándola no puede impedir que el
  // comprobante se adjunte.
  subirPrivado(buffer: Buffer, businessId: string): Promise<{
    url: string
    public_id: string
    phash?: string
  }>
  /**
   * Registra la huella del comprobante y detecta si esa imagen ya se usó.
   *
   * Opcional a propósito: sin ella el buzón se comporta exactamente como
   * antes de que existiera. Es una capa encima, no un punto único de fallo.
   */
  registrarHuella?(input: {
    businessId: string
    orderId: string
    imagen: Buffer
    fileUrl: string
    filePublicId?: string | null
    perceptualHash?: string | null
    /**
     * Lo que ya leyó la compuerta de arriba. Se PASA en vez de volver a
     * pedirlo: mirar dos veces la misma imagen se paga dos veces.
     */
    analisis?: ResultadoVision
    esperado?: {
      total: number
      currency?: string | null
      createdAt?: string | null
      /** Con quién se pidió, para la señal `pagado_por_otro` que ve el dueño. */
      clienteNombre?: string | null
    }
  }): Promise<unknown>
  adjuntar(input: {
    businessId: string
    orderId: string
    contactPhone: string
    url: string
    publicId?: string | null
  }): Promise<{ data: unknown; error: { message?: string } | null }>
  registrarError(input: {
    businessId?: string | null
    category: 'servidor'
    message: unknown
    context?: Record<string, unknown>
  }): Promise<void>
}

export interface ResultadoComprobante {
  /** `true` solo si la foto quedó adjunta al pedido. */
  adjuntado: boolean
  /**
   * La imagen no tiene NADA de un comprobante: ni banco, ni monto, ni fecha,
   * ni referencia. Una foto de un perro, de un plato, de una persona.
   *
   * ⚠️ Solo se pone con el vacío absoluto, nunca ante una duda — ver
   * `decidirSiEsComprobante`. Y cuando se pone, no se sube nada a Cloudinary:
   * el negocio no paga almacenamiento por una foto que no era un pago.
   */
  noEsComprobante?: boolean
  /**
   * El comprobante es un pago de verdad, pero NO es este pago.
   *
   * Solo con señales críticas: cuenta de destino distinta o monto menor. Con
   * cualquier otra duda se adjunta y decide el dueño — un falso rechazo deja
   * tirado a alguien que sí pagó.
   */
  noCuadra?: { flag_type: string; description: string }
  /**
   * `true` cuando lo leído cuadró sin una sola señal preocupante.
   *
   * ⚠️ NO significa «pago confirmado» y el texto que lo usa tampoco lo dice:
   * una imagen se puede editar. Significa «lo que se ve encaja con tu pedido»,
   * que es lo que el cliente necesita saber para quedarse tranquilo mientras
   * el dueño mira.
   */
  datosCuadran?: boolean
  /**
   * Qué pasó por mandar una imagen que no era un pago: cuántas van y si esta
   * dejó al cliente fuera del local un rato.
   *
   * Solo viaja cuando `noEsComprobante` es cierto. Sin contador configurado no
   * viene, y la respuesta es la de siempre.
   */
  rechazo?: { strikes: number; blocked: boolean; limit: number; minutes?: number | null }
  /** El número, para poder nombrarlo en la respuesta al cliente. */
  orderNumber?: number | null
  /**
   * Más de un pedido esperando pago: hay que PREGUNTAR a cuál corresponde.
   *
   * No se adjunta a ninguno mientras tanto. Elegir el más reciente sería
   * atribuir el pago a un local al azar, y eso es peor que pedir una
   * aclaración: el dueño equivocado daría por cobrado lo que no cobró.
   */
  ambiguos?: Array<{
    orderId: string
    orderNumber: number | null
    businessName: string
  }>
}

/**
 * ¿Este pedido está esperando que su dueño pague?
 *
 * Se exige además que NO tenga ya comprobante: quien sube uno por la app y
 * después manda la misma foto por el chat no debe pisar el primero, porque el
 * pedido ya avanzó a revisión y el dueño puede estar mirándolo.
 */
export const esperaComprobante = (pedido: PedidoEsperandoPago | null): boolean => {
  if (!pedido?.id) return false
  if (pedido.status !== ESPERANDO_PAGO) return false
  if (pedido.payment_confirmed_at) return false
  return !pedido.payment_proof_url
}

export const crearBuzonDeComprobantes = (dependencias: ComprobanteDependencias) =>
  async function adjuntarComprobante(
    /**
     * ⚠️ NULO cuando la foto llegó al número de la plataforma: ahí no hay
     * ningún local que resolver. Solo se usa como FILTRO al buscar pedidos y
     * para nombrar el negocio en el registro de errores — el local del
     * comprobante sale del PEDIDO desde el 2026-08-21, nunca del número.
     */
    businessId: string | null,
    contactPhone: string,
    imagen: Buffer,
    mimeType?: string | null,
  ): Promise<ResultadoComprobante> {
    try {
      const pedidos = await dependencias.pedidosEsperando(contactPhone, businessId)
      // Sin pedido esperando pago no se sube NADA: ni un byte a Cloudinary.
      if (!pedidos.length) return { adjuntado: false }

      // ⚠️ Con más de uno NO se adivina. Adjuntarlo al más reciente sería
      // atribuir el pago a un local al azar entre dos que lo están esperando;
      // el dueño equivocado daría por cobrado lo que no cobró y el otro
      // seguiría esperando. Se devuelve la lista y quien llama pregunta.
      if (pedidos.length > 1) {
        return {
          adjuntado: false,
          ambiguos: pedidos.map(pedido => ({
            orderId: pedido.id,
            orderNumber: pedido.order_number ?? null,
            businessName: String(pedido.businesses?.name || '').trim() || 'un local',
          })),
        }
      }

      // El local sale del PEDIDO. Nunca del número por el que llegó la foto.
      const [pedido] = pedidos
      const localDelPedido = pedido.business_id

      // ── LA COMPUERTA: ¿esto es siquiera un comprobante? ──
      //
      // ⚠️ Va ANTES de subir a Cloudinary, y el orden es la mitad del valor:
      // una foto que no es un pago no cuesta almacenamiento, igual que hoy no
      // se sube nada cuando no hay pedido esperando. Y va antes de adjuntar,
      // porque adjuntar mueve el pedido a `pago_en_revision` y le enciende la
      // alarma al dueño — por una foto de un perro.
      //
      // ⚠️ FALLA ABIERTO, siempre. Sin analizador, con el análisis apagado, con
      // OpenAI caído o ante cualquier duda del modelo, se sigue por el camino
      // de siempre: se adjunta y decide el dueño. Solo el vacío absoluto —ni
      // banco, ni monto, ni fecha, ni referencia— corta aquí. Un falso negativo
      // dejaría tirado a alguien que acaba de pagar de verdad, y eso cuesta
      // mucho más que una foto de más en el panel.
      const analisis = dependencias.analizarImagen
        ? await dependencias.analizarImagen(imagen, mimeType).catch(() => undefined)
        : undefined
      if (analisis?.ok && !analisis.esComprobante) {
        // ── Insistir cuesta ──────────────────────────────────────────────
        //
        // Rechazar la foto y pedir la buena ya se hacía. Lo que faltaba es que
        // la segunda seguida tuviera consecuencia: quien manda dos está
        // probando, no equivocándose.
        //
        // ⚠️ El local sale del PEDIDO, como todo en este archivo — nunca del
        // número por el que llegó la foto, que en el marketplace es el mismo
        // para todos.
        //
        // ⚠️ Y NUNCA lanza: si contar falla, el cliente recibe igual la
        // respuesta que le dice qué mandar. Enterarse es lo que no puede
        // faltar.
        const clienteDelPedido = String(pedido.customer_id || '')
        const rechazo = dependencias.contarRechazo && clienteDelPedido
          ? await dependencias.contarRechazo(localDelPedido, clienteDelPedido)
            .catch(() => undefined)
          : undefined
        return { adjuntado: false, noEsComprobante: true, rechazo }
      }

      // ── ¿Es un pago, pero es ESTE pago? ─────────────────────────────
      //
      // La compuerta de arriba responde «¿esto es siquiera un comprobante?».
      // Esta responde «¿es el de este pedido?»: un comprobante perfecto de una
      // transferencia a otra persona pasa la primera y falla esta.
      //
      // ⚠️ Va ANTES de subir, por lo mismo que la otra: un comprobante que no
      // cuadra no cuesta almacenamiento y no le enciende la alarma al dueño.
      //
      // ⚠️ Solo cortan las señales CRÍTICAS —cuenta de destino distinta, monto
      // menor—, nunca el nombre de quien paga. La gente transfiere desde la
      // cuenta de su pareja, de su madre o del negocio, y rechazar por eso
      // tiraría pagos buenos: el propio análisis ya decidió no marcar el
      // beneficiario por esa razón. Lo que identifica el destino es la CUENTA.
      //
      // ⚠️ FALLA ABIERTO: sin la dependencia, con el análisis apagado o si
      // revienta, se adjunta y decide el dueño — lo de siempre.
      let cuadre: CuadreDelComprobante | undefined
      if (dependencias.comprobarCuadre && analisis?.ok) {
        cuadre = await dependencias.comprobarCuadre({
          businessId: localDelPedido,
          analisis,
          esperado: {
            // Lo que FALTABA por pagar: sin lo pagado con saldo Umbani.
            total: porCobrar(pedido),
            createdAt: pedido.created_at ?? null,
            clienteNombre: pedido.contact_name ?? null,
          },
        }).catch(() => undefined)
      }
      if (cuadre?.critica) {
        return { adjuntado: false, noCuadra: cuadre.critica }
      }

      const subida = await dependencias.subirPrivado(imagen, localDelPedido)
      const { error } = await dependencias.adjuntar({
        businessId: localDelPedido,
        orderId: String(pedido.id),
        // El del PEDIDO, no el del canal: ver el comentario del tipo.
        contactPhone: String(pedido.contact_phone || contactPhone),
        url: subida.url,
        publicId: subida.public_id,
      })
      if (error) throw new Error(error.message || 'La base rechazó el comprobante')

      // Llegó uno bueno: la cuenta de rechazos vuelve a cero. Se cuenta la
      // INSISTENCIA, no el historial — quien mandó una borrosa, luego la
      // buena, y dentro de un mes otra borrosa, no está probando nada.
      //
      // Sin `await` y sin poder fallar: el comprobante ya está donde tiene que
      // estar, y olvidar un contador no puede deshacerlo.
      if (dependencias.olvidarRechazos && pedido.customer_id) {
        void dependencias.olvidarRechazos(localDelPedido, String(pedido.customer_id))
          .catch(() => { /* el contador se limpiará al siguiente bueno */ })
      }

      // La huella va DESPUÉS de adjuntar, y sin `await` en el camino del
      // cliente: el comprobante ya está donde tiene que estar, y un fallo
      // registrando su huella no puede deshacerlo ni dejar sin respuesta a
      // quien acaba de pagar. Nunca lanza.
      if (dependencias.registrarHuella) {
        void dependencias.registrarHuella({
          businessId: localDelPedido,
          orderId: String(pedido.id),
          imagen,
          fileUrl: subida.url,
          filePublicId: subida.public_id,
          perceptualHash: subida.phash ?? null,
          // Lo ya leído viaja con la huella: volver a llamar al modelo sería
          // pagar dos veces por mirar la misma imagen.
          analisis,
          esperado: {
            // Lo que FALTABA por pagar: sin lo pagado con saldo Umbani.
            total: porCobrar(pedido),
            createdAt: pedido.created_at ?? null,
            clienteNombre: pedido.contact_name ?? null,
          },
        })
      }

      return {
        adjuntado: true,
        orderNumber: pedido.order_number ?? null,
        datosCuadran: cuadre?.limpio === true,
      }
    } catch (error) {
      // El cliente recibe su respuesta igual: esto es una mejora del camino,
      // no el camino. Callarlo sería peor —el dueño creería tener un
      // comprobante que nunca llegó—, así que queda en el registro.
      await dependencias.registrarError({
        businessId,
        category: 'servidor',
        message: error,
        context: { motivo: 'comprobante por WhatsApp', contacto: contactPhone },
      }).catch(() => { /* registrar el fallo no puede provocar otro */ })
      return { adjuntado: false }
    }
  }

/**
 * Lo que se escribe en la conversación cuando la foto era un comprobante.
 *
 * No es un marcador técnico escondido: es la frase que el DUEÑO va a leer en
 * su panel al abrir ese chat, en el sitio donde antes había una imagen sin
 * explicación. Que además sirva para decidir la respuesta es un extra.
 */
export const MARCA_COMPROBANTE = 'su comprobante de pago'

export const textoDelComprobante = (orderNumber?: number | null): string =>
  `[el cliente envió ${MARCA_COMPROBANTE}${orderNumber ? ` del pedido #${orderNumber}` : ''}]`

export const esComprobante = (texto: string): boolean =>
  String(texto || '').includes(MARCA_COMPROBANTE)

/**
 * El marcador dice además si lo leído CUADRÓ.
 *
 * ⚠️ La cola `|cuadra` viaja dentro del texto, igual que la del rechazo lleva
 * los strikes: quien lo escribe ya hizo la comparación, y rehacerla donde se
 * responde sería pagar dos veces por mirar la misma imagen.
 */
export const textoDelComprobanteQueCuadra = (orderNumber?: number | null): string =>
  `${textoDelComprobante(orderNumber)}|cuadra`

export const comprobanteCuadra = (texto: unknown): boolean =>
  String(texto ?? '').includes(`${MARCA_COMPROBANTE}`) && String(texto ?? '').includes('|cuadra')

/** Lo que se le responde. No lleva el enlace: ya pidió, ya pagó. */
export const RESPUESTA_COMPROBANTE =
  'Recibimos tu comprobante 🙌 El local lo está revisando y te avisamos '
  + 'en cuanto empiece a prepararlo.'

/**
 * El acuse cuando lo leído cuadra con el pedido.
 *
 * ⚠️ Dice «los datos coinciden», NO «pago confirmado», y la diferencia no es
 * de estilo: una imagen se puede editar, generar o reutilizar. Ningún estado
 * del comprobante confirma un pago — es una regla del proyecto con pruebas que
 * la vigilan. Lo que esta frase promete es lo único cierto: que lo que se ve
 * encaja con este pedido, y que el dueño lo va a mirar igual.
 */
export const RESPUESTA_COMPROBANTE_CUADRA =
  'Recibimos tu comprobante 🙌 *Los datos coinciden con tu pedido.*\n\n'
  + 'El local lo revisa y te avisamos en cuanto empiece a prepararlo.'

/**
 * Marcador de que el comprobante es un pago, pero NO este pago.
 *
 * ⚠️ Inconfundible con los otros tres: `esComprobante()` busca la subcadena
 * «su comprobante de pago», y un texto que la contuviera le diría al cliente
 * que su pago quedó registrado cuando fue rechazado — justo el error que no se
 * puede cometer aquí.
 */
export const MARCA_COMPROBANTE_NO_CUADRA = 'un pago que no corresponde a este pedido'

export const textoDeComprobanteQueNoCuadra = (motivo?: string | null): string =>
  `[el cliente envió ${MARCA_COMPROBANTE_NO_CUADRA}${motivo ? `|${motivo}` : ''}]`

export const esComprobanteQueNoCuadra = (texto: unknown): boolean =>
  String(texto ?? '').includes(MARCA_COMPROBANTE_NO_CUADRA)

/**
 * El motivo viaja dentro del marcador, y **es para el DUEÑO**, no para el
 * cliente: queda en el historial que él lee en su panel.
 */
export const motivoDelDescuadre = (texto: unknown): string | null => {
  const bruto = String(texto ?? '')
  const i = bruto.indexOf(`${MARCA_COMPROBANTE_NO_CUADRA}|`)
  if (i < 0) return null
  return bruto.slice(i + MARCA_COMPROBANTE_NO_CUADRA.length + 1).replace(/\]$/, '').trim() || null
}

/**
 * Lo que se le responde a quien mandó un comprobante que no cuadra.
 *
 * ⚠️ **UNO SOLO, y no dice qué falló** (decisión del dueño, 2026-09-01). Antes
 * nombraba el motivo —«la cuenta de destino no es la del negocio»— y eso, que
 * parecía amable, es un manual: al que lo intenta le enseña exactamente qué
 * dato tiene que retocar para que cuele la próxima. El motivo sigue existiendo
 * y va al panel del dueño, que es quien tiene que saberlo.
 *
 * ⚠️ **Y NO acusa a nadie.** Puede ser la captura equivocada de la galería o un
 * pago hecho por error. El tono es el de alguien que quiere cobrar, no el de un
 * guardia — la misma regla que ya rige el rechazo de una foto que no es un pago.
 *
 * ⚠️ **La instrucción es siempre la misma**: el comprobante tiene que estar a
 * su nombre. Se dice por delante, en todas partes y sin que haya pasado nada,
 * para que el día que se rechace uno no parezca una norma inventada sobre la
 * marcha.
 */
export const respuestaComprobanteNoCuadra = (_motivo?: string | null): string =>
  '🧾 Recibimos tu comprobante, pero no coincide con este pedido.\n\n'
  + 'Por tu seguridad, el comprobante tiene que ser el de *esta* transferencia '
  + 'y estar *a tu nombre*.\n\n'
  + 'Revísalo y mándanoslo de nuevo 📸'

/**
 * Marcador de que la foto NO era un comprobante.
 *
 * ⚠️ Tiene que ser inconfundible con los otros dos. `esComprobante()` busca la
 * subcadena «su comprobante de pago», así que un texto que la contuviera le
 * diría al cliente que su pago quedó registrado cuando no lo está — que es
 * justo el error que no se puede cometer aquí. Hay una prueba de los tres.
 */
export const MARCA_NO_ES_COMPROBANTE = 'una imagen que no parece un pago'

/**
 * El marcador, con la consecuencia dentro.
 *
 * ⚠️ Viaja EN EL TEXTO igual que el del comprobante ambiguo lleva los nombres
 * de los locales, y por el mismo motivo: quien lo escribe ya consultó la base,
 * y volver a consultarla donde se responde sería pagar dos veces por el mismo
 * dato. El formato es `|n/N` (van n de N) y `|bloqueado:minutos`.
 */
export const textoDeFotoQueNoEsComprobante = (
  rechazo?: { strikes: number; blocked: boolean; limit: number; minutes?: number | null },
): string => {
  if (!rechazo) return `[el cliente envió ${MARCA_NO_ES_COMPROBANTE}]`
  const cola = rechazo.blocked
    ? `|bloqueado:${rechazo.minutes ?? ''}`
    : `|${rechazo.strikes}/${rechazo.limit}`
  return `[el cliente envió ${MARCA_NO_ES_COMPROBANTE}${cola}]`
}

/**
 * Desempaqueta lo que el marcador lleva dentro.
 *
 * Devuelve `undefined` para un marcador sin cola —los que ya circulaban antes
 * de esto—, y entonces la respuesta es la de siempre.
 */
export const rechazoDelMarcador = (texto: unknown): {
  strikes: number; blocked: boolean; limit: number; minutes?: number | null
} | undefined => {
  const t = String(texto || '')
  const i = t.indexOf(MARCA_NO_ES_COMPROBANTE)
  if (i < 0) return undefined
  const cola = t.slice(i + MARCA_NO_ES_COMPROBANTE.length).replace(/\]$/, '')
  if (!cola.startsWith('|')) return undefined

  const dato = cola.slice(1)
  if (dato.startsWith('bloqueado:')) {
    const min = Number(dato.slice('bloqueado:'.length))
    return { strikes: 0, blocked: true, limit: 0, minutes: Number.isFinite(min) ? min : null }
  }
  const [n, total] = dato.split('/').map(Number)
  if (!Number.isFinite(n) || !Number.isFinite(total)) return undefined
  return { strikes: n, blocked: false, limit: total }
}

export const esFotoQueNoEsComprobante = (texto: unknown): boolean =>
  String(texto || '').includes(MARCA_NO_ES_COMPROBANTE)

/**
 * Lo que se le responde a quien manda una foto que no es un comprobante.
 *
 * ⚠️ Dice QUÉ tiene que verse, no solo que está mal. Sin eso la segunda foto
 * suele salir tan inservible como la primera —es la misma lección que dejó
 * `avisarQueFaltaOtroComprobante` el 2026-08-22—, y cada mensaje se paga.
 *
 * ⚠️ Y no acusa a nadie. Puede ser una foto mandada por error, o una captura
 * que salió movida. El tono es el de alguien que quiere cobrar, no el de un
 * guardia.
 */
export const RESPUESTA_NO_ES_COMPROBANTE =
  '🧾 Recibimos tu imagen, pero no parece el comprobante de la transferencia.\n\n'
  + 'Mándanos la captura de tu banco, *a tu nombre*, donde se vea el *valor*, la *fecha* y el '
  + '*número de referencia*, y registramos tu pago enseguida.'

/**
 * Lo que se le responde según CUÁNTAS lleva.
 *
 * ⚠️ Se avisa en la primera de lo que pasa en la segunda. Un bloqueo que llega
 * sin aviso previo se lee como que la app falló — es la misma regla que rige
 * los pedidos sin pagar, y la que separa una norma de un castigo.
 *
 * ⚠️ Y ninguno de los dos textos acusa a nadie. Puede ser una foto mandada por
 * error o una captura movida; el tono es el de alguien que quiere cobrar, no
 * el de un guardia. Solo el del bloqueo nombra las políticas, porque para
 * entonces ya hubo un aviso por delante.
 */
export const respuestaNoEsComprobante = (
  rechazo?: { strikes: number; blocked: boolean; limit: number; minutes?: number | null },
  nombreDelLocal?: string | null,
): string => {
  if (!rechazo) return RESPUESTA_NO_ES_COMPROBANTE

  if (rechazo.blocked) {
    const plazo = enPalabrasElPlazo(rechazo.minutes)
    const local = nombreDelLocal ? ` en ${nombreDelLocal}` : ''
    return `🚫 *No puedes pedir${local} por ${plazo}*\n\n`
      + 'Mandaste varias imágenes que no eran comprobantes de pago, así que se '
      + 'cerró tu acceso por incumplir las políticas de Umbani.\n\n'
      + `Pasados los ${plazo} podrás volver a pedir con normalidad. Mientras `
      + 'tanto puedes pedir en los demás locales.'
  }

  const quedan = rechazo.limit - rechazo.strikes
  if (quedan > 0) {
    return `${RESPUESTA_NO_ES_COMPROBANTE}\n\n`
      + '⚠️ Si la siguiente tampoco es un comprobante, no podrás pedir en este '
      + 'local durante un rato.'
  }
  return RESPUESTA_NO_ES_COMPROBANTE
}

/** «30 minutos», «2 horas», «1 día». El mismo criterio que en los avisos. */
const enPalabrasElPlazo = (minutos?: number | null): string => {
  const m = Number(minutos)
  if (!Number.isFinite(m) || m <= 0) return 'un rato'
  if (m < 60) return `${m} ${m === 1 ? 'minuto' : 'minutos'}`
  const horas = Math.round(m / 60)
  if (horas < 24) return `${horas} ${horas === 1 ? 'hora' : 'horas'}`
  const dias = Math.round(horas / 24)
  return `${dias} ${dias === 1 ? 'día' : 'días'}`
}

/** Marcador de que la foto era un comprobante pero no se sabe de qué local. */
export const MARCA_COMPROBANTE_AMBIGUO = 'un comprobante sin local claro'

export const textoDelComprobanteAmbiguo = (
  ambiguos: NonNullable<ResultadoComprobante['ambiguos']>,
): string => `[el cliente envió ${MARCA_COMPROBANTE_AMBIGUO}: ${
  ambiguos.map(p => p.businessName).join(' / ')
}]`

export const esComprobanteAmbiguo = (texto: unknown): boolean =>
  String(texto || '').includes(MARCA_COMPROBANTE_AMBIGUO)

/**
 * Lo que se le pregunta al cliente cuando tiene pagos pendientes en más de un
 * local y manda una foto sin decir de cuál es.
 *
 * ⚠️ Se PREGUNTA en vez de adivinar. Con un solo número para todo el
 * marketplace, el teléfono ya no dice de quién es el pago; adjuntarlo al más
 * reciente daría por cobrado a un local lo que pagó otro, y el cliente que sí
 * pagó seguiría en la pantalla de espera. Un mensaje de más es más barato que
 * un pago mal atribuido.
 */
export const preguntaDeQueLocal = (
  ambiguos: NonNullable<ResultadoComprobante['ambiguos']>,
): string => {
  const lineas = ambiguos.map((pedido) => {
    const numero = pedido.orderNumber ? ` (pedido #${pedido.orderNumber})` : ''
    return `• *${pedido.businessName}*${numero}`
  })
  return '🧾 Recibimos tu comprobante, pero tienes pagos pendientes en más de un local.\n\n'
    + `${lineas.join('\n')}\n\n`
    + 'Respóndenos con el nombre del local al que corresponde y lo registramos.'
}
