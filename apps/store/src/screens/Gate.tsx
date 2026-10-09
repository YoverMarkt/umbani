import { RiHome5Line, RiLockLine } from '@remixicon/react'
import { Boton, LocalDeLaPuerta, SelloDePuerta } from '../components/ui'
import { DIRECCION_DE_UMBANI } from '../lib/umbani'
import type { Business } from '../lib/types'

// Lo que ve quien NO puede usar la tienda.
//
// Desde el 2026-10-09 Umbani es SOLO APP: la tienda de un local se abre desde
// la app, que es quien pide la sesión. A quien llega sin una que valga —un
// enlace viejo del chat, uno reenviado, otro teléfono— se le manda de vuelta a
// la app, nunca a WhatsApp: allí entra con su cuenta y vuelve a este local en
// dos toques. Hasta esa fecha esta pantalla le decía que le escribiera a
// Umbani por WhatsApp para recibir un enlace.

/** Motivos que devuelve el servidor al rechazar la sesión. */
const MENSAJES: Record<string, { titulo: string; detalle: string }> = {
  otro_dispositivo: {
    titulo: 'Este acceso es de otro teléfono',
    detalle: 'Cada acceso a una tienda vale en un solo teléfono, para que nadie pida a nombre '
      + 'de otro. Entra en Umbani con tu cuenta y vuelve a este local.',
  },
  // «Expiró» para los dos: que por dentro sea una caducidad o una revocación
  // al cliente le da igual. Su acceso ya no sirve y necesita otro.
  caducada: {
    titulo: 'Tu acceso expiró',
    detalle: 'Entra en Umbani y vuelve a este local: tendrás uno nuevo al instante.',
  },
  revocada: {
    titulo: 'Tu acceso expiró',
    detalle: 'Entra en Umbani y vuelve a este local: tendrás uno nuevo al instante.',
  },
  otro_negocio: {
    titulo: 'Este acceso es de otro local',
    detalle: 'Vuelve a Umbani y elige este local para pedir aquí.',
  },
  // El acceso no se demostró en este teléfono. Antes se pedía el número de
  // WhatsApp; ahora la cuenta de la app es la prueba.
  necesita_telefono: {
    titulo: 'Entra desde la app',
    detalle: 'Las tiendas se abren desde Umbani, con tu cuenta. Entra y elige este local.',
  },
  no_existe: {
    titulo: 'Entra desde la app',
    detalle: 'Puedes mirar la carta, pero para pedir hace falta entrar en Umbani con tu cuenta. '
      + 'Es un momento.',
  },
}

export default function Gate({ business, motivo }: {
  business: Business | null
  motivo: string | null
}) {
  const { titulo, detalle } = MENSAJES[motivo || 'no_existe'] || MENSAJES.no_existe

  return (
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 pt-[calc(env(safe-area-inset-top)+3rem)] pb-12">
      {/* El local con su LOGO, no una línea de texto con un iconito: quien
          llega aquí acaba de tocar un enlace de comida, y ver la marca del
          sitio es lo que convierte «una app que falló» en «Monster Pizza me
          está diciendo algo». */}
      <LocalDeLaPuerta nombre={business?.name} logoUrl={business?.logoUrl} />

      <SelloDePuerta><RiLockLine size={26} /></SelloDePuerta>

      <h1 className="titulo-xl">{titulo}</h1>
      <p className="mt-3 text-[15px] leading-relaxed texto-cuerpo">{detalle}</p>

      <div className="mt-8">
        <a href={DIRECCION_DE_UMBANI} className="block">
          <Boton>
            <span className="flex items-center justify-center gap-2">
              <RiHome5Line size={18} />
              Ir a Umbani
            </span>
          </Boton>
        </a>
      </div>
    </div>
  )
}
