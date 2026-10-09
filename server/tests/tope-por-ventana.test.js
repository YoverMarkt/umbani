import { describe, expect, it, vi } from 'vitest'
import { crearTopePorVentana, enteroDelEntorno } from '../dist/lib/tope-por-ventana.js'

// El tope global de la plataforma (2026-10-08): por IP y por sesión se frena a
// uno que insiste; esto frena a mil que piden una vez. Ver `src/lib/tope-por-ventana.ts`.

describe('crearTopePorVentana', () => {
  it('deja pasar hasta el máximo dentro de la ventana, y ni uno más', () => {
    let t = 0
    const tope = crearTopePorVentana({ maximo: 3, ventanaMs: 1000, ahora: () => t })
    expect([tope.cabe(), tope.cabe(), tope.cabe(), tope.cabe()]).toEqual([true, true, true, false])
    t = 999
    expect(tope.cabe()).toBe(false)
  })

  it('la ventana se DESLIZA: al vencer la marca más vieja, cabe otra', () => {
    let t = 0
    const tope = crearTopePorVentana({ maximo: 2, ventanaMs: 1000, ahora: () => t })
    tope.cabe()
    t = 500
    tope.cabe()
    t = 1000 // vence la de t=0, no la de t=500
    expect(tope.cabe()).toBe(true)
    expect(tope.cabe()).toBe(false)
  })

  it('un rechazo no cuenta: el que no cupo no alarga la espera de los demás', () => {
    let t = 0
    const tope = crearTopePorVentana({ maximo: 1, ventanaMs: 1000, ahora: () => t })
    tope.cabe()
    for (let i = 0; i < 50; i++) tope.cabe()
    t = 1000
    expect(tope.cabe()).toBe(true)
  })

  it('avisa UNA vez por cada vez que se llena, no con cada rechazo', () => {
    let t = 0
    const alLlenarse = vi.fn()
    const tope = crearTopePorVentana({ maximo: 1, ventanaMs: 1000, ahora: () => t, alLlenarse })
    tope.cabe()
    tope.cabe()
    tope.cabe()
    expect(alLlenarse).toHaveBeenCalledTimes(1)
    t = 1000 // se vacía, vuelve a caber…
    tope.cabe()
    tope.cabe() // …y se llena otra vez: otro aviso
    expect(alLlenarse).toHaveBeenCalledTimes(2)
  })
})

describe('enteroDelEntorno', () => {
  it('un entero positivo manda; cualquier otra cosa deja el valor por defecto', () => {
    expect(enteroDelEntorno('50', 120)).toBe(50)
    for (const malo of [undefined, '', 'abc', '0', '-3', '2.5']) {
      expect(enteroDelEntorno(malo, 120), String(malo)).toBe(120)
    }
  })
})
