import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  RiArrowDownSLine, RiHistoryLine, RiMapPin2Line, RiStore2Line,
} from '@remixicon/react'
import { Aviso, Boton, EstadoVacio, LISTA, ROTULO } from '../components/ui'
import { InstalarApp } from '../components/InstalarApp'
import { CAMPO, Entrar, Marco, Cabecera } from './Entrar'
import { COMO_VA } from '../lib/como-va'
import { money, rangoDeEspera } from '../lib/format'
import {
  abrirLocal, ciudadAqui, ciudadGuardada, ciudades as listaDeCiudades, ErrorDeLaApp, guardarCiudad,
  mensaje, menuDeLaCiudad, misPedidos, ponerMiTelefono, salir, tokenDeLaApp,
  type CategoriaDelMenu, type Ciudad, type LocalDelMenu, type PedidoDeLaApp,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════
// UMBANI, LA APP WEB DE CLIENTES (2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// El mismo recorrido que la app Flutter, pantalla por pantalla
// (`docs/apps/APP-CLIENTE.md`):
//   ubicación → inicio de SU ciudad → un local (su tienda, la mini app de
//   siempre) → pagar → seguir el pedido · y «Mis pedidos» de todos los locales.
//
// Se mira sin iniciar sesión, como en las grandes: la sesión se pide al entrar
// a un local, que es cuando hace falta (la tienda necesita saber quién compra).
// Sin router, como la tienda: un estado y cuatro pantallas.

type Pantalla = 'ubicacion' | 'inicio' | 'entrar' | 'telefono' | 'pedidos'


export default function UmbaniApp() {
  const [ciudad, setCiudad] = useState<Ciudad | null>(() => ciudadGuardada())
  const [pantalla, setPantalla] = useState<Pantalla>(() => (ciudadGuardada() ? 'inicio' : 'ubicacion'))
  // El local al que iba cuando se le pidió entrar: al entrar, se abre solo.
  const [pendiente, setPendiente] = useState<LocalDelMenu | null>(null)
  const [abriendo, setAbriendo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const entrarAlLocal = useCallback(async (local: LocalDelMenu) => {
    setError(null)
    if (!tokenDeLaApp()) {
      setPendiente(local)
      setPantalla('entrar')
      return
    }
    setAbriendo(local.nombre)
    try {
      window.location.assign(await abrirLocal(local.slug))
    } catch (e) {
      setAbriendo(null)
      // La sesión venció mientras miraba: se le pide entrar otra vez.
      if (e instanceof ErrorDeLaApp && e.status === 401) {
        setPendiente(local)
        setPantalla('entrar')
        return
      }
      // Entró con correo y aún no dijo a qué número le llaman: se le pregunta
      // una vez, y sigue al local que eligió.
      if (e instanceof ErrorDeLaApp && e.falta === 'telefono') {
        setPendiente(local)
        setPantalla('telefono')
        return
      }
      setError(mensaje(e))
    }
  }, [])

  const alElegirCiudad = (elegida: Ciudad) => {
    setCiudad(elegida)
    void guardarCiudad(elegida)
    setPantalla('inicio')
  }

  if (abriendo) {
    return (
      <Marco>
        <EstadoVacio icono={<RiStore2Line size={28} />} titulo={`Abriendo ${abriendo}…`}>
          Un momento.
        </EstadoVacio>
      </Marco>
    )
  }

  if (pantalla === 'ubicacion' || !ciudad) {
    return <Ubicacion onElegida={alElegirCiudad} puedeVolver={Boolean(ciudad)} onVolver={() => setPantalla('inicio')} />
  }

  if (pantalla === 'entrar') {
    return (
      <Entrar
        explicacion={pendiente ? <>Para pedir en <b>{pendiente.nombre}</b> necesitamos saber quién eres.</> : null}
        onVolver={() => { setPendiente(null); setPantalla('inicio') }}
        onDentro={() => {
          void guardarCiudad(ciudad)
          if (pendiente) void entrarAlLocal(pendiente)
          else setPantalla('pedidos')
          setPendiente(null)
        }}
      />
    )
  }

  if (pantalla === 'telefono') {
    return (
      <TuNumero
        local={pendiente?.nombre ?? null}
        onVolver={() => { setPendiente(null); setPantalla('inicio') }}
        onListo={() => {
          if (pendiente) void entrarAlLocal(pendiente)
          else setPantalla('inicio')
          setPendiente(null)
        }}
      />
    )
  }

  if (pantalla === 'pedidos') {
    return (
      <Pedidos
        onVolver={() => setPantalla('inicio')}
        onEntrar={() => setPantalla('entrar')}
        onAbrir={slug => void entrarAlLocal({ slug, nombre: 'tu pedido', tipo: null, minutos: null, abierto: null, conCarta: null, cartaDesde: null })}
      />
    )
  }

  return (
    <Inicio
      ciudad={ciudad}
      error={error}
      onCambiarCiudad={() => setPantalla('ubicacion')}
      onPedidos={() => setPantalla('pedidos')}
      onLocal={local => void entrarAlLocal(local)}
    />
  )
}


// ── El número de la cuenta ───────────────────────────────────────────────────
// Quien entra con correo dice UNA vez a qué número le llama el repartidor. Es
// suyo en exclusiva: de él cuelgan sus pedidos (`PUT /api/v1/yo/telefono`).

function TuNumero({ local, onVolver, onListo }: { local: string | null; onVolver: () => void; onListo: () => void }) {
  const [telefono, setTelefono] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const guardar = async (evento: FormEvent) => {
    evento.preventDefault()
    setError(null)
    setGuardando(true)
    try {
      await ponerMiTelefono(telefono)
      onListo()
    } catch (e) {
      setError(mensaje(e))
      setGuardando(false)
    }
  }

  return (
    <Marco>
      <Cabecera titulo="Tu número" onVolver={onVolver} />
      {error && <div className="mb-4"><Aviso tono="alerta" titulo="No pudimos guardarlo">{error}</Aviso></div>}
      <form onSubmit={evento => void guardar(evento)} className="space-y-4">
        <p className="texto-cuerpo text-[15px]">
          Es al que te llama el repartidor{local ? <> cuando lleve tu pedido de <b>{local}</b></> : null}. Te lo
          pedimos una sola vez.
        </p>
        <label className="block">
          <span className="mb-1.5 block text-[14px] font-bold">Tu celular</span>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={telefono}
            onChange={evento => setTelefono(evento.target.value)}
            placeholder="0991234567"
            className={CAMPO}
          />
        </label>
        <Boton type="submit" disabled={guardando || telefono.replace(/\D/g, '').length < 9}>
          {guardando ? 'Guardando…' : 'Guardar y seguir'}
        </Boton>
      </form>
    </Marco>
  )
}

// ── 1. ¿Dónde estás? ─────────────────────────────────────────────────────────
// Primero el GPS, como las grandes: no se pregunta, se enseña lo de donde
// está. Sin permiso, la lista. Fuera de toda ciudad, se dice — y Umbani lo
// anota para decidir dónde abrir la siguiente.

function Ubicacion({ onElegida, puedeVolver, onVolver }: {
  onElegida: (ciudad: Ciudad) => void
  puedeVolver: boolean
  onVolver: () => void
}) {
  const [estado, setEstado] = useState<'inicio' | 'buscando' | 'fuera' | 'lista'>('inicio')
  const [cercana, setCercana] = useState<{ nombre: string; km: number } | null>(null)
  const [lista, setLista] = useState<Ciudad[]>([])
  const [error, setError] = useState<string | null>(null)

  const verLista = async () => {
    setError(null)
    try {
      setLista(await listaDeCiudades())
      setEstado('lista')
    } catch (e) {
      setError(mensaje(e))
    }
  }

  const usarGps = () => {
    setError(null)
    if (!('geolocation' in navigator)) { void verLista(); return }
    setEstado('buscando')
    navigator.geolocation.getCurrentPosition(async posicion => {
      try {
        const r = await ciudadAqui(posicion.coords.latitude, posicion.coords.longitude)
        if (r.ciudad) { onElegida(r.ciudad); return }
        setCercana(r.cercana ?? null)
        setEstado('fuera')
      } catch (e) {
        setError(mensaje(e))
        setEstado('inicio')
      }
    }, () => {
      // Sin permiso o sin señal: que elija de la lista.
      void verLista()
    }, { enableHighAccuracy: false, timeout: 12_000, maximumAge: 5 * 60_000 })
  }

  return (
    <Marco>
      <Cabecera titulo="¿Dónde estás?" onVolver={puedeVolver ? onVolver : undefined} />
      {error && <div className="mb-4"><Aviso tono="alerta" titulo="No pudimos seguir">{error}</Aviso></div>}

      {estado === 'fuera' && (
        <div className="mb-5">
          <Aviso tono="alerta" titulo="Todavía no llegamos a tu zona">
            {cercana
              ? `La ciudad más cercana donde estamos es ${cercana.nombre}, a ${Math.round(cercana.km)} km. Ya anotamos que nos buscaste aquí.`
              : 'Ya anotamos que nos buscaste aquí.'}
          </Aviso>
        </div>
      )}

      {estado === 'lista'
        ? (
          <>
            <p className={ROTULO}>Elige tu ciudad</p>
            <ul className={LISTA}>
              {lista.map(c => (
                <li key={c.id}>
                  <button type="button" onClick={() => onElegida(c)} className="flex w-full items-center gap-3 px-4 py-4 text-left text-[16px] font-bold">
                    <RiMapPin2Line size={20} /> {c.nombre}
                  </button>
                </li>
              ))}
            </ul>
            {!lista.length && <p className="texto-cuerpo mt-3 text-sm">Todavía no atendemos en ninguna ciudad.</p>}
          </>
        )
        : (
          <div className="space-y-3">
            <p className="texto-cuerpo text-[15px]">
              Te enseñamos los locales que te pueden llevar el pedido donde estás.
            </p>
            <Boton onClick={usarGps} disabled={estado === 'buscando'}>
              {estado === 'buscando' ? 'Buscando dónde estás…' : 'Usar mi ubicación'}
            </Boton>
            <Boton variante="linea" onClick={() => void verLista()}>Elegir mi ciudad</Boton>
          </div>
        )}
    </Marco>
  )
}

// ── 2. El inicio de SU ciudad ────────────────────────────────────────────────

function Inicio({ ciudad, error, onCambiarCiudad, onPedidos, onLocal }: {
  ciudad: Ciudad
  error: string | null
  onCambiarCiudad: () => void
  onPedidos: () => void
  onLocal: (local: LocalDelMenu) => void
}) {
  const [categorias, setCategorias] = useState<CategoriaDelMenu[] | null>(null)
  const [elegida, setElegida] = useState<string | null>(null)
  const [fallo, setFallo] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    setCategorias(null)
    menuDeLaCiudad(ciudad.id)
      .then(c => { if (vivo) setCategorias(c) })
      .catch(e => { if (vivo) setFallo(mensaje(e)) })
    return () => { vivo = false }
  }, [ciudad.id])

  const visibles = (categorias || []).filter(c => !elegida || c.codigo === elegida)

  return (
    <Marco>
      <header className="mb-4 flex items-center justify-between gap-3">
        <button type="button" onClick={onCambiarCiudad} className="superficie flex items-center gap-1.5 rounded-full px-3.5 py-2.5 text-[15px] font-bold shadow-tarjeta">
          <RiMapPin2Line size={18} /> {ciudad.nombre} <RiArrowDownSLine size={18} />
        </button>
        <button type="button" onClick={onPedidos} className="superficie flex items-center gap-1.5 rounded-full px-3.5 py-2.5 text-[15px] font-bold shadow-tarjeta">
          <RiHistoryLine size={18} /> Mis pedidos
        </button>
      </header>

      <InstalarApp nombre="Umbani" />

      <h1 className="mb-4 text-[26px] leading-tight font-extrabold tracking-tight">¿Qué se te antoja hoy?</h1>
      {(error || fallo) && <div className="mb-4"><Aviso tono="alerta" titulo="No pudimos seguir">{error || fallo}</Aviso></div>}

      {categorias === null && !fallo && <p className="texto-cuerpo text-sm">Cargando los locales de {ciudad.nombre}…</p>}

      {categorias && !categorias.length && (
        <EstadoVacio icono={<RiStore2Line size={28} />} titulo={`Pronto llegamos a ${ciudad.nombre}`}>
          Todavía no hay locales pidiendo por Umbani aquí.
        </EstadoVacio>
      )}

      {categorias && categorias.length > 1 && (
        <div className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1">
          {[{ codigo: '', nombre: 'Todo', emoji: null }, ...categorias].map(c => {
            const activa = (elegida || '') === c.codigo
            return (
              <button key={c.codigo || 'todo'} type="button" onClick={() => setElegida(c.codigo || null)}
                className={`shrink-0 rounded-full px-4 py-2 text-[14px] font-bold ${activa ? 'tinta' : 'superficie shadow-tarjeta'}`}>
                {c.emoji ? `${c.emoji} ` : ''}{c.nombre}
              </button>
            )
          })}
        </div>
      )}

      <div className="space-y-6">
        {visibles.map(categoria => (
          <section key={categoria.codigo}>
            <p className={ROTULO}>{categoria.emoji ? `${categoria.emoji} ` : ''}{categoria.nombre}</p>
            <ul className={LISTA}>
              {categoria.locales.map(local => (
                <li key={local.slug}>
                  <button type="button" onClick={() => onLocal(local)} className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left">
                    <span>
                      <span className="block text-[16px] font-bold">{local.nombre}</span>
                      <span className="texto-cuerpo block text-[13px]">
                        {local.minutos ? rangoDeEspera(local.minutos) : local.tipo}
                        {local.conCarta === false && ' · Sin carta a esta hora'}
                      </span>
                    </span>
                    {local.abierto === false && (
                      <span className="rounded-full bg-black/5 px-2.5 py-1 text-[12px] font-bold texto-cuerpo">Cerrado</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Marco>
  )
}

// ── 4. Mis pedidos, de todos los locales ─────────────────────────────────────

function Pedidos({ onVolver, onEntrar, onAbrir }: {
  onVolver: () => void
  onEntrar: () => void
  onAbrir: (slug: string) => void
}) {
  const [pedidos, setPedidos] = useState<PedidoDeLaApp[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const conSesion = Boolean(tokenDeLaApp())

  useEffect(() => {
    if (!conSesion) return
    misPedidos().then(setPedidos).catch(e => setError(mensaje(e)))
  }, [conSesion])

  return (
    <Marco>
      <Cabecera titulo="Mis pedidos" onVolver={onVolver} />
      {!conSesion
        ? (
          <div className="space-y-3">
            <p className="texto-cuerpo text-[15px]">Entra con tu correo para ver tus pedidos de todos los locales.</p>
            <Boton onClick={onEntrar}>Entrar</Boton>
          </div>
        )
        : (
          <>
            {error && <Aviso tono="alerta" titulo="No pudimos cargar tus pedidos">{error}</Aviso>}
            {pedidos === null && !error && <p className="texto-cuerpo text-sm">Cargando…</p>}
            {pedidos && !pedidos.length && (
              <EstadoVacio icono={<RiHistoryLine size={28} />} titulo="Todavía no tienes pedidos">
                Cuando pidas en un local, lo verás aquí.
              </EstadoVacio>
            )}
            {pedidos && pedidos.length > 0 && (
              <ul className={LISTA}>
                {pedidos.map(p => {
                  const va = COMO_VA[p.status] || { texto: p.status, tono: 'bg-black/5 texto-cuerpo' }
                  return (
                    <li key={p.id}>
                      <button type="button" disabled={!p.local.slug} onClick={() => p.local.slug && onAbrir(p.local.slug)}
                        className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left">
                        <span>
                          <span className="block text-[16px] font-bold">{p.local.nombre || 'Local'}</span>
                          <span className="texto-cuerpo block text-[13px]">
                            {p.order_number ? `Pedido #${p.order_number} · ` : ''}{money(p.total)}
                          </span>
                        </span>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold ${va.tono}`}>{va.texto}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="mt-8">
              <Boton variante="linea" onClick={() => { salir(); onVolver() }}>Salir de mi cuenta</Boton>
            </div>
          </>
        )}
    </Marco>
  )
}
