import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  borrarRecientes,
  buscarEnLaCarta,
  guardarReciente,
  leerRecientes,
  type GrupoDeCarta,
} from '../src/lib/buscar'
import Buscar from '../src/screens/Buscar'
import type { Product } from '../src/lib/types'

// ═══════════════════════════════════════════════════════════════════════════
// BUSCAR, EN SU PROPIA PANTALLA (2026-09-26)
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta hoy buscar era una barra DENTRO de la portada: el héroe seguía arriba
// y los resultados ocupaban el sitio de la carta. El dueño pidió una pantalla
// propia con el diseño de la mini app.

const producto = (id: string, name: string, extra: Partial<Product> = {}): Product => ({
  id,
  name,
  description: null,
  imageUrl: null,
  videoUrl: null,
  categoryId: null,
  tags: [],
  available: true,
  productType: 'simple',
  priceFrom: 5,
  hasVariants: false,
  variants: [],
  extras: [],
  optionGroups: [],
  recommendations: [],
  ...extra,
})

const CARTA: GrupoDeCarta[] = [
  {
    id: 'pizzas',
    nombre: 'Pizzas',
    imagen: null,
    productos: [
      producto('hawaiana', 'Hawaiana', { description: 'Jamón y piña' }),
      producto('pep-fam', 'Pepperoni pizza familiar'),
      producto('pep', 'Pizza pepperoni'),
      producto('agotada', 'Pizza del chef', { available: false }),
    ],
  },
  {
    id: 'bebidas',
    nombre: 'Bebidas',
    imagen: null,
    productos: [producto('cola', 'Coca Cola 500 ml'), producto('agua', 'Agua sin gas')],
  },
]

const ids = (hallazgos: ReturnType<typeof buscarEnLaCarta>) =>
  hallazgos.map(h => `${h.grupo.id}: ${h.productos.map(p => p.id).join(',')}`)

describe('qué sale al buscar', () => {
  it('palabra por palabra, no la frase entera', () => {
    // Con la frase entera, «pizza pepperoni» no encontraba «Pepperoni pizza».
    expect(ids(buscarEnLaCarta(CARTA, 'pizza pepperoni'))).toEqual(['pizzas: pep,pep-fam'])
  })

  it('sin tildes ni mayúsculas, como escribe la gente con una mano', () => {
    expect(ids(buscarEnLaCarta(CARTA, 'JAMON'))).toEqual(['pizzas: hawaiana'])
  })

  it('el nombre de la sección también cuenta', () => {
    expect(ids(buscarEnLaCarta(CARTA, 'bebidas'))).toEqual(['bebidas: cola,agua'])
  })

  it('primero lo que EMPIEZA por lo escrito, y lo agotado al final', () => {
    // «Pizza pepperoni» empieza por «pizza»; «Pepperoni pizza…» solo la lleva;
    // «Hawaiana» solo por la sección, y «Pizza del chef» está agotada.
    expect(ids(buscarEnLaCarta(CARTA, 'pizza'))).toEqual(['pizzas: pep,pep-fam,hawaiana,agotada'])
  })

  it('la sección con el mejor acierto va primero', () => {
    const carta: GrupoDeCarta[] = [
      { id: 'combos', nombre: 'Combos', imagen: null, productos: [producto('c1', 'Combo con agua mineral')] },
      { id: 'bebidas', nombre: 'Bebidas', imagen: null, productos: [producto('a1', 'Agua sin gas')] },
    ]
    expect(buscarEnLaCarta(carta, 'agua').map(h => h.grupo.id)).toEqual(['bebidas', 'combos'])
  })

  it('sin nada escrito no hay resultados que pintar', () => {
    expect(buscarEnLaCarta(CARTA, '   ')).toEqual([])
  })
})

describe('lo que buscó antes, en este teléfono', () => {
  const memoria = new Map<string, string>()
  const almacen = {
    getItem: (k: string) => memoria.get(k) ?? null,
    setItem: (k: string, v: string) => { memoria.set(k, v) },
    removeItem: (k: string) => { memoria.delete(k) },
  }
  afterEach(() => { memoria.clear(); vi.unstubAllGlobals() })

  it('guarda las últimas cinco, sin repetir y la más nueva primero', () => {
    vi.stubGlobal('localStorage', almacen)
    for (const q of ['pizza', 'agua', 'cola', 'combo', 'helado', 'papas']) guardarReciente('monster', q)
    guardarReciente('monster', 'PIZZA')
    expect(leerRecientes('monster')).toEqual(['PIZZA', 'papas', 'helado', 'combo', 'cola'])
  })

  it('una letra suelta no se guarda', () => {
    vi.stubGlobal('localStorage', almacen)
    guardarReciente('monster', 'p')
    expect(leerRecientes('monster')).toEqual([])
  })

  it('cada local tiene las suyas, y se pueden borrar', () => {
    vi.stubGlobal('localStorage', almacen)
    guardarReciente('monster', 'pizza')
    expect(leerRecientes('abuelita')).toEqual([])
    borrarRecientes('monster')
    expect(leerRecientes('monster')).toEqual([])
  })

  it('sin almacenamiento (modo privado) la búsqueda funciona igual', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('bloqueado') },
      setItem: () => { throw new Error('bloqueado') },
      removeItem: () => { throw new Error('bloqueado') },
    })
    expect(() => guardarReciente('monster', 'pizza')).not.toThrow()
    expect(leerRecientes('monster')).toEqual([])
    expect(() => borrarRecientes('monster')).not.toThrow()
  })
})

describe('la pantalla', () => {
  const pintar = () => renderToStaticMarkup(
    <Buscar
      slug="monster"
      negocio="Monster Pizza"
      grupos={CARTA}
      tarjeta={p => <div key={p.id}>{p.name}</div>}
      onCerrar={() => {}}
      onIrACategoria={() => {}}
    />,
  )

  it('al abrirla ofrece la carta por secciones, no una pantalla en blanco', () => {
    const html = pintar()
    expect(html).toContain('Explora la carta')
    expect(html).toContain('Pizzas')
    expect(html).toContain('4 productos')
    expect(html).toContain('placeholder="Buscar en Monster Pizza"')
  })

  it('el campo va a 16 px: por debajo, Safari amplía la página al enfocarlo', () => {
    expect(pintar()).toMatch(/<input[^>]*text-\[16px\]/)
  })

  it('va encima de la tienda pero DEBAJO de la barra de abajo y de las hojas', () => {
    // La barra inferior es z-40 y las hojas z-50: el carrito sigue a mano y
    // la ficha de un resultado se abre encima.
    expect(pintar()).toContain('fixed inset-0 z-[35]')
  })
})
