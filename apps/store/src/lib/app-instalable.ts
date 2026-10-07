import { useEffect, useState } from 'react'

// ═══════════════════════════════════════════════════════════════════════════
// LA APP INSTALABLE (PWA, 2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// `/u` y `/r` se instalan como una app más: icono en el teléfono y pantalla
// completa, sin la barra del navegador. El dueño lo pidió para probar las apps
// «directo», sin entrar por WhatsApp.
//
// Dos piezas:
//  · Registrar el service worker (`public/sw.js`, que el servidor sirve en
//    `/u/sw.js` y `/r/sw.js`).
//  · Saber si se puede OFRECER instalar. Android avisa con
//    `beforeinstallprompt`, y nuestro botón abre su ventana de instalar. El
//    iPhone no avisa: se instala a mano desde Compartir → «Agregar a inicio»,
//    así que se le dice cómo.

type AvisoDeInstalar = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// ⚠️ Se escucha AL CARGAR EL MÓDULO, no al montar la pantalla: Chrome lanza el
// aviso una sola vez, y puede llegar antes de que React pinte nada.
let aviso: AvisoDeInstalar | null = null
const oyentes = new Set<() => void>()
const avisarCambio = () => oyentes.forEach(oyente => oyente())

// Sin DOM completo (al pintar en el servidor, o en una prueba) no hay nada
// que escuchar, y el módulo no puede romper al importarse.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', (evento) => {
    // Sin esto Chrome pone su propia barra abajo, encima de la pantalla.
    evento.preventDefault()
    aviso = evento as AvisoDeInstalar
    avisarCambio()
  })
  window.addEventListener('appinstalled', () => { aviso = null; avisarCambio() })
}

export function registrarLaApp(alcance: '/u' | '/r'): void {
  // En desarrollo Vite no sirve `/u/sw.js`: eso lo hace el servidor.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  // Después de cargar: el service worker no compite con la primera pantalla.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${alcance}/sw.js`, { scope: alcance }).catch(() => {
      // Sin service worker la app funciona entera; solo no se ofrece instalar.
    })
  })
}

/** iPhone o iPad, en un navegador que sabe «Agregar a inicio». */
export function esIphone(agente: string, puntosTactiles: number): boolean {
  // El iPad moderno se presenta como un Mac; lo delata la pantalla táctil.
  const ios = /iPhone|iPad|iPod/.test(agente) || (/Macintosh/.test(agente) && puntosTactiles > 1)
  // Los navegadores de dentro de otras apps (Instagram, Facebook) no tienen
  // «Agregar a inicio»: decirle cómo instalar sería mandarle a buscar algo
  // que no existe.
  return ios && !/FBAN|FBAV|Instagram|Line\//.test(agente)
}

export type QueOfrecer = 'nada' | 'boton' | 'iphone'

export function queOfrecer({ instalada, descartada, hayAviso, agente, puntosTactiles }: {
  instalada: boolean
  descartada: boolean
  hayAviso: boolean
  agente: string
  puntosTactiles: number
}): QueOfrecer {
  if (instalada || descartada) return 'nada'
  if (hayAviso) return 'boton'
  return esIphone(agente, puntosTactiles) ? 'iphone' : 'nada'
}

const DESCARTADA = 'umbani_instalar_descartada'
const DOS_SEMANAS_MS = 14 * 24 * 60 * 60 * 1000

/** «Ahora no» la esconde dos semanas, no para siempre. */
const descartadaHace = (): boolean => {
  try {
    const cuando = Number(localStorage.getItem(DESCARTADA))
    return cuando > 0 && Date.now() - cuando < DOS_SEMANAS_MS
  } catch {
    return false
  }
}

const yaInstalada = (): boolean => (
  window.matchMedia?.('(display-mode: standalone)')?.matches === true
  // El iPhone no entiende `display-mode`: tiene su propia marca.
  || (navigator as Navigator & { standalone?: boolean }).standalone === true
)

export function useInstalar() {
  const [, repintar] = useState(0)
  const [descartada, setDescartada] = useState(descartadaHace)

  useEffect(() => {
    const oyente = () => repintar(n => n + 1)
    oyentes.add(oyente)
    return () => { oyentes.delete(oyente) }
  }, [])

  return {
    ofrecer: queOfrecer({
      instalada: yaInstalada(),
      descartada,
      hayAviso: Boolean(aviso),
      agente: navigator.userAgent,
      puntosTactiles: navigator.maxTouchPoints || 0,
    }),
    instalar: async () => {
      const actual = aviso
      if (!actual) return
      await actual.prompt()
      await actual.userChoice.catch(() => null)
      // Chrome no deja usar el mismo aviso dos veces.
      aviso = null
      avisarCambio()
    },
    descartar: () => {
      try {
        localStorage.setItem(DESCARTADA, String(Date.now()))
      } catch {
        // Sin almacenamiento se esconde igual; solo volverá en la próxima visita.
      }
      setDescartada(true)
    },
  }
}
