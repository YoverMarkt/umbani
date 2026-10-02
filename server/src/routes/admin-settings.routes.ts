import Anthropic from '@anthropic-ai/sdk'
import axios from 'axios'
import type { RequestHandler } from 'express'
import OpenAI from 'openai'
import { createRouter } from '../middleware/async'

interface AiVerificationPayload {
  provider?: string
  anthropic_api_key?: string
  openai_api_key?: string
  gemini_api_key?: string
  groq_api_key?: string
  deepseek_api_key?: string
}

interface CloudinaryVerificationPayload {
  cloudinary_cloud_name?: string
  cloudinary_api_key?: string
  cloudinary_api_secret?: string
}

interface ModuloSettings {
  get(key: string): Promise<string | null>
  getAll(): Promise<Record<string, string | null>>
  setMany(values: Record<string, unknown>): Promise<void>
}
const settings: ModuloSettings = require('../services/settings') as typeof import('../services/settings')
// La tarifa que ENSEÑA la tienda vive un minuto en memoria
// (`services/tarifa-de-servicio.ts`); la que COBRA la base, no. Ver abajo.
const tarifa = require('../services/tarifa-de-servicio') as typeof import('../services/tarifa-de-servicio')
interface ModuloCloudinary {
  verify(values: {
    cloud_name?: string
    api_key?: string
    api_secret?: string
  }): Promise<{ ok: boolean; info: string }>
}
const cloudinary: ModuloCloudinary = require('../integrations/cloudinary') as typeof import('../integrations/cloudinary')
interface ModuloAuth {
  authAdmin: RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()

function maskSettings(values: Record<string, string | null>): Record<string, string> {
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!value) {
      masked[key] = ''
    } else if (key.includes('key') || key.includes('token') || key.includes('secret')) {
      masked[key] = value.length > 8
        ? `${value.slice(0, 6)}••••••${value.slice(-4)}`
        : '••••••'
    } else {
      masked[key] = value
    }
  }
  return masked
}

function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let safe = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) safe = safe.split(secret).join('••••••')
  }
  return safe.slice(0, 160)
}

function verificationError(
  error: unknown,
  secrets: Array<string | undefined>,
): { ok: false; info: string } {
  let status: number | undefined
  let detail = error instanceof Error ? error.message : 'Error de conexión'
  if (axios.isAxiosError(error)) {
    status = error.response?.status
    const response = error.response?.data as { error?: { message?: string } } | undefined
    detail = response?.error?.message || error.message || detail
  }
  const prefix = status ? `[HTTP ${status}] ` : ''
  return { ok: false, info: redactSecrets(`${prefix}${detail}`, secrets) }
}

router.get('/api/admin/server-settings', auth.authAdmin, async (_req, res) => {
  res.json(maskSettings(await settings.getAll()))
})

router.post('/api/admin/server-settings', auth.authAdmin, async (req, res) => {
  try {
    await settings.setMany(req.body as Record<string, unknown>)
    // ⚠️ Cambiar la tarifa y olvidar la que la tienda tenía en memoria va
    // JUNTO. La base cobra la nueva al instante, pero el carrito seguía
    // enseñando la vieja hasta un minuto: el cliente veía $4,62 y se le
    // cobraban $4,77. Lo encontraron los recorridos de punta a punta
    // (2026-10-01). Con una sola instancia en Railway, esto lo cierra del
    // todo; con varias, las demás tardarían como mucho ese minuto.
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'service_fee')) tarifa.olvidarTarifa()
    res.json({ ok: true })
  } catch (error) {
    console.error(
      '❌ guardar configuración del servidor:',
      error instanceof Error ? error.message : 'Error desconocido',
    )
    res.status(500).json({ error: 'No se pudo guardar la configuración' })
  }
})

router.post('/api/admin/server-settings/verify-ai', auth.authAdmin, async (req, res) => {
  const payload = req.body as AiVerificationPayload
  const secrets = [
    payload.anthropic_api_key,
    payload.openai_api_key,
    payload.gemini_api_key,
    payload.groq_api_key,
    payload.deepseek_api_key,
  ]
  try {
    if (payload.provider === 'groq') {
      const key = payload.groq_api_key || await settings.get('groq_api_key')
      if (!key) return res.json({ ok: false, info: 'Falta Groq API Key' })
      const groq = new OpenAI({ apiKey: key, baseURL: 'https://api.groq.com/openai/v1' })
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      })
      return res.json({
        ok: true,
        info: `✅ Groq activo — ${response.model || 'llama-3.3-70b'}`,
      })
    }

    if (payload.provider === 'deepseek') {
      const key = payload.deepseek_api_key || await settings.get('deepseek_api_key')
      if (!key) return res.json({ ok: false, info: 'Falta DeepSeek API Key' })
      const deepseek = new OpenAI({ apiKey: key, baseURL: 'https://api.deepseek.com' })
      const response = await deepseek.chat.completions.create({
        model: 'deepseek-chat',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      })
      return res.json({
        ok: true,
        info: `✅ DeepSeek activo — ${response.model || 'deepseek-chat'}`,
      })
    }

    if (payload.provider === 'gemini') {
      const key = payload.gemini_api_key || await settings.get('gemini_api_key')
      if (!key) return res.json({ ok: false, info: 'Falta Gemini API Key' })
      try {
        const response = await axios.post<{ candidates?: unknown[] }>(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
          {
            contents: [{ parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 5 },
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
        )
        return res.json({
          ok: Boolean(response.data.candidates),
          info: response.data.candidates
            ? '✅ Gemini 2.0 Flash activo y conectado'
            : 'Respuesta inesperada',
        })
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          try {
            const list = await axios.get<{
              models?: Array<{ name: string; supportedGenerationMethods?: string[] }>
            }>(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
              timeout: 10000,
            })
            const flash = (list.data.models || [])
              .filter(model => (
                (model.supportedGenerationMethods || []).includes('generateContent')
                && /flash/i.test(model.name)
              ))
              .map(model => model.name.replace('models/', ''))
            return res.json({
              ok: false,
              info: `Modelo no disponible. Modelos 'flash' que SÍ tienes: ${flash.join(', ') || 'ninguno'}`,
            })
          } catch (listError) {
            console.warn(
              '⚠️  No se pudieron listar modelos Gemini:',
              listError instanceof Error ? listError.message : 'Error desconocido',
            )
          }
        }
        throw error
      }
    }

    if (payload.provider === 'openai') {
      const key = payload.openai_api_key || await settings.get('openai_api_key')
      if (!key) return res.json({ ok: false, info: 'Falta OpenAI API Key' })
      const openai = new OpenAI({ apiKey: key })
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      })
      return res.json({ ok: true, info: `GPT-4o Mini — ${response.model}` })
    }

    const key = payload.anthropic_api_key
      || await settings.get('anthropic_api_key')
      || process.env.ANTHROPIC_API_KEY
    if (!key) return res.json({ ok: false, info: 'Falta Anthropic API Key' })
    const claude = new Anthropic({ apiKey: key })
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'ping' }],
    })
    return res.json({ ok: true, info: `Claude Sonnet activo — ${response.model}` })
  } catch (error) {
    res.json(verificationError(error, secrets))
  }
})

router.post(
  '/api/admin/server-settings/verify-cloudinary',
  auth.authAdmin,
  async (req, res) => {
    const payload = req.body as CloudinaryVerificationPayload
    try {
      res.json(await cloudinary.verify({
        cloud_name: payload.cloudinary_cloud_name,
        api_key: payload.cloudinary_api_key,
        api_secret: payload.cloudinary_api_secret,
      }))
    } catch (error) {
      const cloudError = error as {
        error?: { message?: string }
        message?: string
        http_code?: number
      }
      const detail = cloudError.error?.message || cloudError.message || 'Error de conexión'
      const prefix = cloudError.http_code ? `[HTTP ${cloudError.http_code}] ` : ''
      res.json({
        ok: false,
        info: redactSecrets(`${prefix}${detail}`, [
          payload.cloudinary_api_key,
          payload.cloudinary_api_secret,
        ]),
      })
    }
  },
)

export = router
