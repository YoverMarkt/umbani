import { RiSmartphoneLine } from '@remixicon/react'
import { LocalDeLaPuerta, SelloDePuerta } from '../components/ui'
import type { Business } from '../lib/types'

// Lo que ve quien abre la tienda en una computadora.
//
// No se pide nada al servidor desde aquí salvo la portada, que es pública: así
// abrirla en el PC NO gasta su acceso. Cuando la abra en su teléfono funcionará
// con normalidad.
//
// Desde el 2026-10-09 Umbani es SOLO APP: se le manda a la app del celular,
// no a buscar un mensaje de WhatsApp como antes.

export default function DesktopGate({ business }: { business: Business | null }) {
  return (
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      {/* Las puertas se pintan igual a propósito. */}
      <LocalDeLaPuerta nombre={business?.name} logoUrl={business?.logoUrl} />

      <SelloDePuerta><RiSmartphoneLine size={26} /></SelloDePuerta>

      <h1 className="titulo-xl">
        Abre Umbani en tu celular
      </h1>
      {/* En `texto-cuerpo`, no en el gris de metadatos: esto es la explicación
          de por qué no puede pasar, no un pie de página. */}
      <p className="mt-3 text-[15px] leading-relaxed texto-cuerpo">
        La tienda está hecha para el teléfono. Abre la app de Umbani en tu celular,
        entra con tu cuenta y elige este local.
      </p>

      <div className="superficie mt-6 rounded-(--radius-tarjeta) px-4 py-4 text-[13.5px] leading-relaxed texto-cuerpo shadow-tarjeta">
        Tu acceso sigue intacto: abrirlo aquí no lo gastó.
      </div>
    </div>
  )
}
