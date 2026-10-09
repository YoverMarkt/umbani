// ═══════════════════════════════════════════════════════════════════════════
// UN TOPE PARA TODA LA PLATAFORMA: COMO MUCHO N COSAS POR VENTANA (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// Los limitadores de `express-rate-limit` cuentan por IP o por sesión: frenan a
// UNO que insiste. No frenan a mil que piden una vez cada uno, que es como se
// ataca lo que cuesta dinero o reputación (mandar correos, por ejemplo). Para
// eso, una cuenta GLOBAL del proceso: pasado el tope, nadie más hasta que la
// ventana avance.
//
// ⚠️ Vive en memoria, y basta: Railway corre UNA réplica. Si algún día corren
// varias, cada una tendría su propio tope (el total sería N veces el número).
// ⚠️ Se vacía al reiniciar. Es un freno de emergencia, no una contabilidad.

export interface TopePorVentana {
  /** ¿Cabe una más? Si cabe, YA cuenta: no hay que apuntarla aparte. */
  cabe(): boolean
}

export function crearTopePorVentana({ maximo, ventanaMs, ahora = Date.now, alLlenarse }: {
  maximo: number
  ventanaMs: number
  ahora?: () => number
  /** Se llama UNA vez cada vez que se llena, no con cada rechazo. */
  alLlenarse?: () => void
}): TopePorVentana {
  const marcas: number[] = []
  let lleno = false
  return {
    cabe() {
      const t = ahora()
      while (marcas.length && marcas[0] <= t - ventanaMs) marcas.shift()
      if (marcas.length >= maximo) {
        if (!lleno) {
          lleno = true
          alLlenarse?.()
        }
        return false
      }
      lleno = false
      marcas.push(t)
      return true
    },
  }
}

/** Un entero positivo de una variable de entorno, o el valor por defecto. */
export function enteroDelEntorno(valor: string | undefined, porDefecto: number): number {
  const n = Number(valor)
  return Number.isInteger(n) && n > 0 ? n : porDefecto
}
