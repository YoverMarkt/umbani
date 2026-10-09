import type { Dispatch, SetStateAction } from 'react'
import { RiAddLine } from '@remixicon/react'
import { Foto } from './ui'
import { money } from '../lib/format'
import type { Product } from '../lib/types'

// ── La tarjeta de la rejilla ──────────────────────────────────────────────
// Foto arriba a sangre y el `+` sobre ella. Se declara una vez porque la usan
// la carta y los resultados de búsqueda, y dos copias se desincronizan.
export function TarjetaDeProducto({
  producto, agregarAdicional, puedePedir, setElegido,
}: {
  producto: Product
  agregarAdicional: (productId: string) => void
  puedePedir: boolean
  setElegido: Dispatch<SetStateAction<Product | null>>
}) {
  return (
    <div
      className={`relative transition ${producto.available ? '' : 'opacity-55'}`}
    >
      {/* ⚠️ La foto y los textos NO van dentro de un botón, y el `+` tampoco:
          serían botones anidados, que es HTML inválido. Lo que abre la ficha
          es una CAPA sobre la tarjeta entera (`absolute inset-0`), declarada
          ANTES que el `+` para que el `+` quede encima sin pelear por
          z-index. Así se puede tocar la tarjeta completa y el `+` sigue
          haciendo lo suyo. */}

      {/* ⚠️ SIN caja blanca ni sombra (2026-09-06, referencia del dueño). La
          foto es un bloque redondeado sobre el gris de la app y el texto va
          suelto debajo, sobre el blanco de la sección. Es al revés que antes
          —tarjeta blanca sobre gris— y hace que en la rejilla mande la
          fotografía y no el contorno de la caja.

          ⚠️ El `overflow-hidden` va SOLO en la foto, no en la tarjeta: el `+`
          sobresale de ella a propósito y aquí lo recortaría por la mitad. */}
      <div className="fondo-app relative overflow-hidden rounded-(--radius-tarjeta)">
        <Foto url={producto.imageUrl} alto="h-36" uso="tarjeta" nombre={producto.name} />
        {!producto.available && (
          <span className="absolute top-2 left-2 max-w-[90%] truncate rounded-full bg-black/70 px-2 py-0.5 text-[10.5px] font-bold text-white">
            {producto.availableHint || 'Agotado'}
          </span>
        )}

        {/* El `+` agrega de un toque lo que no exige elegir nada. Si el
            producto trae obligatorios, `agregarAdicional` abre su ficha en vez
            de meterlo a ciegas: la base lo rechazaría igual.

            ⚠️ VA DENTRO DE LA FOTO, y se probó lo contrario el 2026-09-06.
            Montado a caballo del borde —como parecía en la referencia— dejaba
            un hueco de 32 px antes del nombre para que el círculo no se lo
            comiera, y la rejilla quedaba desarmada. Es la misma cicatriz que
            ya estaba escrita aquí: «Doble Cheese Burguer» quedaba debajo del
            círculo. En la referencia el círculo también está dentro; lo que de
            verdad cambia es su COLOR.

            ⚠️ Círculo BLANCO, no del color de marca. Sobre una foto clara lo
            que lo separa del fondo es la sombra, no el color, así que la lleva
            fuerte. El icono va en tinta para leerse sobre el blanco.

            ⚠️ El icono `Plus`, no el CARÁCTER «+»: con el carácter, lo que el
            flex centra es la caja de línea y la cruz queda alta en el círculo. */}
        {producto.available && (
          <button
            onClick={() => agregarAdicional(producto.id)}
            disabled={!puedePedir}
            aria-label={`Agregar ${producto.name}`}
            className="superficie absolute right-2.5 bottom-2.5 z-10 flex size-11 items-center justify-center rounded-full text-(--texto) ring-1 ring-black/5 shadow-flotante transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
          >
            <RiAddLine size={24} />
          </button>
        )}
      </div>

      {/* ⚠️ El orden es NOMBRE → PRECIO → DESCRIPCIÓN (2026-09-06). Antes la
          descripción se colaba entre el nombre y el precio, y en una rejilla
          de dos columnas eso deja el dato que decide la compra —cuánto
          cuesta— al final de un bloque de texto gris. La referencia del dueño
          lo pone justo bajo el nombre, que es donde el ojo ya está. */}
      <div className="pt-2.5 pr-1">
        <p className="text-[15.5px] leading-snug font-bold tracking-tight line-clamp-2">
          {producto.name}
        </p>
        {/* El precio en TINTA, no en el naranja de la referencia: allí ese
            color señala una rebaja, y aquí no hay descuentos que señalar
            —`Product` no lleva precio promocional—. Naranja permanente sería
            color sin significado, y además `--ascua` da 3,49:1 sobre blanco,
            por debajo del 4,5 que exige AA para texto. */}
        <p className="mt-1 text-[15px] leading-none font-semibold tabular-nums">
          {producto.hasVariants && (
            <span className="text-[11px] font-semibold texto-tenue">desde </span>
          )}
          {money(producto.priceFrom)}
        </p>
        {producto.description && (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug texto-cuerpo">
            {producto.description}
          </p>
        )}
      </div>

      <button
        onClick={() => setElegido(producto)}
        aria-label={`Ver ${producto.name}`}
        className="absolute inset-0 rounded-(--radius-tarjeta)"
      />

    </div>
  )
}
