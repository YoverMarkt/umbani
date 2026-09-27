import { describe, expect, it } from 'vitest'
import { filasResueltas } from './errores-resueltos.mjs'

// Lo arreglado desaparece del registro; lo que se repitió con el arreglo ya
// desplegado, NO — no estaba arreglado (2026-09-27, idea del dueño).
describe('qué filas se retiran como resueltas', () => {
  const FILAS = [
    { id: 1, code: 'inbox_poll', last_seen_at: '2026-09-27T12:56:00Z' },
    { id: 2, code: 'inbox_poll', last_seen_at: '2026-09-28T09:00:00Z' },
    { id: 3, code: 'saldo_bajo', last_seen_at: '2026-09-27T10:00:00Z' },
  ]

  it('solo los códigos pedidos, y solo hasta la hora del arreglo', () => {
    const resueltas = filasResueltas(FILAS, ['inbox_poll'], '2026-09-27T15:00:00Z')
    expect(resueltas.map(f => f.id)).toEqual([1])
  })

  it('un código parecido no cuenta: se compara EXACTO', () => {
    expect(filasResueltas(FILAS, ['inbox'], '2026-12-31T00:00:00Z')).toEqual([])
  })

  it('una fecha rota no borra nada: revienta', () => {
    expect(() => filasResueltas(FILAS, ['inbox_poll'], 'ayer')).toThrow(/no es una fecha/)
  })
})
