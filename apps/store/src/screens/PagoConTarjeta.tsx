import { useEffect, useRef, useState } from 'react'
import {
  RiBankCardLine,
  RiCheckLine,
  RiCloseLine,
  RiLoader4Line,
  RiTimeLine,
} from '@remixicon/react'
import { getCardPayment, irAPayPhone, startCardPayment } from '../lib/api'
import { money } from '../lib/format'
import type { CobroConTarjeta } from '../lib/types'

// ── EL PAGO CON TARJETA ────────────────────────────────────────────────────
//
// Dos momentos, una pantalla:
//
//   · ANTES de pagar: el pedido ya existe y falta el cobro. Un botón lleva a
//     la página segura de PayPhone, donde el cliente escribe su tarjeta. Los
//     datos de la tarjeta NUNCA pasan por Umbani.
//   · AL VOLVER de PayPhone (`?pago=<pedido>`): «Confirmando tu pago…», y
//     se pregunta al servidor en qué quedó.
//
// ⚠️ Esta pantalla NO decide nada. Lo que enseña sale de preguntarle al
// servidor, que a su vez lo supo por PayPhone y lo cuadró al centavo en la
// base. La URL de vuelta solo dice QUÉ pedido mirar, nunca si se pagó.
//
// ⚠️ Y si el cliente cierra esto a mitad, no pasa nada: el servidor confirma
// el cobro por su cuenta (`procesarPendientes`). Por eso el texto de
// «tarda más de lo normal» le dice que puede cerrar tranquilo.
//
// Va en su propio trozo (`lazy`): solo lo descarga quien paga con tarjeta, y
// el paquete principal de la tienda está al límite de su presupuesto.

type Fase =
  | 'cargando' | 'listo' | 'abriendo' | 'confirmando'
  | 'pagado' | 'fallido' | 'devuelto' | 'cancelado' | 'lento'

const CADA_MS = 2_000
/** Unos 90 segundos preguntando; después se le dice que puede cerrar. */
const INTENTOS = 45

const NO_SE_COBRO = new Set(['rechazado', 'caducado', 'no_confirmado'])
const SE_DEVUELVE = new Set(['por_devolver', 'devuelto', 'devolucion_manual'])
const MUERTO = new Set(['cancelado', 'rechazado', 'expirado'])

/** Lo que dice el servidor, traducido a lo que ve el cliente. */
function faseDe(cobro: CobroConTarjeta): Fase | null {
  if (cobro.pagado) return 'pagado'
  if (cobro.estado && SE_DEVUELVE.has(cobro.estado)) return 'devuelto'
  if (cobro.estadoDelPedido && MUERTO.has(cobro.estadoDelPedido)) return 'cancelado'
  if (cobro.estado && NO_SE_COBRO.has(cobro.estado)) return 'fallido'
  return null
}

export default function PagoConTarjeta({
  slug, nombreDelLocal, orderId, numero, total, volviendo, pruebas, onVolver,
}: {
  slug: string
  nombreDelLocal: string
  orderId: string
  numero?: number | string | null
  total?: number | string | null
  /** `true` = viene de la página de PayPhone y hay que confirmar. */
  volviendo: boolean
  /** PayPhone en modo pruebas: no se cobra dinero real. */
  pruebas: boolean
  onVolver: () => void
}) {
  const [fase, setFase] = useState<Fase>(volviendo ? 'confirmando' : 'cargando')
  const [error, setError] = useState<string | null>(null)
  const [cobro, setCobro] = useState<CobroConTarjeta | null>(null)
  const vivo = useRef(true)

  useEffect(() => {
    vivo.current = true
    return () => { vivo.current = false }
  }, [])

  // ── Preguntar en qué quedó ──────────────────────────────────────────────
  useEffect(() => {
    if (fase !== 'confirmando' && fase !== 'cargando') return
    let intento = 0
    let reloj: number | undefined
    const mirar = async () => {
      intento += 1
      try {
        const actual = await getCardPayment(slug, orderId)
        if (!vivo.current) return
        setCobro(actual)
        const final = faseDe(actual)
        if (final) return setFase(final)
        // Antes de pagar basta con UNA mirada: si no hay nada resuelto, toca
        // el botón. Al volver de PayPhone se insiste, que el cobro llega.
        if (fase === 'cargando') return setFase('listo')
      } catch {
        if (fase === 'cargando') return setFase('listo')
      }
      if (intento >= INTENTOS) return setFase('lento')
      reloj = window.setTimeout(mirar, CADA_MS)
    }
    void mirar()
    return () => window.clearTimeout(reloj)
  }, [fase, slug, orderId])

  const pagar = async () => {
    setError(null)
    setFase('abriendo')
    try {
      const { url } = await startCardPayment(slug, orderId)
      // ⚠️ En ESTA pestaña y no en otra: al volver tiene que caer donde vive
      // la sesión del cliente. Y con el origen como `Referer`, o PayPhone
      // responde «NO AUTORIZADO» (ver `irAPayPhone`).
      irAPayPhone(url)
    } catch (fallo) {
      if (!vivo.current) return
      setError(fallo instanceof Error ? fallo.message : 'No pudimos abrir el pago')
      setFase('listo')
    }
  }

  const importe = Number(total) || 0
  const n = numero ? ` #${numero}` : ''
  const tarjeta = cobro?.marca
    ? `${cobro.marca}${cobro.ultimos ? ` ···${cobro.ultimos}` : ''}`
    : null

  const icono = {
    pagado: { clase: 'acento shadow-acento-alto', nodo: <RiCheckLine size={34} /> },
    fallido: { clase: 'bg-red-500 text-white shadow-alzada', nodo: <RiCloseLine size={34} /> },
    cancelado: { clase: 'bg-red-500 text-white shadow-alzada', nodo: <RiCloseLine size={34} /> },
    devuelto: { clase: 'bg-amber-500 text-white shadow-alzada', nodo: <RiTimeLine size={32} /> },
    lento: { clase: 'bg-amber-500 text-white shadow-alzada', nodo: <RiTimeLine size={32} /> },
  }[fase as 'pagado'] || {
    clase: 'superficie texto-cuerpo shadow-tarjeta',
    nodo: fase === 'listo'
      ? <RiBankCardLine size={30} />
      : <RiLoader4Line size={30} className="animate-spin" />,
  }

  const titulo = {
    cargando: 'Un momento…',
    listo: 'Paga con tarjeta',
    abriendo: 'Abriendo el pago seguro…',
    confirmando: 'Confirmando tu pago…',
    pagado: '¡Pago recibido!',
    fallido: 'No se completó el pago',
    devuelto: 'Te devolvemos el pago',
    cancelado: 'Este pedido ya no se puede pagar',
    lento: 'Seguimos confirmando tu pago',
  }[fase]

  const texto = {
    cargando: '',
    listo: `Tu pedido${n} está guardado. Pagas en la página segura de PayPhone: tus datos de tarjeta no pasan por Umbani.`,
    abriendo: 'Te llevamos a PayPhone.',
    confirmando: 'Esto tarda unos segundos. No cierres esta pantalla.',
    pagado: `${nombreDelLocal} ya tiene tu pedido${n}. Lo sigues en «Mis pedidos»: ahí ves cuándo lo empieza a preparar.`,
    fallido: 'No se te cobró nada. Puedes intentarlo otra vez, con la misma tarjeta o con otra.',
    devuelto: 'Hubo un problema con este cobro y el dinero vuelve a tu tarjeta. Según tu banco, puede tardar unos días.',
    cancelado: 'Si todavía lo quieres, vuelve al menú y pídelo de nuevo.',
    lento: 'Puedes cerrar esta pantalla tranquilo: si el pago se aprueba, el local recibe tu pedido; si no, no se te cobra nada.',
  }[fase]

  const puedePagar = fase === 'listo' || fase === 'fallido'

  return (
    <div className="animar-entrada mx-auto flex min-h-[100dvh] max-w-md flex-col px-5 pt-[calc(env(safe-area-inset-top)+2.5rem)] pb-10">
      {/* ⚠️ En pruebas se dice ARRIBA y en grande: nadie puede salir de aquí
          creyendo que pagó de verdad, ni un local creer que cobró. */}
      {pruebas && (
        <p className="mb-6 rounded-xl bg-amber-500 px-3 py-2 text-center text-[12px] font-extrabold tracking-[0.06em] text-white uppercase">
          Pagos de prueba · no se cobra dinero real
        </p>
      )}

      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <div className={`flex size-18 items-center justify-center rounded-full ${icono.clase}`}>
          {icono.nodo}
        </div>
        <h1 className="titulo-xl mt-5">{titulo}</h1>
        {texto && (
          <p className="mt-2.5 text-[14.5px] leading-relaxed texto-cuerpo">{texto}</p>
        )}
        {fase === 'pagado' && tarjeta && (
          <p className="mt-2 text-[13px] font-semibold texto-cuerpo">{tarjeta}</p>
        )}
        {error && (
          <p className="mt-3 text-[13.5px] font-semibold text-red-600" role="alert">{error}</p>
        )}
      </div>

      <div className="mt-8 space-y-1">
        {puedePagar && (
          <button
            onClick={pagar}
            className="tinta flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-4 text-[15.5px] font-bold tracking-tight shadow-alzada transition active:scale-[0.98] active:opacity-90"
          >
            <RiBankCardLine size={18} />
            {fase === 'fallido' ? 'Intentar de nuevo' : `Pagar ${importe > 0 ? money(importe) : ''} con tarjeta`.replace('  ', ' ')}
          </button>
        )}
        {fase !== 'abriendo' && fase !== 'confirmando' && (
          <button
            onClick={onVolver}
            className="w-full py-3.5 text-[14px] font-semibold texto-cuerpo transition active:scale-[0.98]"
          >
            Volver al menú
          </button>
        )}
      </div>
    </div>
  )
}
