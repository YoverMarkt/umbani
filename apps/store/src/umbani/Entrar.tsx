import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RiArrowLeftSLine, RiWhatsappLine } from '@remixicon/react'
import { Aviso, Boton } from '../components/ui'
import { ErrorDeLaApp, guardarToken, mensaje, pedirCodigo, verificarCodigo } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// LO COMÚN DE LAS APPS WEB: el marco, la cabecera y ENTRAR CON WHATSAPP
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo usan la app de clientes (`/u`) y la de repartidores (`/r`). Entrar es
// igual para los dos: el teléfono lo prueba WhatsApp, y la API decide después
// si ese teléfono es un repartidor.
//
// ⚠️ Es la forma de entrar de las PRUEBAS. La app Flutter no tiene por qué
// usarla: el dueño quiere Google, Apple o teléfono (ver `docs/apps/`).

/** El marco de todas las pantallas: el fondo y el ancho de un teléfono. */
export function Marco({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto min-h-svh max-w-md px-4 pt-[calc(env(safe-area-inset-top)+16px)] pb-[calc(env(safe-area-inset-bottom)+24px)]">
      {children}
    </main>
  )
}

export function Cabecera({ titulo, onVolver }: { titulo: string; onVolver?: () => void }) {
  return (
    <header className="mb-5 flex items-center gap-2">
      {onVolver && (
        <button type="button" onClick={onVolver} aria-label="Volver" className="superficie -ml-1 flex size-11 items-center justify-center rounded-full shadow-tarjeta">
          <RiArrowLeftSLine size={24} />
        </button>
      )}
      <h1 className="text-[24px] font-extrabold tracking-tight">{titulo}</h1>
    </header>
  )
}

// ── Entrar con WhatsApp ──────────────────────────────────────────────────────
// El cliente MANDA el código a Umbani: recibir no le cuesta a Umbani, y el
// teléfono queda probado por WhatsApp. Mientras tanto se pregunta cada 2,5 s.

export function Entrar({ explicacion, onVolver, onDentro, titulo = 'Entra con WhatsApp' }: {
  explicacion?: ReactNode
  onVolver?: () => void
  onDentro: () => void
  titulo?: string
}) {
  const [codigo, setCodigo] = useState<{ codigo: string; enlace: string } | null>(null)
  const [estado, setEstado] = useState<'inicio' | 'pidiendo' | 'esperando' | 'vencido'>('inicio')
  const [error, setError] = useState<string | null>(null)
  const reloj = useRef<number | null>(null)

  const parar = () => { if (reloj.current) window.clearInterval(reloj.current); reloj.current = null }
  useEffect(() => parar, [])

  const pedir = async () => {
    setError(null)
    setEstado('pidiendo')
    try {
      const nuevo = await pedirCodigo()
      setCodigo(nuevo)
      setEstado('esperando')
      parar()
      reloj.current = window.setInterval(async () => {
        try {
          const r = await verificarCodigo(nuevo.codigo)
          if (r.token) { parar(); guardarToken(r.token); onDentro() }
        } catch (e) {
          parar()
          if (e instanceof ErrorDeLaApp && e.status === 410) setEstado('vencido')
          else { setError(mensaje(e)); setEstado('inicio') }
        }
      }, 2500)
    } catch (e) {
      setError(mensaje(e))
      setEstado('inicio')
    }
  }

  return (
    <Marco>
      <Cabecera titulo={titulo} onVolver={onVolver ? () => { parar(); onVolver() } : undefined} />
      {error && <div className="mb-4"><Aviso tono="alerta" titulo="No pudimos seguir">{error}</Aviso></div>}
      {explicacion && <p className="texto-cuerpo mb-4 text-[15px]">{explicacion}</p>}

      {estado === 'esperando' && codigo
        ? (
          <div className="space-y-4">
            <div className="superficie rounded-(--radius-tarjeta) px-4 py-6 text-center shadow-tarjeta">
              <p className="texto-cuerpo text-[13px] font-bold tracking-[0.08em] uppercase">Tu código</p>
              <p className="mt-1 text-[40px] font-extrabold tracking-[0.12em]">{codigo.codigo}</p>
            </div>
            <a href={codigo.enlace} className="tinta flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-4 text-[15px] font-bold shadow-alzada">
              <RiWhatsappLine size={20} /> Abrir WhatsApp y enviarlo
            </a>
            <p className="texto-cuerpo text-center text-[14px]">Esperando tu mensaje… Vuelve aquí después de enviarlo.</p>
          </div>
        )
        : (
          <div className="space-y-3">
            {estado === 'vencido' && <Aviso tono="alerta" titulo="El código venció">Pide otro: solo dura unos minutos.</Aviso>}
            <p className="texto-cuerpo text-[15px]">Te damos un código, lo envías a Umbani por WhatsApp y entras. Sin contraseñas.</p>
            <Boton onClick={() => void pedir()} disabled={estado === 'pidiendo'}>
              {estado === 'pidiendo' ? 'Preparando tu código…' : estado === 'vencido' ? 'Pedir otro código' : 'Pedir mi código'}
            </Boton>
          </div>
        )}
    </Marco>
  )
}
