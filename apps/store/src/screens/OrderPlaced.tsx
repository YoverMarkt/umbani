import { Suspense, lazy, useEffect, useState } from 'react'
import {
  RiCheckLine,
  RiCloseLine,
  RiTimeLine,
  RiMapPin2Line,
  RiShoppingBag3Line,
} from '@remixicon/react'
import PagoPendiente from '../components/PagoPendiente'
import { getOrder } from '../lib/api'
import { esEstadoFinal, estaCancelado } from '../lib/estado'
import { money, rangoDeEspera } from '../lib/format'
import { grupoEnTexto } from '../lib/resumen'
import type { LineaResumen } from '../lib/resumen'
import { DIRECCION_DE_MIS_PEDIDOS } from '../lib/umbani'
import type { Business, Fulfillment } from '../lib/types'

// Solo lo descarga quien paga por transferencia.
const SubirComprobante = lazy(() => import('../components/SubirComprobante'))

// ── EL PEDIDO ENTRÓ ────────────────────────────────────────────────────────
//
// El instante después de confirmar. Sirve para una cosa muy concreta: que el
// cliente sepa que su pedido LLEGÓ y con qué número reclamarlo, antes de
// pasar al seguimiento.
//
// ⚠️ Dice «recibido», nunca «confirmado», y esto no es una sutileza. Esta
// pantalla existió antes y se retiró el 2026-08-08 justamente por eso: decía
// «¡Pedido confirmado!» en el mismo instante de crearlo, cuando el estado real
// era `pendiente` y el negocio ni lo había mirado. Le prometía al cliente un
// compromiso que nadie había dado, y cuando el local rechazaba el pedido diez
// minutos después, la app ya le había dicho que sí.
//
// «Recibido» es verdad siempre: el pedido está en la base y el dueño lo tiene
// en su bandeja. Es además el primer hito de la línea de tiempo del
// seguimiento, así que las dos pantallas cuentan lo mismo.
//
// ⚠️ Y con transferencia ni siquiera eso basta: ese pedido nace en
// `esperando_pago` y lo que le toca al cliente es pagar, no esperar. Por eso
// el texto cambia — decirle «lo estamos preparando» a quien todavía no ha
// transferido es mandarlo a esperar sentado.
//
// ── El comprobante se sube AQUÍ, y el pedido se sigue en la app (2026-10-09) ─
//
// Del 2026-08-12 a esa fecha el comprobante se mandaba por el chat de WhatsApp
// y el estado del pedido llegaba en tres avisos por ahí. Desde que Umbani es
// SOLO APP, el cliente llegó desde la app y en ella sigue: sube la captura en
// esta misma pantalla (`SubirComprobante`) y ve por dónde va su pedido en «Mis
// pedidos». Ya no se le escribe por WhatsApp (`config/avisos-al-cliente.ts`
// del servidor); las notificaciones push vendrán después.
//
// Es ESTÁTICA a propósito: no consulta nada porque no promete nada que pueda
// cambiar, salvo que el pedido se cancele (ver más abajo).

export interface PedidoRecibido {
  id: string
  order_number?: number | string | null
  total?: number | string | null
  /**
   * Lo que se pidió, ENTERO. Las dos fuentes —el carrito recién enviado y el
   * pedido que devuelve el servidor— se normalizan en `lib/resumen.ts`.
   */
  lineas: LineaResumen[]
  envio: number
  /** La tarifa de servicio: va aparte, como en el carrito. */
  tarifa?: number
  subtotal: number
}

export default function OrderPlaced({
  slug, business, pedido, nombre, entrega, transferencia, volviendo, onVolver,
}: {
  slug: string
  business: Business
  pedido: PedidoRecibido
  nombre: string
  entrega: Fulfillment
  /** Si va a transferir, todavía falta su parte. */
  transferencia: boolean
  /**
   * `true` cuando el cliente VUELVE a un pedido que dejó sin pagar.
   *
   * Cambia el titular, y no es cosmético: «¡Gracias!» sobre un pedido que
   * lleva veinte minutos esperando el comprobante suena a que ya está todo
   * hecho, y es justo lo contrario — falta lo único que hace falta.
   */
  volviendo?: boolean
  onVolver: () => void
}) {
  // ── Lo ÚNICO que esta pantalla consulta ─────────────────────────────────
  //
  // Era estática a propósito: no promete nada que pueda cambiar. Pero sí hay
  // algo que cambia y lo cambia todo — que el dueño cancele. Entonces el
  // «¡Gracias!» pasa a ser mentira y el cliente espera comida que nadie está
  // haciendo.
  //
  // Pregunta UNA cosa, «¿sigue vivo?», y solo mientras está abierta, que son
  // un par de minutos. No es la pantalla de seguimiento que se retiró: aquella
  // preguntaba «¿por dónde va?» durante toda la vida del pedido, cada 10 s.
  //
  // ⚠️ No consulta al montar: el pedido se acaba de crear, o lo acaba de traer
  // la tienda. Sería una petición para saber algo que ya se sabe.
  const [cancelado, setCancelado] = useState(false)
  useEffect(() => {
    if (!pedido.id || cancelado) return
    let vivo = true
    const mirar = () => {
      if (document.visibilityState !== 'visible') return
      getOrder(slug, pedido.id)
        .then((actual) => {
          if (!vivo) return
          if (estaCancelado(actual.status)) setCancelado(true)
          // Un pedido que llegó a un final bueno tampoco necesita más
          // preguntas, pero esta pantalla ya no está delante en ese caso.
          else if (esEstadoFinal(actual.status)) vivo = false
        })
        .catch(() => { /* sin conexión: se vuelve a intentar en 30 s */ })
    }
    const cada = window.setInterval(mirar, 30_000)
    // Y al volver a la app, que es cuando de verdad se nota: el cliente sale a
    // su banco o a otro chat y vuelve al rato.
    document.addEventListener('visibilitychange', mirar)
    return () => {
      vivo = false
      window.clearInterval(cada)
      document.removeEventListener('visibilitychange', mirar)
    }
  }, [slug, pedido.id, cancelado])

  const numero = pedido.order_number ? `#${pedido.order_number}` : null
  // ⚠️ Quien RETIRA tiene que salir de casa a buscarlo, así que necesita el
  // punto — no el nombre del local. Hasta hoy solo se le decía «pasa a
  // retirarlo por Monster Pizza», que es exactamente lo que no se puede
  // teclear en un GPS.
  //
  // El enlace no lleva API key ni cuesta nada: es una URL normal que abre la
  // app de mapas del teléfono. Lo que se paga es DIBUJAR un mapa aquí dentro.
  const puntoDelLocal = entrega === 'pickup'
    && business.latitude != null && business.longitude != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${business.latitude},${business.longitude}`
    : null
  // El MISMO cálculo que la portada: preparación, más el reparto solo si se lo
  // llevan. Quien retira no espera lo que tarda el repartidor.
  const espera = rangoDeEspera(
    business.prepTimeMinutes + (entrega === 'delivery' ? business.deliveryExtraMinutes : 0),
  )
  const total = Number(pedido.total) || pedido.subtotal + pedido.envio

  // ── El pedido murió ─────────────────────────────────────────────────────
  //
  // Reemplaza la pantalla ENTERA, no se añade encima. El resumen de lo que
  // pidió y el número de cuenta ya no sirven para nada: lo único que le queda
  // por hacer es preguntar qué pasó.
  //
  // El botón lleva a «Mis pedidos» de la app, donde el pedido sigue con su
  // estado (2026-10-09). Antes abría el chat de WhatsApp de Umbani; Umbani es
  // solo app, y un local nunca le da su número a un cliente.
  if (cancelado) {
    return (
      <div className="animar-entrada mx-auto flex min-h-[100dvh] max-w-md flex-col justify-center px-5 py-10">
        <div className="flex flex-col items-center text-center">
          {/* El rojo NO es color de marca y por eso sí lleva blanco fijo: es
              una advertencia, y un negocio no elige el color de su mala
              noticia. */}
          <div className="flex size-18 items-center justify-center rounded-full bg-red-500 text-white shadow-alzada">
            <RiCloseLine size={34} />
          </div>
          <h1 className="titulo-xl mt-5">
            Pedido cancelado
          </h1>
          <p className="mt-2.5 text-[14.5px] leading-relaxed texto-cuerpo">
            {numero ? `Tu pedido ${numero} no pudo continuar. ` : 'Tu pedido no pudo continuar. '}
            Lo ves en «Mis pedidos» de Umbani, y puedes volver a pedir cuando quieras.
          </p>
        </div>

        <div className="mt-8 space-y-1">
          <a
            href={DIRECCION_DE_MIS_PEDIDOS}
            className="tinta flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-4 text-[15.5px] font-bold tracking-tight shadow-alzada transition active:scale-[0.98] active:opacity-90"
          >
            <RiShoppingBag3Line size={18} />
            Ver mis pedidos
          </a>
          <button
            onClick={onVolver}
            className="w-full py-3.5 text-[14px] font-semibold texto-cuerpo transition active:scale-[0.98]"
          >
            Volver al menú
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col px-5 pt-[calc(env(safe-area-inset-top)+2.5rem)] pb-10">
      <div className="flex flex-1 flex-col items-center text-center">
        {/* ⚠️ El check va en `acento` SÓLIDO, no en `bg-marca` con el icono
            forzado a blanco. Era el mismo fallo de contraste que la letra, del
            revés: sobre el lima de la plataforma un icono blanco desaparece.
            La utilidad `acento` trae su color calculado por luminancia
            (`aplicarColorDeMarca`), así que cualquier color del negocio se ve.
            El ámbar de «falta tu comprobante» sí lleva blanco fijo: no es
            color de marca, es una advertencia, y esa no la elige el dueño. */}
        <div className={`flex size-18 items-center justify-center rounded-full ${
          volviendo ? 'bg-amber-500 text-white shadow-alzada' : 'acento shadow-acento-alto'
        }`}
        >
          {volviendo ? <RiTimeLine size={32} /> : <RiCheckLine size={34} />}
        </div>

        <h1 className="titulo-xl mt-5">
          {volviendo
            ? 'Falta tu comprobante'
            : nombre ? `¡Gracias, ${nombre.split(' ')[0]}!` : '¡Gracias!'}
        </h1>
        <p className="mt-2.5 text-[14.5px] leading-relaxed texto-cuerpo">
          {volviendo
            ? 'Tu pedido está guardado. En cuanto recibamos tu comprobante, el local lo prepara.'
            : transferencia
              ? 'Recibimos tu pedido. Falta tu comprobante para que el local lo prepare.'
              : 'Tu pedido fue recibido correctamente.'}
        </p>

        {/* Número y espera, en tarjeta: son los dos datos que el cliente puede
            tener que repetir por teléfono, y sueltos sobre el fondo se leían
            como un pie de página.

            ⚠️ El número va en `acento` SÓLIDO. Estaba en `text-marca` sobre su
            propio tinte —1,80:1 con el verde real de Monster Pizza y 1,19:1
            con el lima de la plataforma, donde AA exige 4,5—, y es justo el
            dato que el cliente dicta y el dueño canta en la cocina. Sigue
            «destacado en el color de marca» como pide el diseño: lo que cambia
            es que el color va DETRÁS de la letra y no en ella. */}
        <dl className="superficie mt-7 w-full divide-y divide-(--linea) overflow-hidden rounded-(--radius-tarjeta) shadow-tarjeta">
          {numero && (
            <div className="flex items-center justify-between gap-3 px-4 py-3.5">
              <dt className="caption texto-tenue">Número de pedido</dt>
              <dd className="acento rounded-full px-3 py-1 text-[14px] font-extrabold tabular-nums shadow-acento">
                {numero}
              </dd>
            </div>
          )}
          {espera && (
            <div className="flex items-center justify-between gap-3 px-4 py-3.5">
              <dt className="caption texto-tenue">Tiempo estimado</dt>
              <dd className="flex items-center gap-1.5 text-[14px] font-bold tabular-nums">
                <RiTimeLine size={14} className="texto-tenue" />
                {espera}
              </dd>
            </div>
          )}
        </dl>

        {/* El resumen es del CARRITO que se acaba de enviar: el servidor ya
            devolvió el total oficial, y ese es el que manda arriba del todo. */}
        {pedido.lineas.length > 0 && (
          <section className="mt-6 w-full text-left">
            <h2 className="titulo-l mb-2.5 px-1">
              Resumen del pedido
            </h2>
            <div className="superficie space-y-2.5 rounded-(--radius-tarjeta) px-4 py-4 shadow-tarjeta">
              {/* ⚠️ Lo elegido va DEBAJO de su producto, no pegado al nombre.
                  Esta pantalla decía «1× Pizza $16.83» justo después de que el
                  cliente eligiera masa, borde y sabor: el dato estaba en el
                  carrito y en el pedido, y no se pintaba.

                  Se corta a dos líneas —y solo aquí—: el cliente acaba de
                  armarlo y ya sabe lo que pidió. En el panel del dueño va
                  entero, porque ahí lo lee la cocina. */}
              {pedido.lineas.map((linea, indice) => (
                <div key={indice} className="flex items-baseline justify-between gap-3 text-[14px]">
                  <span className="min-w-0">
                    <span className="font-bold tabular-nums">{linea.cantidad}× </span>
                    <span className="font-semibold">{linea.nombre}</span>
                    {/* Lo elegido y la nota son CONTENIDO, no metadatos: es lo
                        que el cliente repasa para comprobar que le entendieron.
                        En `texto-tenue` (3,17:1 sobre blanco) a 12,5 px no se
                        lee al sol, que es donde se abre esta app. */}
                    {linea.grupos.map(grupo => (
                      <span key={grupo.group} className="mt-0.5 block text-[12.5px] leading-snug line-clamp-2 texto-cuerpo">
                        {grupoEnTexto(grupo)}
                      </span>
                    ))}
                    {linea.nota && (
                      <span className="mt-0.5 block text-[12.5px] leading-snug italic texto-cuerpo">
                        «{linea.nota}»
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{money(linea.importe)}</span>
                </div>
              ))}
              {pedido.envio > 0 && (
                <div className="flex items-baseline justify-between text-[14px] texto-cuerpo">
                  <span>Envío</span>
                  <span className="tabular-nums">{money(pedido.envio)}</span>
                </div>
              )}
              {/* ⚠️ Sin esta línea, desde que la tarifa se encendió el desglose
                  no sumaba: «Agua $0,83 + Envío $1,50 = Total $2,43». */}
              {(pedido.tarifa || 0) > 0 && (
                <div className="flex items-baseline justify-between text-[14px] texto-cuerpo">
                  <span>Tarifa de servicio</span>
                  <span className="tabular-nums">{money(pedido.tarifa || 0)}</span>
                </div>
              )}
              <div className="flex items-baseline justify-between border-t borde-tema pt-3">
                <span className="text-[14px] font-bold">Total</span>
                <span className="titulo-l tabular-nums">
                  {money(total)}
                </span>
              </div>
            </div>
          </section>
        )}
        {/* Los datos para transferir y, debajo, dónde subir la captura (vuelve
            el 2026-10-09: Umbani es solo app y el chat ya no es el camino). */}
        {transferencia && (
          <div className="mt-6 w-full">
            <PagoPendiente slug={slug} />
            <Suspense fallback={null}>
              <SubirComprobante slug={slug} orderId={pedido.id} />
            </Suspense>
          </div>
        )}

        {/* ── Cómo llegar, para quien retira ──
            Va ANTES del bloque del seguimiento y a tamaño de botón, no de nota al
            pie: quien eligió retirar tiene que salir de casa, y el dato que
            necesita es el punto. Sin esto solo sabía el nombre del local. */}
        {puntoDelLocal && (
          <a
            href={puntoDelLocal}
            target="_blank"
            rel="noreferrer"
            className="tinta mt-6 flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-4 text-[15.5px] font-bold tracking-tight shadow-alzada transition active:scale-[0.98] active:opacity-90"
          >
            <RiMapPin2Line size={18} />
            Cómo llegar al local
          </a>
        )}

        {/* ⚠️ EL TEXTO GRANDE, y el tamaño es la decisión: es la promesa de
            que el cliente sabrá por dónde va su pedido sin tener que preguntar.
            Con transferencia no sale: allí la instrucción es subir el
            comprobante, que va arriba con su botón. */}
        {!transferencia && (
          <div className="superficie mt-6 w-full rounded-(--radius-tarjeta) px-4 py-4 text-left shadow-tarjeta">
            <div className="flex items-start gap-3">
              <span className="acento flex size-10 shrink-0 items-center justify-center rounded-full shadow-acento">
                <RiTimeLine size={19} />
              </span>
              <div className="min-w-0">
                <p className="titulo-m">Síguelo en «Mis pedidos»</p>
                <p className="mt-1.5 text-[14px] leading-relaxed texto-cuerpo">
                  {entrega === 'delivery'
                    ? 'Ahí ves cuándo el local empieza a prepararlo, cuándo sale para tu dirección y cuándo llega.'
                    : 'Ahí ves cuándo el local empieza a prepararlo y cuándo está listo para que pases a retirarlo.'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-8 space-y-1">
        {/* La salida principal es «Mis pedidos» de la app (2026-10-09): ahí
            se sigue el pedido. Antes era volver al chat de WhatsApp. Va en
            TINTA como todo botón principal: el acento señala, no acciona. */}
        <a
          href={DIRECCION_DE_MIS_PEDIDOS}
          className="tinta flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-4 text-[15.5px] font-bold tracking-tight shadow-alzada transition active:scale-[0.98] active:opacity-90"
        >
          <RiShoppingBag3Line size={18} />
          Ver mis pedidos
        </a>
        <button
          onClick={onVolver}
          className="w-full py-3.5 text-[14px] font-semibold texto-cuerpo transition active:scale-[0.98]"
        >
          Volver al menú
        </button>
      </div>
    </div>
  )
}
