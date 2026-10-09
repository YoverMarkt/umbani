import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { rutaDeReparto } from '@/lib/ubicacion'
import { api } from '../../api/client'
import { toast } from 'sonner'
import {
  Banknote, Bike, Clock, CreditCard, Landmark, MapPin, Navigation, ShoppingBag, Check, X, FileText, RotateCcw,
} from 'lucide-react'
import {
  ACTIVOS, ESTADO_COLOR, ESTADO_TEXTO, confirmOrderPayment, getOrderProof, money, marcarLineaPreparada, requestNewProof, siguientePaso, type Order, type OrderStatus,
} from './api'
import { desgloseDelPedido, elPedidoSeCobra } from './dinero-del-pedido'
import { Alert, AlertDescription, AlertTitle } from '@botpanel/ui/components/alert'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Progress } from '@botpanel/ui/components/progress'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { AnalisisDelComprobante } from './AnalisisDelComprobante'
import { hora, espera } from './formato'

// La tarjeta de UN pedido en Pedidos: su estado, sus líneas, el cobro y la ruta
// (vivía en Orders.tsx hasta el 2026-10-08: ningún archivo pasa de 1.000 líneas).

/**
 * El punto del local, para poder trazar la ruta del reparto.
 *
 * ⚠️ Comparte la clave `['business']` con Ajustes a propósito: es la misma
 * consulta y React Query la sirve de caché. Así el dueño guarda su ubicación
 * en Ajustes y la ruta aparece en Pedidos sin recargar la página.
 */
function usePuntoDelLocal() {
  const { data } = useQuery({
    queryKey: ['business'],
    queryFn: () => api<{ latitude: number | null; longitude: number | null }>('/api/client/business'),
    staleTime: 5 * 60 * 1000,
  })
  return data ?? null
}

export function TarjetaPedido({ pedido, ocupado, onCambiar, onRefrescar }: {
  pedido: Order
  ocupado: boolean
  onCambiar: (status: OrderStatus) => void
  /** Recarga la lista tras un cambio que no pasa por `onCambiar`. */
  onRefrescar: () => void
}) {
  const local = usePuntoDelLocal()
  const paso = siguientePaso(pedido)
  const domicilio = !pedido.fulfillment || pedido.fulfillment === 'delivery'
  const direccion = pedido.delivery_address
  // El pin abre en Google Maps con una URL normal: sin clave, sin cuenta y sin
  // costo. Lo que se paga es DIBUJAR un mapa dentro de la app, no enlazarlo.
  const pin = pedido.delivery_latitude != null && pedido.delivery_longitude != null
    ? `https://www.google.com/maps?q=${pedido.delivery_latitude},${pedido.delivery_longitude}`
    : null
  // ⚠️ La RUTA completa, no solo el destino. Quien lleva el pedido sale DEL
  // LOCAL: el pin del cliente suelto le dice a dónde va, no por dónde. Con el
  // trayecto trazado, el dueño lo copia y se lo pasa a su motorizado tal cual.
  //
  // Solo aparece con los DOS extremos: sin el punto del local (Ajustes →
  // «Dónde está tu local») no hay origen que trazar.
  const ruta = rutaDeReparto(local, {
    // Llegan como texto o número según el driver: se normaliza aquí, que es
    // donde se sabe de dónde vienen.
    latitude: pedido.delivery_latitude == null ? null : Number(pedido.delivery_latitude),
    longitude: pedido.delivery_longitude == null ? null : Number(pedido.delivery_longitude),
  })
  const precision = Number(pedido.delivery_accuracy_m)
  const enCurso = ACTIVOS.includes(pedido.status)

  // Lo que se queda la plataforma y lo que le entra al local. El porqué, las
  // dos reglas que no se negocian y por qué esto tiene que cuadrar con
  // Finanzas están en `dinero-del-pedido.ts`.
  const { servicio, porLosProductos, reparto, servicioVaEncima } = desgloseDelPedido(pedido)
  const seCobra = elPedidoSeCobra(pedido.status)

  // ── La checklist: cuántas líneas están ya en la bolsa ────────────────────
  const preparadas = pedido.order_items.filter(item => item.prepared_at).length
  const faltanPorPreparar = pedido.order_items.length - preparadas

  // ⚠️ Se refresca la lista al marcar, no se toca el estado local: el número
  // que manda lo lleva la base, y con dos empleados preparando el mismo
  // pedido en dos pantallas, un contador propio se desincroniza enseguida.
  const prepararLinea = useMutation({
    mutationFn: (itemId: string) => marcarLineaPreparada(pedido.id, itemId),
    onSuccess: () => { onRefrescar() },
    onError: (e: Error) => toast.error(e.message || 'No pudimos marcar ese producto'),
  })
  const [abriendo, setAbriendo] = useState(false)
  const [confirmando, setConfirmando] = useState(false)

  // Solo tiene sentido en transferencia y mientras el pedido siga esperando:
  // en efectivo se cobra al entregar, y una vez en preparación el pago ya se
  // dio por bueno al aceptarlo. La ruta lo vuelve a comprobar en el `where`.
  const puedeConfirmarPago = pedido.payment_method === 'transferencia'
    && !pedido.payment_confirmed_at
    && (pedido.status === 'esperando_pago' || pedido.status === 'pago_en_revision')

  const pedirOtroComprobante = async () => {
    setConfirmando(true)
    try {
      await requestNewProof(pedido.id)
      toast.success('Le pedimos otro comprobante', {
        description: 'El pedido vuelve a esperar el pago y el cliente lo ve así en la tienda. '
          + 'La próxima captura que mande por WhatsApp se adjunta sola.',
      })
      onRefrescar()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'No se pudo pedir otro comprobante',
      )
    } finally {
      setConfirmando(false)
    }
  }

  const confirmarPago = async () => {
    setConfirmando(true)
    try {
      await confirmOrderPayment(pedido.id)
      toast.success('Pago confirmado. El cliente ya lo ve en su pedido.')
      onRefrescar()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'No se pudo confirmar el pago',
      )
    } finally {
      setConfirmando(false)
    }
  }

  /**
   * Se pide la URL firmada AL TOCAR, no al pintar la lista: firmarla antes
   * sería repartir accesos a comprobantes que nadie va a mirar, y cada uno
   * caduca desde que se emite.
   */
  const abrirComprobante = async () => {
    setAbriendo(true)
    try {
      const { url } = await getOrderProof(pedido.id)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      toast.error('No pudimos abrir el comprobante')
    } finally {
      setAbriendo(false)
    }
  }

  return (
    <Card className={`p-4 gap-0 ${enCurso ? '' : 'opacity-70'}`}>
      {/* Quién y cuándo */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-semibold text-foreground">
            {pedido.contact_name || pedido.contact_phone}
          </span>
          <span className="ml-2 text-xs text-muted-foreground/80">{pedido.contact_phone}</span>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {espera(pedido.created_at)} · {hora(pedido.created_at)}
          </div>
        </div>
        <Badge variant="secondary" className={ESTADO_COLOR[pedido.status]}>
          {ESTADO_TEXTO[pedido.status]}
        </Badge>
        {/* Un pedido programado no se prepara ahora. Si esto no se ve, la
            cocina lo saca cuatro horas antes de tiempo. */}
        {pedido.scheduled_for && (
          <Badge
            variant="secondary"
            className="bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300"
          >
            <Clock className="mr-1 h-3 w-3" />
            Para {new Date(pedido.scheduled_for).toLocaleString('es-EC', {
              timeZone: 'America/Guayaquil',
              weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })}
          </Badge>
        )}
      </div>

      {/* ── LA CHECKLIST DE PREPARACIÓN ──────────────────────────────────────
          El caso del dueño: «el cliente pide hamburguesa, papas y gaseosa; el
          empleado mete las dos primeras, olvida la gaseosa y el pedido sale
          incompleto».

          ⚠️ Solo mientras el pedido está VIVO. En uno ya entregado o cancelado
          sobra: la tarjeta volvería a ser una lista y ya no hay nada que meter
          en ninguna bolsa.

          ⚠️ Y esto es AYUDA, no la defensa. Quien impide de verdad que salga
          incompleto es `set_order_status` en PostgreSQL: esta pantalla se
          puede saltar, esa puerta no. */}
      {enCurso && pedido.order_items.length > 0 && (
        <Alert className="mt-3">
          <ShoppingBag className="h-4 w-4" />
          <AlertTitle className="flex items-center justify-between gap-2">
            <span>Preparación del pedido</span>
            <span className="tabular-nums font-normal text-muted-foreground">
              {preparadas} de {pedido.order_items.length}
            </span>
          </AlertTitle>
          <AlertDescription className="block">
            <Progress
              value={Math.round((preparadas / pedido.order_items.length) * 100)}
              className="my-2 h-1.5"
            />
            {faltanPorPreparar > 0
              ? `Falta meter ${faltanPorPreparar} producto${faltanPorPreparar === 1 ? '' : 's'} en la bolsa.`
              : 'Pedido completo — todo está en la bolsa.'}
          </AlertDescription>
        </Alert>
      )}

      {/* Qué pidió */}
      <div className="mt-3 space-y-1 text-sm">
        {pedido.order_items.map(item => (
          // ⚠️ Por `id` y no por índice: la lista se refresca cada vez que se
          // marca una línea, y con el índice React reutilizaría el nodo
          // equivocado — el tilde aparecería en el producto de al lado.
          <div key={item.id} className="flex justify-between gap-3">
            {/* ⚠️ `Button` y no un `<button>` a pelo: lo exige el sistema de
                diseño, y con él vienen gratis el foco visible, el estado
                deshabilitado y el tema oscuro.

                ⚠️ Y no es un `Checkbox`: marcar es IRREVERSIBLE y va al
                servidor. Una casilla invita a desmarcar, y eso aquí no existe
                — un producto que ya está en la bolsa no se saca. */}
            {enCurso && (
              item.prepared_at
                ? (
                    <span
                      className="mt-0.5 flex size-7 shrink-0 items-center justify-center text-primary"
                      aria-label={`${item.product_name} ya está en la bolsa`}
                    >
                      <Check className="size-4" />
                    </span>
                  )
                : (
                    <Button
                      variant="outline"
                      size="icon-xs"
                      className="mt-0.5 shrink-0"
                      disabled={prepararLinea.isPending}
                      onClick={() => prepararLinea.mutate(item.id)}
                      aria-label={`Marcar ${item.product_name} como puesto en la bolsa`}
                    />
                  )
            )}
            <span className="min-w-0">
              <span className="font-medium text-foreground">{item.quantity}× {item.product_name}</span>
              {item.variant_name && (
                <span className="text-muted-foreground"> · {item.variant_name}</span>
              )}
              {/* ⚠️ ENTERO Y SIN CORTAR, una línea por grupo. Esto lo lee la
                  cocina: cortarlo a dos líneas como en la mini app —donde el
                  cliente ya sabe lo que pidió— haría que se prepare mal.
                  El servidor lo manda ya agrupado; `extras_names` es el
                  respaldo de los pedidos anteriores al motor de opciones. */}
              {item.options?.length
                ? item.options.map(grupo => (
                    <span key={grupo.group} className="block text-xs text-muted-foreground">
                      <span className="font-medium">{grupo.group}:</span>{' '}
                      {grupo.items.map(elegido => (
                        elegido.quantity > 1 ? `${elegido.name} x${elegido.quantity}` : elegido.name
                      )).join(', ')}
                    </span>
                  ))
                : item.extras_names?.length
                  ? (
                      <span className="block text-xs text-muted-foreground">
                        {item.extras_names.join(' · ')}
                      </span>
                    )
                  : null}
              {item.item_note && (
                <span className="block text-xs italic text-muted-foreground">“{item.item_note}”</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {money(item.line_total)}
            </span>
          </div>
        ))}
      </div>

      {/* A dónde va y cómo paga: lo que necesita quien lo entrega */}
      <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 text-sm sm:grid-cols-2">
        <div className="flex items-start gap-2">
          {domicilio
            ? <Bike className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            : <ShoppingBag className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="font-medium text-foreground">
              {domicilio ? 'A domicilio' : 'Retira en el local'}
            </div>
            {domicilio && (
              direccion
                ? (
                    <div className="text-xs text-muted-foreground">
                      <span className="flex items-start gap-1">
                        <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          {direccion}
                          {pedido.delivery_reference && (
                            <span className="block">{pedido.delivery_reference}</span>
                          )}
                        </span>
                      </span>
                      {/* El pin, si el cliente lo dejó. La precisión va al lado
                          a propósito: uno de 2 km no es una dirección, es un
                          barrio, y quien reparte tiene que saberlo ANTES. */}
                      {pin && (
                        <a
                          href={pin}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        >
                          <Navigation className="h-3 w-3 shrink-0" />
                          Abrir en el mapa
                          {Number.isFinite(precision) && precision > 0 && (
                            <span className="font-normal text-muted-foreground">
                              (±{Math.round(precision)} m)
                            </span>
                          )}
                        </a>
                      )}
                      {/* ⚠️ La RUTA completa, no solo el destino. Quien lleva
                          el pedido sale DEL LOCAL: el pin suelto le dice a
                          dónde va, no por dónde. Esto se copia y se le pasa al
                          motorizado tal cual, hasta que exista su app.

                          Solo con los DOS extremos: sin el punto del local
                          (Ajustes → «Dónde está tu local») no hay origen. */}
                      {ruta && (
                        <a
                          href={ruta}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 ml-3 inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        >
                          <Navigation className="h-3 w-3 shrink-0" />
                          Ruta desde el local
                        </a>
                      )}
                      {/* Lo permanente de esa casa: no cambia entre pedidos. */}
                      {pedido.delivery_courier_notes && (
                        <span className="mt-1 block">{pedido.delivery_courier_notes}</span>
                      )}
                      {/* Lo que el cliente pidió para ESTE pedido. Va aquí, con
                          la dirección, que es donde lo busca quien reparte. */}
                      {pedido.delivery_notes && (
                        <span className="mt-1 block font-medium text-foreground">
                          «{pedido.delivery_notes}»
                        </span>
                      )}
                    </div>
                  )
                : (
                    <div className="text-xs text-amber-600 dark:text-amber-400">
                      Sin dirección — coordínala por WhatsApp
                    </div>
                  )
            )}
          </div>
        </div>

        <div className="flex items-start gap-2">
          {pedido.payment_method === 'efectivo'
            ? <Banknote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            : pedido.payment_method === 'tarjeta'
              ? <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              : <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="font-medium text-foreground">
              {pedido.payment_method === 'efectivo'
                ? 'Paga en efectivo'
                : pedido.payment_method === 'transferencia'
                  ? 'Transferencia'
                  : pedido.payment_method === 'pago_al_retirar'
                    ? 'Paga al retirar'
                    : pedido.payment_method === 'tarjeta'
                      ? 'Tarjeta'
                      : 'Pago por coordinar'}
            </div>
            {/* Con tarjeta el pago lo confirma PayPhone, no el dueño: aquí
                solo se dice si ya está cobrado. Mientras no lo esté, el pedido
                no se puede preparar (lo impide la base). */}
            {pedido.payment_method === 'tarjeta' && (
              pedido.payment_confirmed_at
                ? (
                    <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      <Check className="h-3 w-3" />
                      Pagado con tarjeta · {hora(pedido.payment_confirmed_at)}
                    </span>
                  )
                : (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      Esperando el pago con tarjeta. No lo prepares todavía.
                    </span>
                  )
            )}
            {pedido.payment_method === 'transferencia' && (
              <>
                {pedido.payment_proof_url
                  ? (
                      <Button
                        type="button"
                        variant="link"
                        onClick={abrirComprobante}
                        disabled={abriendo}
                        className="h-auto gap-1 p-0 text-xs font-semibold underline underline-offset-2"
                      >
                        <FileText className="size-3" />
                        {abriendo ? 'Abriendo…' : 'Ver comprobante'}
                      </Button>
                    )
                  : !pedido.payment_confirmed_at && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      Sin comprobante todavía
                    </span>
                  )}
                {/* El pago dado por bueno se dice UNA vez y con su hora: sin
                    esto, un pedido cobrado por WhatsApp seguía leyéndose como
                    «sin comprobante» para siempre. */}
                {pedido.payment_confirmed_at && (
                  <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3 w-3" />
                    Pago confirmado · {hora(pedido.payment_confirmed_at)}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Lo que el sistema leyó del comprobante. Solo aparece si hay uno y si
          el análisis llegó a escribirse: con el interruptor apagado, o en los
          pedidos anteriores a esta capa, la tarjeta se pinta como siempre. */}
      {pedido.payment_method === 'transferencia' && (
        <AnalisisDelComprobante pedido={pedido} />
      )}

      {/* El dinero, tal como lo calculó el servidor */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
        {/* El espaciado va por `gap` y no por un `ml-3` en cada pieza: así en
            un móvil las líneas envuelven sin dejar sangrías sueltas. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">Subtotal {money(pedido.subtotal)}</span>
          {Number(pedido.discount) > 0 && (
            <span className="text-muted-foreground">Descuento −{money(pedido.discount)}</span>
          )}
          {Number(pedido.shipping) > 0 && (
            <span className="text-muted-foreground">Envío {money(pedido.shipping!)}</span>
          )}
          {/* Lleva el NOMBRE a propósito: «Servicio» a secas no dice quién se
              queda ese dinero, y el dueño tiene derecho a leerlo sin
              suponerlo. */}
          {servicio > 0 && (
            <span className="text-muted-foreground">
              Servicio Umbani {servicioVaEncima ? '' : '−'}{money(servicio)}
            </span>
          )}
          <span className="font-bold text-foreground">Total {money(pedido.total)}</span>

          {/* ── Lo que le entra al local, y de quién es cada parte ──────────
              SU número, tan visible como el total: el de al lado es el del
              CLIENTE, y el dueño no tiene por qué restar de cabeza.

              ⚠️ LA CARRERA VA APARTE Y NO SE SUMA AQUÍ. No es del local, es de
              quien reparte. Hoy reparte él mismo, así que hoy también acaba en
              su bolsillo —pero por llevar la comida, no por venderla—. Juntar
              las dos en un «Recibes $13.98» es lo que pidió quitar el dueño el
              2026-09-21: el día que exista el módulo de repartidores, esa cifra
              bajaría sola y habría que explicar por qué.

              ⚠️ Y solo si el pedido llega a cobrarse. Sobre uno expirado,
              cancelado o rechazado no recibe nada y la plataforma tampoco
              factura su servicio: afirmar «Recibes» ahí descuadraba la tarjeta
              con Finanzas, que suma únicamente lo entregado. */}
          {servicio > 0 && (
            seCobra ? (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 font-semibold text-foreground">
                  Recibes <span className="tabular-nums">{money(porLosProductos)}</span>
                  <span className="font-normal text-muted-foreground">por tus productos</span>
                </span>
                {reparto > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                    <Bike className="h-3.5 w-3.5 shrink-0" />
                    Reparto <span className="tabular-nums">{money(reparto)}</span>
                    <span>· de quien entrega</span>
                  </span>
                )}
              </>
            ) : (
              <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                Sin cobro — este pedido no se completó
              </span>
            )
          )}
        </div>

        {/* Las acciones: avanzar o rechazar. Nunca retroceder. */}
        {paso && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {/* ── El pago que llegó por WhatsApp ──
                Da el pago por bueno SIN arrancar el pedido ni avisar al
                cliente. Existe para el rato en que el dueño ya vio la
                transferencia pero todavía no va a encender la cocina
                —cerrando, o con cola—.

                ⚠️ Y desde el 2026-08-11 hace algo más importante: es lo ÚNICO
                que libera al cliente de la pantalla de pago. Quien manda el
                comprobante por WhatsApp se queda ahí hasta que esto se marque,
                porque su pedido sigue en `esperando_pago`. Sin este botón, la
                única forma de desatascarlo sería mandarlo a la cocina.

                El texto dice «SOLO confirmar» a propósito: al lado de «Aceptar
                el pago y preparar» los dos se leían igual, y el dueño no sabía
                cuál era cuál. */}
            {puedeConfirmarPago && (
              <ConfirmAction
                trigger={
                  <Button variant="ghost" size="sm" disabled={ocupado || confirmando}>
                    <Landmark /> {confirmando ? 'Confirmando…' : 'Solo confirmar el pago'}
                  </Button>
                }
                title="Confirmar el pago sin preparar todavía"
                description={
                  'El cliente deja de ver el aviso de pago pendiente y los datos bancarios, '
                  + 'y en su cuenta aparece «Pago confirmado». NO se le avisa por WhatsApp y '
                  + 'el pedido no arranca: sigue esperando a que lo aceptes.'
                }
                confirmLabel="Ya me llegó el pago"
                onConfirm={confirmarPago}
              />
            )}
            <ConfirmAction
              trigger={
                <Button
                  size="sm"
                  disabled={ocupado}
                  // Aceptar sin comprobante no se bloquea —el dueño puede tener
                  // el dinero en su cuenta—, pero tampoco se ofrece con el
                  // mismo peso que un pago ya comprobado.
                  variant={paso.avisa ? 'outline' : 'default'}
                >
                  <Check /> {paso.etiqueta}
                </Button>
              }
              title={paso.etiqueta}
              description={paso.descripcion}
              confirmLabel={paso.etiqueta}
              onConfirm={() => onCambiar(paso.status)}
            />
            {/* Atajo para quien no reparte: cerrar sin recorrer todo el flujo. */}
            {pedido.status !== 'pendiente' && paso.status !== 'completado' && (
              <ConfirmAction
                trigger={<Button variant="outline" size="sm" disabled={ocupado}><Check /> Marcar entregado</Button>}
                title="Marcar entregado"
                description="El pedido queda cerrado como entregado."
                confirmLabel="Marcar entregado"
                onConfirm={() => onCambiar('completado')}
              />
            )}
            {/* ⚠️ Rechazar el comprobante CIERRA el pedido, y el texto lo dice
                desde el 2026-08-15. Antes prometía «para que mande otro», y era
                falso por dos motivos: `rechazado` es un estado FINAL —la
                máquina no permite volver a `esperando_pago`— y desde que los
                finales avisan, al cliente le llega «tu pedido fue cancelado».
                Prometer una segunda oportunidad que el sistema no puede dar es
                peor que no ofrecerla.

                Si el dueño quiere darla, la vía es no rechazar: pedirle otro
                comprobante por WhatsApp y confirmar el pago a mano. */}
            {/* La salida que NO cierra el pedido. Va antes de rechazar porque
                es la que se quiere casi siempre: una foto borrosa no debería
                costar una venta. */}
            {pedido.status === 'pago_en_revision' && (
              <ConfirmAction
                trigger={
                  <Button variant="outline" size="sm" disabled={ocupado || confirmando}>
                    <RotateCcw /> Pedir otro comprobante
                  </Button>
                }
                title="Pedir otro comprobante"
                description={
                  'El pedido vuelve a esperar el pago y se borra el comprobante actual, así '
                  + 'que la próxima captura que el cliente mande por WhatsApp se adjunta sola. '
                  + 'NO se le avisa automáticamente: escríbele tú para decirle qué pasó.'
                }
                confirmLabel="Pedir otro"
                onConfirm={pedirOtroComprobante}
              />
            )}
            {pedido.status === 'pago_en_revision' && (
              <ConfirmAction
                trigger={
                  <Button variant="outline" size="sm" disabled={ocupado}>
                    <X /> Rechazar el pago
                  </Button>
                }
                title="Rechazar el comprobante y cerrar el pedido"
                description={
                  'El pedido queda CERRADO y al cliente le llega un WhatsApp diciendo que no '
                  + 'continúa, con tu teléfono para llamarte. Si prefieres darle otra '
                  + 'oportunidad, no lo rechaces: pídele otro comprobante por WhatsApp.'
                }
                confirmLabel="Rechazar el pago"
                destructive
                onConfirm={() => onCambiar('rechazado')}
              />
            )}
            <ConfirmAction
              trigger={
                <Button variant="outline" size="sm" disabled={ocupado}>
                  <X /> {pedido.status === 'pendiente' ? 'Rechazar' : 'Cancelar'}
                </Button>
              }
              title={pedido.status === 'pendiente' ? 'Rechazar pedido' : 'Cancelar pedido'}
              description="El pedido queda cerrado y no se puede reabrir. Avísale al cliente por WhatsApp."
              confirmLabel={pedido.status === 'pendiente' ? 'Rechazar' : 'Cancelar pedido'}
              destructive
              onConfirm={() => onCambiar('cancelado')}
            />
          </div>
        )}
      </div>
    </Card>
  )
}
