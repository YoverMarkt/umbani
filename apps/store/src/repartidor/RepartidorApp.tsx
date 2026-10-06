import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  RiCheckLine, RiEBikeLine, RiHistoryLine, RiMapPin2Line, RiMoneyDollarCircleLine, RiStore2Line, RiUser3Line,
} from '@remixicon/react'
import { Aviso, Boton, EstadoVacio, LISTA, ROTULO } from '../components/ui'
import { Cabecera, Entrar, Marco } from '../umbani/Entrar'
import { money } from '../lib/format'
import { ErrorDeLaApp, mensaje, salir, tokenDeLaApp } from '../umbani/api'
import {
  comoLlegar, entregado, liquidaciones as leerLiquidaciones, pedidos as leerPedidos, ponerDisponible, recogido,
  tomar, yo as leerYo, type Liquidacion, type PedidoDelRepartidor, type Yo,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════
// UMBANI REPARTIDORES, LA APP WEB (2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// El mismo recorrido que la app Flutter del motorizado, pantalla por pantalla
// (`docs/apps/APP-MOTORIZADO.md`):
//   entrar → disponible → tomar un pedido → recogerlo → entregarlo (con el
//   efectivo confirmado) · y «Mi semana» con sus liquidaciones.
//
// Las reglas las pone la base, no esta pantalla: qué pedidos le tocan, el
// tope de efectivo, que el local haya terminado de empacar. Aquí se pinta lo
// que la API dice y se repite su mensaje cuando dice que no.
//
// ⚠️ «Disponible» no lo exige la base para tomar: apagado, deja de ver
// pedidos NUEVOS, pero los que lleva siguen aquí hasta entregarlos — apagar no
// puede dejar una comida en la calle sin nadie que la marque.

type Pantalla = 'cargando' | 'entrar' | 'no-es' | 'inicio' | 'semana'

/** Los centavos de la API, dichos en dólares. Solo para enseñar: aquí no se suma nada. */
const dolares = (centavos: number | null | undefined) => money((centavos ?? 0) / 100)

export default function RepartidorApp() {
  const [pantalla, setPantalla] = useState<Pantalla>(() => (tokenDeLaApp() ? 'cargando' : 'entrar'))
  const [perfil, setPerfil] = useState<Yo | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 401 = la sesión venció; 403 = ese número no es (o dejó de ser) repartidor. */
  const alFallar = useCallback((e: unknown): string | null => {
    if (e instanceof ErrorDeLaApp && e.status === 401) { setPantalla('entrar'); return null }
    if (e instanceof ErrorDeLaApp && e.status === 403) { setPantalla('no-es'); return null }
    return mensaje(e)
  }, [])

  const cargarPerfil = useCallback(async () => {
    try {
      setPerfil(await leerYo())
      setError(null)
      setPantalla(p => (p === 'semana' ? p : 'inicio'))
    } catch (e) {
      setError(alFallar(e))
    }
  }, [alFallar])

  useEffect(() => { if (pantalla === 'cargando') void cargarPerfil() }, [pantalla, cargarPerfil])

  const otroNumero = () => { salir(); setPerfil(null); setPantalla('entrar') }

  if (pantalla === 'entrar') {
    return (
      <Entrar
        titulo="Entra como repartidor"
        explicacion="Con el WhatsApp con el que te registraron en Umbani."
        onDentro={() => setPantalla('cargando')}
      />
    )
  }

  if (pantalla === 'no-es') {
    return (
      <Marco>
        <EstadoVacio icono={<RiEBikeLine size={28} />} titulo="Este número no es de un repartidor">
          Pide a Umbani, o a tu local, que te registren con este WhatsApp. O entra con otro número.
        </EstadoVacio>
        <Boton variante="linea" onClick={otroNumero}>Entrar con otro número</Boton>
      </Marco>
    )
  }

  if (pantalla === 'cargando' || !perfil) {
    return (
      <Marco>
        {error
          ? (
            <div className="space-y-3 pt-8">
              <Aviso tono="alerta" titulo="No pudimos abrir tu cuenta">{error}</Aviso>
              <Boton onClick={() => { setError(null); void cargarPerfil() }}>Intentar de nuevo</Boton>
            </div>
          )
          : <EstadoVacio icono={<RiEBikeLine size={28} />} titulo="Abriendo tu cuenta…">Un momento.</EstadoVacio>}
      </Marco>
    )
  }

  if (pantalla === 'semana') {
    return <Semana perfil={perfil} onVolver={() => setPantalla('inicio')} alFallar={alFallar} />
  }

  return (
    <Inicio
      perfil={perfil}
      onPerfil={cargarPerfil}
      onSemana={() => setPantalla('semana')}
      onSalir={otroNumero}
      alFallar={alFallar}
    />
  )
}


// ── 1. Inicio: disponible, el efectivo, lo que lleva y lo que puede tomar ────

function Inicio({ perfil, onPerfil, onSemana, onSalir, alFallar }: {
  perfil: Yo
  onPerfil: () => Promise<void>
  onSemana: () => void
  onSalir: () => void
  alFallar: (e: unknown) => string | null
}) {
  const [lista, setLista] = useState<PedidoDelRepartidor[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cambiando, setCambiando] = useState(false)

  const cargar = useCallback(async () => {
    try {
      setLista(await leerPedidos())
      setError(null)
    } catch (e) {
      setError(alFallar(e))
    }
  }, [alFallar])

  const llevando = (lista ?? []).filter(p => p.mio)
  const libres = (lista ?? []).filter(p => !p.mio)
  // Se pregunta cada 15 s mientras esté disponible o lleve algo (lo que pide
  // la guía). Con la pantalla escondida no, y al volver a ella, enseguida.
  const vigilar = perfil.disponible || llevando.length > 0

  useEffect(() => { void cargar() }, [cargar])
  useEffect(() => {
    if (!vigilar) return
    const siSeVe = () => { if (document.visibilityState === 'visible') void cargar() }
    const reloj = window.setInterval(siSeVe, 15_000)
    document.addEventListener('visibilitychange', siSeVe)
    return () => { window.clearInterval(reloj); document.removeEventListener('visibilitychange', siSeVe) }
  }, [vigilar, cargar])

  // Tras cada paso, la lista y el efectivo: el servidor es quien los sabe.
  const despues = async () => { await Promise.all([cargar(), onPerfil()]) }

  const cambiarDisponible = async () => {
    setCambiando(true)
    setError(null)
    try {
      await ponerDisponible(!perfil.disponible)
      await despues()
    } catch (e) {
      setError(alFallar(e))
    } finally {
      setCambiando(false)
    }
  }

  // La de una cooperativa cobra y liquida como la de Umbani (2026-10-06).
  const liquidaConUmbani = perfil.flota !== 'local'
  const encima = perfil.semana?.efectivoEncimaCents ?? 0
  const tope = perfil.topeEfectivoCents
  const lleno = tope > 0 && encima >= tope

  return (
    <Marco>
      <header className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* El primer nombre, como las grandes: «Carlos (Umbani)» se cortaba en «Carlos (Um…». */}
          <h1 className="truncate text-[24px] font-extrabold tracking-tight">Hola, {perfil.nombre.trim().split(/\s+/)[0]}</h1>
          <p className="texto-cuerpo text-[14px]">
            {perfil.flota === 'local' ? 'Repartes para tu local' : `Repartes con ${perfil.cooperativa || 'Umbani'}`}{perfil.vehiculo ? ` · ${perfil.vehiculo}` : ''}
          </p>
        </div>
        <button type="button" onClick={onSemana} className="superficie flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2.5 text-[15px] font-bold shadow-tarjeta">
          <RiHistoryLine size={18} /> Mi semana
        </button>
      </header>

      {error && <div className="mb-4"><Aviso tono="alerta" titulo="No pudimos seguir">{error}</Aviso></div>}

      <section className={`mb-4 rounded-(--radius-tarjeta) px-4 py-4 shadow-tarjeta ${perfil.disponible ? 'acento' : 'superficie'}`}>
        <p className="text-[17px] font-extrabold">{perfil.disponible ? 'Estás disponible' : 'No estás recibiendo pedidos'}</p>
        <p className="texto-cuerpo mb-3 text-[14px]">
          {perfil.disponible ? 'Te enseñamos los pedidos que los locales ya aceptaron.' : 'Ponte disponible para ver los pedidos nuevos.'}
        </p>
        <Boton variante={perfil.disponible ? 'linea' : 'principal'} disabled={cambiando} onClick={() => void cambiarDisponible()}>
          {cambiando ? 'Un momento…' : perfil.disponible ? 'Dejar de recibir pedidos' : 'Empezar a recibir pedidos'}
        </Boton>
      </section>

      <section className="superficie mb-6 rounded-(--radius-tarjeta) px-4 py-4 shadow-tarjeta">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[15px] font-bold">Efectivo encima</p>
          <p className="text-[15px] font-extrabold">
            {dolares(encima)} <span className="texto-cuerpo font-semibold">de {dolares(tope)}</span>
          </p>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-black/5">
          <div className={`h-full rounded-full ${lleno ? 'bg-amber-500' : 'tinta'}`} style={{ width: `${tope > 0 ? Math.min(100, (encima / tope) * 100) : 0}%` }} />
        </div>
        <p className="texto-cuerpo mt-2 text-[13px]">
          {lleno
            ? (liquidaConUmbani ? 'Llegaste al tope: liquida con Umbani antes de tomar otro pedido en efectivo.' : 'Llegaste al tope: entrega algún pedido antes de tomar otro en efectivo.')
            : (liquidaConUmbani ? 'Lo liquidas el lunes con Umbani.' : 'Es de tu local: entrégaselo al volver.')}
        </p>
      </section>

      {llevando.length > 0 && (
        <section className="mb-6">
          <p className={ROTULO}>Llevando</p>
          <div className="space-y-3">
            {llevando.map(p => <PedidoMio key={p.id} pedido={p} onListo={despues} alFallar={alFallar} />)}
          </div>
        </section>
      )}

      <section className="mb-8">
        <p className={ROTULO}>Pedidos para tomar</p>
        {!perfil.disponible
          ? <p className="texto-cuerpo px-1 text-[14px]">Ponte disponible para verlos.</p>
          : lista === null
            ? <p className="texto-cuerpo px-1 text-[14px]">{error ? 'No pudimos traerlos.' : 'Buscando pedidos…'}</p>
            : libres.length === 0
              ? (
                <EstadoVacio icono={<RiEBikeLine size={28} />} titulo="Nada por ahora">
                  Cuando un local acepte un pedido, aparece aquí. Miramos cada 15 segundos.
                </EstadoVacio>
              )
              : (
                <div className="space-y-3">
                  {libres.map(p => <PedidoLibre key={p.id} pedido={p} liquidaConUmbani={liquidaConUmbani} onTomado={despues} alFallar={alFallar} />)}
                </div>
              )}
      </section>

      <Boton variante="linea" onClick={onSalir}>Salir</Boton>
    </Marco>
  )
}

const TARJETA = 'superficie rounded-(--radius-tarjeta) px-4 py-4 shadow-tarjeta'

function Lugar({ icono, texto, detalle }: { icono: ReactNode; texto: string | null; detalle?: string | null }) {
  if (!texto && !detalle) return null
  return (
    <p className="mt-1.5 flex gap-2 text-[14px]">
      <span className="texto-cuerpo mt-0.5 shrink-0">{icono}</span>
      <span className="min-w-0">
        {texto && <span className="block font-semibold">{texto}</span>}
        {detalle && <span className="texto-cuerpo block text-[13px]">{detalle}</span>}
      </span>
    </p>
  )
}

/** Si cobra en la puerta, cuánto; si no, que no cobre nada. */
function Cobro({ pedido }: { pedido: PedidoDelRepartidor }) {
  return pedido.cobrarEnEfectivo
    ? <Lugar icono={<RiMoneyDollarCircleLine size={18} />} texto={`Cobras ${dolares(pedido.totalCents)} en efectivo`} />
    : <Lugar icono={<RiCheckLine size={18} />} texto="Ya está pagado: no cobres nada" />
}

function PedidoLibre({ pedido, liquidaConUmbani, onTomado, alFallar }: {
  pedido: PedidoDelRepartidor
  liquidaConUmbani: boolean
  onTomado: () => Promise<void>
  alFallar: (e: unknown) => string | null
}) {
  const [tomando, setTomando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const alTomar = async () => {
    setTomando(true)
    setError(null)
    try {
      await tomar(pedido.id)
      await onTomado()
    } catch (e) {
      // «Otro llegó antes», el tope… lo dice el servidor; la tarjeta se va
      // sola en la siguiente vuelta si el pedido ya no es para él.
      setError(alFallar(e))
      setTomando(false)
    }
  }

  return (
    <article className={TARJETA}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-[16px] font-extrabold">{pedido.recoger.local || 'Local'}</p>
        {/* La carrera del repartidor del local es del local: no se le enseña como suya. */}
        {liquidaConUmbani && <p className="shrink-0 text-[15px] font-extrabold">Carrera {dolares(pedido.carreraCents)}</p>}
      </div>
      <Lugar icono={<RiStore2Line size={18} />} texto={pedido.recoger.direccion} />
      <Lugar icono={<RiMapPin2Line size={18} />} texto={pedido.entregar.direccion} />
      <Cobro pedido={pedido} />
      {error && <div className="mt-3"><Aviso tono="alerta">{error}</Aviso></div>}
      <div className="mt-3">
        <Boton disabled={tomando} onClick={() => void alTomar()}>{tomando ? 'Tomando…' : 'Tomar este pedido'}</Boton>
      </div>
    </article>
  )
}

function PedidoMio({ pedido, onListo, alFallar }: {
  pedido: PedidoDelRepartidor
  onListo: () => Promise<void>
  alFallar: (e: unknown) => string | null
}) {
  const [enviando, setEnviando] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enCamino = pedido.estado === 'en_camino'
  const mapa = comoLlegar(enCamino ? pedido.entregar : pedido.recoger)

  const avanzar = async () => {
    setEnviando(true)
    setError(null)
    try {
      await (enCamino ? entregado(pedido.id) : recogido(pedido.id))
      setConfirmando(false)
      await onListo()
    } catch (e) {
      // «El local aún no termina de empacar: falta …» viene del servidor tal cual.
      setError(alFallar(e))
    } finally {
      setEnviando(false)
    }
  }

  const notas = [pedido.entregar.referencia, pedido.entregar.notas].filter(Boolean).join(' · ')

  return (
    <article className={TARJETA}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-[16px] font-extrabold">
          {pedido.numero ? `#${pedido.numero} · ` : ''}{pedido.recoger.local || 'Local'}
        </p>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold ${enCamino ? 'acento' : 'bg-black/5 texto-cuerpo'}`}>
          {enCamino ? 'En camino' : 'Por recoger'}
        </span>
      </div>
      <p className="texto-cuerpo mt-0.5 text-[14px]">{enCamino ? 'Llévalo al cliente.' : 'Recógelo en el local.'}</p>
      {enCamino
        ? (
          <>
            <Lugar icono={<RiUser3Line size={18} />} texto={pedido.entregar.cliente} />
            <Lugar icono={<RiMapPin2Line size={18} />} texto={pedido.entregar.direccion} detalle={notas || null} />
          </>
        )
        : <Lugar icono={<RiStore2Line size={18} />} texto={pedido.recoger.direccion} />}
      <Cobro pedido={pedido} />

      {mapa && (
        <a href={mapa} target="_blank" rel="noreferrer"
          className="superficie borde-tema mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border-2 px-4 py-3.5 text-[15px] font-bold shadow-tarjeta">
          <RiMapPin2Line size={18} /> Cómo llegar
        </a>
      )}
      {error && <div className="mt-3"><Aviso tono="alerta">{error}</Aviso></div>}

      {confirmando
        ? (
          <div className="mt-3 space-y-2">
            <p className="text-[15px] font-bold">¿Cobraste {dolares(pedido.totalCents)} en efectivo?</p>
            <Boton disabled={enviando} onClick={() => void avanzar()}>
              {enviando ? 'Un momento…' : `Sí, cobré ${dolares(pedido.totalCents)}`}
            </Boton>
            <Boton variante="linea" disabled={enviando} onClick={() => setConfirmando(false)}>Todavía no</Boton>
          </div>
        )
        : (
          <div className="mt-3">
            {/* Con efectivo, «entregado» se confirma antes: es su dinero el que cuadra el lunes. */}
            <Boton disabled={enviando} onClick={() => (enCamino && pedido.cobrarEnEfectivo ? setConfirmando(true) : void avanzar())}>
              {enviando ? 'Un momento…' : enCamino ? 'Lo entregué' : 'Ya lo recogí'}
            </Boton>
          </div>
        )}
    </article>
  )
}


// ── 2. Mi semana y mis liquidaciones ─────────────────────────────────────────
// Los de Umbani liquidan cada lunes con Umbani; los del local cuadran con su
// local, así que a ellos no se les enseñan carreras ni liquidaciones.

const COMO_QUEDO: Record<string, string> = {
  por_pagar: 'Umbani te paga',
  pagada: 'Te pagamos',
  por_cobrar: 'Debes entregarlo',
  cobrada: 'Lo entregaste',
  en_cero: 'En cero',
  compensada: 'Pasó a la semana siguiente',
}

const dia = (fecha: string) => new Date(`${fecha}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })

function Fila({ nombre, valor, detalle }: { nombre: string; valor: string; detalle?: string }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3.5">
      <span className="min-w-0">
        <span className="block text-[15px] font-bold">{nombre}</span>
        {detalle && <span className="texto-cuerpo block text-[13px]">{detalle}</span>}
      </span>
      <span className="shrink-0 text-right text-[15px] font-extrabold">{valor}</span>
    </li>
  )
}

function Semana({ perfil, onVolver, alFallar }: {
  perfil: Yo
  onVolver: () => void
  alFallar: (e: unknown) => string | null
}) {
  const liquidaConUmbani = perfil.flota !== 'local'
  const [lista, setLista] = useState<Liquidacion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const s = perfil.semana

  useEffect(() => {
    if (!liquidaConUmbani) return
    leerLiquidaciones().then(setLista).catch(e => setError(alFallar(e)))
  }, [liquidaConUmbani, alFallar])

  const deAntes = s?.deAntesCents ?? 0

  return (
    <Marco>
      <Cabecera titulo="Mi semana" onVolver={onVolver} />
      <p className={ROTULO}>Desde el último cierre</p>
      <ul className={`${LISTA} mb-2`}>
        <Fila nombre="Pedidos entregados" valor={String(s?.pedidos ?? 0)} />
        {liquidaConUmbani && <Fila nombre="Tus carreras" valor={dolares(s?.carrerasCents)} />}
        {liquidaConUmbani && (s?.retenidasCents ?? 0) > 0 && (
          <Fila nombre="Carreras retenidas" valor={dolares(s?.retenidasCents)} detalle="De pedidos en los que se cayó la comida." />
        )}
        {liquidaConUmbani && <Fila nombre="Efectivo que cobraste" valor={dolares(s?.efectivoCobradoCents)} />}
        {liquidaConUmbani && deAntes !== 0 && (
          <Fila nombre={deAntes < 0 ? 'Debes de semanas anteriores' : 'Te debemos de semanas anteriores'} valor={dolares(Math.abs(deAntes))} />
        )}
      </ul>
      <p className="texto-cuerpo mb-6 px-1 text-[13px]">
        {liquidaConUmbani
          ? 'Cada lunes se cierra la semana: tus carreras menos el efectivo que tienes.'
          : 'Las carreras y el efectivo son de tu local: cuadras con ellos.'}
      </p>

      {liquidaConUmbani && (
        <>
          <p className={ROTULO}>Mis liquidaciones</p>
          {error && <div className="mb-3"><Aviso tono="alerta" titulo="No pudimos traerlas">{error}</Aviso></div>}
          {lista === null && !error && <p className="texto-cuerpo px-1 text-[14px]">Cargando…</p>}
          {lista?.length === 0 && <p className="texto-cuerpo px-1 text-[14px]">Todavía no se ha cerrado ninguna semana.</p>}
          {!!lista?.length && (
            <ul className={LISTA}>
              {lista.map(l => (
                <Fila
                  key={l.id}
                  nombre={`${dia(l.period_start)} – ${dia(l.period_end)}`}
                  detalle={`${l.orders_count} pedidos · carreras ${dolares(l.derecho_cents)} · efectivo ${dolares(l.en_mano_cents)} · ${COMO_QUEDO[l.status] ?? l.status}`}
                  valor={dolares(Math.abs(l.neto_cents))}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </Marco>
  )
}
