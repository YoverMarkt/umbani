import {
  v2 as cloudinary,
  type UploadApiErrorResponse,
  type UploadApiResponse,
} from 'cloudinary'
import { esStaging } from '../config/environment'

interface CloudinaryCredentials {
  cloud_name?: string
  api_key?: string
  api_secret?: string
}

export interface MediaUploadResult {
  url: string
  public_id: string
  resource_type: string
}

interface ModuloSettings {
  get(key: string): Promise<string | null | undefined>
}
const settings: ModuloSettings = require('../services/settings') as typeof import('../services/settings')

/**
 * La carpeta raíz de todo lo que se sube (2026-10-10). El servidor de PRUEBAS
 * usa la misma cuenta de Cloudinary que producción (decisión del dueño), así
 * que sus fotos van aparte: nada de pruebas se mezcla con las de verdad.
 */
export const raizDeLaNube = (env: NodeJS.ProcessEnv = process.env): string =>
  esStaging(env) ? 'botpanel-pruebas' : 'botpanel'

async function configure(): Promise<boolean> {
  const cloudName = await settings.get('cloudinary_cloud_name')
  const apiKey = await settings.get('cloudinary_api_key')
  const apiSecret = await settings.get('cloudinary_api_secret')
  if (!cloudName || !apiKey || !apiSecret) return false

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  })
  return true
}

export async function isConfigured(): Promise<boolean> {
  return configure()
}

export async function verify(override: CloudinaryCredentials = {}) {
  const cloudName = override.cloud_name || await settings.get('cloudinary_cloud_name')
  const apiKey = override.api_key || await settings.get('cloudinary_api_key')
  const apiSecret = override.api_secret || await settings.get('cloudinary_api_secret')
  if (!cloudName || !apiKey || !apiSecret) {
    return {
      ok: false,
      info: 'Faltan datos de Cloudinary (cloud name, API key o secret)',
    }
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  })
  const response = await cloudinary.api.ping()
  const connected = response?.status === 'ok'
  return {
    ok: connected,
    info: connected
      ? `✅ Cloudinary conectado — cloud "${cloudName}"`
      : 'Respuesta inesperada',
  }
}

export async function uploadMedia(
  buffer: Buffer,
  businessId: string,
): Promise<MediaUploadResult> {
  if (!(await configure())) throw new Error('Cloudinary no está configurado')

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `${raizDeLaNube()}/${businessId}`, resource_type: 'auto' },
      (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
        if (error) return reject(error)
        const uploaded = result as UploadApiResponse
        resolve({
          url: uploaded.secure_url,
          public_id: uploaded.public_id,
          resource_type: uploaded.resource_type,
          ...(uploaded.phash ? { phash: String(uploaded.phash) } : {}),
        })
      },
    )
    stream.end(buffer)
  })
}

/**
 * Sube algo que NO puede ser público: el comprobante de una transferencia.
 *
 * Con `type: 'authenticated'` la URL deja de servir por sí sola — hace falta
 * una firma con caducidad, que solo genera el servidor y solo para quien tiene
 * derecho a verla. Un comprobante bancario colgado en una URL adivinable es
 * una fuga de datos de un cliente real, no un descuido estético.
 *
 * Va a una carpeta aparte para que no se mezcle con las fotos del catálogo,
 * que sí son públicas a propósito.
 */
export async function uploadPrivateMedia(
  buffer: Buffer,
  businessId: string,
  /** `comprobantes`, o `reclamos/<pedido>` para la foto de un reclamo (2026-10-10). */
  carpeta = 'comprobantes',
): Promise<MediaUploadResult & { phash?: string }> {
  if (!(await configure())) throw new Error('Cloudinary no está configurado')

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${raizDeLaNube()}/${businessId}/${carpeta}`,
        resource_type: 'image',
        type: 'authenticated',
        // La huella PERCEPTUAL de la imagen, que la calcula Cloudinary al
        // subirla. Reconoce la misma foto recortada, recomprimida o con otro
        // brillo — que es justo lo que pasa cuando alguien reenvía un
        // comprobante por WhatsApp, porque WhatsApp la recomprime y el
        // SHA-256 deja de coincidir.
        //
        // Sale gratis aquí: pedirla evita añadir una librería de imagen al
        // servidor solo para esto.
        phash: true,
      },
      (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
        if (error) return reject(error)
        const uploaded = result as UploadApiResponse
        resolve({
          url: uploaded.secure_url,
          public_id: uploaded.public_id,
          resource_type: uploaded.resource_type,
        })
      },
    )
    stream.end(buffer)
  })
}

/**
 * Una URL temporal para ver un comprobante privado.
 *
 * Caduca sola: si la captura de pantalla del panel acaba en un chat, deja de
 * servir. Diez minutos bastan para mirarla y son pocos para reenviarla.
 */
export async function signedMediaUrl(
  publicId: string,
  seconds = 600,
): Promise<string | null> {
  if (!publicId) return null
  if (!(await configure())) return null

  try {
    return cloudinary.url(publicId, {
      type: 'authenticated',
      resource_type: 'image',
      sign_url: true,
      secure: true,
      expires_at: Math.floor(Date.now() / 1000) + seconds,
    })
  } catch (error) {
    console.error('❌ Cloudinary firma:', (error as Error).message)
    return null
  }
}

export async function deleteMedia(
  publicId: string,
  resourceType: 'image' | 'video' = 'image',
): Promise<void> {
  if (!publicId) return
  if (!(await configure())) return

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType })
    console.log(`🗑️  Cloudinary: borrado ${publicId}`)
  } catch (error) {
    console.error('❌ Cloudinary destroy:', (error as Error).message)
  }
}
