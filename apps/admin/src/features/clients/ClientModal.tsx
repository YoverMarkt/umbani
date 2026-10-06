import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import * as adm from './api'
import type { BusinessPayload } from './api'
import { Button } from '@botpanel/ui/components/button'
import { Input } from '@botpanel/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Label } from '@botpanel/ui/components/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { toast } from 'sonner'
import CartaDelLocal from './CartaDelLocal'
import { getCiudades, type Ciudad } from '../ciudades/api'
import { getCooperativas, type Cooperativa } from '../cooperativas/api'
import { contarProductos, paraEnviar, preciosQueFaltan, type CartaEnRevision } from './carta'
import {
  BUSINESS_TYPE_OPTIONS,
  CUSTOM_BUSINESS_TYPE,
  businessTypeChoice,
  recommendedStorefrontForBusinessType,
  recommendedSalesForBusinessType,
  chatModeSummary,
} from './business-types'
import { PLAN_CATALOG, planById } from './plans'

// Modal de crear/editar negocio — paridad con el panel viejo:
// identidad, canal WhatsApp por proveedor (con verificación real),
// modo de venta, IA por negocio, plan/tarifa y acceso del dueño.

const EMPTY = {
  name: '', type: 'negocio', whatsapp_number: '', owner_phone: '',
  // Un local NUEVO nace en el marketplace: se atiende por el número de la
  // plataforma y no necesita cuenta de YCloud. Era 'ycloud' hasta el
  // 2026-08-21, y eso obligaba a acordarse de cambiarlo — si no, el alta pedía
  // credenciales de una cuenta que ese local no va a tener nunca.
  //
  // ⚠️ Solo afecta al alta. Al EDITAR se lee el proveedor guardado (más abajo),
  // así que ningún negocio con canal propio se ve reescrito.
  whatsapp_provider: 'marketplace', ycloud_api_key: '',
  ycloud_webhook_endpoint_id: '', ycloud_webhook_secret: '',
  meta_token: '', meta_phone_id: '',
  telegram_bot_token: '',
  sales: 'informa',
  storefront: 'no',
  plan: 'micro', monthly_rate: '25',
  monthly_contact_limit: '50', monthly_outbound_message_limit: '250',
  client_email: '', client_password: '', notes: '',
  card_mode: 'apagado' as 'apagado' | 'pruebas' | 'produccion',
  delivery_by: 'local' as 'local' | 'umbani' | 'cooperativa',
  cooperative_id: '',
  own_fleet: false,
  city_id: '',
}

export default function ClientModal({ id, onClose, onSaved }: { id: string | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(EMPTY)
  const [loading, setLoading] = useState(!!id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [salesTouched, setSalesTouched] = useState(false)
  const [storefrontTouched, setStorefrontTouched] = useState(false)
  const [applyPlanDefaults, setApplyPlanDefaults] = useState(false)

  // Editar → cargar el detalle real (el server nunca manda esto a paneles de cliente)
  useEffect(() => {
    if (!id) return
    adm.getClient(id).then(c => {
      setF({
        name: c.name ?? '', type: c.type ?? 'negocio',
        whatsapp_number: c.whatsapp_number ?? '', owner_phone: c.owner_phone ?? '',
        // ⚠️ `marketplace` y no `ycloud`: desde el 2026-08-23 ningún local
        // tiene canal propio. Con `ycloud` de defecto, un negocio sin
        // proveedor guardado abría el modal pidiendo credenciales de una
        // cuenta que no existe.
        whatsapp_provider: c.whatsapp_provider ?? 'marketplace',
        ycloud_api_key: '',
        ycloud_webhook_endpoint_id: c.ycloud_webhook_endpoint_id ?? '',
        ycloud_webhook_secret: '',
        meta_token: '', meta_phone_id: c.meta_phone_id ?? '',
        telegram_bot_token: '',
        sales: c.takes_orders === false ? 'informa' : 'vende',
        storefront: c.storefront_enabled ? 'yes' : 'no',
        plan: planById(c.plan)?.id ?? c.plan ?? 'micro',
        monthly_rate: c.monthly_rate != null ? String(c.monthly_rate) : '',
        monthly_contact_limit: c.monthly_contact_limit != null
          ? String(c.monthly_contact_limit)
          : '',
        monthly_outbound_message_limit: c.monthly_outbound_message_limit != null
          ? String(c.monthly_outbound_message_limit)
          : '',
        client_email: c.client_email ?? '', client_password: '',
        notes: c.notes ?? '',
        card_mode: c.card_mode ?? 'apagado',
        delivery_by: c.delivery_by ?? 'local',
        cooperative_id: c.cooperative_id ?? '',
        own_fleet: c.own_fleet === true,
        city_id: c.city_id ?? '',
      })
      setCajones(c.marketplace_categories ?? [])
      setLoading(false)
    }).catch(e => { setError(e instanceof Error ? e.message : 'Error'); setLoading(false) })
  }, [id])

  // ⚠️ Aquí vivía `setVal`, el ayudante para los Select de Radix. Se queda sin
  // uso el 2026-08-23: los dos desplegables que quedaban en el modal —«Ventas
  // por el bot» y «Mini app de la tienda»— se fundieron en «Aparece en el
  // marketplace», que escribe los dos campos a la vez con `setEnMarketplace`.
  // El tipo de negocio y el plan tienen sus propios manejadores.

  // ── Los cajones del menú del chat ────────────────────────────────────────
  //
  // ⚠️ El cliente no busca «un restaurante de comida típica»: busca pizza,
  // almuerzo o cena. Por eso un local vive en los CAJONES que cubre —hasta
  // tres— y no en el que le tocó por su tipo. El primero es el principal.
  //
  // Vacío = no se manda nada y sigue mandando el tipo, que es como viven los
  // locales que nadie ha editado.
  const [cajones, setCajones] = useState<string[]>([])
  // Solo al crear: la carta revisada ocupa el sitio de los productos de ejemplo.
  const [carta, setCarta] = useState<CartaEnRevision | null>(null)
  const [cajonesDelMenu, setCajonesDelMenu] = useState<adm.CajonDelMenu[]>([])
  useEffect(() => {
    adm.getMarketplaceCategories().then(setCajonesDelMenu).catch(() => setCajonesDelMenu([]))
  }, [])
  // Las ciudades donde atiende Umbani (2026-10-05): sin ciudad, el local no
  // aparece a ningún cliente.
  const [ciudades, setCiudades] = useState<Ciudad[]>([])
  useEffect(() => {
    getCiudades().then(setCiudades).catch(() => setCiudades([]))
  }, [])
  // Las cooperativas de reparto (2026-10-06): se ofrecen las de la ciudad del local.
  const [cooperativas, setCooperativas] = useState<Cooperativa[]>([])
  useEffect(() => {
    getCooperativas().then(setCooperativas).catch(() => setCooperativas([]))
  }, [])

  const alternarCajon = (code: string) => {
    setCajones(prev => (
      prev.includes(code)
        ? prev.filter(item => item !== code)
        // Tres como mucho, igual que la base: más cajones es ruido, y el
        // cliente deja de fiarse de los botones del menú.
        : prev.length >= 3 ? prev : [...prev, code]
    ))
  }

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = e.target.value
    setF(prev => {
      const next = { ...prev, [k]: value }
      // Presugerir el modo según el tipo SOLO al crear (al editar se respeta lo guardado)
      if (k === 'type' && !id && !salesTouched) {
        next.sales = recommendedSalesForBusinessType(value)
      }
      if (k === 'type' && !id && !storefrontTouched) {
        next.storefront = recommendedStorefrontForBusinessType(value) ? 'yes' : 'no'
      }
      return next
    })
  }

  const selectBusinessType = (value: string) => {
    setF(prev => {
      const type = value === CUSTOM_BUSINESS_TYPE ? '' : value
      return {
        ...prev,
        type,
        sales: id || salesTouched ? prev.sales : recommendedSalesForBusinessType(type),
        storefront: id || storefrontTouched
          ? prev.storefront
          : recommendedStorefrontForBusinessType(type) ? 'yes' : 'no',
      }
    })
  }

  const selectPlan = (value: string) => {
    const preset = planById(value)
    if (!preset) return
    setApplyPlanDefaults(true)
    setF(prev => ({
      ...prev,
      plan: preset.id,
      monthly_rate: String(preset.monthlyRate),
      monthly_contact_limit: String(preset.monthlyContactLimit),
      monthly_outbound_message_limit: String(preset.monthlyOutboundMessageLimit),
    }))
  }

  // ⚠️ Aquí vivían `requestVerification` y `verify`, que comprobaban las
  // credenciales del canal PROPIO de un negocio. Se van con el bloque que las
  // llamaba: sin canal propio no hay nada que verificar — el verificador
  // consultaría una cuenta que no existe.
  //
  // El botón de verificar el número del MARKETPLACE es otro y sigue vivo, en
  // Ajustes del servidor (`/api/admin/verify-platform-channel`).

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    // ⚠️ SIEMPRE. Desde el 2026-08-23 ningún local tiene canal propio: no hay
    // pantalla para dárselo y la base lo impediría con el número de la
    // plataforma. Se deja explícito en vez de leer el guardado para que un
    // negocio que venga de la etapa anterior quede convertido al editarlo, en
    // vez de conservar en silencio un número que secuestraría el enrutado.
    const sinCanalPropio = true
    if (!f.name.trim()) { setError('El nombre es obligatorio'); return }
    if (!sinCanalPropio && !f.whatsapp_number.trim()) { setError('El número de WhatsApp es obligatorio'); return }
    // En el marketplace es el ÚNICO número del negocio, y es lo que le deja
    // pedir sus reportes por WhatsApp. Sin él, el local nace sin forma de que
    // su dueño lo alcance desde el chat.
    if (sinCanalPropio && !id && !f.owner_phone.trim()) {
      setError('El WhatsApp del dueño es obligatorio: es con lo que pide sus reportes')
      return
    }
    if (!id && !(parseFloat(f.monthly_rate) > 0)) { setError('Selecciona un plan con una tarifa mensual válida'); return }
    if (!id && (!f.client_email.trim() || !f.client_password)) { setError('El correo y la contraseña del dueño son obligatorios al crear'); return }
    const payload: BusinessPayload = {
      name: f.name.trim(), type: f.type.trim() || 'negocio',
      whatsapp_number: sinCanalPropio ? null : f.whatsapp_number.trim(),
      owner_phone: f.owner_phone.trim() || null,
      whatsapp_provider: 'marketplace' as BusinessPayload['whatsapp_provider'],
      ycloud_number: sinCanalPropio ? null : (f.whatsapp_number.trim() || null),
      ycloud_webhook_endpoint_id: sinCanalPropio ? null : (f.ycloud_webhook_endpoint_id.trim() || null),
      meta_phone_id: sinCanalPropio ? null : (f.meta_phone_id || null),
      takes_orders: f.sales !== 'informa',
      // Un negocio que deja de vender no puede quedarse con la tienda
      // encendida: abriría una app vacía.
      storefront_enabled: f.storefront === 'yes' && f.sales !== 'informa',
      notes: f.notes || null,
    }
    // La tarjeta solo se decide EDITANDO: un local nace sin cobro con tarjeta.
    if (id) payload.card_mode = f.card_mode === 'apagado' ? null : f.card_mode
    if (id) payload.delivery_by = f.delivery_by
    // La cooperativa solo con «Una cooperativa»; con las otras dos, se suelta.
    if (id) payload.cooperative_id = f.delivery_by === 'cooperativa' ? (f.cooperative_id || null) : null
    if (id) payload.own_fleet = f.own_fleet
    // Al crear y al editar: sin ella no aparece a los clientes.
    payload.city_id = f.city_id || null
    // Solo si hay algo elegido: una lista vacía en el alta significaría
    // «ninguno», y lo que queremos es «los de su tipo».
    if (cajones.length) payload.marketplace_categories = cajones
    const officialPlan = planById(f.plan)
    if (officialPlan) {
      payload.plan = officialPlan.id
      payload.monthly_rate = parseFloat(f.monthly_rate) || null
      payload.monthly_contact_limit = f.monthly_contact_limit
        ? Number(f.monthly_contact_limit)
        : null
      payload.monthly_outbound_message_limit = f.monthly_outbound_message_limit
        ? Number(f.monthly_outbound_message_limit)
        : null
      if (id && applyPlanDefaults) payload.apply_plan_defaults = true
    }
    if (f.ycloud_api_key.trim()) payload.ycloud_api_key = f.ycloud_api_key.trim()
    if (f.ycloud_webhook_secret.trim()) {
      payload.ycloud_webhook_secret = f.ycloud_webhook_secret.trim()
    }
    if (f.meta_token.trim()) payload.meta_token = f.meta_token.trim()
    if (f.telegram_bot_token.trim()) payload.telegram_bot_token = f.telegram_bot_token.trim()
    if (f.client_email) payload.client_email = f.client_email.trim()
    if (f.client_password) payload.client_password = f.client_password
    if (!id && carta) {
      // El servidor lo vuelve a comprobar todo; esto ahorra el viaje para lo
      // que ya se ve en pantalla.
      const faltan = preciosQueFaltan(carta)
      if (faltan.length) {
        setError(`Faltan precios en la carta: ${faltan.slice(0, 3).join(' · ')}`)
        return
      }
      if (!contarProductos(carta)) {
        setError('La carta se quedó sin productos: quítala o añade alguno')
        return
      }
      payload.carta = paraEnviar(carta)
    }
    setSaving(true)
    // ⚠️ Aquí se verificaban las credenciales del canal antes de guardar, y el
    // bloque entero murió el 2026-08-23: sin canal propio no hay credenciales
    // que verificar, así que la condición nunca se cumplía. Se retira en vez
    // de dejarla como rama inalcanzable — que es justo el tipo de código que
    // luego nadie sabe si está vivo.
    //
    // ⚠️ Y este bloque tiene historia: en su día verificaba para TODO proveedor
    // que no fuera Telegram, así que el alta de un local de marketplace moría
    // con «Proveedor no reconocido» — con las pruebas y los verificadores en
    // verde, porque ninguno pasa por el panel.
    try {
      if (id) await adm.updateClient(id, payload)
      else {
        const alta = await adm.createClient(payload)
        if (alta.carta) {
          toast.success(`Carta cargada: ${alta.carta.productos} producto${alta.carta.productos === 1 ? '' : 's'}`)
        }
        // Si la carta no entró, quien la revisó tiene que enterarse: el local
        // existe igual, pero sin sus productos.
        if (alta.aviso) toast.warning(alta.aviso, { duration: 12_000 })
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
    } finally { setSaving(false) }
  }

  /**
   * ¿Este local sale en el menú de Umbani?
   *
   * DERIVADO de los dos campos que ya existían, no un campo nuevo: el payload
   * sigue mandando exactamente `takes_orders` y `storefront_enabled`. Lo que
   * cambia es que ya no se pueden poner en desacuerdo desde la pantalla, que
   * era el estado en el que un local «vendía» sin que ningún cliente pudiera
   * encontrarlo.
   *
   * Las condiciones son las mismas que aplica `marketplace_categories_disponibles`
   * en la base. `active` y `suspended` no entran aquí: se manejan con Suspender
   * y Reactivar, no editando la ficha.
   */
  const enMarketplace = f.sales !== 'informa' && f.storefront === 'yes'

  const setEnMarketplace = (value: string) => {
    const visible = value === 'si'
    setSalesTouched(true)
    setStorefrontTouched(true)
    setF(prev => ({
      ...prev,
      sales: visible ? 'vende' : 'informa',
      storefront: visible ? 'yes' : 'no',
      // ⚠️ Aquí se escribía el modo de conversación, y no era un capricho: el
      // servidor rechazaba la mini app sin pedidos ni tienda, así que ocultar
      // un local fallaba al guardar y había que moverle el modo para
      // esquivarlo. Esa validación se retiró el 2026-09-16 junto con el modo
      // menú —con un solo modo significaba «todo local tiene que vender»— y
      // ocultar un local vuelve a ser lo que dice que es: dos columnas.
    }))
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
      <form onSubmit={save}>
        <DialogHeader className="mb-4">
          <DialogTitle>{id ? 'Editar negocio' : 'Nuevo negocio'}</DialogTitle>
          <DialogDescription>Configura identidad, canales, plan y acceso del negocio.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Identidad */}
            <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-2">
              <div><Label htmlFor="client-name">Nombre *</Label><Input id="client-name" value={f.name} onChange={set('name')} placeholder="Pizzería Don Luigi" /></div>
              <div>
                <Label htmlFor="client-business-type">Tipo de negocio</Label>
                <Select value={businessTypeChoice(f.type)} onValueChange={selectBusinessType}>
                  <SelectTrigger id="client-business-type" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUSINESS_TYPE_OPTIONS.map(option => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_BUSINESS_TYPE}>Escribir otro tipo…</SelectItem>
                  </SelectContent>
                </Select>
                {businessTypeChoice(f.type) === CUSTOM_BUSINESS_TYPE && (
                  <Input id="client-custom-business-type" aria-label="Otro tipo de negocio" className="mt-2" value={f.type} onChange={set('type')} placeholder="Ej: centro de yoga" />
                )}
              </div>
              {/* El negocio del marketplace se atiende por el número de la
                  plataforma, así que no tiene uno propio que pedirle. El campo
                  se oculta en vez de quedarse vacío: la base lo rechazaría. */}
              {f.whatsapp_provider !== 'marketplace' && (
                <div><Label htmlFor="client-whatsapp-number">WhatsApp del negocio *</Label><Input id="client-whatsapp-number" value={f.whatsapp_number} onChange={set('whatsapp_number')} placeholder="+593…" /></div>
              )}
              <div><Label htmlFor="client-owner-phone">WhatsApp del dueño (reportes){f.whatsapp_provider === 'marketplace' ? ' *' : ''}</Label><Input id="client-owner-phone" value={f.owner_phone} onChange={set('owner_phone')} placeholder="+593… (solo él pide reportes)" /></div>
            </div>

            {/* ⚠️ UNA decisión, no dos — cambiado el 2026-08-23.
                Aquí había dos desplegables, «Ventas por el bot»
                (`takes_orders`) y «Mini app de la tienda»
                (`storefront_enabled`), y la base exige LOS DOS para que un
                local salga en el menú (`marketplace_categories_disponibles`).
                Eso abría un estado trampa —crea pedidos pero sin tienda— en el
                que el local quedaba invisible en el marketplace sin que nada
                lo dijera: el superadmin lo veía «vendiendo» y ningún cliente
                podía encontrarlo.

                Los nombres tampoco valían ya: hablaban de un bot que informa y
                deriva, y de un bot que manda su enlace. Ese bot por local no
                existe desde que se retiró la IA y el canal propio; quien manda
                el enlace es el menú de Umbani.

                Las DOS columnas se siguen enviando en el payload, con el mismo
                valor. Ninguna se retira. */}
            {id ? (
            <div className="mb-4 rounded-lg border border-border/70 p-3">
              <Label htmlFor="client-marketplace">Aparece en el marketplace</Label>
              <Select value={enMarketplace ? 'si' : 'no'} onValueChange={setEnMarketplace}>
                <SelectTrigger id="client-marketplace" className="mt-1 w-full sm:max-w-md"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="si">Sí — sale en el menú y recibe pedidos</SelectItem>
                  <SelectItem value="no">No — queda oculto para los clientes</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-muted-foreground" data-testid="client-marketplace-help">
                {enMarketplace
                  ? 'Quien escriba al número de Umbani lo encontrará en su categoría y recibirá el enlace de su tienda. Enciéndelo con el catálogo ya cargado: una tienda vacía se ve peor que ninguna.'
                  : 'No aparece en ninguna categoría del menú y su tienda no acepta pedidos. Úsalo mientras se carga el catálogo; el negocio y sus datos siguen intactos.'}
              </p>
            </div>
            ) : (
              <div className="mb-4 rounded-lg border border-border/70 p-3">
                <p className="text-sm text-foreground" data-testid="client-mode-summary">
                  {chatModeSummary(f.type)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Lo decide el tipo de negocio. Se puede cambiar después, al editarlo.
                </p>
              </div>
            )}

            {/* ── Cobro con tarjeta (PayPhone) ──────────────────────────
                Solo aquí y solo editando: el dinero de la tarjeta entra en la
                cuenta de Umbani, así que no lo enciende el dueño. El servidor
                la ofrece únicamente si su propio modo (PAYPHONE_MODO) coincide
                con este: un local en «pruebas» no cobra con el servidor en
                producción, y uno real nunca recibe pagos de prueba. */}
            {id && (
              <div className="mb-4 rounded-lg border border-border/70 p-3">
                <Label htmlFor="client-card-mode">Cobro con tarjeta (PayPhone)</Label>
                <Select
                  value={f.card_mode}
                  onValueChange={valor => setF(prev => ({ ...prev, card_mode: valor as typeof prev.card_mode }))}
                >
                  <SelectTrigger id="client-card-mode" className="mt-1 w-full sm:max-w-md"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="apagado">Apagado — no ofrece tarjeta</SelectItem>
                    <SelectItem value="pruebas">Pruebas — solo el local de pruebas</SelectItem>
                    <SelectItem value="produccion">Producción — cobro real</SelectItem>
                  </SelectContent>
                </Select>
                <p
                  className={f.card_mode === 'apagado'
                    ? 'mt-2 text-xs text-muted-foreground'
                    : 'mt-2 text-xs font-medium text-amber-600 dark:text-amber-400'}
                  data-testid="client-card-mode-help"
                >
                  {f.card_mode === 'pruebas'
                    ? 'En pruebas PayPhone aprueba todo SIN cobrar. Úsalo solo en el local de pruebas, nunca en uno real.'
                    : f.card_mode === 'produccion'
                      ? 'Cobro REAL: el dinero entra en la cuenta PayPhone de Umbani. Enciéndelo solo con el contrato firmado con el local.'
                      : 'El cliente paga en efectivo o por transferencia, como siempre.'}
                </p>
              </div>
            )}

            {/* ── Quién reparte ─────────────────────────────────────────
                Con «Umbani», sus pedidos se les ofrecen a los motorizados de
                la plataforma, que guardan el efectivo y liquidan los lunes. */}
            {id && (
              <div className="mb-4 rounded-lg border border-border/70 p-3">
                <Label htmlFor="client-delivery-by">Quién reparte</Label>
                <Select value={f.delivery_by} onValueChange={v => setF(prev => ({ ...prev, delivery_by: v as typeof prev.delivery_by }))}>
                  <SelectTrigger id="client-delivery-by" className="mt-1 w-full sm:max-w-md"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">El local, con su gente (como hoy)</SelectItem>
                    <SelectItem value="umbani">Motorizados de Umbani</SelectItem>
                    <SelectItem value="cooperativa">Una cooperativa</SelectItem>
                  </SelectContent>
                </Select>

                {/* Una cooperativa (2026-10-06): de la ciudad del local, o sus
                    motorizados nunca verían sus pedidos. La base lo exige igual. */}
                {f.delivery_by === 'cooperativa' && (() => {
                  const deSuCiudad = cooperativas.filter(c => c.ciudadId === f.city_id && (c.activa || c.id === f.cooperative_id))
                  return (
                    <div className="mt-3">
                      <Label htmlFor="client-cooperative">Qué cooperativa</Label>
                      {!f.city_id
                        ? <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Primero elige la ciudad del local (más abajo).</p>
                        : !deSuCiudad.length
                          ? <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">No hay cooperativas en la ciudad del local. Créala en «Cooperativas».</p>
                          : (
                            <Select value={f.cooperative_id || 'ninguna'} onValueChange={v => setF(prev => ({ ...prev, cooperative_id: v === 'ninguna' ? '' : v }))}>
                              <SelectTrigger id="client-cooperative" className="mt-1 w-full sm:max-w-md"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ninguna">Elige la cooperativa</SelectItem>
                                {deSuCiudad.map(c => <SelectItem key={c.id} value={c.id}>{c.nombre}{c.activa ? '' : ' (apagada)'}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        Sus motorizados llevan los pedidos de este local: Umbani les paga la carrera el lunes y ellos
                        liquidan su efectivo con Umbani.
                      </p>
                    </div>
                  )
                })()}

                {/* Repartidores propios, local por local (2026-10-04): se
                    enciende al local que dice «tengo mi flota». Solo tiene
                    sentido si reparte él mismo; con «Umbani» la base no deja
                    a su flota llevar nada, así que ni se ofrece. */}
                {f.delivery_by === 'local' && (
                  <div className="mt-3">
                    <Label htmlFor="client-own-fleet">Repartidores propios en la app</Label>
                    <Select value={f.own_fleet ? 'si' : 'no'} onValueChange={v => setF(prev => ({ ...prev, own_fleet: v === 'si' }))}>
                      <SelectTrigger id="client-own-fleet" className="mt-1 w-full sm:max-w-md"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="no">Apagado: el local reparte sin la app</SelectItem>
                        <SelectItem value="si">Encendido: el local registra a sus repartidores</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Encendido, el local ve «Repartidores» en su panel y los registra. Ellos entran a la
                      app del motorizado con su WhatsApp y solo ven los pedidos de este local. Apagado, no
                      reciben pedidos nuevos.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── Dónde lo busca el cliente ────────────────────────────
                El cajón es un ANTOJO, no una clasificación de empresas: nadie
                busca «un restaurante de comida típica», busca almuerzo o cena.
                Un local real cubre varios, y hasta el 2026-09-17 solo podía
                vivir en el que le tocaba por su tipo — a las 7 de la tarde el
                cliente veía «Almuerzos» y se iba creyendo que no había nada
                para él. */}
            {/* ── En qué ciudad está (2026-10-05) ───────────────────────
                El cliente solo ve los locales de SU ciudad, y el motorizado de
                Umbani solo los pedidos de la suya. Sin ciudad, no aparece. */}
            <div className="mb-4 rounded-lg border border-border/70 p-3">
              <Label htmlFor="client-ciudad">Ciudad</Label>
              <Select value={f.city_id || 'sin'} onValueChange={v => setF(prev => ({ ...prev, city_id: v === 'sin' ? '' : v }))}>
                <SelectTrigger id="client-ciudad" className="mt-1 w-full sm:max-w-md"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sin">Sin ciudad (no aparece a los clientes)</SelectItem>
                  {ciudades.filter(c => c.active || c.id === f.city_id).map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (apagada)'}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!f.city_id && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  Sin ciudad, este local no sale en el chat, ni en la búsqueda, ni en la app.
                </p>
              )}
            </div>

            {cajonesDelMenu.length > 0 && (
              <div className="mb-4 rounded-lg border border-border/70 p-3">
                {/* ⚠️ No es un `Label`: no hay un control al que apuntar, son
                    botones. Un `label` suelto rompe —con razón— la guardia de
                    etiquetas del E2E. El grupo lleva su nombre accesible. */}
                <span id="client-cajones-titulo" className="text-sm font-medium">
                  Dónde lo busca el cliente
                </span>
                <div
                  role="group"
                  aria-labelledby="client-cajones-titulo"
                  className="mt-2 flex flex-wrap gap-2"
                >
                  {cajonesDelMenu.map(cajon => {
                    const elegido = cajones.includes(cajon.code)
                    const principal = cajones[0] === cajon.code
                    return (
                      <Button
                        key={cajon.code}
                        type="button"
                        size="sm"
                        variant={elegido ? 'default' : 'outline'}
                        aria-pressed={elegido}
                        onClick={() => alternarCajon(cajon.code)}
                        className={`gap-0 rounded-full text-xs ${elegido ? '' : 'text-muted-foreground'}`}
                      >
                        {cajon.emoji ? `${cajon.emoji} ` : ''}{cajon.label}
                        {principal && ' · principal'}
                      </Button>
                    )
                  })}
                </div>
                <p className="mt-2 text-xs text-muted-foreground" data-testid="client-cajones-help">
                  {cajones.length === 0
                    ? 'Sin elegir: aparece en el cajón que le da su tipo de negocio.'
                    : `Aparece en ${cajones.length} de 3. El primero es el principal; un local que sirve almuerzo y cena puede estar en los dos.`}
                </p>
              </div>
            )}

            {/* Canal WhatsApp — ⚠️ Solo al EDITAR.
                Un local NACE en el marketplace: se atiende por el número de
                la plataforma y no tiene credenciales que pedir ni verificar.
                Un negocio con número propio es hoy el caso raro —queda uno en
                producción y ya existe—, así que se configura aquí, al editar,
                en vez de gastar siete campos del alta en algo que casi nadie
                rellena. Nada se pierde: todo esto sigue vivo e intacto. */}
            {/* ⚠️ AQUÍ NO HAY NADA DEL CANAL, y es el final de un camino.

                Hasta el 2026-08-23 vivían aquí siete campos —proveedor, API
                Key, Endpoint ID, Signing Secret, token y Phone ID de Meta,
                token de Telegram— y un botón de verificar. Se retiraron cuando
                Monster Pizza acabó con el MISMO número que la plataforma:
                `resolveBusinessChannel` la encontraba antes de llegar a la
                rama del marketplace, y escribir al número de Umbani contestaba
                con su mini app en vez de las categorías.

                En su lugar quedó un aviso que explicaba que este local no
                tiene número propio, ni YCloud, ni webhook. Se retiró el
                2026-09-03 a petición del dueño: «todo local va al marketplace,
                no le vemos la razón de ser». Y tenía razón — con cero negocios
                de canal propio, ese recuadro gastaba cinco líneas del modal
                para decir lo que ya se da por supuesto, y hacía que editar
                pareciera más complicado que crear.

                ⚠️ La defensa NO era esta pantalla ni ese texto: es el
                disparador `businesses_numero_de_plataforma` en la base. Quitar
                los campos evitó el error de dedo; solo la guarda impide que el
                número de la plataforma vuelva a entrar por una API o por un
                `update` a mano. Si algún día vuelve el canal propio, vuelve
                aquí — y con él su aviso. */}

            {/* Plan y facturación */}
            <div className="mb-4 rounded-lg border border-border/70 p-3">
              <h3 className="mb-3 text-sm font-semibold">Plan y facturación automática</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="client-plan">Plan</Label>
                <Select value={f.plan} onValueChange={selectPlan}>
                  <SelectTrigger id="client-plan" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {!planById(f.plan) && (
                      <SelectItem value={f.plan} disabled>Plan anterior: {f.plan}</SelectItem>
                    )}
                    {PLAN_CATALOG.map(plan => (
                      // Solo el precio: los cupos se siguen guardando y
                      // Medición alerta los excesos, pero al dar de alta lo
                      // único que se pacta con el negocio es la mensualidad.
                      <SelectItem key={plan.id} value={plan.id}>
                        {plan.label} — ${plan.monthlyRate}/mes
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* ⚠️ Eran tres inputs `readOnly`: tres campos que ocupaban
                  media pantalla y que nadie podía tocar, porque los tres
                  salen del plan elegido arriba. Como resumen dicen lo mismo
                  ocupando una línea. El payload no cambia: se siguen enviando
                  los mismos valores. */}
              <div className="self-end text-sm text-muted-foreground" data-testid="client-plan-summary">
                {planById(f.plan)
                  ? <strong className="text-foreground">${f.monthly_rate}/mes</strong>
                  : 'Selecciona un plan'}
              </div>
              </div>
              <p id="client-plan-help" className="mt-3 text-xs text-muted-foreground">
                La tarifa pertenece al plan seleccionado. Cada mes se crea una sola cuota automáticamente; la suspensión por falta de pago continúa siendo manual.
              </p>
              {id && planById(f.plan) && (
                <Button
                  className="mt-3"
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => selectPlan(f.plan)}
                >
                  Aplicar valores vigentes del plan
                </Button>
              )}
            </div>

            {/* Acceso del dueño */}
            <div className="grid grid-cols-1 gap-3 mb-4 sm:grid-cols-2">
              <div><Label htmlFor="client-owner-email">Correo del dueño (panel)</Label><Input id="client-owner-email" type="email" autoComplete="off" value={f.client_email} onChange={set('client_email')} /></div>
              <div><Label htmlFor="client-owner-password">Contraseña {id ? '(solo si cambia)' : 'del panel'}</Label><Input id="client-owner-password" type="password" autoComplete="new-password" minLength={12} value={f.client_password} onChange={set('client_password')} /></div>
              <div className="sm:col-span-2"><Label htmlFor="client-internal-notes">Notas internas</Label><Input id="client-internal-notes" value={f.notes} onChange={set('notes')} /></div>
            </div>

            {!id && <CartaDelLocal carta={carta} onCambio={setCarta} />}

            {!id && <p className="mb-4 text-xs text-muted-foreground">Se creará un horario inicial de lunes a viernes, 09:00–18:00, y sábado, 09:00–13:00. El dueño puede cambiarlo inmediatamente desde Horarios.</p>}

            {error && (
              <p role="alert" className="text-sm text-destructive mb-3 flex items-start gap-1.5">
                <X className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </p>
            )}

            <DialogFooter className="mx-0 mb-0 px-0 pb-0">
              <Button variant="outline" type="button" onClick={onClose}>Cancelar</Button>
              <Button disabled={saving}>
                {saving ? 'Guardando…' : id ? 'Guardar cambios' : 'Crear negocio'}
              </Button>
            </DialogFooter>
          </>
        )}
      </form>
      </DialogContent>
    </Dialog>
  )
}
