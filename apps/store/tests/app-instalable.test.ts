import { describe, expect, it } from 'vitest'
import { esIphone, queOfrecer } from '../src/lib/app-instalable'

// Qué se le ofrece a cada teléfono para instalar `/u` o `/r`. La regla vive
// en una función sin navegador para poder comprobarla aquí, teléfono por
// teléfono, sin un Android y un iPhone en la mesa.

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_COMO_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const INSTAGRAM_EN_IPHONE = `${IPHONE} Instagram 340.0.0.22.109`
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A145M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'

const base = { instalada: false, descartada: false, hayAviso: false, agente: ANDROID, puntosTactiles: 5 }

describe('qué se ofrece para instalar la app', () => {
  it('Android con el aviso de Chrome: el botón «Instalar»', () => {
    expect(queOfrecer({ ...base, hayAviso: true })).toBe('boton')
  })

  it('Android sin aviso (aún no es instalable, o ya se usó): nada', () => {
    // Un botón que no puede abrir la ventana de instalar no se pinta.
    expect(queOfrecer(base)).toBe('nada')
  })

  it('iPhone: cómo hacerlo desde Compartir, porque no hay aviso', () => {
    expect(queOfrecer({ ...base, agente: IPHONE })).toBe('iphone')
  })

  it('ya instalada, o «Ahora no»: nada, ni siquiera con el aviso', () => {
    expect(queOfrecer({ ...base, hayAviso: true, instalada: true })).toBe('nada')
    expect(queOfrecer({ ...base, agente: IPHONE, descartada: true })).toBe('nada')
  })
})

describe('reconocer un iPhone que sabe «Agregar a inicio»', () => {
  it('el iPhone y el iPad, aunque el iPad se presente como un Mac', () => {
    expect(esIphone(IPHONE, 5)).toBe(true)
    expect(esIphone(IPAD_COMO_MAC, 5)).toBe(true)
  })

  it('un Mac de verdad no: no tiene pantalla táctil', () => {
    expect(esIphone(IPAD_COMO_MAC, 0)).toBe(false)
  })

  it('el navegador de dentro de Instagram no, porque no tiene esa opción', () => {
    expect(esIphone(INSTAGRAM_EN_IPHONE, 5)).toBe(false)
  })

  it('Android no', () => {
    expect(esIphone(ANDROID, 5)).toBe(false)
  })
})
