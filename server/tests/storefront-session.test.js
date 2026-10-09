import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  checkSession,
  createSessionToken,
  deviceFingerprint,
  hashToken,
  rejectionMessage,
} = require('../dist/services/storefront-session')

const ahora = new Date('2026-08-01T12:00:00.000Z')
const enHoras = h => new Date(ahora.getTime() + h * 3_600_000).toISOString()

const sesion = (extra = {}) => ({
  id: 'ses-1',
  business_id: 'biz-1',
  customer_id: 'cli-1',
  contact_phone: '593990978367',
  device_hash: null,
  claimed_at: null,
  expires_at: enHoras(6),
  revoked_at: null,
  ...extra,
})

const MOVIL_CLIENTE = deviceFingerprint({ userAgent: 'iPhone', clientId: 'abc' })
const MOVIL_AMIGO = deviceFingerprint({ userAgent: 'Android', clientId: 'xyz' })

describe('sesiones de la mini app', () => {
  describe('el token', () => {
    it('genera tokens distintos e impredecibles', () => {
      const a = createSessionToken()
      const b = createSessionToken()
      expect(a.token).not.toBe(b.token)
      // 128 bits en base64url = 22 caracteres. Es la misma entropía que un
      // UUID v4 y cabe en un mensaje de WhatsApp sin parecer spam.
      expect(a.token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    })

    // Un enlace largo se lee como spam y la gente no lo toca. Este límite es
    // una decisión de producto, no un detalle: si alguien sube la entropía
    // "por si acaso", este test le recuerda lo que cuesta.
    it('el token cabe en un mensaje sin afearlo', () => {
      expect(createSessionToken().token.length).toBeLessThanOrEqual(24)
    })

    // Si alguien lee la base, no puede entrar en la tienda de nadie.
    it('guarda el hash, nunca el token', () => {
      const { token, tokenHash } = createSessionToken()
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
      expect(tokenHash).not.toContain(token)
      expect(hashToken(token)).toBe(tokenHash)
    })

    // Caducaba en 6 h hasta el 2026-08-02. Se quitó porque el cliente guardaba
    // el enlace, volvía dos días después y se encontraba un error — y el
    // negocio perdía el pedido. Lo que protege el enlace ahora es el teléfono,
    // no el reloj (ver `enlace-permanente.test.js`).
    it('ya no caduca: una sesión sin fecha sigue valiendo años después', () => {
      const resultado = checkSession({
        session: sesion({
          device_hash: MOVIL_CLIENTE, claimed_at: ahora.toISOString(),
          expires_at: null,
        }),
        deviceHash: MOVIL_CLIENTE,
        now: new Date('2030-01-01T00:00:00.000Z'),
      })
      expect(resultado.ok).toBe(true)
    })
  })

  describe('huella del dispositivo', () => {
    it('distingue dos teléfonos distintos', () => {
      expect(MOVIL_CLIENTE).not.toBe(MOVIL_AMIGO)
    })

    it('es estable para el mismo dispositivo', () => {
      expect(deviceFingerprint({ userAgent: 'iPhone', clientId: 'abc' })).toBe(MOVIL_CLIENTE)
    })

    it('siempre devuelve un sha256', () => {
      expect(deviceFingerprint({})).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('quién puede comprar', () => {
    // ESTE test decía lo contrario, y ahí estaba el agujero: la primera
    // apertura se quedaba la sesión sin preguntar nada, así que quien reenviaba
    // el enlace ANTES de abrirlo se lo regalaba al primero que hiciera clic.
    // Ahora hay que confirmar el número de WhatsApp al que se emitió.
    it('la primera apertura ya NO reclama: pide confirmar el número', () => {
      const resultado = checkSession({ session: sesion(), deviceHash: MOVIL_CLIENTE, now: ahora })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('necesita_telefono')
      // La sesión se devuelve igual: la app la necesita para pedir el número.
      expect(resultado.session).toBeTruthy()
    })

    it('el mismo dispositivo puede volver a entrar', () => {
      const resultado = checkSession({
        session: sesion({ device_hash: MOVIL_CLIENTE, claimed_at: ahora.toISOString() }),
        deviceHash: MOVIL_CLIENTE,
        now: ahora,
      })
      expect(resultado.ok).toBe(true)
      expect(resultado.claims).toBe(false)
    })

    // El caso que pidió el usuario: el enlace reenviado NO compra.
    it('otro dispositivo con el mismo enlace no entra sin confirmar el número', () => {
      const resultado = checkSession({
        session: sesion({ device_hash: MOVIL_CLIENTE, claimed_at: ahora.toISOString() }),
        deviceHash: MOVIL_AMIGO,
        now: ahora,
      })
      expect(resultado.ok).toBe(false)
      // Ya no es un portazo seco: el amigo pondrá su número y no coincidirá,
      // pero el cliente que cambió de teléfono sí puede volver a entrar.
      expect(resultado.reason).toBe('necesita_telefono')
    })

    it('rechaza un enlace vencido', () => {
      const resultado = checkSession({
        session: sesion({ expires_at: enHoras(-1) }),
        deviceHash: MOVIL_CLIENTE,
        now: ahora,
      })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('caducada')
    })

    it('rechaza una sesión revocada aunque no haya vencido', () => {
      const resultado = checkSession({
        session: sesion({ revoked_at: ahora.toISOString() }),
        deviceHash: MOVIL_CLIENTE,
        now: ahora,
      })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('revocada')
    })

    it('rechaza un token que no existe', () => {
      const resultado = checkSession({ session: null, deviceHash: MOVIL_CLIENTE, now: ahora })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('no_existe')
    })

    // Sin esto, una sesión de la pizzería abriría la tienda del hostal con solo
    // cambiar el slug de la URL.
    it('un token de otro negocio no sirve aunque sea válido', () => {
      const resultado = checkSession({
        session: sesion({ business_id: 'biz-pizzeria' }),
        deviceHash: MOVIL_CLIENTE,
        expectedBusinessId: 'biz-hostal',
        now: ahora,
      })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('otro_negocio')
    })

    it('el token sí sirve en su propio negocio', () => {
      // Con el dispositivo ya confirmado: lo que se comprueba aquí es que el
      // negocio correcto NO rechaza, no el camino de la confirmación.
      const resultado = checkSession({
        session: sesion({
          business_id: 'biz-1',
          device_hash: MOVIL_CLIENTE,
          claimed_at: ahora.toISOString(),
        }),
        deviceHash: MOVIL_CLIENTE,
        expectedBusinessId: 'biz-1',
        now: ahora,
      })
      expect(resultado.ok).toBe(true)
    })

    // El negocio se comprueba ANTES que nada: un token caducado de otro negocio
    // no debe revelar siquiera que caducó.
    it('no distingue entre un token ajeno y uno inexistente', () => {
      const ajeno = checkSession({
        session: sesion({ business_id: 'biz-otro', revoked_at: ahora.toISOString() }),
        deviceHash: MOVIL_CLIENTE,
        expectedBusinessId: 'biz-1',
        now: ahora,
      })
      expect(rejectionMessage(ajeno.reason)).toBe(rejectionMessage('no_existe'))
    })
  })

  describe('qué se le dice a quien no puede entrar', () => {
    // Desde el 2026-10-09 Umbani es solo app: lo manda de vuelta a la APP,
    // nunca a WhatsApp (antes: «Escríbele al negocio por WhatsApp»).
    it('siempre lo manda de vuelta a la app, nunca a WhatsApp', () => {
      for (const motivo of ['no_existe', 'otro_negocio', 'caducada', 'revocada', 'otro_dispositivo', 'necesita_telefono']) {
        expect(rejectionMessage(motivo), motivo).toMatch(/Umbani/)
        expect(rejectionMessage(motivo), motivo).not.toMatch(/whatsapp/i)
      }
    })

    // La pantalla la ve un desconocido: no puede filtrar datos del dueño.
    it('nunca revela el teléfono ni el nombre del dueño de la sesión', () => {
      for (const motivo of ['no_existe', 'caducada', 'revocada', 'otro_dispositivo']) {
        const mensaje = rejectionMessage(motivo)
        expect(mensaje).not.toMatch(/\d{7,}/)
        expect(mensaje).not.toMatch(/593/)
      }
    })
  })
})
