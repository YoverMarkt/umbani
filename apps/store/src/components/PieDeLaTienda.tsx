import type { Dispatch, RefObject, SetStateAction } from 'react'
import {
  RiHome5Fill, RiHome5Line, RiSearchFill, RiSearchLine,
  RiShoppingCart2Fill, RiShoppingCart2Line, RiUser3Fill, RiUser3Line,
} from '@remixicon/react'
import { money } from '../lib/format'

/**
 * El pie de la tienda: «Ver pedido» encima de la barra de navegación, nunca tapándola.
 * Vivía dentro de `screens/FoodStore.tsx` hasta el 2026-10-08 (ningún archivo
 * pasa de 1.000 líneas). El JSX es el mismo, con las mismas variables como props.
 */
export function PieDeLaTienda({
  buscando, carritoAbierto, enfocarAntes, setBuscando, setCarritoAbierto, setEnCuenta, total, unidades,
}: {
  buscando: boolean
  carritoAbierto: boolean
  enfocarAntes: RefObject<HTMLInputElement | null>
  setBuscando: Dispatch<SetStateAction<boolean>>
  setCarritoAbierto: Dispatch<SetStateAction<boolean>>
  setEnCuenta: Dispatch<SetStateAction<boolean>>
  total: number
  unidades: number
}) {
  return (
    <>
      {/* ══ EL PIE: «Ver pedido» ENCIMA de la barra, no tapándola ═══════
          ⚠️ Esto era un fallo, no una decisión. La barra del carrito estaba
          `fixed bottom-0 z-50` y la de navegación `fixed bottom-0 z-40`: con
          una sola cosa en el carrito, «Ver pedido» se pintaba ENCIMA y hacía
          desaparecer Inicio · Buscar · Carrito · Cuenta. El cliente añadía un
          producto y perdía el menú de la app.

          Ahora las dos viven en el MISMO contenedor fijo, apiladas, así que
          el carrito se apoya sobre la barra sin números mágicos: nada de
          calcular a mano el alto de la navegación, que se desincroniza en
          cuanto alguien le cambia un padding. */}
      <div className="fixed inset-x-0 bottom-0 z-40">
        {unidades > 0 && (
          <div className="mx-auto max-w-lg px-4 pb-2">
            <button
              onClick={() => setCarritoAbierto(true)}
              className="tinta flex w-full items-center justify-between rounded-[1.75rem] px-5 py-4 shadow-flotante transition active:scale-[0.99]"
            >
              <span className="flex items-center gap-2.5 text-[15px] font-bold tracking-tight">
                <span className="acento flex size-7 items-center justify-center rounded-full text-[12px] font-extrabold tabular-nums">
                  {unidades}
                </span>
                Ver pedido
              </span>
              <span className="flex items-center gap-2 text-[19px] font-extrabold tracking-tight tabular-nums">
                {money(total)}
                <RiShoppingCart2Line size={18} />
              </span>
            </button>
          </div>
        )}

        {/* ⚠️ La barra activa RELLENA el icono, y esto es lo que separa una
            app de una plantilla. Con todo en línea, las cuatro pestañas pesan
            igual y ninguna dice dónde estás; el relleno lo dice sin leer, que
            es como funcionan las barras de las apps grandes.

            Se pasó de lucide a Remix el 2026-08-27 precisamente por esto:
            lucide es SOLO línea —no tiene rellenos—, así que este estado no
            se podía dibujar. Y de paso deja de ser el set por defecto de las
            herramientas de IA, que era la queja del dueño. */}
        <nav className="superficie border-t borde-tema">
          <div className="mx-auto flex max-w-lg items-stretch px-2 pt-1.5 pb-seguro">
            {([
              {
                id: 'inicio',
                icono: RiHome5Line,
                iconoActivo: RiHome5Fill,
                texto: 'Inicio',
                accion: () => {
                  setBuscando(false)
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                },
              },
              // Abre la pantalla de Buscar (2026-09-26). Antes abría una barra
              // DENTRO de la portada, con el héroe encima y los resultados
              // en el sitio de la carta: parecía la portada rota.
              {
                id: 'buscar',
                icono: RiSearchLine,
                iconoActivo: RiSearchFill,
                texto: 'Buscar',
                accion: () => {
                  // ⚠️ El foco, DENTRO del toque: iOS solo abre el teclado
                  // así. El campo de verdad está en la pantalla de Buscar, que
                  // se monta después; este campo escondido lo recibe ya y se
                  // lo pasa (ver `screens/Buscar.tsx`). De un campo a otro,
                  // iOS mantiene el teclado abierto.
                  enfocarAntes.current?.focus()
                  setBuscando(true)
                },
              },
              // ⚠️ Abre SIEMPRE, también con el carrito vacío. Estaba como
              // `unidades > 0 && setCarritoAbierto(true)`: con el carrito
              // vacío el botón no hacía absolutamente nada —ni abría, ni
              // avisaba— y se sentía roto. La hoja ya sabe decir «Tu carrito
              // está vacío», que es una respuesta; el silencio no lo es.
              {
                id: 'carrito',
                icono: RiShoppingCart2Line,
                iconoActivo: RiShoppingCart2Fill,
                texto: 'Carrito',
                accion: () => setCarritoAbierto(true),
                contador: unidades,
              },
              // ⚠️ Antes decía «Pedido» y abría el ÚLTIMO directamente. Servía
              // mientras solo hubiera uno del que preocuparse; quien ha pedido
              // cinco veces no tiene «un pedido», tiene un historial.
              {
                id: 'cuenta',
                icono: RiUser3Line,
                iconoActivo: RiUser3Fill,
                texto: 'Cuenta',
                accion: () => setEnCuenta(true),
              },
            ]).map(({ id, icono: Linea, iconoActivo: Relleno, texto, accion, contador }) => {
              // Cuál está activa. `inicio` lo está mientras no haya nada
              // abierto encima: es la pantalla en la que se está de verdad.
              const activa = id === 'buscar' ? buscando
                : id === 'carrito' ? carritoAbierto
                  : id === 'inicio' ? !buscando && !carritoAbierto
                    : false
              const Icono = activa ? Relleno : Linea
              return (
              <button
                key={id}
                onClick={accion}
                aria-current={activa ? 'page' : undefined}
                className={`relative flex flex-1 flex-col items-center gap-1 py-1.5 text-[10.5px] font-bold transition active:scale-95 ${
                  activa ? '' : 'texto-tenue'
                }`}
              >
                <span className="relative">
                  <Icono size={22} />
                  {Boolean(contador) && (
                    <span className="acento absolute -top-1.5 -right-2.5 flex min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] leading-4.5 font-extrabold tabular-nums">
                      {contador}
                    </span>
                  )}
                </span>
                {texto}
              </button>
              )
            })}
          </div>
        </nav>
      </div>
    </>
  )
}
