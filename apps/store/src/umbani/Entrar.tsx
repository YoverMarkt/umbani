import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { RiArrowLeftSLine } from '@remixicon/react'
import { Aviso, Boton } from '../components/ui'
import { NO_COMPROBADO } from '../lib/turnstile'
import { canjearCodigoDeCorreo, ErrorDeLaApp, guardarToken, mensaje, pedirCodigoPorCorreo } from './api'
import { claveDelCaptcha, humanoListo, olvidarCaptcha, type Captcha } from './captcha'

// ═══════════════════════════════════════════════════════════════════════════
// LO COMÚN DE LAS APPS WEB: el marco, la cabecera y ENTRAR CON EL CORREO
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo usan la app de clientes (`/u`) y la de repartidores (`/r`). Entrar es
// igual para los dos: el correo lo prueba un código que llega a él, y la API
// decide después si ese correo es de un repartidor.
//
// ⚠️ Desde el 2026-10-06 las apps NO entran por WhatsApp (decisión del dueño).
// Esa puerta sigue en el servidor, en espera, pero aquí no se usa.

/**
 * Un campo de texto de las apps. ⚠️ 16 px como mínimo: con menos, el iPhone
 * agranda la pantalla al tocarlo y no la devuelve (lo aprendió Buscar).
 */
export const CAMPO = 'superficie w-full rounded-2xl border-2 borde-tema px-4 py-3.5 text-[16px] font-semibold outline-none '
  + 'focus:border-(--tinta) placeholder:font-normal placeholder:texto-tenue'

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

// ── Entrar con el correo ───────────────────────────────────────────────────
// Dos pasos: el correo, y el código de 6 números que llega a él. Sin
// contraseñas. En el servidor de PRUEBAS no se mandan correos: el código
// vuelve en la respuesta y se enseña aquí (en producción eso no existe).
// Con el captcha encendido, cada petición lleva su ficha (`./captcha`).

export function Entrar({ explicacion, onVolver, onDentro, titulo = 'Entra con tu correo' }: {
  explicacion?: ReactNode
  onVolver?: () => void
  onDentro: () => void
  titulo?: string
}) {
  const [paso, setPaso] = useState<'correo' | 'codigo'>('correo')
  const [correo, setCorreo] = useState('')
  const [codigo, setCodigo] = useState('')
  const [dePruebas, setDePruebas] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // El captcha: su sitio está fuera de los dos pasos para que «Mandarme otro
  // código» también tenga ficha.
  const [comprobando, setComprobando] = useState(false)
  const lugarDelCaptcha = useRef<HTMLDivElement>(null)
  const captcha = useRef<Captcha>({})

  useEffect(() => {
    const actual = captcha.current
    humanoListo(actual, lugarDelCaptcha.current).catch(() => { /* se reintenta al pedir el código */ })
    return () => olvidarCaptcha(actual)
  }, [])

  /** La ficha para esta petición: `undefined` si el servidor no pide captcha. */
  const fichaDePersona = async (): Promise<string | undefined> => {
    if (!await claveDelCaptcha(captcha.current)) return undefined
    setComprobando(true)
    try {
      const humano = await humanoListo(captcha.current, lugarDelCaptcha.current)
      return humano ? await humano.obtener() : undefined
    } catch {
      olvidarCaptcha(captcha.current)
      throw new Error(NO_COMPROBADO)
    } finally {
      setComprobando(false)
    }
  }

  const pedirCodigo = async (evento?: FormEvent) => {
    evento?.preventDefault()
    setError(null)
    setOcupado(true)
    try {
      const r = await pedirCodigoPorCorreo(correo.trim(), await fichaDePersona())
      setDePruebas(r.codigoDePruebas ?? null)
      setCodigo('')
      setPaso('codigo')
    } catch (e) {
      // El servidor pide un captcha que esta pantalla no conocía (se encendió
      // después de abrirla): el próximo intento lee la clave y lo monta.
      if (e instanceof ErrorDeLaApp && e.falta === 'turnstile') olvidarCaptcha(captcha.current)
      setError(mensaje(e))
    } finally {
      setOcupado(false)
    }
  }

  const entrar = async (evento: FormEvent) => {
    evento.preventDefault()
    setError(null)
    setOcupado(true)
    try {
      guardarToken((await canjearCodigoDeCorreo(correo.trim(), codigo)).token)
      onDentro()
    } catch (e) {
      setError(mensaje(e))
      setCodigo('')
      setOcupado(false)
    }
  }

  return (
    <Marco>
      <Cabecera
        titulo={titulo}
        onVolver={paso === 'codigo' ? () => { setPaso('correo'); setError(null) } : onVolver}
      />
      {error && <div className="mb-4"><Aviso tono="alerta" titulo="No pudimos seguir">{error}</Aviso></div>}

      {paso === 'correo'
        ? (
          <form onSubmit={evento => void pedirCodigo(evento)} className="space-y-4">
            {explicacion && <p className="texto-cuerpo text-[15px]">{explicacion}</p>}
            <p className="texto-cuerpo text-[15px]">Te mandamos un código a tu correo y entras. Sin contraseñas.</p>
            <label className="block">
              <span className="mb-1.5 block text-[14px] font-bold">Tu correo</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                value={correo}
                onChange={evento => setCorreo(evento.target.value)}
                placeholder="nombre@correo.com"
                className={CAMPO}
              />
            </label>
            <Boton type="submit" disabled={ocupado || !correo.includes('@')}>
              {comprobando ? 'Comprobando…' : ocupado ? 'Enviando…' : 'Enviarme el código'}
            </Boton>
          </form>
        )
        : (
          <form onSubmit={evento => void entrar(evento)} className="space-y-4">
            <p className="texto-cuerpo text-[15px]">
              Escribe el código de 6 números que mandamos a <b>{correo.trim()}</b>. Si no lo ves, mira en spam.
            </p>
            {dePruebas && (
              // El código en el TÍTULO: es lo que se busca con la vista, y el
              // cuerpo del aviso va en gris pequeño (2026-10-07, revisado en
              // el staging).
              <Aviso titulo={<>Tu código de pruebas: <span className="tracking-[0.12em]">{dePruebas}</span></>}>
                Este servidor no manda correos: el código sale aquí.
              </Aviso>
            )}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Código de 6 números"
              maxLength={6}
              value={codigo}
              onChange={evento => setCodigo(evento.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className={`${CAMPO} text-center text-[28px] font-extrabold tracking-[0.3em]`}
            />
            <Boton type="submit" disabled={ocupado || codigo.length !== 6}>{ocupado ? 'Entrando…' : 'Entrar'}</Boton>
            <Boton variante="linea" onClick={() => void pedirCodigo()} disabled={ocupado}>Mandarme otro código</Boton>
          </form>
        )}
      {/* Casi siempre vacío: el captcha solo se deja ver cuando Cloudflare duda. */}
      <div ref={lugarDelCaptcha} className="mt-4 flex justify-center" />
    </Marco>
  )
}
