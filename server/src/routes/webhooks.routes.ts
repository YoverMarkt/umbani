import crypto from 'node:crypto'
import type { Request } from 'express'
import rateLimit from 'express-rate-limit'
import { createRouter } from '../middleware/async'
import type { BusinessRecord } from '../db/types'
import { resolveBusinessChannel } from '../services/channel-resolution'
import {
  inboundConversationKey,
  type InboundWebhookPayload,
} from '../services/inbound-webhook'
import { recordWebhookFailure } from '../services/channel-health'
import { verifyYCloudSignature } from '../services/webhook-signatures'
import { avisarQueEntroUnMensaje } from '../lib/despertador-de-la-cola'
import {
  esNumeroDePlataforma,
  getPlatformChannel,
} from '../services/platform-channel'
import type {
  ChannelAddress,
  ChannelIdentifierType,
  WhatsAppChannelAddress,
  WhatsAppProvider,
} from '../types/channels'

interface MediaReference {
  id?: string
  link?: string
  url?: string
  mime_type?: string
}

interface InboundMessage {
  id?: string
  wamid?: string
  from?: string
  to?: string
  type?: string
  timestamp?: string | number
  sendTime?: string | number
  text?: { body?: string }
  button?: { text?: string; payload?: string }
  interactive?: {
    button_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string }
  }
  audio?: MediaReference
  voice?: MediaReference
  image?: MediaReference
  // La ubicación que comparte el cliente. Meta y YCloud usan la misma forma.
  location?: {
    latitude?: number | string
    longitude?: number | string
    address?: string
    name?: string
  }
  whatsappApiAccountPhoneNumber?: string
}

interface MetaWebhookBody {
  object?: string
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: InboundMessage[]
        metadata?: {
          display_phone_number?: string
          phone_number_id?: string
        }
      }
    }>
  }>
}

interface YCloudWebhookBody {
  id?: string
  type?: string
  createTime?: string
  whatsappInboundMessage?: InboundMessage
}

const db: {
  getBusinessByChannel(address: ChannelAddress): Promise<BusinessRecord | null>
  enqueueWebhookEvent(
    // Nulo = mensaje al número del marketplace, sin local elegido todavía.
    businessId: string | null,
    provider: WebhookProvider,
    messageId: string,
    conversationKey: string,
    payload: InboundWebhookPayload,
  ): Promise<{ data?: boolean | null; error?: { message?: string } | null }>
} = require('../db') as typeof import('../db')

const router = createRouter()
type WebhookProvider = WhatsAppProvider

const isProduction = () => process.env.NODE_ENV === 'production' || Boolean(process.env.BASE_URL)

function verifyMetaSignature(req: Request): boolean {
  const secret = process.env.META_APP_SECRET
  if (!secret) return !isProduction()
  const signature = req.headers['x-hub-signature-256']
  if (typeof signature !== 'string' || !req.rawBody) return false
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex')}`
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit' },
})

function channelAddresses(
  provider: WebhookProvider,
  identifiers: Array<{
    identifierType: ChannelIdentifierType
    value?: string | null
  }>,
): WhatsAppChannelAddress[] {
  return identifiers.flatMap(({ identifierType, value }) => {
    if (typeof value !== 'string' || !value.trim()) return []
    return [{ provider, identifierType, identifier: value }]
  })
}

function firstIdentifier(
  ...values: Array<string | null | undefined>
): string | undefined {
  const value = values.find(
    candidate => typeof candidate === 'string' && Boolean(candidate.trim()),
  )
  return typeof value === 'string' ? value : undefined
}

/**
 * A dónde llegó el mensaje.
 *
 * Hasta el 2026-08-21 solo existía el primer caso: el número era la llave y
 * un mensaje sin negocio se descartaba. `platform` es el número único del
 * marketplace, donde todavía no hay local que resolver — lo elegirá el
 * cliente durante la conversación.
 */
type ResolvedInbound =
  | { business: BusinessRecord; address: WhatsAppChannelAddress }
  | { business: null; address: WhatsAppChannelAddress }

async function enqueueResolvedInbound(
  provider: WebhookProvider,
  messageId: string,
  resolved: ResolvedInbound,
  payload: InboundWebhookPayload,
): Promise<'accepted' | 'duplicate'> {
  const { data, error } = await db.enqueueWebhookEvent(
    resolved.business?.id ?? null,
    provider,
    messageId,
    inboundConversationKey(payload),
    payload,
  )
  if (error) throw new Error(error.message || 'No se pudo persistir el webhook')
  if (!data) return 'duplicate'
  // Ya está a salvo en la cola: se despierta al worker en vez de dejar que se
  // entere en su próximo sondeo. Un duplicado no trae nada nuevo que atender.
  avisarQueEntroUnMensaje(payload)
  return 'accepted'
}

function loggedError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function metaMessages(body: MetaWebhookBody): Array<{
  message: InboundMessage
  addresses: WhatsAppChannelAddress[]
}> {
  return (body.entry || []).flatMap(entry => (
    (entry.changes || []).flatMap((change) => {
      const value = change.value
      if (!value) return []
      const metaPhoneId = firstIdentifier(value.metadata?.phone_number_id)
      const addresses = channelAddresses('meta', metaPhoneId
        ? [{ identifierType: 'account_id', value: metaPhoneId }]
        : [{
            identifierType: 'phone',
            value: value.metadata?.display_phone_number,
          }])
      return (value.messages || []).map(message => ({ message, addresses }))
    })
  ))
}

/**
 * La ubicación compartida, si el mensaje es de ese tipo.
 *
 * Meta y YCloud mandan la misma forma, así que un solo extractor sirve para
 * los dos. La VALIDACIÓN vive en `parseInboundWebhookPayload` —rango real del
 * planeta, coordenadas juntas— para que sea la misma comprobación tanto si el
 * mensaje entra ahora como si se relee de la cola durable.
 */
function sharedLocation(message: InboundMessage): InboundWebhookPayload['content'] | null {
  if (message.type !== 'location' || !message.location) return null
  const { latitude, longitude, address, name } = message.location
  if (latitude === undefined || longitude === undefined) return null
  return {
    kind: 'location',
    location: {
      latitude: Number(latitude),
      longitude: Number(longitude),
      ...(address ? { address } : {}),
      ...(name ? { name } : {}),
    },
  }
}

function metaContent(message: InboundMessage): InboundWebhookPayload['content'] | null {
  const text = message.type === 'text'
    ? message.text?.body
    : message.type === 'button'
      ? message.button?.text
      : message.type === 'interactive'
        ? message.interactive?.button_reply?.title
          || message.interactive?.list_reply?.title
        : undefined
  // Tocar un botón o una fila de lista NO es escribir: llega entero y de una
  // vez. Se marca para que la cola no le imponga la ventana de silencio que
  // existe para juntar mensajes escritos a trozos.
  if (text?.trim() && (message.type === 'button' || message.type === 'interactive')) {
    return { kind: 'text', text, interactivo: true }
  }
  if (text?.trim()) return { kind: 'text', text }
  if ((message.type === 'audio' || message.type === 'voice') && message.audio?.id) {
    return {
      kind: 'audio',
      media: { id: message.audio.id, mimeType: message.audio.mime_type },
    }
  }
  if (message.type === 'image' && message.image?.id) {
    return {
      kind: 'image',
      media: { id: message.image.id, mimeType: message.image.mime_type },
    }
  }
  return sharedLocation(message)
}

function headerText(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** El id de una opción con la marca de su lista: «k3f9a.2». */
const OPCION_CON_MARCA = /^[a-z0-9]{4,10}\.\d{1,2}$/

function ycloudContent(message: InboundMessage): InboundWebhookPayload['content'] | null {
  let text: string | undefined
  if (message.type === 'text') text = message.text?.body
  if (message.type === 'button') text = message.button?.text
  if (message.type === 'interactive') {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply
    // El id que enviamos es el NÚMERO de la opción; el menú ya entiende
    // números, y así el emparejamiento no depende del título, que WhatsApp
    // trunca a 20-24 caracteres.
    //
    // ⚠️ Desde el 2026-09-26 el número lleva delante la MARCA de su lista
    // («k3f9a.2») y pasa ENTERO: es lo que deja saber si el toque viene del
    // último mensaje o de uno viejo. Ver `marketplace-entry`.
    const id = String(reply?.id || '').trim()
    text = OPCION_CON_MARCA.test(id) || /^\d{1,2}$/.test(id) ? id : reply?.title
  }
  // Igual que en Meta: lo elegido llega entero y no debe esperar la ventana.
  if (text?.trim() && (message.type === 'button' || message.type === 'interactive')) {
    return { kind: 'text', text, interactivo: true }
  }
  if (text?.trim()) return { kind: 'text', text }
  const kind = message.type === 'image'
    ? 'image'
    : message.type === 'audio' || message.type === 'voice'
      ? 'audio'
      : null
  const reference = kind === 'image' ? message.image : message.audio || message.voice
  const url = reference?.link || reference?.url
  if (!kind || !url) return sharedLocation(message)
  return {
    kind,
    media: { url, mimeType: reference?.mime_type },
  }
}

function durablePayload(
  provider: WebhookProvider,
  message: InboundMessage,
  inboundId: string,
  resolved: ResolvedInbound,
  content: InboundWebhookPayload['content'],
): InboundWebhookPayload {
  return {
    version: 1,
    provider,
    businessId: resolved.business?.id ?? null,
    from: message.from || '',
    inboundId,
    channelAddress: resolved.address,
    content,
  }
}

router.get('/webhook', (req, res) => {
  const {
    'hub.mode': mode,
    'hub.verify_token': token,
    'hub.challenge': challenge,
  } = req.query
  const expectedToken = process.env.META_VERIFY_TOKEN
  if (mode === 'subscribe' && expectedToken && token === expectedToken) {
    console.log('✅ Webhook Meta verificado')
    return res.status(200).send(challenge || 'OK')
  }
  res.sendStatus(403)
})

router.post('/webhook', webhookLimiter, async (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.warn('⚠️  Webhook Meta: firma inválida — rechazado')
    recordWebhookFailure('meta', 401, 'Firma inválida')
    return res.sendStatus(401)
  }
  const body = req.body as MetaWebhookBody
  if (body.object !== 'whatsapp_business_account') return res.sendStatus(200)
  const deliveries = metaMessages(body).filter(({ message, addresses }) => (
    Boolean(message.id && message.from && addresses.length && metaContent(message))
  ))
  if (!deliveries.length) return res.sendStatus(200)

  try {
    for (const { message, addresses } of deliveries) {
      const resolved = await resolveBusinessChannel(db, addresses)
      if (!resolved) {
        console.warn('⚠️  [Meta] canal sin negocio exacto — mensaje ignorado')
        continue
      }
      const messageId = message.id
      const content = metaContent(message)
      if (!messageId || !content) continue
      const payload = durablePayload('meta', message, messageId, resolved, content)
      const status = await enqueueResolvedInbound('meta', messageId, resolved, payload)
      if (status === 'duplicate') {
        console.log(`🔁 [Meta] mensaje duplicado ignorado (${messageId})`)
      }
    }
  } catch (error) {
    console.error('❌ Webhook Meta persistencia:', loggedError(error))
    recordWebhookFailure('meta', 503, `No se pudo encolar el mensaje: ${loggedError(error)}`)
    return res.sendStatus(503)
  }

  return res.sendStatus(200)
})

router.post('/webhook/ycloud', webhookLimiter, async (req, res) => {
  const body = req.body as YCloudWebhookBody
  console.log(`📨 [YCloud webhook] recibido — type: ${body.type || '(sin type)'}`)
  if (body.type !== 'whatsapp.inbound_message.received') return res.sendStatus(200)
  const message = body.whatsappInboundMessage
  if (!message) return res.sendStatus(200)
  const from = message.from
  const addresses = channelAddresses('ycloud', [{
    identifierType: 'phone',
    value: firstIdentifier(
      message.to,
      message.whatsappApiAccountPhoneNumber,
    ),
  }])
  const inboundId = message.id || message.wamid
  const eventId = body.id || inboundId
  if (!from || !inboundId || !eventId || !addresses.length) {
    console.warn('⚠️  [YCloud] payload inbound incompleto — mensaje ignorado')
    return res.sendStatus(200)
  }

  let resolved: {
    business: BusinessRecord
    address: WhatsAppChannelAddress
  } | null
  try {
    resolved = await resolveBusinessChannel(db, addresses)
  } catch (error) {
    console.error('❌ Webhook YCloud resolución:', loggedError(error))
    recordWebhookFailure('ycloud', 503, 'No se pudo resolver el negocio del canal')
    return res.sendStatus(503)
  }
  // Sin negocio exacto quedan dos casos, y solo uno se descarta: el número
  // desconocido, y el número de la PLATAFORMA — donde el cliente todavía no
  // eligió local, así que no hay negocio que resolver ni debe haberlo.
  //
  // ⚠️ Las credenciales del número de plataforma NO pueden salir de un
  // negocio: ese número no es de ninguno. Salen de `server_settings`, y la
  // firma se valida con ellas exactamente igual de estricto que antes — un
  // mensaje sin negocio no es un mensaje sin comprobar.
  let target: ResolvedInbound
  let configuredEndpointId: string | undefined
  let signingSecret: string | undefined

  if (resolved) {
    target = resolved
    configuredEndpointId = resolved.business.ycloud_webhook_endpoint_id?.trim()
      || process.env.YCLOUD_WEBHOOK_ENDPOINT_ID?.trim()
    signingSecret = resolved.business.ycloud_webhook_secret?.trim()
      || process.env.YCLOUD_WEBHOOK_SECRET?.trim()
  } else {
    const platform = await getPlatformChannel()
    const platformAddress = platform
      ? addresses.find(address => esNumeroDePlataforma([address], platform.number))
      : undefined
    if (!platform || !platformAddress) {
      console.warn('⚠️  [YCloud] canal sin negocio exacto — mensaje ignorado')
      return res.sendStatus(200)
    }
    console.log('🏬 [YCloud] mensaje al número del marketplace — sin local aún')
    target = { business: null, address: platformAddress }
    configuredEndpointId = platform.endpointId || undefined
    signingSecret = platform.webhookSecret || undefined
  }

  const endpointId = headerText(req.headers['x-webhook-endpoint-id'])
  if (!configuredEndpointId && isProduction()) {
    console.error('❌ Webhook YCloud: falta configurar el Endpoint ID')
    recordWebhookFailure('ycloud', 503, 'Falta configurar el Endpoint ID del webhook')
    return res.sendStatus(503)
  }
  if (configuredEndpointId && endpointId !== configuredEndpointId) {
    console.warn('⚠️  [YCloud] Endpoint ID inválido — rechazado')
    recordWebhookFailure('ycloud', 401, 'Endpoint ID inválido')
    return res.sendStatus(401)
  }
  if (!signingSecret) {
    if (isProduction()) {
      console.error('❌ Webhook YCloud: falta el signing secret oficial')
      recordWebhookFailure('ycloud', 503, 'Falta el signing secret del webhook')
      return res.sendStatus(503)
    }
  } else if (!verifyYCloudSignature(
    req.rawBody,
    req.headers['ycloud-signature'],
    signingSecret,
  )) {
    console.warn('⚠️  [YCloud] firma inválida o fuera de tiempo — rechazado')
    recordWebhookFailure('ycloud', 401, 'Firma inválida o fuera de tiempo')
    return res.sendStatus(401)
  }

  const content = ycloudContent(message)
  if (!content) {
    console.log(`ℹ️  [YCloud] tipo inbound no soportado ignorado (${message.type || 'sin tipo'})`)
    return res.sendStatus(200)
  }

  try {
    const durableResolved = target
    const payload = durablePayload(
      'ycloud',
      message,
      inboundId,
      durableResolved,
      content,
    )
    const status = await enqueueResolvedInbound(
      'ycloud',
      eventId,
      durableResolved,
      payload,
    )
    if (status === 'duplicate') {
      console.log(`🔁 [YCloud] evento duplicado ignorado (${eventId})`)
    }
  } catch (error) {
    console.error('❌ Webhook YCloud persistencia:', loggedError(error))
    // Este es el fallo que tuvo el bot mudo cinco días en julio de 2026: se
    // registra para que salte en el panel el mismo minuto, no una semana después.
    recordWebhookFailure('ycloud', 503, `No se pudo encolar el mensaje: ${loggedError(error)}`)
    return res.sendStatus(503)
  }
  return res.sendStatus(200)
})

export = router
