import type { Dispatch, SetStateAction } from 'react'
import { RiAddLine } from '@remixicon/react'
import { Contador, LISTA, ROTULO } from './ui'
import { money } from '../lib/format'
import { foto } from '../lib/imagen'
import type { Recommendation } from '../lib/types'

/**
 * «Agrega algo más» en la ficha de un producto: los adicionales agrupados por
 * la sección que puso el dueño («Agrega bebidas», «También te puede gustar»).
 *
 * Vivía dentro de `ProductSheet.tsx` hasta el 2026-10-08 (ningún archivo pasa
 * de 1.000 líneas). Lo que se marca aquí NO entra al carrito todavía: se suma
 * al botón de la ficha y viaja con el plato (ver los avisos de abajo).
 */
export function AdicionalesDeLaFicha({
  agrupadas, adicionales, setAdicionales, seArmaElAdicional, onAgregarSuelto, puedePedir,
}: {
  agrupadas: { section: string; items: Recommendation[] }[]
  adicionales: Record<string, number>
  setAdicionales: Dispatch<SetStateAction<Record<string, number>>>
  seArmaElAdicional: (productId: string) => boolean
  onAgregarSuelto: (productId: string) => void
  puedePedir: boolean
}) {
  return (
    <>
      {agrupadas.map(({ section, items }) => (
        <section key={section}>
          <h3 className={ROTULO}>
            <span className="min-w-0 truncate">{section}</span>
          </h3>
          <div className={LISTA}>
            {items.map((reco) => {
              const llevadas = adicionales[reco.productId] || 0
              const hayQueArmarlo = seArmaElAdicional(reco.productId)
              return (
                <div
                  key={reco.productId}
                  className="flex items-center gap-3 px-4 py-3.5"
                >
                  {reco.imageUrl && (
                    <img
                      src={foto(reco.imageUrl, 'miniatura') || undefined}
                      alt=""
                      loading="lazy"
                      className="size-12 shrink-0 rounded-xl object-cover"
                    />
                  )}
                  {/* ⚠️ El precio va DEBAJO del nombre, no en su propia
                      columna. Con las tres cosas en fila —nombre, precio y
                      control— el contador se comía el ancho y los nombres
                      salían cortados: «Pan de Ajo …», «Nachos Sup…». Se vio
                      en producción en cuanto el contador sustituyó al `+`.
                      Debajo, el nombre se lleva todo el ancho que sobra y
                      el precio se sigue leyendo igual de bien. */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-bold tracking-tight">
                      {reco.name}
                    </span>
                    {reco.description && (
                      <span className="block truncate text-[12.5px] texto-cuerpo">
                        {reco.description}
                      </span>
                    )}
                    <span className="mt-0.5 block text-[14px] font-bold tabular-nums">
                      {money(reco.price)}
                    </span>
                  </span>
                  {/* ⚠️ El mismo `+` de la carta: acento con su glow y el icono
                      `RiAddLine`, no `bg-marca text-white` con el CARÁCTER «+».
                      Con el carácter, lo que el flex centra es la caja de
                      línea y la cruz queda alta dentro del círculo; y con el
                      blanco forzado, sobre el lima no se ve. Las dos cosas ya
                      se corrigieron en la rejilla de la portada. */}
                  {/* ⚠️ Lo que se marca aquí NO entra al carrito todavía:
                      se suma al botón de abajo y viaja con el plato. Cuando
                      entraba solo, el pie enseñaba DOS cuentas —«ya en tu
                      pedido» y «este plato»— y el cliente no sabía cuál iba
                      a pagar. Una ficha, una cuenta, un botón.

                      El `+` se vuelve contador en cuanto hay uno marcado:
                      acusa el toque y deja corregir sin salir de aquí.

                      ⚠️ Un adicional que hay que ARMAR (variantes, un grupo
                      obligatorio, por partes) no se puede contar aquí: no
                      entra de un toque porque la base lo rechazaría. Ese
                      conserva el `+` y abre su propia ficha. */}
                  {llevadas > 0
                    ? (
                        <Contador
                          valor={llevadas}
                          minimo={0}
                          onCambiar={valor => setAdicionales(previos => ({
                            ...previos,
                            [reco.productId]: valor,
                          }))}
                        />
                      )
                    : (
                        <button
                          type="button"
                          onClick={() => (hayQueArmarlo
                            ? onAgregarSuelto(reco.productId)
                            : setAdicionales(previos => ({ ...previos, [reco.productId]: 1 })))}
                          disabled={!puedePedir}
                          aria-label={`Agregar ${reco.name}`}
                          className="acento flex size-11 shrink-0 items-center justify-center rounded-full shadow-acento transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
                        >
                          <RiAddLine size={20} />
                        </button>
                      )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </>
  )
}
