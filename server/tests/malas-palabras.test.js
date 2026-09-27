import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { contieneInsulto } = require('../dist/lib/malas-palabras')

// ═══════════════════════════════════════════════════════════════════════════
// MALAS PALABRAS: lo que cuenta, y sobre todo lo que NO
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño probó el chat con insultos el 2026-09-27. Decidió: solo las
// fuertes, advertencia la primera vez, bloqueo de 15 días la segunda.
//
// ⚠️ Lo que más importa de este archivo es la segunda mitad: en una app de
// comida de Ecuador, «ceviche de concha» o «huevos revueltos» marcados como
// insulto serían un cliente bueno bloqueado 15 días.

describe('cuenta como insulto', () => {
  it.each([
    // Los que escribió el dueño probando.
    'Putas', 'Verga', 'Mierda', 'Que putas',
    // Los insultos de Ecuador y Colombia.
    'hijueputa', 'eres un hijo de puta', 'chucha', 'conchetumadre',
    'concha de tu madre', 'chucha tu madre', 'maricón', 'cabrón', 'pendejo',
    'güevón', 'huevón', 'cojudo', 'malparido', 'gonorrea', 'imbécil', 'idiota',
    'mamaverga', 'la puta madre',
    // Abreviaturas.
    'hdp', 'ctm', 'mrd', 'vrg', 'hpta',
    // Las formas de esquivar el filtro.
    'puuuuta', 'p u t a', 'p.u.t.a', 'm1erda', 'put4', 'VERGAAA', 'perrrra',
    // Dentro de una frase.
    'no sirven para nada, pendejos', 'qué mierda de servicio',
  ])('«%s»', (texto) => {
    expect(contieneInsulto(texto)).toBe(true)
  })
})

describe('NO cuenta: la comida y las palabras normales', () => {
  it.each([
    // Mariscos y platos de Ecuador.
    'ceviche de concha', 'quiero conchas asadas', 'concha prieta', 'mariscos',
    'huevos revueltos', 'huevo frito', 'dos huevos', 'pico de gallo', 'pollo',
    'caldo para el chuchaqui', 'culantro', 'longaniza', 'encebollado', 'bolón',
    // Heladerías: «coño» sin tilde es «cono», y no se puede bloquear un helado.
    'un cono de helado', 'dos conos', 'perros calientes',
    // Palabras que contienen un trozo de una mala palabra.
    'vergüenza', 'disputa', 'computadora', 'reputación', 'pingüino', 'cojín',
    'pendiente', 'pera', 'zorro', 'coñac',
    // Los eufemismos suaves: decisión del dueño, no cuentan.
    'chuta', 'gaver', 'carajo', 'shunsho', 'baboso',
    // Lo normal del chat.
    'hola', 'Menu', 'Locales abiertos en está hora?', 'Parilladas', 'Sopa',
    'te envío el comprobante de mi pedido #25', 'gracias',
  ])('«%s»', (texto) => {
    expect(contieneInsulto(texto)).toBe(false)
  })
})
