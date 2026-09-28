import { useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getReports, getAlerts, getPlatformFees, money, type Alert } from './api'
import { Compass, BarChart3, UserRound, ClipboardList, Trophy, ShoppingCart, Snail, Package, Handshake, Frown, Brain, Users, DollarSign, Bot as Repeat2, Sparkles, PackageX, PackageMinus, TrendingDown, TrendingUp, UserMinus, Moon, CreditCard, CircleAlert, TriangleAlert, CircleCheck, Info, Receipt } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Card as UICard, CardContent, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Tabs, TabsList, TabsTrigger } from '@botpanel/ui/components/tabs'
import { Separator } from '@botpanel/ui/components/separator'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@botpanel/ui/components/chart'
import { QueryError } from '@botpanel/ui/components/query-error'
import { BarChart, Bar, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, LabelList } from 'recharts'

// Reportes premium con la librería (misma información REAL del servidor):
// Tabs para el período, pills con variantes, stat-tiles con icono, charts
// oficiales para tendencias y magnitudes, más Badges para conteos/estados.
// Estados (rojo/ámbar) reservados para stock, como siempre.

// Paleta de la librería: crítico/negativo = destructive, positivo = verde
// (estados semáforo), informativo = acento de marca (primary)
const ALERT_STYLE: Record<Alert['level'], string> = {
  critical: 'bg-destructive/10 border-destructive/30 text-destructive',
  warning:  'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300',
  good:     'bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-300',
  info:     'bg-primary/10 border-primary/30 text-primary',
}

// El server manda las alertas con emoji en `icon`; aquí se traduce a Lucide (línea shadcn)
const ALERT_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  '🔴': PackageX, '🟡': PackageMinus, '📋': ClipboardList, '📉': TrendingDown,
  '📈': TrendingUp, '😴': UserMinus, '🛒': ShoppingCart, '🧠': Brain,
  '🌙': Moon, '💳': CreditCard,
}
const ALERT_ICON_FALLBACK: Record<string, React.ComponentType<{ className?: string }>> = {
  critical: CircleAlert, warning: TriangleAlert, good: CircleCheck, info: Info,
}

const PERIODS = [['hoy', 'Hoy'], ['semana', 'Semana'], ['mes', 'Mes']] as const

// Categorías del panel viejo (filterReports): cada card pertenece a un grupo
const CATS = [
  ['todos', 'Todos', null],
  ['ventas', 'Ventas', DollarSign],
  ['productos', 'Productos', Package],
  ['clientes', 'Clientes', Users],
  ['umbani', 'Cómo llegan', Compass],
] as const
type Cat = typeof CATS[number][0]

export default function Reports() {
  const [period, setPeriod] = useState<string>('mes')
  const [cat, setCat] = useState<Cat>('todos')
  // keepPreviousData: al cambiar el período se sigue mostrando el reporte
  // anterior mientras llega el nuevo, en vez de vaciar la pantalla.
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['reports', period],
    queryFn: () => getReports(period),
    placeholderData: keepPreviousData,
  })
  const { data: alertsData } = useQuery({ queryKey: ['alerts'], queryFn: getAlerts, staleTime: 60_000 })
  // Lo que llevamos con la plataforma este mes. Va aquí y no en su propia
  // entrada del menú: es un reporte más, y el menú ya tiene doce.
  const { data: fees } = useQuery({ queryKey: ['platform-fees'], queryFn: getPlatformFees, staleTime: 300_000 })

  const show = (g: Cat) => cat === 'todos' || cat === g

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Reportes del negocio</h1>
          <p className="text-sm text-muted-foreground">
            Ventas y métricas operativas. También puedes pedir reportes por WhatsApp.
            {isFetching && !isLoading && <span className="ml-2 text-primary">Actualizando…</span>}
          </p>
        </div>
        <Tabs value={period} onValueChange={setPeriod}>
          <TabsList>
            {PERIODS.map(([v, l]) => <TabsTrigger key={v} value={v}>{l}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      </div>

      {/* Lo que llevamos con la plataforma. Solo si hay algo que mostrar: un
          negocio sin comisión configurada no tiene por qué ver una tarjeta en
          cero preguntándose qué le van a cobrar. */}
      {fees && Number(fees.margen) > 0 && (
        <UICard className="mb-5 border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Receipt className="w-4 h-4 text-primary shrink-0" />
              Comisión de la plataforma este mes
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* ── Las TRES bolsas, y no se mezclan ─────────────────────────
                Antes eran «Vendiste / Te quedas / Comisión», y las dos
                primeras llevaban dentro la CARRERA: sobre $15.18 decían que
                el local se quedaba $13.98 cuando de su comida solo eran
                $11.98. La carrera es de quien entrega — hoy el propio local,
                pero por LLEVAR la comida, no por venderla. */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">Vendiste</div>
                <div className="text-xl font-bold tabular-nums text-foreground">{money(fees.productos)}</div>
                <div className="text-xs text-muted-foreground">
                  {fees.pedidos} pedidos entregados · solo tus productos
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Reparto</div>
                <div className="text-xl font-bold tabular-nums text-foreground">{money(fees.reparto)}</div>
                <div className="text-xs text-muted-foreground">de quien entrega</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Comisión Umbani</div>
                <div className="text-xl font-bold tabular-nums text-primary">{money(fees.margen)}</div>
                <div className="text-xs text-muted-foreground">se liquida cada lunes con tus pagos</div>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Cuenta al ENTREGAR el pedido. Un pedido cancelado no paga comisión, y una venta anulada deja de contar.
            </p>
          </CardContent>
        </UICard>
      )}

      {/* Atajo a reactivar (igual que el viejo) */}
      <div className="mb-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/reactivate"><span className="inline-flex items-center gap-1.5"><Users className="w-4 h-4" /> Clientes sin escribir (reactivar)</span></Link>
        </Button>
      </div>

      {/* Banner de alertas */}
      {alertsData && alertsData.alerts.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {alertsData.alerts.map((a, i) => {
            const Icon = ALERT_ICON[a.icon] ?? ALERT_ICON_FALLBACK[a.level] ?? Info
            const style = a.icon === '📉' ? ALERT_STYLE.critical : ALERT_STYLE[a.level]
            return (
              <span key={i} className={`text-xs font-medium rounded-lg border px-2.5 py-1.5 inline-flex items-center gap-1.5 ${style}`}>
                <Icon className="w-3.5 h-3.5 shrink-0" /> {a.text}
              </span>
            )
          })}
        </div>
      )}

      {/* Categorías como pestañas de la librería (mismas del panel viejo) */}
      <div className="mb-5 max-w-full overflow-x-auto pb-1">
        <Tabs value={cat} onValueChange={v => setCat(v as Cat)}>
          <TabsList>
            {CATS.map(([v, l, Icon]) => (
              <TabsTrigger key={v} value={v}>
                <span className="inline-flex items-center gap-1.5">{Icon && <Icon className="w-3.5 h-3.5" />}{l}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {isLoading && (
        <div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4 mt-5">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        </div>
      )}
      {isError && <QueryError onRetry={() => { void refetch() }} message="No se pudieron cargar los reportes." />}
      {data && (
        <>
          {/* Resumen del período */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <Stat icon={DollarSign} label="Tus ventas" value={money(data.summary.total)} />
            <Stat icon={ShoppingCart} label="Pedidos" value={String(data.summary.orders)} />
            <Stat icon={Package} label="Ítems" value={String(data.summary.items)} />
            <Stat icon={Receipt} label="Ticket promedio" value={money(data.summary.avg)} />
            <Stat icon={Sparkles} label="Nuevos" value={String(data.summary.nuevos)} />
            <Stat icon={Repeat2} label="Recurrentes" value={String(data.summary.recurrentes)} />
            <Stat icon={TrendingUp} label="Conversión" value={data.summary.conversion === null ? '—' : `${Math.round(data.summary.conversion)}%`} />
          </div>

          <Separator className="my-5" />

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {show('ventas') && (
              <Card title={`Ventas por día (últimos ${data.trend.days} días)`} icon={TrendingUp} full>
                <SalesTrendChart rows={data.trend.rows} />
              </Card>
            )}
            {/* Comparación — BarChart oficial de la librería */}
            {show('ventas') && (<>
            <Card title="Comparación con período anterior" icon={BarChart3} full={cat === 'ventas'}>
              <ComparisonChart label={data.comparison.label} cur={Number(data.comparison.curTotal) || 0} prev={Number(data.comparison.prevTotal) || 0} />
              <p className="text-xs text-muted-foreground mt-2">
                {data.comparison.curOrders} vs {data.comparison.prevOrders} pedidos · Variación:{' '}
                {data.comparison.pct === null
                  ? (data.comparison.curTotal > 0 ? 'sin base anterior' : 'sin datos')
                  : <span className={data.comparison.pct >= 0 ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-destructive font-semibold'}>
                      {data.comparison.pct >= 0 ? '▲ +' : '▼ '}{data.comparison.pct.toFixed(1)}%
                    </span>}
              </p>
            </Card>
            </>)}
            {/* Vendedores */}
            {show('ventas') && (<>
            <Card title="Ventas por vendedor" icon={UserRound}>
              {data.bySeller.rows.length === 0 ? <Empty msg="Sin ventas en el período." /> :
                <MetricBarChart rows={data.bySeller.rows.map(r => ({ label: r.name, value: Number(r.total) || 0, text: money(r.total) }))} metricLabel="Ventas" />}
            </Card>
            </>)}
            {/* Pendientes */}
            {show('ventas') && (<>
            <Card title="Pedidos sin cerrar" icon={ClipboardList} badge={data.pending.count || undefined}>
              {data.pending.rows.length === 0 ? <Empty msg="No hay cotizaciones sin cerrar." /> :
                <ul className="text-sm space-y-1.5">
                  {data.pending.rows.map((r, i) => <li key={i} className="truncate text-foreground/90">{r.name}{r.last_message ? <span className="text-muted-foreground/80"> — “{r.last_message.slice(0, 40)}”</span> : null}</li>)}
                </ul>}
            </Card>
            </>)}
            {/* Top productos */}
            {show('productos') && (<>
            <Card title="Productos más vendidos" icon={Trophy}>
              {data.top.rows.length === 0 ? <Empty msg="Sin ventas en el período." /> :
                <MetricBarChart rows={data.top.rows.map(r => ({ label: r.name, value: r.qty, text: `${r.qty} uds · ${money(r.rev)}` }))} metricLabel="Unidades" />}
            </Card>
            </>)}
            {/* ⚠️ Aquí vivían «Más consultados» y «Consultados sin ventas»:
                las llenaba `product_consultations`, del bot por chat retirado,
                con 2 filas desde el 3 de agosto. Dos tarjetas vacías para
                siempre. Lo que hoy necesita el dueño está en «Cómo llegan tus
                clientes». */}
            {/* Bajo movimiento */}
            {show('productos') && (<>
            <Card title="Bajo movimiento (candidatos a promo)" icon={Snail}>
              {data.lowMovement.rows.length === 0 ? <Empty msg="Todos tus productos tuvieron ventas." /> :
                <ul className="text-sm space-y-2">
                  {data.lowMovement.rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between gap-2">
                      <span className="truncate text-foreground/90">{r.name}</span>
                      <Badge variant="secondary" className="shrink-0 tabular-nums">{r.qty} uds</Badge>
                    </li>
                  ))}
                </ul>}
            </Card>
            </>)}
            {/* Stock bajo (colores de ESTADO reservados; nunca color como única identidad) */}
            {show('productos') && (<>
            <Card title="Stock bajo o agotado" icon={Package}>
              {data.lowStock.rows.length === 0 ? <Empty msg="Nada agotado ni en últimas unidades." /> :
                <StockStatusChart rows={data.lowStock.rows} />}
            </Card>
            </>)}
            {/* Clientes frecuentes */}
            {show('clientes') && (<>
            <Card title="Clientes frecuentes" icon={Handshake}>
              {data.recurring.rows.length === 0 ? <Empty msg="Aún sin clientes recurrentes." /> :
                <MetricBarChart rows={data.recurring.rows.map(r => ({ label: r.name, value: r.orders, text: `${r.orders} compra(s) · ${money(r.total)}` }))} metricLabel="Compras" />}
            </Card>
            </>)}
            {/* Clientes perdidos */}
            {show('clientes') && (<>
            <Card title="Clientes perdidos (escribieron sin comprar)" icon={Frown}>
              {data.lostCustomers.rows.length === 0 ? <Empty msg="Nadie se quedó sin comprar." /> :
                <>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <Badge variant="secondary" className="gap-1"><Repeat2 className="w-3 h-3" /> {data.lostCustomers.returning} ya-cliente</Badge>
                    <Badge variant="secondary" className="gap-1"><Sparkles className="w-3 h-3" /> {data.lostCustomers.nuevos} nuevos</Badge>
                    <Badge variant="secondary" className="tabular-nums">{data.lostCustomers.noRespondio} sin respuesta del negocio</Badge>
                  </div>
                  <MetricBarChart rows={[
                    { label: 'Nuevos', value: data.lostCustomers.nuevos, text: String(data.lostCustomers.nuevos) },
                    { label: 'Ya eran clientes', value: data.lostCustomers.returning, text: String(data.lostCustomers.returning) },
                    { label: 'Sin respuesta', value: data.lostCustomers.noRespondio, text: String(data.lostCustomers.noRespondio) },
                  ]} metricLabel="Clientes" compact />
                  <ul className="text-sm space-y-1.5">
                    {data.lostCustomers.rows.map((r, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span className="truncate text-foreground/90 flex items-center gap-1.5">{r.returning ? <Repeat2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <Sparkles className="w-3.5 h-3.5 text-muted-foreground shrink-0" />} {r.name}</span>
                        {r.reason && <span className="text-xs text-muted-foreground/80 shrink-0">{r.reason}</span>}
                      </li>
                    ))}
                  </ul>
                </>}
            </Card>
            </>)}
            {/* ── Cómo llegan tus clientes ──────────────────────────────
                ⚠️ Esta pestaña se llamaba «Bot» y enseñaba lo que preguntaba
                la gente por chat. Ese bot se retiró en #360/#361 y sus tres
                tablas llevan meses muertas —`conversation_history` parada el
                2026-08-23, `ai_gaps` en cero—: eran tarjetas vacías para
                siempre. Hoy el cliente escribe al número de UMBANI, elige el
                local y recibe su enlace; eso es lo que se mide aquí. */}
            {show('umbani') && (<>
            <Card title="Cómo llegan tus clientes" icon={Compass} full>
              {(data.umbani?.embudo ?? []).length === 0
                ? <Empty msg="Todavía nadie recibió tu enlace en este período." />
                : <MetricBarChart
                    rows={(data.umbani?.embudo ?? []).map(p => ({
                      label: p.paso, value: p.clientes, text: `${p.clientes} persona(s)`,
                    }))}
                    metricLabel="personas"
                  />}
            </Card>

            <Card title="Dónde te encontraron" icon={Compass}>
              {(data.umbani?.llegadas ?? []).length === 0
                ? <Empty msg="Sin datos del menú de Umbani todavía." />
                : <MetricBarChart
                    rows={(data.umbani?.llegadas ?? []).map(l => ({
                      label: l.label, value: l.veces, text: `${l.veces} vez(ces)`,
                    }))}
                    metricLabel="clientes"
                  />}
            </Card>
            </>)}
          </div>
        </>
      )}
    </div>
  )
}

function Card({ title, icon: Icon, badge, full, children }: { title: string; icon?: React.ComponentType<{ className?: string }>; badge?: number; full?: boolean; children: React.ReactNode }) {
  return (
    <UICard className={`gap-3 ${full ? 'md:col-span-2' : ''}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {Icon && <Icon className="w-4 h-4 text-muted-foreground shrink-0" />}
          <span className="truncate">{title}</span>
          {badge !== undefined && <Badge variant="secondary" className="ml-auto shrink-0 tabular-nums">{badge}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </UICard>
  )
}

// Stat-tile de la librería: icono + label y número grande en negrita
function Stat({ label, value, icon: Icon }: { label: string; value: string; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <UICard className="py-3 gap-0">
      <CardContent className="px-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground truncate">
          {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />} {label}
        </div>
        <div className="text-2xl font-bold tracking-tight text-foreground tabular-nums mt-0.5">{value}</div>
      </CardContent>
    </UICard>
  )
}

function Empty({ msg }: { msg: string }) {
  return <p className="text-sm text-muted-foreground">{msg}</p>
}

function SalesTrendChart({ rows }: { rows: { label: string; total: number }[] }) {
  return (
    <ChartContainer config={{ total: { label: 'Ventas', color: 'var(--chart-1)' } }} className="aspect-auto h-56 w-full">
      <LineChart accessibilityLayer data={rows} margin={{ top: 24, left: 12, right: 12 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={18} tick={{ fontSize: 11 }} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel formatter={moneyTooltip('Ventas')} />} />
        <Line dataKey="total" type="monotone" stroke="var(--color-total)" strokeWidth={2}
          dot={{ r: 3, fill: 'var(--color-total)', stroke: 'var(--card)', strokeWidth: 2 }}>
          <LabelList dataKey="total" position="top" offset={8} className="fill-muted-foreground" fontSize={10}
            formatter={(value: unknown) => Number(value) > 0 ? money(Number(value)) : ''} />
        </Line>
      </LineChart>
    </ChartContainer>
  )
}

type MetricChartRow = { label: string; value: number; text: string }

function MetricBarChart({ rows, metricLabel, compact = false }: {
  rows: MetricChartRow[]
  metricLabel: string
  compact?: boolean
}) {
  const visibleRows = rows.slice(0, 10)
  return (
    <ChartContainer
      config={{ value: { label: metricLabel, color: 'var(--chart-1)' } }}
      className="aspect-auto w-full"
      style={{ height: compact ? 126 : Math.max(visibleRows.length * 38 + 20, 96) }}
    >
      <BarChart accessibilityLayer data={visibleRows} layout="vertical" margin={{ left: 4, right: 92 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" hide />
        <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={112}
          tick={{ fontSize: 11 }} tickFormatter={value => String(value).length > 18 ? `${String(value).slice(0, 17)}…` : String(value)} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="value" fill="var(--color-value)" radius={4} maxBarSize={18}>
          <LabelList dataKey="text" position="right" className="fill-muted-foreground" fontSize={10} />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

function StockStatusChart({ rows }: { rows: { name: string; stock: string }[] }) {
  const exhausted = rows.filter(row => row.stock === 'agotado').length
  const lastUnits = rows.length - exhausted
  return <MetricBarChart metricLabel="Productos" compact rows={[
    { label: 'Agotados', value: exhausted, text: String(exhausted) },
    { label: 'Últimas unidades', value: lastUnits, text: String(lastUnits) },
  ]} />
}

// Tooltip de dinero para los charts
const moneyTooltip = (label: string) => (value: unknown) => (
  <div className="flex w-full items-center justify-between gap-4">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-mono font-medium tabular-nums text-foreground">{money(Number(value))}</span>
  </div>
)

// ── Comparación — BarChart vertical oficial (actual azul, anterior gris) ──
function ComparisonChart({ label, cur, prev }: { label: string; cur: number; prev: number }) {
  const data = [
    { name: label, total: cur, fill: 'var(--chart-1)' },
    { name: 'Anterior', total: prev, fill: 'var(--muted-foreground)' },
  ]
  return (
    <ChartContainer config={{ total: { label: 'Ventas' } }} className="aspect-auto h-48 w-full">
      <BarChart accessibilityLayer data={data} margin={{ top: 24 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel formatter={moneyTooltip('Ventas')} />} />
        <Bar dataKey="total" radius={[8, 8, 0, 0]} maxBarSize={72}>
          <LabelList dataKey="total" position="top" offset={8} className="fill-muted-foreground" fontSize={11}
            formatter={(v: unknown) => money(Number(v))} />
          {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
