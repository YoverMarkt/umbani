import type { Dispatch, SetStateAction } from 'react'
import { RiArrowLeftSLine } from '@remixicon/react'
import { foto } from '../lib/imagen'
import type { Business } from '../lib/types'

/**
 * El héroe de la tienda: la portada a sangre, el logo centrado y la vuelta.
 * Vivía dentro de `screens/FoodStore.tsx` hasta el 2026-10-08 (ningún archivo
 * pasa de 1.000 líneas). El JSX es el mismo, con las mismas variables como props.
 */
export function HeroeDeLaTienda({
  business, onVolver, portada, setPortadaRota,
}: {
  business: Business
  onVolver?: () => void
  portada: string | null
  setPortadaRota: Dispatch<SetStateAction<boolean>>
}) {
  return (
    <>
      {/* ══ EL HÉROE ════════════════════════════════════════════════════
          Portada a sangre y ALTA, con el logo del negocio centrado
          solapando el borde. Es la ficha de local de cualquier app de
          reparto grande, y sustituye al banner pequeño del 2026-08-25 por
          decisión del dueño (2026-08-26): aquel confirmaba dónde estabas,
          pero no daba ninguna sensación de marca.

          ⚠️ La foto llega al borde FÍSICO de la pantalla a propósito
          —`viewport-fit=cover` en el index.html—, así que el héroe pasa por
          debajo de la barra de estado y solo el botón de volver respeta el
          `safe-area`. Si el héroe respetara el inset quedaría una franja
          del color del fondo sobre la foto, que es justo lo que se ve roto.

          ⚠️ Sin portada NO se deja un hueco gris: va un degradado del color
          del negocio. Hoy Monster Pizza sí tiene una cargada. */}
      <header className="relative">
        {/* ⚠️ PROPORCIÓN, no alto fijo. Con `h-56` el marco cambiaba de forma
            según el ancho de la pantalla —1,75:1 en un iPhone y 2,29:1 en el
            `max-w-lg`—, así que la misma portada se recortaba distinto en cada
            teléfono. En 16:9 el marco es siempre el mismo, y coincide con el
            recorte que ya viene hecho de Cloudinary (`RECORTE` en
            `lib/imagen.ts`): la foto llega con la forma exacta del hueco, así
            que `object-cover` no tiene nada que recortar por su cuenta. */}
        {/* Sin redondeo abajo, por decisión del dueño (2026-08-26): la portada
            corta recta y el logo se apoya sobre esa línea. */}
        <div className="relative aspect-video overflow-hidden">
          {portada
            ? (
                <img
                  src={portada}
                  alt=""
                  // Si el dueño la borró de Cloudinary se retira sola y queda
                  // el degradado de marca: el icono de imagen rota no puede
                  // ser la primera impresión de la tienda.
                  onError={() => setPortadaRota(true)}
                  className="size-full object-cover"
                />
              )
            : (
                <div
                  className="size-full"
                  style={{
                    backgroundImage:
                      'linear-gradient(150deg, color-mix(in srgb, var(--acento) 90%, black) 0%,'
                      + ' color-mix(in srgb, var(--acento) 40%, black) 100%)',
                  }}
                />
              )}
          {/* El velo no es adorno: sin él, una portada clara deja el botón
              de volver invisible, y el negocio elige qué sube. */}
          <div className="absolute inset-0 bg-linear-to-b from-black/45 via-black/5 to-black/25" />

          {onVolver && (
            <button
              onClick={onVolver}
              aria-label="Volver"
              className="absolute left-4 top-[calc(env(safe-area-inset-top)+0.75rem)] flex size-10 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition active:scale-95"
            >
              <RiArrowLeftSLine size={20} />
            </button>
          )}
        </div>

        {/* El logo, CENTRADO y solapando el borde del héroe. El anillo es
            del color de la superficie, no blanco fijo, para que el recorte
            siga siendo limpio si algún día la superficie cambia. */}
        {/* ⚠️ `relative z-10`: sin contexto de apilado propio, el héroe —que es
            `relative`— se pinta ENCIMA y le come la mitad de arriba al logo.
            El margen negativo solapa, pero no decide quién va delante. */}
        <div className="relative z-10 -mt-12 flex justify-center">
          <div className="superficie size-24 rounded-full p-1 shadow-alzada">
            {business.logoUrl
              ? (
                  <img
                    src={foto(business.logoUrl, 'miniatura') || undefined}
                    alt=""
                    className="size-full rounded-full object-cover"
                  />
                )
              : (
                  <span className="marcador flex size-full items-center justify-center rounded-full text-[2rem] leading-none font-black opacity-40 select-none">
                    {business.name.trim().charAt(0).toUpperCase()}
                  </span>
                )}
          </div>
        </div>
      </header>
    </>
  )
}
