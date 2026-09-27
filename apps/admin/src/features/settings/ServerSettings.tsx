import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as cfg from './api'
import { getPlatformBlocked, setPlatformBlocked } from '../clients/api'
import { Ban, Bot as BotIcon, Check, Cloud, Plug, Receipt, Search, Store, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Label } from '@botpanel/ui/components/label'

// Configuración del servidor — paridad con el panel viejo:
// proveedor de IA global + keys (verificables), Cloudinary (verificable),
// Telegram y túnel público con URLs de webhooks listas para copiar.

const card = 'p-5 mb-5 gap-0'

const AI_FIELDS: Record<string, { key: string; label: string; ph: string }> = {
  groq:     { key: 'groq_api_key',      label: 'Groq API Key',      ph: 'gsk_…' },
  deepseek: { key: 'deepseek_api_key',  label: 'DeepSeek API Key',  ph: 'sk-…' },
  gemini:   { key: 'gemini_api_key',    label: 'Gemini API Key',    ph: 'AIzaSy…' },
  claude:   { key: 'anthropic_api_key', label: 'Anthropic API Key', ph: 'sk-ant-api03-…' },
  openai:   { key: 'openai_api_key',    label: 'OpenAI API Key',    ph: 'sk-proj-…' },
}


/**
 * El resultado de una verificación.
 *
 * ⚠️ El visto y la cruz van como ICONO, no como caracteres dibujados en el
 * texto. Con el carácter, lo que se alinea es la caja de línea de la fuente y
 * el símbolo queda alto respecto al texto: se lee como pegado de otra app. Es
 * la misma regla que el `+` y el visto de la tienda, y esta pantalla era de
 * los últimos sitios donde quedaban a mano (2026-09-20).
 */
function Veredicto({ estado, cuando }: {
  estado: { ok: boolean | null; texto: string } | null
  /** Qué decir mientras nadie ha verificado nada. */
  cuando: string
}) {
  if (!estado) return <span className="text-xs text-foreground/80">{cuando}</span>
  return (
    <span className="inline-flex items-center gap-1 text-xs text-foreground/80">
      {estado.ok === true && <Check className="w-3.5 h-3.5 shrink-0 text-primary" />}
      {estado.ok === false && <X className="w-3.5 h-3.5 shrink-0 text-destructive" />}
      {estado.texto}
    </span>
  )
}

export default function ServerSettings() {
  const qc = useQueryClient()
  const { data: saved = {} } = useQuery({ queryKey: ['adm-settings'], queryFn: cfg.getServerSettings })

  // Solo lo que el admin ESCRIBE se guarda; lo vacío no pisa keys existentes
  const [f, setF] = useState<Record<string, string>>({})
  const [provider, setProvider] = useState('')
  const [aiMsg, setAiMsg] = useState<{ ok: boolean | null; texto: string } | null>(null)
  const [cldMsg, setCldMsg] = useState<{ ok: boolean | null; texto: string } | null>(null)
  const [platMsg, setPlatMsg] = useState<{ ok: boolean | null; texto: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const activeProvider = provider || saved.ai_provider || 'claude'
  const aiField = AI_FIELDS[activeProvider] ?? AI_FIELDS.claude
  const val = (k: string) => f[k] ?? ''
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF(p => ({ ...p, [k]: e.target.value }))

  async function verifyAI() {
    setAiMsg({ ok: null, texto: 'Verificando…' })
    try {
      const r = await cfg.verifyAI({ provider: activeProvider, [aiField.key]: val(aiField.key) || undefined })
      setAiMsg({ ok: r.ok, texto: r.info })
    } catch (e) { setAiMsg({ ok: false, texto: e instanceof Error ? e.message : 'Error' }) }
  }

  async function verifyCloudinary() {
    setCldMsg({ ok: null, texto: 'Verificando…' })
    try {
      const r = await cfg.verifyCloudinary({
        cloudinary_cloud_name: val('cloudinary_cloud_name') || undefined,
        cloudinary_api_key: val('cloudinary_api_key') || undefined,
        cloudinary_api_secret: val('cloudinary_api_secret') || undefined,
      })
      setCldMsg({ ok: r.ok, texto: r.info })
    } catch (e) { setCldMsg({ ok: false, texto: e instanceof Error ? e.message : 'Error' }) }
  }

  async function verifyPlatform() {
    setPlatMsg({ ok: null, texto: 'Verificando el número del marketplace…' })
    try {
      const r = await cfg.verifyPlatformChannel({
        platform_ycloud_api_key: val('platform_ycloud_api_key') || undefined,
        platform_ycloud_number: val('platform_ycloud_number') || undefined,
        platform_webhook_secret: val('platform_webhook_secret') || undefined,
        platform_webhook_endpoint_id: val('platform_webhook_endpoint_id') || undefined,
      })
      setPlatMsg({ ok: r.ok, texto: r.info })
    } catch (e) { setPlatMsg({ ok: false, texto: e instanceof Error ? e.message : 'Error' }) }
  }

  async function save() {
    setBusy(true)
    const payload: Record<string, string> = { ai_provider: activeProvider }
    for (const [k, v] of Object.entries(f)) if (v.trim()) payload[k] = v.trim()
    try {
      await cfg.saveServerSettings(payload)
      toast.success('Guardado correctamente')
      setF({}) // limpiar campos: las keys quedan enmascaradas del server
      qc.invalidateQueries({ queryKey: ['adm-settings'] })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error al guardar') }
    setBusy(false)
  }


  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground mb-1">Configuración del servidor</h1>
      <p className="text-sm text-muted-foreground mb-6">Keys globales de IA, Cloudinary y conexiones. Las keys guardadas se muestran enmascaradas.</p>

      {/* IA global */}
      <Card className={card}>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><BotIcon className="w-4 h-4" /> Proveedor de IA activo (global)</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="server-ai-provider">Proveedor</Label>
            <Select value={activeProvider} onValueChange={setProvider}>
              <SelectTrigger id="server-ai-provider" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="groq">Groq (Llama) — rápido y barato</SelectItem>
                <SelectItem value="deepseek">DeepSeek</SelectItem>
                <SelectItem value="gemini">Gemini</SelectItem>
                <SelectItem value="claude">Claude</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="server-ai-api-key">{aiField.label} {saved[aiField.key] && <em className="text-muted-foreground not-italic">— guardada: {saved[aiField.key]}</em>}</Label>
            <Input id="server-ai-api-key" type="password" autoComplete="new-password" value={val(aiField.key)} onChange={set(aiField.key)} placeholder={saved[aiField.key] || aiField.ph} />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Button variant="outline" size="sm" onClick={verifyAI} ><span className="inline-flex items-center gap-1"><Search className="w-3.5 h-3.5" /> Verificar conexión</span></Button>
          <Veredicto estado={aiMsg} cuando="Ingresa la key (o usa la guardada) y verifica" />
        </div>
      </Card>

      {/* Análisis de comprobantes */}
      <Card className={card}>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><Receipt className="w-4 h-4" /> Análisis de comprobantes</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Lee la captura del banco que manda el cliente y le da al dueño señales antes de
          aprobar: valor, fecha, cuenta destino y si esa imagen ya se usó. Sobre todo evita
          que una foto que no es un comprobante se trate como un pago. Usa la OpenAI API Key
          de arriba y cuesta alrededor de $0,003 por comprobante.
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">
          ⚠️ El análisis nunca confirma un pago ni mueve un pedido: eso lo sigue decidiendo
          el dueño desde su panel. Si se apaga, o si OpenAI falla, todo funciona como hoy.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="server-receipt-analysis">Estado</Label>
            <Select
              value={val('receipt_analysis_enabled') || saved.receipt_analysis_enabled || '0'}
              onValueChange={v => setF(p => ({ ...p, receipt_analysis_enabled: v }))}
            >
              <SelectTrigger id="server-receipt-analysis" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Apagado — no se analiza nada (por defecto)</SelectItem>
                <SelectItem value="1">Encendido — se analiza cada comprobante</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="server-receipt-rules">
              Puntos de cada señal (JSON, opcional)
            </Label>
            <Input
              id="server-receipt-rules"
              value={val('receipt_risk_rules')}
              onChange={set('receipt_risk_rules')}
              placeholder={saved.receipt_risk_rules || '{"monto_menor":60,"cuenta_incorrecta":80}'}
            />
          </div>
        </div>
      </Card>

      {/* Cloudinary */}
      <Card className={card}>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><Cloud className="w-4 h-4" /> Cloudinary — Imágenes y videos</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div><Label htmlFor="server-cloudinary-cloud-name">Cloud name {saved.cloudinary_cloud_name && <em className="text-muted-foreground not-italic">— {saved.cloudinary_cloud_name}</em>}</Label>
            <Input id="server-cloudinary-cloud-name" value={val('cloudinary_cloud_name')} onChange={set('cloudinary_cloud_name')} placeholder={saved.cloudinary_cloud_name || 'tu-cloud-name'} /></div>
          <div><Label htmlFor="server-cloudinary-api-key">API Key</Label>
            <Input id="server-cloudinary-api-key" value={val('cloudinary_api_key')} onChange={set('cloudinary_api_key')} placeholder={saved.cloudinary_api_key || '123456789012345'} /></div>
          <div><Label htmlFor="server-cloudinary-api-secret">API Secret</Label>
            <Input id="server-cloudinary-api-secret" type="password" autoComplete="new-password" value={val('cloudinary_api_secret')} onChange={set('cloudinary_api_secret')} placeholder={saved.cloudinary_api_secret || '••••••••'} /></div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Button variant="outline" size="sm" onClick={verifyCloudinary} ><span className="inline-flex items-center gap-1"><Search className="w-3.5 h-3.5" /> Verificar conexión</span></Button>
          <Veredicto estado={cldMsg} cuando="Guarda o ingresa las llaves y verifica" />
        </div>
      </Card>

      {/* El número de Umbani */}
      <Card className={card}>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><Store className="w-4 h-4" /> Número del marketplace (Umbani)</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          El número por el que escriben TODOS los clientes. No pertenece a
          ningún local: es el de la plataforma, y por eso vive aquí y no en la
          ficha de un negocio. Sin él, los locales sin número propio no reciben
          ni envían WhatsApp.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="server-platform-number">Número de WhatsApp {saved.platform_ycloud_number && <em className="text-muted-foreground not-italic">— {saved.platform_ycloud_number}</em>}</Label>
            <Input id="server-platform-number" value={val('platform_ycloud_number')} onChange={set('platform_ycloud_number')} placeholder={saved.platform_ycloud_number || '+593…'} />
          </div>
          <div>
            <Label htmlFor="server-platform-api-key">YCloud API Key {saved.platform_ycloud_api_key && <em className="text-muted-foreground not-italic">— guardada</em>}</Label>
            <Input id="server-platform-api-key" type="password" autoComplete="new-password" value={val('platform_ycloud_api_key')} onChange={set('platform_ycloud_api_key')} placeholder={saved.platform_ycloud_api_key || 'Escribe solo para reemplazarla'} />
          </div>
          <div>
            <Label htmlFor="server-platform-endpoint">Webhook Endpoint ID</Label>
            <Input id="server-platform-endpoint" value={val('platform_webhook_endpoint_id')} onChange={set('platform_webhook_endpoint_id')} placeholder={saved.platform_webhook_endpoint_id || 'Developers → Webhooks'} />
          </div>
          <div>
            <Label htmlFor="server-platform-secret">Webhook Signing Secret {saved.platform_webhook_secret && <em className="text-muted-foreground not-italic">— guardado</em>}</Label>
            <Input id="server-platform-secret" type="password" autoComplete="new-password" value={val('platform_webhook_secret')} onChange={set('platform_webhook_secret')} placeholder={saved.platform_webhook_secret || 'whsec_…'} />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Button variant="outline" size="sm" onClick={verifyPlatform}>
            <span className="inline-flex items-center gap-1"><Search className="w-3.5 h-3.5" /> Verificar el número</span>
          </Button>
          <Veredicto
            estado={platMsg}
            cuando="Comprueba contra YCloud que el número está vinculado y el webhook configurado"
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          En producción el signing secret es <strong>obligatorio</strong>: sin
          él no hay con qué comprobar la firma de un mensaje que llega sin
          local, y el webhook responde 503 en vez de aceptarlo sin verificar.
        </p>
      </Card>

      {/* Otras conexiones */}
      <Card className={card}>
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2"><Plug className="w-4 h-4" /> Otras conexiones</h2>
        <div>
          <div><Label htmlFor="server-telegram-token">Telegram Bot Token (global) {saved.telegram_bot_token && <em className="text-muted-foreground not-italic">— guardado</em>}</Label>
            <Input id="server-telegram-token" type="password" autoComplete="new-password" value={val('telegram_bot_token')} onChange={set('telegram_bot_token')} placeholder={saved.telegram_bot_token || '1234567890:ABC…'} /></div>
        </div>
      </Card>

      <BloqueoDePlataforma />

      <div className="flex items-center gap-3 mb-8">
        <Button onClick={save} disabled={busy}
          >
          Guardar configuración
        </Button>
      </div>

    </div>
  )
}

/**
 * Bloqueo de PLATAFORMA: Umbani entero deja de atender a esa persona.
 *
 * ⚠️ NO sustituye al bloqueo del dueño, que sigue en el panel de cada negocio.
 * Aquel lo pone un local y solo cierra ese local — que El Puerto te expulse no
 * puede dejarte fuera de Umbani entero. Este lo pone el superadmin: el bot no
 * responde y NINGÚN local acepta el pedido, ni siquiera de mostrador.
 *
 * ⚠️ Vive aquí y no en Clientes porque no es de un negocio: es de la
 * plataforma, como el número del marketplace.
 *
 * ⚠️ Se guarda al pulsar, no con el botón de abajo. Los ajustes se envían
 * juntos al guardar; esto es una acción con consecuencia inmediata, y mezclarla
 * con el resto haría que bloquear a alguien dependiera de acordarse de guardar.
 */
function BloqueoDePlataforma() {
  const qc = useQueryClient()
  const [nuevo, setNuevo] = useState('')
  const [motivo, setMotivo] = useState('')
  const { data: bloqueados = [] } = useQuery({
    queryKey: ['adm-blocked'],
    queryFn: getPlatformBlocked,
  })

  const digitos = nuevo.replace(/\D/g, '')
  const valido = digitos.length >= 8 && digitos.length <= 15

  const mBlock = useMutation({
    mutationFn: ({ phone, blocked, reason }: { phone: string; blocked: boolean; reason?: string }) =>
      setPlatformBlocked(phone, blocked, reason),
    onSuccess: (_d, v) => {
      toast.success(v.blocked ? 'Bloqueado en toda la plataforma' : 'Desbloqueado')
      setNuevo(''); setMotivo('')
      qc.invalidateQueries({ queryKey: ['adm-blocked'] })
    },
    onError: e => toast.error(e instanceof Error ? e.message : 'No se pudo actualizar'),
  })

  // Una respuesta a medias no puede tumbar la pantalla de ajustes entera.
  const lista = Array.isArray(bloqueados) ? bloqueados : []

  return (
    <Card className={card}>
      <h2 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2">
        <Ban className="w-4 h-4" /> Bloqueados en toda la plataforma
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        El bot deja de responderle y ningún local acepta su pedido, ni siquiera de mostrador.
        Al que bloqueas aquí no se le avisa. Los marcados <strong>Insultos</strong> los bloqueó
        el chat solo, al segundo insulto: caducan a los 15 días y, al volver, se le dice
        «te hemos desbloqueado». Para bloquear solo en un local, lo hace su dueño desde su panel.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="server-block-phone">Número</Label>
          <Input id="server-block-phone" value={nuevo} onChange={e => setNuevo(e.target.value)}
            placeholder="+593…" className="mt-1 w-44" />
        </div>
        <div className="min-w-0 flex-1">
          <Label htmlFor="server-block-reason">Motivo (queda en el registro)</Label>
          <Input id="server-block-reason" value={motivo} onChange={e => setMotivo(e.target.value)}
            placeholder="Pedidos falsos repetidos" className="mt-1" />
        </div>
        <Button variant="outline" disabled={!valido || mBlock.isPending}
          onClick={() => mBlock.mutate({ phone: digitos, blocked: true, reason: motivo.trim() || undefined })}>
          <Ban /> Bloquear
        </Button>
      </div>
      {nuevo && !valido && (
        <p className="mt-2 text-xs text-destructive">
          Escribe el número completo con su código de país (entre 8 y 15 dígitos).
        </p>
      )}
      {lista.length > 0 && (
        <div className="mt-3">
          {lista.map(b => (
            <div key={b.phone} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-0">
              <span className="font-mono text-sm text-foreground/80">{b.phone}</span>
              {/* ⚠️ Se distinguen a propósito (2026-09-27): el de insultos lo
                  puso el chat solo y caduca; el manual lo pusiste tú y es para
                  siempre. Levantarlos es el mismo botón. */}
              {b.kind === 'insultos' && <Badge variant="destructive">Insultos</Badge>}
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {b.kind === 'insultos'
                  ? `hasta el ${b.until ? new Date(b.until).toLocaleDateString('es-EC') : '—'}`
                  : `${b.reason || 'sin motivo anotado'} · ${new Date(b.blockedAt).toLocaleDateString('es-EC')}`}
              </span>
              <Button variant="outline" size="sm"
                onClick={() => mBlock.mutate({ phone: b.phone, blocked: false })}>
                <Undo2 /> Desbloquear
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
