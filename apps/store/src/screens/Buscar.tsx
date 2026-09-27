import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiHistoryLine,
  RiSearchLine,
} from '@remixicon/react'
import { EstadoVacio, LISTA, ROTULO } from '../components/ui'
import { foto } from '../lib/imagen'
import {
  borrarRecientes,
  buscarEnLaCarta,
  guardarReciente,
  leerRecientes,
  type GrupoDeCarta,
} from '../lib/buscar'
import type { Product } from '../lib/types'

// ═══════════════════════════════════════════════════════════════════════════
// BUSCAR, EN SU PROPIA PANTALLA (2026-09-26)
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta hoy buscar era una barra que aparecía DENTRO de la portada: el héroe y
// el logo seguían arriba y los resultados sustituían a la carta debajo, así
// que parecía la portada rota. El dueño lo pidió así: «que buscar tenga su
// propia pantalla con el nuevo diseño de la mini app».
//
// ⚠️ Es una CAPA sobre la tienda, no una pantalla que la sustituya. La tienda
// sigue montada debajo con su scroll intacto: al volver, el cliente está donde
// estaba. Va por DEBAJO de la barra inferior (z-40) —el carrito y «Ver pedido»
// siguen a mano— y de las hojas (z-50), para que la ficha de un resultado se
// abra encima.
//
// ⚠️ Viaja en su propio trozo de JS (`lazy`): la tienda está a 0,1 kB de su
// presupuesto y quien no busca no tiene por qué descargarla. Se precarga en
// segundo plano al abrir la carta, así que al tocar «Buscar» ya está.

export default function Buscar({
  slug, negocio, grupos, tarjeta, onCerrar, onIrACategoria,
}: {
  slug: string
  negocio: string
  grupos: GrupoDeCarta[]
  /** La MISMA tarjeta de la carta: su `+`, su ficha y sus adicionales. */
  tarjeta: (producto: Product) => ReactNode
  onCerrar: () => void
  onIrACategoria: (id: string) => void
}) {
  const [consulta, setConsulta] = useState('')
  const [recientes, setRecientes] = useState<string[]>(() => leerRecientes(slug))
  const campo = useRef<HTMLInputElement>(null)

  // ⚠️ El teclado. iOS solo lo abre si el foco llega DENTRO del toque, y esta
  // pantalla se monta después. Por eso la tienda enfoca un campo escondido en
  // el mismo toque de «Buscar» (`enfocarAntes`) y aquí se le pasa el foco: de
  // un campo a otro, iOS mantiene el teclado abierto.
  useEffect(() => { campo.current?.focus() }, [])

  const hallazgos = useMemo(() => buscarEnLaCarta(grupos, consulta), [grupos, consulta])
  const total = hallazgos.reduce((suma, h) => suma + h.productos.length, 0)
  const escrita = consulta.trim()

  const recordar = () => {
    if (escrita && total) setRecientes(guardarReciente(slug, escrita))
  }

  return (
    <div className="fondo-app fixed inset-0 z-[35] overflow-y-auto overscroll-contain">
      <div className="mx-auto min-h-full max-w-lg pb-48">
        <header className="superficie sticky top-0 z-10 px-4 pt-seguro pb-3 shadow-tarjeta">
          <form
            role="search"
            onSubmit={(evento) => { evento.preventDefault(); recordar(); campo.current?.blur() }}
            className="flex items-center gap-2"
          >
            <button
              type="button"
              onClick={onCerrar}
              aria-label="Volver a la carta"
              className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-full transition active:scale-95 active:bg-black/5"
            >
              <RiArrowLeftSLine size={22} />
            </button>
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border-2 borde-tema px-3.5 py-2.5 focus-within:border-(--tinta)">
              <RiSearchLine size={18} className="shrink-0 texto-tenue" />
              {/* ⚠️ 16 px, no 15: por debajo de 16 Safari hace ZOOM al
                  enfocar el campo, y la página se queda ampliada. */}
              <input
                ref={campo}
                type="search"
                enterKeyHint="search"
                value={consulta}
                onChange={evento => setConsulta(evento.target.value.slice(0, 60))}
                placeholder={`Buscar en ${negocio}`}
                aria-label="Buscar en la carta"
                className="min-w-0 flex-1 bg-transparent text-[16px] font-semibold tracking-tight outline-none placeholder:font-medium placeholder:texto-tenue [&::-webkit-search-cancel-button]:hidden"
              />
              {consulta && (
                <button
                  type="button"
                  onClick={() => { setConsulta(''); campo.current?.focus() }}
                  aria-label="Borrar lo escrito"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-black/10 transition active:scale-90"
                >
                  <RiCloseLine size={14} />
                </button>
              )}
            </label>
          </form>
          {escrita && total > 0 && (
            <p className="caption mt-2.5 px-1 texto-tenue" aria-live="polite">
              {`${total} ${total === 1 ? 'resultado' : 'resultados'} para «${escrita}»`}
            </p>
          )}
        </header>

        {!escrita && (
          <div className="space-y-7 px-4 pt-5">
            {recientes.length > 0 && (
              <section>
                <h2 className={ROTULO}>
                  Buscaste antes
                  <button
                    type="button"
                    onClick={() => { borrarRecientes(slug); setRecientes([]) }}
                    className="text-[12px] font-bold tracking-normal normal-case texto-tenue transition active:scale-95"
                  >
                    Borrar
                  </button>
                </h2>
                <div className="flex flex-wrap gap-2">
                  {recientes.map(reciente => (
                    <button
                      key={reciente}
                      type="button"
                      onClick={() => setConsulta(reciente)}
                      className="superficie flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[14px] font-semibold shadow-tarjeta transition active:scale-95"
                    >
                      <RiHistoryLine size={15} className="texto-tenue" />
                      {reciente}
                    </button>
                  ))}
                </div>
              </section>
            )}
            <Secciones grupos={grupos} onIrACategoria={onIrACategoria} titulo="Explora la carta" />
          </div>
        )}

        {escrita && total > 0 && (
          // Tocar un resultado —abrirlo o sumarlo— es la señal de que la
          // búsqueda sirvió: ahí se recuerda, no con cada letra escrita.
          <div className="space-y-6 pt-4" onClickCapture={recordar}>
            {hallazgos.map(({ grupo, productos }) => (
              <section key={grupo.id} className="superficie px-4 pt-4 pb-5">
                <h2 className={ROTULO}>
                  {grupo.nombre}
                  <span className="font-bold tracking-normal texto-tenue">{productos.length}</span>
                </h2>
                <div className="grid grid-cols-2 gap-3">{productos.map(tarjeta)}</div>
              </section>
            ))}
          </div>
        )}

        {escrita && total === 0 && (
          <div className="space-y-7 px-4 pt-6">
            <EstadoVacio icono={<RiSearchLine size={28} />} titulo={`No encontramos «${escrita}»`}>
              Prueba con otra palabra, o mira lo que hay en la carta.
            </EstadoVacio>
            <Secciones grupos={grupos} onIrACategoria={onIrACategoria} titulo="La carta" />
          </div>
        )}
      </div>
    </div>
  )
}

/** Las secciones de la carta, para quien aún no sabe qué escribir. */
function Secciones({ grupos, onIrACategoria, titulo }: {
  grupos: GrupoDeCarta[]
  onIrACategoria: (id: string) => void
  titulo: string
}) {
  if (!grupos.length) return null
  return (
    <section>
      <h2 className={ROTULO}>{titulo}</h2>
      <div className={LISTA}>
        {grupos.map(grupo => {
          const imagen = foto(grupo.imagen, 'miniatura')
          return (
            <button
              key={grupo.id}
              type="button"
              onClick={() => onIrACategoria(grupo.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-black/5"
            >
              {imagen
                ? <img src={imagen} alt="" loading="lazy" className="size-11 shrink-0 rounded-xl object-cover" />
                : (
                    <span className="marcador flex size-11 shrink-0 items-center justify-center rounded-xl text-[15px] font-extrabold">
                      {grupo.nombre.slice(0, 1).toUpperCase()}
                    </span>
                  )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-bold tracking-tight">{grupo.nombre}</span>
                <span className="caption texto-tenue">
                  {grupo.productos.length} {grupo.productos.length === 1 ? 'producto' : 'productos'}
                </span>
              </span>
              <RiArrowRightSLine size={20} className="shrink-0 texto-tenue" />
            </button>
          )
        })}
      </div>
    </section>
  )
}
