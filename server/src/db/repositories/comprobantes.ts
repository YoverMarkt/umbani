import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '../tipos-generados'

// Los comprobantes de transferencia de la mini app: registrarlos, lo que leyó
// su análisis y adjuntarlos al pedido. Vivían en `storefront.ts` hasta el
// 2026-10-07 (ningún archivo pasa de 1.000 líneas). Todo filtra por business_id.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

const fail = (error: { message?: string } | null, context: string): void => {
  if (error) throw new Error(`${context}: ${error.message || 'sin detalle'}`)
}

/**
 * Registra la huella del comprobante y avisa si esa imagen ya se usó.
 *
 * ⚠️ La búsqueda de duplicados es GLOBAL —un comprobante reutilizado en otro
 * local es el fraude que más importa cazar—, pero la RPC nunca devuelve datos
 * del otro negocio: solo dice que ya se usó. Por eso vive en una función
 * `security definer` y no en una consulta desde aquí.
 */
const registerPaymentReceipt = async (input: {
  businessId: string
  orderId: string
  fileUrl: string
  filePublicId?: string | null
  sha256: string
  perceptualHash?: string | null
  mimeType?: string | null
  fileSize?: number | null
}) => db.rpc('register_payment_receipt', {
  p_business_id: input.businessId,
  p_order_id: input.orderId,
  p_file_url: input.fileUrl,
  // ⚠️ Obligatorio en SQL pero acepta NULL (una foto sin id de Cloudinary), y el
  // generador de tipos no sabe decir «texto o nulo» en un argumento. Omitirlo
  // —`undefined`— rompería la llamada: la función se busca por sus argumentos.
  p_file_public_id: (input.filePublicId || null) as string,
  p_sha256: input.sha256,
  p_perceptual_hash: input.perceptualHash || undefined,
  p_mime_type: input.mimeType || undefined,
  p_file_size: input.fileSize ?? undefined,
})

/**
 * Guarda lo que la visión leyó del comprobante, sus señales y su score.
 *
 * ⚠️ El score lo calcula la BASE sumando todas las señales del comprobante, no
 * el servidor: `register_payment_receipt` ya dejó escrita la del duplicado
 * ANTES de que el análisis existiera, y un total calculado aquí la perdería.
 *
 * ⚠️ Y no confirma ningún pago: la RPC no escribe una sola columna de `orders`.
 */
const saveReceiptAnalysis = async (input: {
  businessId: string
  receiptId: string
  status: 'analizado' | 'requiere_revision'
  datos?: Record<string, unknown> | null
  flags?: Array<Record<string, unknown>> | null
  analysis?: Record<string, unknown> | null
  /** Los puntos de la señal de referencia repetida, configurables en Ajustes. */
  puntosReferencia?: number
}) => db.rpc('save_receipt_analysis', {
  p_business_id: input.businessId,
  p_receipt_id: input.receiptId,
  p_status: input.status,
  // Lo que leyó el análisis del comprobante: objetos JSON, sin `default` distinto de null.
  p_datos: (input.datos ?? undefined) as Json | undefined,
  p_flags: (input.flags ?? undefined) as Json | undefined,
  p_analysis: (input.analysis ?? undefined) as Json | undefined,
  p_puntos_referencia: input.puntosReferencia ?? 60,
})

/**
 * El análisis del comprobante más reciente de un pedido, para el panel.
 *
 * El filtro por negocio va DENTRO de la función: el identificador del pedido
 * viaja en la URL, y sin el negocio se estaría enseñando el comprobante de
 * otro local.
 */
const getReceiptAnalysis = async (businessId: string, orderId: string) => {
  const { data, error } = await db.rpc('get_receipt_analysis', {
    p_business_id: businessId,
    p_order_id: orderId,
  })
  fail(error, 'No se pudo leer el análisis del comprobante')
  return (data || null) as Record<string, unknown> | null
}

// El comprobante lo sube el cliente desde la mini app, sin JWT: la RPC
// comprueba negocio + pedido + teléfono de la sesión antes de guardarlo.
const attachStorefrontPaymentProof = async (input: {
  businessId: string
  orderId: string
  contactPhone: string
  url: string
  /** Sin él no se puede firmar el acceso temporal al comprobante. */
  publicId?: string | null
}) => db.rpc('attach_storefront_payment_proof', {
  p_business_id: input.businessId,
  p_order_id: input.orderId,
  p_contact_phone: input.contactPhone,
  p_url: input.url,
  p_public_id: input.publicId || undefined,
})

export = {
  registerPaymentReceipt,
  saveReceiptAnalysis,
  getReceiptAnalysis,
  attachStorefrontPaymentProof,
}
