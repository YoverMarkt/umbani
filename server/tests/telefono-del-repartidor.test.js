import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { telefonoDelRepartidor } = require('../dist/lib/telefono-del-repartidor')

// ═══════════════════════════════════════════════════════════════════════════
// EL TELÉFONO DE UN REPARTIDOR (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// El repartidor entra por WhatsApp y el servidor lo busca por el remitente
// (593991234567). Registrado de otra forma, NUNCA podía entrar — y nadie lo
// veía, porque el simulador del staging usa 000000000000.

describe('el teléfono del repartidor queda como lo verá WhatsApp', () => {
  it('un celular escrito a la manera de Ecuador (09…) lleva el código del país', () => {
    expect(telefonoDelRepartidor('0991234567')).toBe('593991234567')
    expect(telefonoDelRepartidor('099 123 4567')).toBe('593991234567')
  })

  it('con «+», espacios o guiones, solo quedan los dígitos', () => {
    expect(telefonoDelRepartidor('+593 99 123 4567')).toBe('593991234567')
    expect(telefonoDelRepartidor('593-99-123-4567')).toBe('593991234567')
  })

  it('con el código del país Y el cero local, el cero sobra', () => {
    expect(telefonoDelRepartidor('+593 099 123 4567')).toBe('593991234567')
  })

  it('un número de otro país se respeta tal cual (en dígitos)', () => {
    expect(telefonoDelRepartidor('+58 412 1234567')).toBe('584121234567')
    // El del simulador del staging.
    expect(telefonoDelRepartidor('000000000000')).toBe('000000000000')
  })

  it('lo que no es un teléfono no pasa', () => {
    for (const malo of ['', null, undefined, '12', 'hola', '1234567', '1234567890123456']) {
      expect(telefonoDelRepartidor(malo)).toBeNull()
    }
  })
})
