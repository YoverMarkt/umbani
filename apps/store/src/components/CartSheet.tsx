import { Suspense, lazy, useState } from 'react'
import {
  RiErrorWarningLine,
  RiAddLine,
  RiBankCardLine,
  RiBankLine,
  RiDeleteBin6Line,
  RiEBikeLine,
  RiFocus3Line,
  RiMapPin2Line,
  RiMoneyDollarCircleLine,
  RiShoppingBag3Line,
  RiShoppingCart2Line,
} from '@remixicon/react'
import { Aviso, Boton, Contador, EstadoVacio, Foto, Hoja, Marca, ROTULO } from './ui'
import { money } from '../lib/format'
import {
  cartTotal, detalleDeLinea, esPlatoPorPartes, lineTotal, needsAddress, orderTotal,
} from '../lib/cart'
import { MENSAJES, pedirUbicacion } from '../lib/ubicacion'

/**
 * El formulario de dirección se DESCARGA APARTE.
 *
 * ⚠️ No es una optimización de manual: al unificarlo pasó a este componente,
 * que sí entra en el arranque, y la mini app se salió del presupuesto de
 * tamaño (96 kB) que existe porque la tienda se abre con datos móviles. Es
 * una pantalla secundaria —solo la ve quien no tiene dirección guardada—, así
 * que no tiene por qué pesar en el primer pintado. `DireccionRapida`, que ya
 * se cargaba aparte, comparte el mismo trozo.
 */
const FormularioDireccion = lazy(() => import('./FormularioDireccion'))
import type { Ubicacion } from '../lib/ubicacion'
import type { Address, CartLine, Fulfillment, Me, PaymentMethod, StorePaymentMethod } from '../lib/types'

/** Un icono por método. Uno que no esté en la lista cae en el genérico. */
const ICONO_PAGO: Record<string, typeof RiBankLine> = {
  transferencia: RiBankLine,
  efectivo: RiMoneyDollarCircleLine,
  pago_al_retirar: RiShoppingBag3Line,
  tarjeta: RiBankCardLine,
}

// El carrito y el cierre del pedido, en una sola hoja.
//
// El total que se ve aquí es informativo. Al confirmar se mandan ids y
// cantidades, y el importe real lo devuelve el servidor: si el negocio cambió
// un precio hace un minuto, gana el suyo.

/** Lo que se manda al guardar una dirección. El pin viaja aparte y es opcional. */
export interface NuevaDireccion {
  label: string
  address: string
  reference: string
  buildingType: string
  latitude?: number
  longitude?: number
  accuracy?: number | null
}

/** Con pin es tener los DOS: media coordenada apunta al ecuador, no a medias. */
const tieneUbicacion = (direccion: Address): boolean =>
  direccion.latitude !== null && direccion.latitude !== undefined
  && direccion.longitude !== null && direccion.longitude !== undefined

export default function CartSheet({
  abierta, onCerrar, lines, onCantidad, onEditar, me, puedePedir, enviando, error, deliveryFee, serviceFee,
  minOrderAmount, entrega, paymentMethods, onEntrega, onConfirmar, onNuevaDireccion,
  onUbicarDireccion, onBorrarDireccion,
}: {
  abierta: boolean
  onCerrar: () => void
  lines: CartLine[]
  onCantidad: (key: string, cantidad: number) => void
  /**
   * Reabre la ficha de un plato por partes con lo que ya lleva la mesa. Esa
   * línea no se cambia con un contador: «2» sería pedir la mesa entera dos
   * veces, y la base la rechaza. Se edita entera, sopa por sopa.
   */
  onEditar: (product: CartLine['product']) => void
  me: Me | null
  puedePedir: boolean
  enviando: boolean
  error: string | null
  deliveryFee: number
  /** La tarifa de servicio. Se enseña ANTES de confirmar, como su propia línea. */
  serviceFee: number
  /** Lo mínimo que el local prepara, sin el envío. Cero = sin mínimo. */
  minOrderAmount: number
  /**
   * Cómo lo recibe. Llega de fuera porque también se elige en la portada, y
   * las dos pantallas tienen que reflejar la MISMA decisión: con un estado
   * aquí dentro, elegir «Retiro» arriba y abrir el carrito volvía a «Entrega»
   * y el cliente pagaba un envío que había rechazado.
   */
  entrega: Fulfillment
  /**
   * Los métodos que ESTE local acepta, tal como los manda el servidor.
   *
   * Llega de fuera y no se decide aquí: hasta el 2026-08-16 los tres estaban
   * escritos en este archivo y el dueño no elegía nada.
   */
  paymentMethods: StorePaymentMethod[]
  onEntrega: (entrega: Fulfillment) => void
  onConfirmar: (datos: {
    fulfillment: Fulfillment
    addressId: string | null
    name: string
    paymentMethod: PaymentMethod
    deliveryNotes: string | null
  }) => void
  /** Devuelve el id de la dirección creada: se selecciona sola para ESTE pedido. */
  onNuevaDireccion: (datos: NuevaDireccion) => Promise<string | null>
  /** Le pone el pin a una dirección ya guardada, que es la que no lo tiene. */
  onUbicarDireccion: (addressId: string, ubicacion: Ubicacion) => Promise<void>
  onBorrarDireccion: (addressId: string) => Promise<void>
}) {
  /**
   * En qué paso está el cliente.
   *
   * ⚠️ Son dos pantallas y no una hoja larga a propósito. Mezcladas, el
   * cliente tenía que pasar por encima de la dirección y del método de pago
   * solo para comprobar qué llevaba, y el botón de confirmar quedaba a un
   * scroll de distancia de los productos. Revisar y decidir son dos momentos
   * distintos: el carrito revisa, el checkout decide.
   */
  const [paso, setPaso] = useState<'carrito' | 'checkout' | 'direccion'>('carrito')
  const [pago, setPago] = useState<PaymentMethod>('transferencia')
  const [direccionId, setDireccionId] = useState<string | null>(null)
  /**
   * `null` = el cliente no ha tocado el campo; una cadena = lo que escribió,
   * aunque sea vacía.
   *
   * La distinción no es un capricho. Antes era `value={nombre || me?.name}`
   * sobre un estado que empezaba vacío: el campo se veía relleno pero el
   * estado no lo estaba, así que al borrarlo reaparecía el nombre guardado y
   * no había forma de cambiárselo. Y guardar `me.name` en el estado inicial
   * tampoco vale: este panel se monta con la tienda, ANTES de que `me`
   * responda, así que el valor inicial siempre sería vacío.
   */
  const [nombreEscrito, setNombreEscrito] = useState<string | null>(null)
  const nombre = nombreEscrito ?? me?.name ?? ''
  // Lo que cambia de un pedido a otro: «llame al llegar», «timbre roto». La
  // referencia de la dirección es del SITIO y se queda; esto es de HOY.
  const [instrucciones, setInstrucciones] = useState('')
  const [avisoPin, setAvisoPin] = useState<string | null>(null)
  /** Qué dirección está pidiendo ubicación: `'nueva'`, un id, o nada. */
  const [ubicando, setUbicando] = useState<string | null>(null)
  /** Qué dirección se está retirando. Evita el doble toque. */
  const [borrando, setBorrando] = useState<string | null>(null)

  const borrarDireccion = async (direccion: Address) => {
    // Confirmar antes: la papelera está a un centímetro de elegir la
    // dirección, y perderla por un dedo grande no se deshace.
    if (!window.confirm(`¿Eliminar «${direccion.label}»?`)) return
    setBorrando(direccion.id)
    try {
      await onBorrarDireccion(direccion.id)
      // Si era la elegida, se suelta: dejar seleccionada una que ya no está
      // mandaría el pedido con un id que el servidor va a rechazar.
      if (direccionId === direccion.id) setDireccionId(null)
    } finally {
      setBorrando(null)
    }
  }

  // Solo para ponerle el pin a una dirección YA guardada. El de una dirección
  // nueva lo lleva `FormularioDireccion`, con el suyo propio.
  const capturar = async (destino: string) => {
    setUbicando(destino)
    setAvisoPin(null)
    try {
      const resultado = await pedirUbicacion()
      if (!resultado.ok) {
        setAvisoPin(resultado.mensaje)
        return
      }
      await onUbicarDireccion(destino, resultado.ubicacion)
    } catch {
      // Ni un fallo inesperado puede dejar al cliente sin poder pedir.
      setAvisoPin(MENSAJES.no_disponible)
    } finally {
      setUbicando(null)
    }
  }

  // Cerrar y volver a abrir empieza por el carrito: si la hoja se reabriera en
  // el checkout, el cliente no vería lo que está a punto de pagar.
  const cerrar = () => {
    setPaso('carrito')
    onCerrar()
  }

  const direcciones: Address[] = me?.addresses || []
  const elegida = direccionId || direcciones.find(item => item.is_default)?.id || direcciones[0]?.id || null
  const nombreFinal = nombre.trim()
  const faltaDireccion = needsAddress(entrega) && !elegida
  // Al pasar de retiro a domicilio, «pago al retirar» deja de tener sentido.
  // Se DERIVA en vez de corregir el estado durante el render: así no hay un
  // repintado extra ni un instante en que el método guardado sea imposible.
  const pagoEfectivo: PaymentMethod =
    needsAddress(entrega) && pago === 'pago_al_retirar' ? 'efectivo' : pago
  const faltaNombre = nombreFinal.length < 2

  /**
   * Guarda la dirección que acaba de escribir el cliente en el paso anterior.
   *
   * ⚠️ Queda ELEGIDA. Quien escribe una dirección en el checkout la escribe
   * para ESTE pedido; sin esto seguía seleccionada la anterior y el pedido
   * salía a la casa vieja mientras la app decía «guardada».
   */
  const guardarDireccion = async (datos: NuevaDireccion) => {
    const creadaId = await onNuevaDireccion(datos)
    if (creadaId) setDireccionId(creadaId)
    return creadaId
  }

  const opcionesEntrega = [
    { id: 'delivery' as const, icono: RiEBikeLine, texto: 'A domicilio' },
    { id: 'pickup' as const, icono: RiShoppingBag3Line, texto: 'Yo lo recojo' },
  ]

  // «Pago al retirar» no es cómo paga, es CUÁNDO: al pasar por el local. Solo
  // se ofrece en retiro — prometérselo a quien pidió a domicilio es ofrecer
  // algo que no se puede cumplir. El servidor lo vuelve a comprobar.
  //
  // ⚠️ La lista sale del NEGOCIO, no de aquí. Hasta el 2026-08-16 estaban los
  // tres escritos a mano, así que el dueño creía que elegía cómo le pagan y no
  // elegía nada. Ahora se pinta lo que el servidor dice que acepta, y el
  // servidor lo vuelve a exigir al crear el pedido.
  const opcionesPago = paymentMethods
    .filter((m: StorePaymentMethod) => m.code !== 'pago_al_retirar' || !needsAddress(entrega))
    .map((m: StorePaymentMethod) => ({
      id: m.code as PaymentMethod,
      icono: ICONO_PAGO[m.code] || RiBankLine,
      // El texto del catálogo manda; el matiz de entrega/retiro solo aplica
      // al efectivo, que es el único que cambia de significado según cómo se
      // reciba el pedido.
      texto: m.code === 'efectivo' && !needsAddress(entrega) ? 'Efectivo' : m.label,
      detalle: m.code === 'efectivo' && !needsAddress(entrega)
        ? 'Pagas en efectivo en el local.'
        : m.help_text || '',
    }))

  // Vista previa del envío. El importe que manda es el que calcula el servidor
  // al crear el pedido: aquí solo se anticipa para que nadie se lleve sorpresas.
  const subtotal = cartTotal(lines)
  // ⚠️ Sobre el SUBTOTAL, sin el envío: el local decide cuánto vale la pena
  // cocinar, no cuánto gasta el cliente. Quien quiera un agua y pagar el
  // reparto está en su derecho. Es la misma cuenta que hace la base en
  // `orders_enforce_min_amount`, y tienen que coincidir o el botón dejaría
  // pasar un pedido que se rechaza al confirmar.
  const faltaParaElMinimo = minOrderAmount > 0
    ? Math.max(0, Math.round((minOrderAmount - subtotal) * 100) / 100)
    : 0
  // ⚠️ Sin líneas no hay envío que cobrar. Igual que en `orderTotal`: el
  // carrito vacío enseñaba «Envío $2.00» y «Total $2.00» sobre cero
  // productos. Los dos sitios tienen que contar lo mismo o el desglose no
  // sumaría el total que hay justo debajo.
  const envio = lines.length && needsAddress(entrega) ? deliveryFee : 0
  const tarifa = lines.length ? serviceFee : 0
  const total = orderTotal(lines, entrega, deliveryFee, tarifa)

  const enCarrito = paso === 'carrito'
  const enDireccion = paso === 'direccion'

  // ⚠️ La flecha vuelve al paso ANTERIOR, no siempre al carrito: desde la
  // dirección se vuelve al checkout, que es de donde se vino. Mandarla al
  // carrito obligaría a rehacer el camino entero por escribir una calle.
  const TITULOS = {
    carrito: 'Tu carrito',
    checkout: 'Finalizar pedido',
    direccion: '¿A dónde te lo llevamos?',
  } as const

  return (
    <Hoja
      abierta={abierta}
      onCerrar={cerrar}
      onAtras={enCarrito ? undefined : () => setPaso(enDireccion ? 'checkout' : 'carrito')}
      titulo={TITULOS[paso]}
    >
      {/* ⚠️ El cuerpo va sobre el OFF-WHITE, no sobre el blanco de la hoja:
          con las tarjetas blancas sobre fondo blanco, lo único que las separa
          es la sombra y esto se lee como un formulario. Mismo fondo que la
          carta de la que el cliente viene. */}
      <div className="fondo-app space-y-6 p-4">
        {/* ── PASO 1: solo lo que lleva ─────────────────────────────────── */}
        {enCarrito && !lines.length && (
          <EstadoVacio icono={<RiShoppingCart2Line size={28} />} titulo="Tu carrito está vacío">
            Vuelve a la carta y agrega lo que quieras pedir.
          </EstadoVacio>
        )}

        {enCarrito && (
        <section className="space-y-2.5">
          {lines.map(linea => (
            /* ⚠️ Con FOTO, que es lo que pedía el diseño desde el principio
               («líneas con foto pequeña, nombre, lo elegido, contador y
               precio») y no estaba. Importa más aquí que en ninguna otra
               pantalla: es lo último que el cliente mira antes de pagar, y
               reconocer lo que lleva por la imagen es más rápido que leer
               cuatro nombres. Sin foto queda el marcador con la inicial, que
               hoy es el estado normal. */
            <div
              key={linea.key}
              className="superficie flex gap-3 rounded-(--radius-tarjeta) p-3 shadow-tarjeta"
            >
              <div className="size-18 shrink-0 overflow-hidden rounded-xl">
                <Foto
                  url={linea.product.imageUrl}
                  alto="h-18"
                  uso="miniatura"
                  nombre={linea.product.name}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2.5">
                  <p className="min-w-0 text-[15px] leading-snug font-bold tracking-tight">
                    {linea.product.name}
                  </p>
                  <span className="shrink-0 text-[15px] font-extrabold tracking-tight tabular-nums">
                    {money(lineTotal(linea))}
                  </span>
                </div>
                {linea.variant && (
                  <p className="text-[12.5px] leading-snug texto-cuerpo">{linea.variant.name}</p>
                )}
                {/* ⚠️ Lo que eligió, una línea por grupo. Faltaba: el carrito
                    pintaba solo `extras` —el sistema viejo— así que una pizza
                    con masa, sabor y borde salía como «Pizza · Familiar» y el
                    cliente confirmaba sin ver lo que había armado. Es la
                    pantalla donde más importa: es la última antes de pagar. */}
                {detalleDeLinea(linea).map(texto => (
                  <p key={texto} className="line-clamp-2 text-[12.5px] leading-snug texto-cuerpo">
                    {texto}
                  </p>
                ))}
                {linea.note && (
                  <p className="mt-0.5 text-[12.5px] leading-snug italic texto-cuerpo">
                    «{linea.note}»
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  {/* La mesa de un plato por partes se EDITA, no se cuenta: su
                      contador diría «2» y pediría la mesa entera dos veces, que
                      la base rechaza. «Editar» reabre la ficha con lo que lleva. */}
                  {esPlatoPorPartes(linea.product)
                    ? (
                        <button
                          type="button"
                          onClick={() => onEditar(linea.product)}
                          className="superficie borde-tema h-11 rounded-full border-2 px-5 text-[14px] font-bold transition active:scale-95"
                        >
                          Editar
                        </button>
                      )
                    : (
                        <Contador
                          valor={linea.quantity}
                          minimo={0}
                          onCambiar={cantidad => onCantidad(linea.key, cantidad)}
                        />
                      )}
                  {/* 44×44 reales: era un icono de 17 px sin caja, o sea una
                      diana de 17 para una acción que quita algo del pedido. */}
                  <button
                    onClick={() => onCantidad(linea.key, 0)}
                    aria-label={`Quitar ${linea.product.name}`}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full texto-cuerpo transition active:scale-90 active:bg-black/5"
                  >
                    <RiDeleteBin6Line size={17} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </section>
        )}

        {/* ── PASO 3: escribir una dirección nueva ──────────────────────
            La MISMA pantalla que salta al primer «Agregar», no un formulario
            propio: ver `FormularioDireccion`. Sin resumen ni total debajo —
            aquí no se decide una compra, se escribe una calle, y el botón que
            importa es «Guardar». */}
        {enDireccion && (
          /* ⚠️ SIN padding propio: el cuerpo de la hoja ya trae `p-4`, y
              ponerlo otra vez aquí restaba 32 px de ancho a los campos. Se
              notaba comparándolo con la misma pantalla del primer «Agregar»,
              que sí los lleva a todo lo ancho — mismo formulario y dos anchos
              distintos. Lo vio el dueño en staging (2026-09-20). */
          <section className="space-y-4">
            <p className="text-[14px] leading-relaxed texto-cuerpo">
              Guárdala una vez y no te la volvemos a pedir. La usamos solo para
              llevarte el pedido.
            </p>
            {/* Sin `fallback`: mientras baja, lo correcto es que no se vea
                nada. Un esqueleto que aparece y desaparece molesta más que el
                cuarto de segundo que tarda — el mismo criterio que la hoja de
                la portada. */}
            <Suspense fallback={null}>
              <FormularioDireccion
                onGuardar={guardarDireccion}
                onListo={() => setPaso('checkout')}
                textoGuardar="Guardar dirección"
              />
            </Suspense>
          </section>
        )}

        {/* ── PASO 2: cómo lo recibe, a dónde, cómo paga y quién ────────── */}
        {paso === 'checkout' && (
        <>
        <section>
          <h3 className={ROTULO}>¿Cómo lo quieres?</h3>
          <div className="grid grid-cols-2 gap-2">
            {opcionesEntrega.map(({ id, icono: Icono, texto }) => (
              <button
                key={id}
                onClick={() => onEntrega(id)}
                // ⚠️ Acento SÓLIDO. Estaba como color de letra sobre su propio
                // tinte, con 1,80:1 de contraste para el verde de Monster Pizza
                // —AA exige 4,5— y 1,19:1 con el lima de la plataforma. La regla
                // ya estaba escrita en `index.css`: «un lima sobre blanco no se
                // lee al sol».
                className={`flex items-center justify-center gap-2 rounded-(--radius-tarjeta) border-2 px-3 py-4 text-[14px] font-bold transition active:scale-[0.98] ${
                  entrega === id
                    ? 'acento border-transparent shadow-acento'
                    : 'superficie borde-tema texto-cuerpo shadow-tarjeta'
                }`}
              >
                <Icono size={17} />
                {texto}
              </button>
            ))}
          </div>
        </section>

        {/* ── A dónde ── */}
        {needsAddress(entrega) && (
          <section>
            <h3 className={ROTULO}>Dirección</h3>
            <div className="space-y-2">
              {direcciones.map(direccion => (
                <div
                  key={direccion.id}
                  className={`superficie flex w-full items-start gap-2 rounded-(--radius-tarjeta) border-2 px-4 py-3.5 transition ${
                    elegida === direccion.id
                      ? 'border-(--tinta) bg-marca-suave'
                      : 'borde-tema shadow-tarjeta'
                  }`}
                >
                <button
                  onClick={() => setDireccionId(direccion.id)}
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                >
                  <RiMapPin2Line size={17} className="mt-0.5 shrink-0 texto-cuerpo" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] font-bold tracking-tight">{direccion.label}</span>
                    <span className="block text-[13px] texto-cuerpo">{direccion.address}</span>
                    {direccion.reference && (
                      <span className="block text-[12.5px] texto-tenue">{direccion.reference}</span>
                    )}
                    {/* Las direcciones de siempre no tienen pin. Se ofrece
                        añadirlo aquí porque el cliente que ya tiene la suya
                        guardada es justo el que más pide. */}
                    {tieneUbicacion(direccion)
                      ? (
                          /* ⚠️ `text-verde` NO EXISTÍA: no hay ningún
                             `--color-verde` en el tema, así que Tailwind no
                             emitía la clase y esto salía en el color
                             heredado. Es el fallo silencioso de una utilidad
                             mal escrita — no rompe el build, simplemente no
                             existe. `emerald` es el mismo verde de acierto
                             que ya usa `DireccionRapida`. */
                          <span className="mt-1 flex items-center gap-1 text-[12px] font-semibold text-emerald-700">
                            <RiFocus3Line size={12} /> Ubicación guardada
                          </span>
                        )
                      : (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(event) => { event.stopPropagation(); void capturar(direccion.id) }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return
                              event.preventDefault()
                              event.stopPropagation()
                              void capturar(direccion.id)
                            }}
                            // Acción secundaria: va en tinta subrayada. En
                            // acento no se leería (ver el contraste de arriba).
                            // 18 px de alto medidos: con `py-2` la diana
                            // llega a la altura de un dedo sin mover nada de
                            // sitio, porque el hueco ya estaba en el margen.
                            className="-my-1.5 mt-0.5 flex items-center gap-1 py-3.5 text-[12px] font-semibold underline underline-offset-2"
                          >
                            <RiFocus3Line size={12} />
                            {ubicando === direccion.id ? 'Buscando…' : 'Agregar ubicación'}
                          </span>
                        )}
                  </span>
                  <Marca activa={elegida === direccion.id} unica />
                </button>
                {/* Borrar pide confirmación: está a un centímetro de elegir, y
                    perder una dirección por un dedo grande es una molestia que
                    no se deshace.
                    44×44 reales, como pide el diseño: iba en `p-1.5` sobre un
                    icono de 16, o sea 28 px de diana para algo que borra. */}
                <button
                  onClick={() => void borrarDireccion(direccion)}
                  disabled={borrando === direccion.id}
                  aria-label={`Eliminar ${direccion.label}`}
                  className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full texto-cuerpo transition active:scale-90 active:bg-black/5"
                >
                  <RiDeleteBin6Line size={16} />
                </button>
                </div>
              ))}

              {/* ⚠️ El aviso de que el GPS falló va AQUÍ, y antes no se
                  veía nunca: vivía dentro del formulario de dirección nueva,
                  que normalmente está cerrado cuando alguien toca «Agregar
                  ubicación» en una dirección que ya tiene guardada. El
                  permiso denegado se quedaba mudo y el cliente volvía a
                  tocar. Al retirar aquel formulario quedó a la vista. */}
              {avisoPin && (
                <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13px] font-medium text-amber-700">
                  {avisoPin}
                </p>
              )}

              {/* ⚠️ Lleva a un PASO de esta misma hoja, no abre un
                  formulario aquí dentro ni una ventana encima.

                  Aquí vivía un formulario propio —con un `select` y el pin
                  abajo, de secundario— que hacía lo mismo que la pantalla
                  «¿A dónde te lo llevamos?» del primer «Agregar», con otra
                  cara. Dos formularios para lo mismo: el cliente aprendía los
                  dos y nosotros manteníamos los dos, que ya habían empezado a
                  divergir. Lo vio el dueño probando La Abuelita (2026-09-19).

                  Gana la otra, y el motivo no es estético: pone «Usar mi
                  ubicación actual» ARRIBA y grande. El pin es el dato que hace
                  que el repartidor llegue —una calle escrita en un barrio sin
                  numerar puede ser cualquier sitio—, y enterrarlo al final
                  empujaba al camino peor.

                  Un paso y no una ventana encima porque la hoja ya sabe ir y
                  volver (`onAtras`): apilar dos modales deja el aspa
                  ambigua — ¿cierro la dirección o el pedido? */}
              <button
                onClick={() => setPaso('direccion')}
                className="flex w-full items-center justify-center gap-2 rounded-(--radius-tarjeta) border-2 border-dashed borde-tema px-4 py-3.5 text-[14px] font-bold texto-cuerpo transition active:scale-[0.98]"
              >
                <RiAddLine size={17} />
                Agregar dirección
              </button>
            </div>
          </section>
        )}

        {/* ── Instrucciones ──
            Va tras la dirección y antes del pago, como la pantalla 9. Solo a
            domicilio: a quien retira no hay nada que indicarle. */}
        {needsAddress(entrega) && (
          <section>
            <h3 className={ROTULO}>
              <span>Instrucciones</span>
              <span className="shrink-0 text-[11px] font-semibold tracking-normal normal-case texto-tenue">
                Opcional
              </span>
            </h3>
            <input
              value={instrucciones}
              onChange={event => setInstrucciones(event.target.value.slice(0, 300))}
              placeholder="Ej: llame al llegar, timbre roto…"
              className="superficie w-full rounded-(--radius-tarjeta) border-2 borde-tema px-4 py-3.5 text-[14px] shadow-tarjeta outline-none focus:border-(--tinta) placeholder:texto-tenue"
            />
          </section>
        )}

        {/* ── Cómo paga ── */}
        {/* La tarjeta NO está y no es un olvido: la plataforma no procesa
            cobros (regla inviolable #6). El negocio cobra por fuera. */}
        <section>
          <h3 className={ROTULO}>¿Cómo vas a pagar?</h3>
          <div className="space-y-2">
            {opcionesPago.map(({ id, icono: Icono, texto, detalle }) => (
              /* ⚠️ Mismo arreglo que en las direcciones: el elegido se marcaba
                 solo con `border-(--acento)`, y un borde lima sobre blanco da
                 1,19:1. Ahora lo dicen el marco de tinta y la marca de
                 selección; el tinte del acento se queda de fondo. */
              <button
                key={id}
                onClick={() => setPago(id)}
                className={`superficie flex w-full items-center gap-3 rounded-(--radius-tarjeta) border-2 px-4 py-3.5 text-left transition ${
                  pagoEfectivo === id
                    ? 'border-(--tinta) bg-marca-suave'
                    : 'borde-tema shadow-tarjeta'
                }`}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-black/5">
                  <Icono size={18} className="texto-cuerpo" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-bold tracking-tight">{texto}</span>
                  {detalle && (
                    <span className="block text-[12.5px] leading-snug texto-cuerpo">{detalle}</span>
                  )}
                </span>
                <Marca activa={pagoEfectivo === id} unica />
              </button>
            ))}
          </div>
        </section>

        {/* ── Quién ── */}
        <section>
          <h3 className={ROTULO}>A nombre de</h3>
          <input
            value={nombre}
            onChange={event => setNombreEscrito(event.target.value.slice(0, 120))}
            placeholder="Tu nombre"
            className="superficie w-full rounded-(--radius-tarjeta) border-2 borde-tema px-4 py-3.5 text-[15px] font-semibold shadow-tarjeta outline-none focus:border-(--tinta) placeholder:font-normal placeholder:texto-tenue"
          />
          {me?.phone && (
            <p className="mt-2 px-1 text-[12.5px] texto-cuerpo">
              Si hace falta, te llamamos al {me.phone}.
            </p>
          )}
        </section>
        </>
        )}

        {error && <Aviso tono="alerta" icono={<RiErrorWarningLine size={18} />}>{error}</Aviso>}
      </div>

      {/* ⚠️ El pie NO se pinta al escribir una dirección. Ahí el botón que
          importa es «Guardar dirección», y un «Confirmar pedido · $2.83»
          pegado debajo compite con él y deja al cliente sin saber cuál cierra
          qué. Además el resumen no cambia por escribir una calle: repetirlo
          es ruido. */}
      {!enDireccion && (
      <div className="superficie sticky bottom-0 border-t borde-tema px-4 pt-3 pb-seguro">
        {/* ⚠️ El desglose en `texto-cuerpo`, no en el gris de metadatos: a
            13,5 px, `texto-tenue` da 3,17:1 sobre blanco y esto es lo que el
            cliente comprueba antes de pagar. Es el mismo argumento que ya
            estaba escrito para el resumen del pedido recibido. */}
        <div className="mb-3 space-y-1.5">
          <div className="flex items-baseline justify-between text-[13.5px] texto-cuerpo">
            <span>Subtotal</span>
            <span className="tabular-nums">{money(subtotal)}</span>
          </div>
          {/* ⚠️ El mínimo solo cuando FALTA. Superado ya, esta fila decía
              «Pedido mínimo $5.00» junto a un subtotal de $20.70: informa de un
              requisito cumplido justo en la pantalla donde el cliente comprueba
              lo que va a pagar, y cada línea de más ahí es una duda de más.
              Cuando de verdad falta, sigue estando — y el botón dice además
              cuánto. */}
          {faltaParaElMinimo > 0 && (
            <div className="flex items-baseline justify-between text-[13.5px] texto-cuerpo">
              <span>Pedido mínimo</span>
              <span className="tabular-nums">{money(minOrderAmount)}</span>
            </div>
          )}
          <div className="flex items-baseline justify-between text-[13.5px] texto-cuerpo">
            <span>Envío</span>
            <span className="tabular-nums">
              {entrega === 'pickup' ? 'Retiras en el local' : envio > 0 ? money(envio) : 'Gratis'}
            </span>
          </div>
          {/* La tarifa de servicio va en su PROPIA línea y antes de confirmar:
              es lo que hacen las grandes, y un cargo que aparece al final se
              lee como un engaño. Igual para todo método de pago. */}
          {tarifa > 0 && (
            <div className="flex items-baseline justify-between text-[13.5px] texto-cuerpo">
              <span>Tarifa de servicio</span>
              <span className="tabular-nums">{money(tarifa)}</span>
            </div>
          )}
          <div className="flex items-baseline justify-between border-t borde-tema pt-2.5">
            <span className="text-[15px] font-bold tracking-tight">Total</span>
            <span className="text-[24px] font-extrabold tracking-tight tabular-nums">{money(total)}</span>
          </div>
        </div>
        {/* ⚠️ El botón dice QUÉ FALTA, no «completa los datos». Con seis
            bloques encima, «faltan datos» deja al cliente buscando cuál. */}
        {enCarrito
          ? (
              <Boton
                onClick={() => setPaso('checkout')}
                disabled={!puedePedir || !lines.length || faltaParaElMinimo > 0}
              >
                {!lines.length
                  ? 'Tu carrito está vacío'
                  : !puedePedir
                    ? 'El local está cerrado'
                    : faltaParaElMinimo > 0
                      // Dice CUÁNTO falta, no «no llegas al mínimo»: con el
                      // número exacto el cliente sabe qué añadir.
                      ? `Te faltan ${money(faltaParaElMinimo)} para el mínimo`
                      : `Continuar · ${money(total)}`}
              </Boton>
            )
          : (
              <Boton
                onClick={() => onConfirmar({
                  fulfillment: entrega, addressId: elegida, name: nombreFinal,
                  paymentMethod: pagoEfectivo, deliveryNotes: instrucciones.trim() || null,
                })}
                disabled={!puedePedir || enviando || faltaDireccion || faltaNombre || !lines.length || faltaParaElMinimo > 0}
              >
                {enviando
                  ? 'Enviando…'
                  : faltaNombre
                    ? 'Escribe tu nombre'
                    : faltaDireccion
                      ? 'Elige una dirección'
                      : pagoEfectivo === 'tarjeta'
                        ? `Pagar con tarjeta · ${money(total)}`
                        : `Confirmar pedido · ${money(total)}`}
              </Boton>
            )}
        <p className="mt-2.5 text-center text-[11.5px] texto-cuerpo">
          {pagoEfectivo === 'tarjeta'
            ? 'Pagas en la página segura de PayPhone. Tus datos de tarjeta no pasan por Umbani.'
            : 'El local confirma tu pedido y lo sigues en «Mis pedidos».'}
        </p>
      </div>
      )}
    </Hoja>
  )
}
