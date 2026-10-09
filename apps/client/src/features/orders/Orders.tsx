// ── PEDIDOS ───────────────────────────────────────────────────────────────
//
// La bandeja de entrada del negocio. Existe separada de Ventas porque son dos
// momentos distintos: un pedido LLEGA y hay que atenderlo ya —lo inicia el
// cliente—; una venta se REGISTRA cuando ya se cobró, y la cierra el negocio.
// Mientras los pedidos vivieron dentro de Ventas, el dueño tenía que entrar a
// "registrar una venta" para ver algo que todavía no había vendido, y por eso
// nadie conectó nunca la alarma ahí.
//
// El orden manda: primero lo que espera respuesta, y dentro de eso, lo más
// viejo arriba. Un pedido que lleva 20 minutos sin aceptar es el problema más
// urgente de la pantalla, no el que acaba de entrar.
import { useMemo, useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Receipt, Plus } from 'lucide-react'
import { ACTIVOS, ESTADO_TEXTO, getOrders, setOrderStatus, type OrderStatus } from './api'
import CounterOrder from './CounterOrder'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@botpanel/ui/components/tabs'
import { TarjetaPedido } from './TarjetaPedido'

export default function Orders() {
  const qc = useQueryClient()
  const [filtro, setFiltro] = useState<'activos' | 'todos'>('activos')
  const [mostrador, setMostrador] = useState(false)

  const { data: pedidos = [], isLoading } = useQuery({
    queryKey: ['orders'],
    queryFn: getOrders,
    // Mismo ritmo que la alarma: si suena, la lista ya tiene el pedido.
    refetchInterval: 12_000,
    // Y al volver a la pestaña, sin esperar al siguiente intervalo: el dueño
    // deja el panel abierto en un rincón y vuelve cuando suena la campana.
    refetchOnWindowFocus: true,
  })

  const cambiar = useMutation({
    mutationFn: ({ id, status }: { id: string; status: OrderStatus }) => setOrderStatus(id, status),
    onSuccess: (_data, variables) => {
      const textos: Record<OrderStatus, string> = {
        confirmado: 'Pedido aceptado.',
        aceptado: 'Pedido aceptado.',
        preparacion: 'Pedido en preparación.',
        listo_para_retiro: 'Listo. Avísale al cliente que ya puede venir.',
        en_camino: 'En camino. Avísale al cliente que ya salió.',
        completado: 'Pedido entregado.',
        cancelado: 'Pedido cancelado.',
        rechazado: 'Pedido rechazado.',
        pendiente: 'Pedido actualizado.',
        esperando_pago: 'A la espera del pago.',
        pago_en_revision: 'Comprobante en revisión.',
        expirado: 'Pedido expirado.',
      }
      toast.success(textos[variables.status])
      void qc.invalidateQueries({ queryKey: ['orders'] })
      // La alarma mira la misma lista: se refresca para que deje de sonar.
      void qc.invalidateQueries({ queryKey: ['orders-watch'] })
    },
    onError: error => toast.error(
      error instanceof Error ? error.message : 'No se pudo actualizar el pedido',
    ),
  })

  // La alarma mira la misma lista: se refresca para que deje de sonar.
  const refrescar = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['orders'] })
    void qc.invalidateQueries({ queryKey: ['orders-watch'] })
  }, [qc])

  const activos = useMemo(
    () => pedidos.filter(p => ACTIVOS.includes(p.status)),
    [pedidos],
  )

  const visibles = useMemo(() => {
    const lista = filtro === 'activos' ? activos : pedidos
    // Los que esperan, primero; y entre ellos, el más viejo arriba.
    return [...lista].sort((a, b) => {
      const activoA = ACTIVOS.includes(a.status) ? 0 : 1
      const activoB = ACTIVOS.includes(b.status) ? 0 : 1
      if (activoA !== activoB) return activoA - activoB
      const fechaA = new Date(a.created_at).getTime()
      const fechaB = new Date(b.created_at).getTime()
      return activoA === 0 ? fechaA - fechaB : fechaB - fechaA
    })
  }, [pedidos, activos, filtro])

  // `useCallback` para que el linter vea que solo depende de `activos`. Sin
  // esto la función se redefinía en cada render y el `useMemo` de abajo lo
  // avisaba como dependencia que falta: el código era correcto —`activos` sí
  // estaba en su lista— pero el aviso salía en cada compilación.
  const cuenta = useCallback(
    (estado: OrderStatus) => activos.filter(p => p.status === estado).length,
    [activos],
  )

  /**
   * Los cuatro estados que más trabajo tienen parado ahora mismo.
   *
   * `pago_en_revision` va SIEMPRE que tenga algo: es un comprobante esperando
   * a que una persona lo mire, y mientras tanto el cliente no sabe si su
   * pedido existe.
   */
  const resumen = useMemo(() => {
    const conPedidos = ACTIVOS.filter(estado => cuenta(estado) > 0)
    const urgentes = conPedidos.filter(estado => estado === 'pago_en_revision')
    const resto = conPedidos.filter(estado => estado !== 'pago_en_revision')
    return [...urgentes, ...resto].slice(0, 4)
  }, [cuenta])

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Pedidos</h1>
          <p className="text-sm text-muted-foreground">
            Lo que llega por la tienda y por el bot, de que entra hasta que se entrega
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={filtro} onValueChange={v => setFiltro(v as typeof filtro)}>
            <TabsList>
              <TabsTrigger value="activos">
                En curso{activos.length ? ` (${activos.length})` : ''}
              </TabsTrigger>
              <TabsTrigger value="todos">Historial</TabsTrigger>
            </TabsList>
          </Tabs>
          {!mostrador && (
            <Button onClick={() => setMostrador(true)}><Plus /> Nuevo pedido</Button>
          )}
        </div>
      </div>

      {mostrador && (
        <div className="mb-4">
          <CounterOrder onListo={() => setMostrador(false)} />
        </div>
      )}

      {/* Resumen del momento: dónde está atascado el trabajo. */}
      {!isLoading && activos.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {/* Se enseñan los cuatro estados con más pedidos parados: con doce,
              una rejilla fija dejaría cuadros en cero ocupando la pantalla y
              escondería justo el que hay que atender. */}
          {resumen.map(estado => (
            <Card key={estado} className="p-3 gap-0">
              <span className="text-xs text-muted-foreground">{ESTADO_TEXTO[estado]}</span>
              <span className="text-xl font-bold text-foreground tabular-nums">{cuenta(estado)}</span>
            </Card>
          ))}
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-4 gap-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
          ))}
        </div>
      )}

      {!isLoading && !visibles.length && (
        <Card className="p-10 text-center gap-1">
          <Receipt className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
          <p className="font-medium text-foreground/90">
            {filtro === 'activos' ? 'Ningún pedido en curso.' : 'Todavía no hay pedidos.'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Cuando un cliente pida por la tienda o por WhatsApp, aparece aquí y suena la alarma.
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {visibles.map(pedido => (
          <TarjetaPedido
            key={pedido.id}
            pedido={pedido}
            ocupado={cambiar.isPending}
            onCambiar={(status) => cambiar.mutate({ id: pedido.id, status })}
            onRefrescar={refrescar}
          />
        ))}
      </div>
    </div>
  )
}
