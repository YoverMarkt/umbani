import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fuentes, lineasDeComentario, raiz } from './pantallas.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// LOS VISTOS Y LAS CRUCES SON ICONOS, NO CARACTERES
// ═══════════════════════════════════════════════════════════════════════════
//
// Con el carácter «✓» dentro de un texto, lo que el navegador alinea es la
// caja de línea de la FUENTE: el símbolo queda alto respecto al texto que
// lleva al lado y la pantalla se lee como pegada de otra app. Con el icono,
// se alinea la caja del icono.
//
// No es teoría: es la misma cicatriz que ya está escrita para el `+` de la
// carta («el icono `Plus`, no el CARÁCTER «+»: con el carácter, lo que el flex
// centra es la caja de línea y la cruz queda alta en el círculo»).
//
// El dueño lo vio en producción el 2026-09-20, en la píldora «✓ Listo» de un
// grupo obligatorio: «el check de obligatorio es un check viejo». Al buscarlo
// aparecieron NUEVE más repartidos por los dos paneles — errores de login, de
// dashboard, de subida de archivos y de verificación de credenciales.
//
// Este guardián existe porque el dueño pidió justo eso: «quiero que el diseño
// esté en todas las pantallas y estas cosas no pasen».
//
// ⚠️ Los COMENTARIOS sí pueden nombrarlos: explicar por qué no se usan es
// parte de que la regla sobreviva.

/** El visto, la cruz y sus parientes, cuando van dibujados en el texto. */
const SIMBOLOS = /[✓✔✗✘☑☒]/

const CARPETAS = ['apps/store/src', 'apps/client/src', 'apps/admin/src', 'apps/cooperativa/src', 'packages/ui/src']

// `lineasDeComentario` y `fuentes` viven en `pantallas.mjs`: las comparte
// con el guardián de controles a pelo.

describe('los vistos y las cruces van como icono', () => {
  it('ninguna pantalla los dibuja a mano en el texto', () => {
    const culpables = []
    for (const carpeta of CARPETAS) {
      for (const archivo of fuentes(carpeta)) {
        const lineas = readFileSync(path.join(raiz, archivo), 'utf8').split('\n')
        const comentarios = lineasDeComentario(lineas)
        lineas.forEach((linea, i) => {
          if (SIMBOLOS.test(linea) && !comentarios.has(i)) {
            culpables.push(`${archivo}:${i + 1} → ${linea.trim().slice(0, 90)}`)
          }
        })
      }
    }

    expect(culpables, `Usa el icono del sistema (RiCheckLine en la tienda, `
      + `Check/X de lucide en los paneles) en vez del carácter:\n${culpables.join('\n')}`)
      .toEqual([])
  })

  it('sabe distinguir un comentario de una pantalla', () => {
    // Si no supiera, el propio aviso que explica la regla lo haría fallar para
    // siempre y alguien acabaría borrando el guardián.
    const marcadas = lineasDeComentario([
      '    {/* Aquí iba un visto',
      '        dibujado a mano, y quedaba alto */}',
      "    setStatus('OK')",
      '    // ojo con esto',
      '    <p>{error}</p>',
      '    /* de una línea */',
      '    <input type="file" accept="image/*" />',
      '    <p>✓ esto ya no es comentario</p>',
    ])
    // El `accept="image/*"` no abre un comentario: la línea de debajo se mira.
    expect([...marcadas].sort((a, b) => a - b)).toEqual([0, 1, 3, 5])
  })

  it('caza de verdad un símbolo escrito en una pantalla', () => {
    // Un guardián que nunca ha visto lo que persigue no sirve de nada.
    const lineas = ["  <p>✗ {error}</p>", '  // el ✓ va como icono']
    const comentarios = lineasDeComentario(lineas)
    const pillados = lineas.filter((l, i) => SIMBOLOS.test(l) && !comentarios.has(i))
    expect(pillados).toHaveLength(1)
    expect(pillados[0]).toContain('<p>')
  })
})
