import { useRef, useState } from 'react'
import { RiBankLine, RiCheckLine, RiLoader4Line } from '@remixicon/react'
import { Aviso, Boton } from './ui'
import { uploadPaymentProof } from '../lib/api'

// ── EL COMPROBANTE SE SUBE AQUÍ (2026-10-09) ──────────────────────────────────
//
// Del 2026-08-12 a hoy se mandaba por el chat de WhatsApp: la captura quedaba
// en la galería, a un toque de la conversación donde había llegado el enlace.
// Desde que Umbani es SOLO APP ese chat no es el camino —el cliente llegó desde
// la app—, así que vuelve a subirse en la propia tienda.
//
// Detrás está la ruta de siempre (`POST /api/store/:slug/orders/:id/proof`):
// la imagen la guarda el servidor en privado, calcula su huella contra los
// duplicados y analiza el monto y la cuenta de destino. El pedido pasa a
// `pago_en_revision` y el dueño lo ve con su alarma, como antes.
//
// Viaja en su propio trozo: solo lo descarga quien paga por transferencia.

/** Lo que admite el servidor (`MEDIA_LIMITS.image`). */
const MAXIMO = 5 * 1024 * 1024

/**
 * Una CAPTURA de pantalla —lo normal— pesa poco; una FOTO del papel tomada con
 * la cámara puede pasar de 5 MB y el servidor la rechazaría. Solo esa se reduce
 * aquí, en el teléfono: hasta 2.000 px por lado y en JPEG, de sobra para leer
 * un comprobante (la huella contra duplicados del servidor no depende del
 * tamaño). Si el navegador no sabe abrirla —un HEIC fuera de Safari—, se sube
 * tal cual y el servidor dirá el límite.
 */
async function aptaParaSubir(archivo: File): Promise<File> {
  if (archivo.size <= MAXIMO * 0.9) return archivo
  try {
    const imagen = await createImageBitmap(archivo)
    const escala = Math.min(1, 2000 / Math.max(imagen.width, imagen.height))
    const lienzo = document.createElement('canvas')
    lienzo.width = Math.round(imagen.width * escala)
    lienzo.height = Math.round(imagen.height * escala)
    lienzo.getContext('2d')?.drawImage(imagen, 0, 0, lienzo.width, lienzo.height)
    imagen.close()
    const reducida = await new Promise<Blob | null>(listo => lienzo.toBlob(listo, 'image/jpeg', 0.85))
    return reducida ? new File([reducida], 'comprobante.jpg', { type: 'image/jpeg' }) : archivo
  } catch {
    return archivo
  }
}

export default function SubirComprobante({ slug, orderId }: { slug: string; orderId: string }) {
  const campo = useRef<HTMLInputElement>(null)
  const [estado, setEstado] = useState<'esperando' | 'subiendo' | 'subido'>('esperando')
  const [error, setError] = useState<string | null>(null)

  const alElegir = async (archivo: File | undefined) => {
    // Limpiar el campo deja volver a elegir LA MISMA foto tras un fallo: con el
    // valor puesto, el navegador no avisa de un cambio que no ve.
    if (campo.current) campo.current.value = ''
    if (!archivo) return
    setError(null)
    setEstado('subiendo')
    const fallo = await uploadPaymentProof(slug, orderId, await aptaParaSubir(archivo))
    if (fallo) {
      setError(fallo)
      setEstado('esperando')
      return
    }
    setEstado('subido')
  }

  if (estado === 'subido') {
    return (
      <section className="superficie mt-6 w-full rounded-(--radius-tarjeta) px-4 py-4 text-left shadow-tarjeta">
        <div className="flex items-start gap-3">
          <span className="acento flex size-10 shrink-0 items-center justify-center rounded-full shadow-acento">
            <RiCheckLine size={20} />
          </span>
          <div className="min-w-0">
            <p className="titulo-m">Recibimos tu comprobante</p>
            <p className="mt-1.5 text-[14px] leading-relaxed texto-cuerpo">
              El local lo está revisando. En cuanto lo apruebe empiezan a prepararlo, y lo ves en «Mis pedidos».
            </p>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="superficie mt-6 w-full rounded-(--radius-tarjeta) px-4 py-4 text-left shadow-tarjeta">
      <div className="flex items-start gap-3">
        <span className="acento flex size-10 shrink-0 items-center justify-center rounded-full shadow-acento">
          <RiBankLine size={19} />
        </span>
        <div className="min-w-0">
          <p className="titulo-m">Sube tu comprobante</p>
          {/* ⚠️ «a tu nombre» se dice POR DELANTE (2026-09-01): es la
              instrucción, no un reproche que aparezca al rechazarlo. */}
          <p className="mt-1.5 text-[14px] leading-relaxed texto-cuerpo">
            Transfiere desde tu banco, toma la captura y súbela aquí. Tiene que estar a tu nombre.
            En cuanto el local la revise, empiezan a prepararlo.
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <Aviso tono="alerta" titulo="No se pudo subir">{error}</Aviso>
        </div>
      )}

      {/* El campo de archivo de verdad, escondido: el botón de la tienda lo
          abre. `image/*` deja elegir de la galería o tomar la foto. */}
      <input
        ref={campo}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={evento => void alElegir(evento.target.files?.[0])}
      />
      <div className="mt-4">
        <Boton onClick={() => campo.current?.click()} disabled={estado === 'subiendo'}>
          {estado === 'subiendo'
            ? (
                <span className="flex items-center justify-center gap-2">
                  <RiLoader4Line size={18} className="animate-spin" />
                  Subiendo…
                </span>
              )
            : 'Subir la captura'}
        </Boton>
      </div>
    </section>
  )
}
