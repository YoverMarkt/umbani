import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import mediaRouter from '../dist/routes/products-media.routes.js'

const require = createRequire(import.meta.url)
const cloud = require('../dist/integrations/cloudinary')
const media = require('../dist/lib/media')
const JWT_SECRET = 'products-media-test-secret'

let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

function authorization() {
  const token = jwt.sign({
    role: 'client', businessId: 'business-a', urole: 'owner',
  }, JWT_SECRET)
  return `Bearer ${token}`
}

async function dispatchFinal(file) {
  const route = mediaRouter.stack.find(layer => layer.route?.path === '/api/client/media')
  const handler = route.route.stack.at(-1).handle
  const req = {
    headers: { authorization: authorization() },
    user: { role: 'client', businessId: 'business-a', urole: 'owner' },
    file,
  }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }
  await handler(req, res, error => { if (error) throw error })
  return result
}

describe('subida de media', () => {
  it('conserva autenticación, permiso, Multer y límite multipart de 16 MB', () => {
    const route = mediaRouter.stack.find(layer => layer.route?.path === '/api/client/media')
    expect(route.route.stack).toHaveLength(4)
    expect(mediaRouter.multipartFileSize).toBe(16 * 1024 * 1024)
    // Y con el límite de cada subida: el comprobante admite 5 MB, no 16.
    expect(media.mapMulterError({ code: 'LIMIT_FILE_SIZE' }, media.MEDIA_LIMITS.image).error)
      .toBe('Archivo demasiado grande (máx 5MB)')
    expect(media.mapMulterError({ code: 'LIMIT_FILE_SIZE' })).toEqual({
      status: 413,
      error: 'Archivo demasiado grande (máx 16MB)',
    })
  })

  it('permite subir media con permiso de catálogo sin aceptar otros', async () => {
    const route = mediaRouter.stack.find(layer => layer.route?.path === '/api/client/media')
    const permission = route.route.stack[1].handle
    const next = vi.fn()
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await permission({ user: { urole: 'employee', perms: ['catalogo'] } }, response, next)
    expect(next).toHaveBeenCalledTimes(1)

    next.mockClear()
    await permission({ user: { urole: 'employee', perms: ['reportes'] } }, response, next)
    expect(next).not.toHaveBeenCalled()
    expect(response.status).toHaveBeenCalledWith(403)
  })

  it('rechaza ausencia, tipo inválido e imágenes mayores a 5 MB', async () => {
    expect(await dispatchFinal(undefined)).toEqual({
      status: 400, body: { error: 'No se recibió archivo' },
    })
    expect(await dispatchFinal({
      mimetype: 'application/pdf', size: 100, buffer: Buffer.from('pdf'),
    })).toEqual({
      status: 400, body: { error: 'Solo se permiten imágenes o videos' },
    })
    const oversized = await dispatchFinal({
      mimetype: 'image/jpeg',
      size: 6 * 1024 * 1024,
      buffer: Buffer.alloc(1),
    })
    expect(oversized.status).toBe(413)
    expect(oversized.body.error).toContain('5 MB para imagen')
  })

  it('informa cuando Cloudinary no está configurado', async () => {
    vi.spyOn(cloud, 'isConfigured').mockResolvedValue(false)

    const response = await dispatchFinal({
      mimetype: 'video/mp4', size: 1024, buffer: Buffer.from('video'),
    })

    expect(response.status).toBe(503)
    expect(response.body.error).toContain('Cloudinary no está configurado')
  })

  it('sube un archivo válido a la carpeta del negocio del JWT', async () => {
    vi.spyOn(cloud, 'isConfigured').mockResolvedValue(true)
    const uploadMedia = vi.spyOn(cloud, 'uploadMedia').mockResolvedValue({
      url: 'https://cdn.example/image.jpg',
      public_id: 'botpanel/business-a/image',
      resource_type: 'image',
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const buffer = Buffer.from('image')

    const response = await dispatchFinal({
      mimetype: 'image/jpeg', size: buffer.length, buffer,
    })

    expect(response.status).toBe(200)
    expect(uploadMedia).toHaveBeenCalledWith(buffer, 'business-a')
    expect(response.body.public_id).toBe('botpanel/business-a/image')
  })

  it('oculta errores internos de subida', async () => {
    vi.spyOn(cloud, 'isConfigured').mockRejectedValue(new Error('secreto interno'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await dispatchFinal({
      mimetype: 'image/png', size: 100, buffer: Buffer.from('image'),
    })

    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo subir el archivo. Intenta de nuevo.' },
    })
  })
})
