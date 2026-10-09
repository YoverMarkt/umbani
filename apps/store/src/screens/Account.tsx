import { useEffect, useState } from 'react'
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiDeleteBin6Line,
  RiLockLine,
  RiErrorWarningLine,
  RiMapPin2Line,
  RiShoppingBag3Line,
} from '@remixicon/react'
import { Aviso, Boton, EstadoVacio } from '../components/ui'
import { LlegoTodoBien } from '../components/LlegoTodoBien'
import { getOrders } from '../lib/api'
import { COMO_VA, PILL_ACTIVO, PILL_QUIETO } from '../lib/como-va'
import { money } from '../lib/format'
import { DIRECCION_DE_UMBANI } from '../lib/umbani'
import type { Address, Me, TrackedOrder } from '../lib/types'

// ── LA CUENTA DEL CLIENTE ──────────────────────────────────────────────────
//
// Sus pedidos y sus direcciones, en un solo sitio.
//
// La pestaña de abajo decía «Pedido» y abría el ÚLTIMO pedido directamente.
// Servía mientras solo hubiera uno del que preocuparse, pero un cliente que ha
// pedido cinco veces no tiene «un pedido»: tiene un historial. Y desde que la
// pantalla de pago dejó de ofrecer el atajo al seguimiento, hacía falta una
// puerta estable para mirar cómo va lo de uno.
//
// Es la casa de lo que venga después: datos personales, favoritos, o lo que el
// dueño decida. Hoy son dos secciones y ya justifica la pestaña.
//
// ⚠️ La lista de pedidos es de SOLO LECTURA desde el 2026-08-12: una fila que
// no lleva a ninguna parte no debe FINGIR que sí, así que no es un botón. Lo
// que lleva es el estado dicho en cristiano junto a cada pedido, y desde el
// 2026-10-09 es EL sitio donde el cliente sigue lo suyo: Umbani es solo app y
// ya no le llega ningún aviso por WhatsApp (las notificaciones push vendrán
// después).

// ── El estado se lee, o esta pantalla no sirve para nada ───────────────────
//
// ⚠️ Los estados vivos iban en `text-marca`, el color del negocio como color de
// LETRA. Medido sobre blanco: el verde real de Monster Pizza (`#1BDE60`) da
// **1,80:1** y el lima de la plataforma **1,19:1**, donde AA exige 4,5. O sea
// que «En camino» —el único sitio de la app donde el cliente puede comprobar
// por dónde va lo suyo si el aviso de WhatsApp no llegara— era prácticamente
// invisible. `index.css` ya lo tenía escrito: «un lima sobre blanco no se lee
// al sol», y esta app se abre en la calle.
//
// Ahora el estado es una PASTILLA y el tono dice de quién es el turno:
//
//   · `PILL_ACTIVO`  — el pedido se mueve. Acento SÓLIDO, con el texto
//     calculado por luminancia (`aplicarColorDeMarca`), así que el negocio
//     puede elegir cualquier color sin romper el contraste.
//   · `PILL_ATENCION` — le toca al cliente. Ámbar fijo: «ojo» no es marca, y
//     un negocio no elige el color de lo que le falta a su cliente.
//   · `PILL_QUIETO`  — nada que hacer (recibido, entregado, cancelado).
//
// ⚠️ Sin `dark:`. El ámbar llevaba `dark:text-amber-400` de un modo oscuro que
// esta app no tiene —`color-scheme: light` fijo—, pero la media query SÍ se
// dispara con el teléfono en oscuro: era amber-400 sobre tarjeta blanca.
// Los doce estados, dichos como los entiende quien compró: viven en
// `lib/como-va.ts` desde que la app de clientes (`/u`) los usa también.

const cuando = (iso: string) => {
  const fecha = new Date(iso)
  if (Number.isNaN(fecha.getTime())) return ''
  return fecha.toLocaleDateString('es-EC', {
    timeZone: 'America/Guayaquil', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

/** En qué está mirando el cliente. */
type Vista = 'inicio' | 'pedidos' | 'direcciones'

export default function Account({
  slug, me, onVolver, onBorrarDireccion, onFalloEnlace,
}: {
  slug: string
  me: Me | null
  onVolver: () => void
  onBorrarDireccion: (addressId: string) => Promise<void>
  /** El mismo manejo que el resto de la tienda para un enlace que no vale. */
  onFalloEnlace: (error: unknown) => Promise<boolean>
}) {
  const [pedidos, setPedidos] = useState<TrackedOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // El acceso a la tienda no vale en este teléfono y la puerta ya se encargó:
  // no es un error ni una carga, es un paso pendiente del cliente —entrar desde
  // la app—.
  const [sinAcceso, setSinAcceso] = useState(false)
  const [intento, setIntento] = useState(0)
  /**
   * ⚠️ Las dos secciones dejan de ir APILADAS (2026-08-28, pedido del dueño).
   * Con los pedidos arriba y las direcciones debajo, quien entraba a cambiar
   * una dirección tenía que pasar por encima de su historial entero — y cuanto
   * más compra un cliente, más largo es ese scroll. Ahora la cuenta es una
   * portada con dos puertas, y cada una abre su pantalla.
   */
  const [vista, setVista] = useState<Vista>('inicio')

  useEffect(() => {
    setError(null)
    setSinAcceso(false)
    getOrders(slug)
      .then(setPedidos)
      .catch(async (fallo) => {
        // ⚠️ Un acceso que no vale NO es «no pudimos cargar» (2026-09-25).
        // Abriendo la tienda en otro teléfono, «Mis pedidos» decía que fallaba
        // cuando lo que faltaba era entrar: el resto de la tienda ya lo decía y
        // esta pantalla se lo tragaba. Ahora pasa por la misma puerta —acceso
        // que no vale o bloqueo— y dice lo que falta en vez de cargar para
        // siempre. Solo lo que de verdad es un fallo del camino es un error.
        if (await onFalloEnlace(fallo)) {
          setSinAcceso(true)
          return
        }
        setError('No pudimos cargar tus pedidos')
      })
  }, [slug, onFalloEnlace, intento])

  const direcciones: Address[] = me?.addresses || []
  // La flecha vuelve un paso, no dos: desde una sección se vuelve a la portada
  // de la cuenta, y solo desde ahí a la tienda. Es la misma regla que la hoja
  // del carrito, donde la flecha vuelve al carrito y no cierra el pedido.
  const atras = () => (vista === 'inicio' ? onVolver() : setVista('inicio'))
  const titulo = vista === 'pedidos' ? 'Mis pedidos'
    : vista === 'direcciones' ? 'Mis direcciones'
      : 'Mi cuenta'

  return (
    <div className="mx-auto min-h-dvh max-w-md pb-24">
      {/* ⚠️ `pt-seguro`, no `py-4`. Con `viewport-fit=cover` en el index.html
          la página arranca en el borde FÍSICO de la pantalla, así que esta
          cabecera pegajosa se metía bajo la hora y la batería del iPhone. Es
          el mismo descuido que ya se corrigió en la portada: `pb-seguro`
          existía desde el principio y su pareja de arriba, no. Sin muesca el
          `env()` vale 0 y queda exactamente el aire de antes. */}
      <header className="superficie sticky top-0 z-30 flex items-center gap-2 px-4 pt-seguro pb-4 shadow-tarjeta">
        <button
          onClick={atras}
          aria-label="Volver"
          className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-full transition active:scale-95 active:bg-black/5"
        >
          <RiArrowLeftSLine size={20} />
        </button>
        <h1 className="titulo-l">{titulo}</h1>
      </header>

      <div className="space-y-7 px-4 pt-5">
        {me?.phone && vista === 'inicio' && (
          <p className="caption texto-cuerpo">
            Tus pedidos y direcciones en este local, ligados a tu número {me.phone}.
          </p>
        )}

        {/* ── La portada de la cuenta: dos puertas ──────────────────────
            Cada una dice CUÁNTO hay dentro, que es lo que decide si vale la
            pena entrar. Un contador en cero se dice con palabras («todavía
            ninguno»), no con un 0 suelto: un cero se lee como un error. */}
        {vista === 'inicio' && (
          <div className="space-y-2.5">
            {([
              {
                id: 'pedidos' as const,
                icono: RiShoppingBag3Line,
                texto: 'Mis pedidos',
                detalle: sinAcceso
                  ? 'Entra desde la app para verlos'
                  : pedidos === null
                  ? 'Cargando…'
                  : pedidos.length === 0
                    ? 'Todavía no has pedido nada'
                    : `${pedidos.length} ${pedidos.length === 1 ? 'pedido' : 'pedidos'}`,
              },
              {
                id: 'direcciones' as const,
                icono: RiMapPin2Line,
                texto: 'Mis direcciones',
                detalle: direcciones.length === 0
                  ? 'Ninguna guardada todavía'
                  : `${direcciones.length} ${direcciones.length === 1 ? 'dirección' : 'direcciones'}`,
              },
            ]).map(({ id, icono: Icono, texto, detalle }) => (
              <button
                key={id}
                onClick={() => setVista(id)}
                className="superficie flex w-full items-center gap-3.5 rounded-(--radius-tarjeta) px-4 py-4 text-left shadow-tarjeta transition active:scale-[0.99]"
              >
                <span className="acento grid size-11 shrink-0 place-items-center rounded-2xl shadow-acento">
                  <Icono size={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="titulo-m block">{texto}</span>
                  <span className="caption mt-0.5 block texto-cuerpo">{detalle}</span>
                </span>
                <RiArrowRightSLine size={20} className="shrink-0 texto-tenue" />
              </button>
            ))}
          </div>
        )}

        {/* ── Mis pedidos ── */}
        {vista === 'pedidos' && (
        <section>
          {error && (
            <Aviso tono="alerta" icono={<RiErrorWarningLine size={18} />} titulo={error}>
              Revisa tu conexión y vuelve a entrar.
            </Aviso>
          )}

          {/* Esqueleto con la forma de la lista, no una rueda girando: así la
              pantalla no salta cuando llegan los datos. El `brillo` recorre en
              vez de parpadear —un bloque que respira parece algo que viene— y
              se apaga solo con `prefers-reduced-motion`. */}
          {sinAcceso && (
            <EstadoVacio icono={<RiLockLine size={28} />} titulo="Entra desde la app">
              Para ver tus pedidos, entra en Umbani con tu cuenta y vuelve a este local.
              <a href={DIRECCION_DE_UMBANI} className="mt-4 block">
                <Boton>Ir a Umbani</Boton>
              </a>
            </EstadoVacio>
          )}

          {!pedidos && !error && !sinAcceso && (
            <div className="space-y-2">
              {[0, 1].map(fila => (
                <div key={fila} className="brillo h-17 rounded-(--radius-tarjeta)" />
              ))}
            </div>
          )}

          {pedidos?.length === 0 && (
            <EstadoVacio icono={<RiShoppingBag3Line size={28} />} titulo="Todavía no has pedido nada">
              Cuando hagas tu primer pedido, aparecerá aquí.
            </EstadoVacio>
          )}

          <div className="space-y-2">
            {(pedidos || []).map((pedido) => {
              // ⚠️ El pago confirmado MANDA sobre el estado mientras el pedido
              // siga esperando. `payment_confirmed_at` no es un estado —dice
              // algo que pasó, no dónde está el pedido—, así que un pedido
              // cobrado seguía leyéndose «Falta tu pago» hasta que el dueño lo
              // aceptara. El dueño toca «Solo confirmar el pago» precisamente
              // para que el cliente deje de creer que debe dinero.
              const cobrado = Boolean(pedido.payment_confirmed_at)
                && (pedido.status === 'esperando_pago' || pedido.status === 'pago_en_revision')
              const estado = cobrado
                ? { texto: 'Pago confirmado', tono: PILL_ACTIVO }
                : COMO_VA[pedido.status] || { texto: pedido.status, tono: PILL_QUIETO }
              const cuantos = (pedido.order_items || []).length
              return (
                // ⚠️ Sigue siendo un `div`, no un botón: esta fila no lleva a
                // ninguna parte desde que se retiró el seguimiento, y fingir
                // que sí es peor que no ofrecerlo. Lo que sí lleva, desde el
                // 2026-10-06, es «¿Llegó todo bien?» debajo, si está entregado.
                <div
                  key={pedido.id}
                  className="superficie w-full rounded-(--radius-tarjeta) px-4 py-3.5 text-left shadow-tarjeta"
                >
                <div className="flex w-full items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[15px] font-extrabold tracking-tight tabular-nums">
                        #{pedido.order_number}
                      </span>
                      <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-bold ${estado.tono}`}>
                        {estado.texto}
                      </span>
                    </span>
                    <span className="mt-1 block text-[12.5px] texto-cuerpo">
                      {cuando(pedido.created_at)}
                      {cuantos > 0 && ` · ${cuantos} ${cuantos === 1 ? 'producto' : 'productos'}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-[16px] font-extrabold tracking-tight tabular-nums">
                    {money(Number(pedido.total) || 0)}
                  </span>
                </div>
                <LlegoTodoBien slug={slug} pedido={pedido} onCambio={() => setIntento(n => n + 1)} />
                </div>
              )
            })}
          </div>
        </section>
        )}

        {/* ── Mis direcciones ── */}
        {vista === 'direcciones' && (
        <section>
          {direcciones.length === 0 && (
            <div className="rounded-(--radius-tarjeta) border border-dashed borde-tema px-4 py-6 text-center">
              <p className="text-[13px] texto-cuerpo">
                Las direcciones que guardes al pedir aparecerán aquí.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {direcciones.map(direccion => (
              <div
                key={direccion.id}
                className="superficie flex items-center gap-3 rounded-(--radius-tarjeta) px-4 py-3.5 shadow-tarjeta"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-black/5">
                  <RiMapPin2Line size={17} className="texto-cuerpo" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-bold tracking-tight">{direccion.label}</span>
                  <span className="block text-[13px] texto-cuerpo">{direccion.address}</span>
                  {direccion.reference && (
                    <span className="caption block texto-tenue">{direccion.reference}</span>
                  )}
                </span>
                {/* 44×44 reales, como pide el diseño: iba en `p-1.5` sobre un
                    icono de 16, o sea 28 px de diana para una acción que
                    además borra algo. */}
                <button
                  onClick={() => {
                    if (!window.confirm(`¿Eliminar «${direccion.label}»?`)) return
                    void onBorrarDireccion(direccion.id)
                  }}
                  aria-label={`Eliminar ${direccion.label}`}
                  className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full texto-cuerpo transition active:scale-90 active:bg-black/5"
                >
                  <RiDeleteBin6Line size={17} />
                </button>
              </div>
            ))}
          </div>
        </section>
        )}
      </div>
    </div>
  )
}
