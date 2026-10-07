import { useState } from 'react'
import { RiCheckLine, RiErrorWarningLine, RiTimeLine } from '@remixicon/react'
import { Aviso, Boton, Contador, Hoja, ROTULO } from './ui'
import { money } from '../lib/format'
import { confirmarTodoBien, reportarProblema, type TipoDeReclamo } from '../lib/reclamos'
import type { TrackedOrder } from '../lib/types'

// ═══════════════════════════════════════════════════════════════════════════
// «¿LLEGÓ TODO BIEN?» (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedido del dueño: «algo para que el cliente diga todo está correcto con su
// pedido… en las grandes, cuando no me llega algo me dan dinero de la app».
// En cada pedido entregado de «Mis pedidos», durante 48 horas: «Todo bien» o
// «Algo salió mal» (faltó algo, vino mal, no llegó). Una vez por pedido.
//
// ⚠️ Lo que le corresponde lo calcula el SERVIDOR y lo decide Umbani al
// revisarlo: aquí no se suma nada ni se le promete una cifra. Va en su propio
// archivo porque solo lo usa «Mi cuenta», que viaja aparte de la tienda.

const TIPOS: { tipo: TipoDeReclamo; texto: string; detalle: string }[] = [
  { tipo: 'falta_producto', texto: 'Faltó algo', detalle: 'No llegó todo lo que pediste' },
  { tipo: 'vino_mal', texto: 'Algo vino mal', detalle: 'Llegó otra cosa, dañado o en mal estado' },
  { tipo: 'no_llego', texto: 'No llegó mi pedido', detalle: 'No recibiste nada' },
]

const mensaje = (e: unknown) => (e instanceof Error ? e.message : 'No pudimos enviarlo. Inténtalo de nuevo.')

export function LlegoTodoBien({ slug, pedido, onCambio }: {
  slug: string
  pedido: TrackedOrder
  /** Para volver a pedir la lista: el estado nuevo lo dice el servidor. */
  onCambio: () => void
}) {
  const [abierta, setAbierta] = useState(false)
  const [tipo, setTipo] = useState<TipoDeReclamo | null>(null)
  const [cantidades, setCantidades] = useState<Record<string, number>>({})
  const [nota, setNota] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const c = pedido.confirmacion
  if (!c) return null

  if (c.reclamo) {
    const r = c.reclamo
    const texto = r.estado === 'abierta'
      ? 'Nos contaste un problema: lo estamos revisando.'
      : r.estado === 'resuelta'
        ? (r.compensacionCents ? `Lo revisamos: Umbani te compensa ${money(r.compensacionCents / 100)}.` : 'Lo revisamos y quedó resuelto.')
        : 'Lo revisamos. Si tienes dudas, escríbenos.'
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[12.5px] font-semibold texto-cuerpo">
        <RiTimeLine size={15} className="shrink-0" /> {texto}
      </p>
    )
  }
  if (c.todoBien) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[12.5px] font-semibold texto-cuerpo">
        <RiCheckLine size={15} className="shrink-0" /> Nos dijiste que llegó todo bien.
      </p>
    )
  }
  if (!c.reclamableHasta) return null

  const lineas = (pedido.order_items || []).filter(l => l.id)
  const elegidas = Object.entries(cantidades).filter(([, n]) => n > 0)
  const listo = tipo === 'no_llego' || (tipo !== null && elegidas.length > 0)

  const cerrar = () => {
    setAbierta(false)
    setTipo(null)
    setCantidades({})
    setNota('')
    setError(null)
  }

  const todoBien = async () => {
    setError(null)
    setEnviando(true)
    try {
      await confirmarTodoBien(slug, pedido.id)
      onCambio()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setEnviando(false)
    }
  }

  const enviar = async () => {
    if (!tipo) return
    setError(null)
    setEnviando(true)
    try {
      await reportarProblema(slug, pedido.id, {
        tipo,
        lineas: tipo === 'no_llego' ? [] : elegidas.map(([item, cantidad]) => ({ item, cantidad })),
        nota: nota.trim(),
      })
      cerrar()
      onCambio()
    } catch (e) {
      setError(mensaje(e))
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="mt-3 border-t borde-tema pt-3">
      <p className="text-[13.5px] font-bold">¿Llegó todo bien?</p>
      {error && !abierta && <p className="mt-1 text-[12.5px] font-semibold text-amber-700">{error}</p>}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={enviando}
          onClick={() => void todoBien()}
          className="acento flex items-center justify-center gap-1.5 rounded-full px-3 py-2.5 text-[13.5px] font-bold transition active:scale-[0.98] disabled:opacity-50"
        >
          <RiCheckLine size={16} /> Sí, todo bien
        </button>
        <button
          type="button"
          disabled={enviando}
          onClick={() => setAbierta(true)}
          className="superficie flex items-center justify-center gap-1.5 rounded-full border-2 borde-tema px-3 py-2.5 text-[13.5px] font-bold transition active:scale-[0.98] disabled:opacity-50"
        >
          <RiErrorWarningLine size={16} /> Algo salió mal
        </button>
      </div>

      <Hoja abierta={abierta} onCerrar={cerrar} onAtras={tipo ? () => setTipo(null) : undefined} titulo="Cuéntanos qué pasó">
        <div className="space-y-4 p-4 pb-6">
          {!tipo
            ? (
              <>
                <p className="text-[14px] leading-relaxed texto-cuerpo">
                  Lo revisamos con el local y con quien lo llevó. Si fue un error nuestro, te compensamos.
                </p>
                <div className="space-y-2">
                  {TIPOS.map(t => (
                    <button
                      key={t.tipo}
                      type="button"
                      onClick={() => setTipo(t.tipo)}
                      className="superficie block w-full rounded-(--radius-tarjeta) px-4 py-3.5 text-left shadow-tarjeta transition active:scale-[0.99]"
                    >
                      <span className="block text-[15px] font-bold">{t.texto}</span>
                      <span className="block text-[12.5px] texto-cuerpo">{t.detalle}</span>
                    </button>
                  ))}
                </div>
              </>
            )
            : (
              <>
                {tipo === 'no_llego'
                  ? (
                    <Aviso tono="alerta" icono={<RiErrorWarningLine size={18} />} titulo="No recibiste tu pedido">
                      Lo revisamos con quien lo llevó y te escribimos.
                    </Aviso>
                  )
                  : (
                    <section>
                      <h3 className={ROTULO}><span>{tipo === 'falta_producto' ? '¿Qué faltó?' : '¿Qué vino mal?'}</span></h3>
                      <ul className="space-y-2">
                        {lineas.map(l => (
                          <li key={l.id} className="superficie flex items-center justify-between gap-3 rounded-(--radius-tarjeta) px-4 py-3 shadow-tarjeta">
                            <span className="min-w-0">
                              <span className="block text-[14px] font-bold">{l.product_name}</span>
                              {l.variant_name && <span className="block text-[12.5px] texto-cuerpo">{l.variant_name}</span>}
                              <span className="block text-[12px] texto-tenue">Pediste {l.quantity}</span>
                            </span>
                            <Contador
                              valor={cantidades[l.id!] ?? 0}
                              onCambiar={n => setCantidades({ ...cantidades, [l.id!]: n })}
                              minimo={0}
                              maximo={l.quantity}
                            />
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                <section>
                  <h3 className={ROTULO}>
                    <span>Cuéntanos más</span>
                    <span className="shrink-0 text-[11px] font-semibold tracking-normal normal-case texto-tenue">Opcional</span>
                  </h3>
                  <textarea
                    value={nota}
                    onChange={e => setNota(e.target.value.slice(0, 500))}
                    rows={3}
                    placeholder="Ej: faltó la cola, la pizza llegó fría…"
                    className="superficie w-full resize-none rounded-(--radius-tarjeta) border-2 borde-tema px-4 py-3 text-[14px] shadow-tarjeta outline-none focus:border-(--tinta) placeholder:texto-tenue"
                  />
                </section>
                {error && <Aviso tono="alerta" titulo="No pudimos enviarlo">{error}</Aviso>}
                <Boton onClick={() => void enviar()} disabled={!listo || enviando}>
                  {enviando ? 'Enviando…' : 'Enviar'}
                </Boton>
              </>
            )}
        </div>
      </Hoja>
    </div>
  )
}
