import type { Dispatch, SetStateAction } from 'react'
import { RiArrowDownSLine, RiEBikeLine, RiMapPin2Line, RiShoppingBag3Line } from '@remixicon/react'
import { money, rangoDeEspera } from '../lib/format'
import type { Business, Fulfillment } from '../lib/types'

/**
 * Cómo llega y a dónde: la tarjeta de servicio (entrega o retiro, tiempo, envío, mínimo) y la dirección.
 * Vivía dentro de `screens/FoodStore.tsx` hasta el 2026-10-08 (ningún archivo
 * pasa de 1.000 líneas). El JSX es el mismo, con las mismas variables como props.
 */
export function ServicioDeLaTienda({
  business, direccionActiva, entrega, setEnCuenta, setEntrega,
}: {
  business: Business
  direccionActiva: string | null
  entrega: Fulfillment
  setEnCuenta: Dispatch<SetStateAction<boolean>>
  setEntrega: Dispatch<SetStateAction<Fulfillment>>
}) {
  return (
    <>
      {/* ── Cómo llega, y a dónde ──────────────────────────────────────
          La tarjeta de servicio de la referencia, con NUESTROS datos
          reales: el tiempo sale de las dos columnas que pone el dueño, el
          envío de `delivery_fee` y el mínimo de `min_order_amount`.

          ⚠️ Aquí VIVE el selector Entrega/Retiro, que es la misma decisión
          que la del carrito, no dos. Ya estuvo a punto de perderse una vez
          al rediseñar la cabecera: sin él el cliente paga envío sin poder
          elegir retiro. La referencia lo dibuja igual —dos iconos de modo
          dentro de la píldora—, así que el sitio es el suyo.

          ⚠️ La dirección solo aparece en ENTREGA: en retiro la fila entera
          desaparece en vez de pedir un dato que nadie va a usar. */}
      <div className="px-4 pt-4">
        <div className="superficie rounded-[1.75rem] shadow-tarjeta">
          <div className="flex items-center gap-3 p-2.5">
            <div className="flex shrink-0 gap-1 rounded-full bg-black/5 p-1">
              {([
                { id: 'delivery' as const, icono: RiEBikeLine, etiqueta: 'Entrega a domicilio' },
                { id: 'pickup' as const, icono: RiShoppingBag3Line, etiqueta: 'Retiro en el local' },
              ]).map(({ id, icono: Icono, etiqueta }) => (
                <button
                  key={id}
                  onClick={() => setEntrega(id)}
                  aria-label={etiqueta}
                  aria-pressed={entrega === id}
                  className={`flex size-11 items-center justify-center rounded-full transition active:scale-95 ${
                    entrega === id ? 'acento shadow-acento' : 'texto-cuerpo'
                  }`}
                >
                  <Icono size={18} />
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1 pr-1">
              <p className="titulo-m">
                {entrega === 'delivery' ? 'Entrega' : 'Retiro'}
                {' · '}
                {rangoDeEspera(
                  business.prepTimeMinutes
                  + (entrega === 'delivery' ? business.deliveryExtraMinutes : 0),
                )}
              </p>
              <p className="caption mt-0.5 texto-cuerpo">
                {entrega === 'delivery'
                  ? `Envío ${business.deliveryFee > 0 ? money(business.deliveryFee) : 'gratis'}`
                  : 'Sin costo de envío'}
                {business.minOrderAmount > 0 && ` · Mínimo ${money(business.minOrderAmount)}`}
              </p>
            </div>
          </div>

          {entrega === 'delivery' && (
            <button
              onClick={() => setEnCuenta(true)}
              className="flex w-full items-center gap-2.5 border-t borde-tema px-4 py-3 text-left transition active:bg-black/5"
            >
              <RiMapPin2Line size={17} className="shrink-0 texto-cuerpo" />
              <span className="min-w-0 flex-1">
                <span className="caption block texto-tenue">Entregar en</span>
                <span className="block truncate text-[14px] font-bold tracking-tight">
                  {direccionActiva || 'Elige tu dirección'}
                </span>
              </span>
              <RiArrowDownSLine size={18} className="shrink-0 texto-tenue" />
            </button>
          )}
        </div>
      </div>
    </>
  )
}
