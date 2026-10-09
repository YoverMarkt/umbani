export const MEDIA_LIMITS = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  multipart: 16 * 1024 * 1024,
} as const

interface MediaFileInfo {
  mimetype?: string
  size: number
}

export interface MediaError {
  status: 400 | 413
  error: string
}

export function validateMediaFile(file: MediaFileInfo): MediaError | null {
  const mime = file.mimetype || ''
  if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
    return { status: 400, error: 'Solo se permiten imágenes o videos' }
  }

  const isVideo = mime.startsWith('video/')
  const maxSize = isVideo ? MEDIA_LIMITS.video : MEDIA_LIMITS.image
  if (file.size > maxSize) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(1)
    return {
      status: 413,
      error: `El archivo supera el límite de WhatsApp (${isVideo ? '16 MB para video' : '5 MB para imagen'}). Tu archivo pesa ${sizeMb} MB.`,
    }
  }

  return null
}

/**
 * El error de una subida, dicho para la persona. ⚠️ Con el límite de ESA
 * subida (2026-10-09): decía «máx 16MB» también en el comprobante, que admite
 * 5, y quien subía una foto de 6 MB leía que le sobraba espacio.
 */
export function mapMulterError(error: unknown, maximo: number = MEDIA_LIMITS.multipart): MediaError {
  const uploadError = error as { code?: string; message?: string }
  if (uploadError.code === 'LIMIT_FILE_SIZE') {
    return { status: 413, error: `Archivo demasiado grande (máx ${Math.round(maximo / 1024 / 1024)}MB)` }
  }
  return { status: 400, error: uploadError.message as string }
}
