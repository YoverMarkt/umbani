import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { elegir } from '../dist/services/marketplace-menu.js'

// ═══════════════════════════════════════════════════════════════════════════
// LAS OPCIONES TIENEN QUE CABER EN LO QUE WHATSAPP DEVUELVE
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Fallo REAL del 2026-08-23, visto por el dueño en su teléfono: tocaba
// «✅ Sí, empezar de nu…» y recibía «🙏 No te entendí».
//
// WhatsApp RECORTA el título de un botón a 20 caracteres y devuelve el
// recorte. «✅ Sí, empezar de nuevo» son 22, así que volvía cortado, no casaba
// con ninguna opción, y esa opción era **IMPOSIBLE de elegir**. No es que
// costara: no se podía, nunca.
//
// Seis de las diez opciones se pasaban: «Repetir mi último pedido», «Ver
// productos y precios», «Hablar con el equipo», «Sí, empezar de nuevo» y
// «No, seguir con mi pedido» estaban todas muertas.

const leer = ruta => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), 'utf8')

/** El tope real de un título de botón en WhatsApp. */
const TOPE = 20

/**
 * Saca las etiquetas literales que el cliente ve como opción.
 *
 * ⚠️ Mira las constantes Y los `push('…')` sueltos. Al escribir esta prueba
 * solo miraba las constantes, y se le escapó `bot-menu.ts`, que empujaba sus
 * opciones directamente — con «📋 Ver productos y precios» de 25 caracteres.
 * Un guardián que no mira donde de verdad están las cosas no protege nada.
 * (`bot-menu.ts` se retiró el 2026-08-23 al quedarse sin un solo llamador, y
 * `bot-menu-flow.ts` el 2026-09-16 con el pedido por chat; la lección de mirar
 * los `push` sueltos vale igual para el que queda.)
 */
const etiquetasDe = (fuente) => [
  ...[...fuente.matchAll(
    /^(?:export )?const (?:OPT_[A-Z_]+|SI_REINICIAR|NO_CONTINUAR|VER_MAS|VOLVER) = '([^']+)'/gm,
  )].map(m => m[1]),
  ...[...fuente.matchAll(/options\.push\('([^']+)'\)/g)].map(m => m[1]),
].filter(Boolean)

describe('ninguna opción se pasa del tope de WhatsApp', () => {
  // ⚠️ El menú y sus DOS partes (2026-10-07): `VER_MAS` y `VOLVER` viven ahora
  // en los textos, y algunas opciones en las pantallas. Leyendo solo el menú,
  // esas etiquetas se escaparían de la prueba sin que nada fallara.
  const fuentes = {
    'el menú del marketplace (con sus textos y pantallas)': [
      '../src/services/marketplace-menu.ts',
      '../src/services/marketplace-menu-textos.ts',
      '../src/services/marketplace-menu-pantallas.ts',
    ].map(leer).join('\n'),
  }

  for (const [archivo, fuente] of Object.entries(fuentes)) {
    it(`${archivo}: todas caben en ${TOPE} caracteres`, () => {
      const etiquetas = etiquetasDe(fuente)
      // Si el extractor deja de encontrar nada, la prueba pasaría en falso.
      expect(etiquetas.length, `no encontró etiquetas en ${archivo}`).toBeGreaterThan(1)
      const largas = etiquetas
        .map(texto => ({ texto, largo: [...texto].length }))
        .filter(x => x.largo > TOPE)
      expect(
        largas,
        largas.length
          ? `WhatsApp las recortaría y el cliente NO PODRÍA elegirlas:\n`
            + largas.map(x => `  · «${x.texto}» (${x.largo})`).join('\n')
          : '',
      ).toEqual([])
    })
  }
})

describe('y aun así se tolera el recorte', () => {
  // La red de seguridad: si algún día entra una opción larga por otra vía
  // —el nombre de un local, por ejemplo—, tocarla tiene que seguir valiendo.
  const opciones = ['✅ Empezar de nuevo', '↩️ Seguir mi pedido']

  it('un título recortado por WhatsApp se reconoce igual', () => {
    expect(elegir('✅ Empezar de nu…', opciones)).toBe('✅ Empezar de nuevo')
    expect(elegir('↩️ Seguir mi ped…', opciones)).toBe('↩️ Seguir mi pedido')
  })

  it('también recortado con puntos suspensivos normales', () => {
    expect(elegir('Empezar de nue...', opciones)).toBe('✅ Empezar de nuevo')
  })

  // ⚠️ Pero NO se adivina: con dos opciones que empiezan igual, se vuelve a
  // preguntar en vez de elegir una al azar. Tirar un carrito no tiene vuelta.
  it('con dos opciones que empiezan igual NO elige ninguna', () => {
    const ambiguas = ['🍕 Pizza grande', '🍕 Pizza pequeña']
    expect(elegir('🍕 Pizza…', ambiguas)).toBeNull()
  })

  it('y un prefijo demasiado corto tampoco vale', () => {
    expect(elegir('✅…', opciones)).toBeNull()
  })

  it('lo de siempre sigue funcionando: texto exacto y número', () => {
    expect(elegir('✅ Empezar de nuevo', opciones)).toBe('✅ Empezar de nuevo')
    expect(elegir('2', opciones)).toBe('↩️ Seguir mi pedido')
    expect(elegir('empezar de nuevo', opciones)).toBe('✅ Empezar de nuevo')
  })
})
