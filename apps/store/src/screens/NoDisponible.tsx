import { RiHome5Line, RiStore2Line } from '@remixicon/react'
import { Boton, SelloDePuerta } from '../components/ui'
import { DIRECCION_DE_UMBANI } from '../lib/umbani'

// La tienda no existe, o el negocio la apagó.
//
// ⚠️ Vivía escrita a mano dentro de `App.tsx`, en el paquete PRINCIPAL — el que
// se descarga con datos móviles antes de ver un solo producto—, para una
// pantalla que en una visita normal no se ve nunca. Las otras puertas ya
// viajaban aparte por esa misma razón; esta se quedó atrás.
//
// ⚠️ Distinta de `SinConexion`: aquí reintentar NO arregla nada, así que no se
// ofrece. Lo que resuelve es volver a Umbani y elegir otro local (antes:
// «vuelve al chat de WhatsApp»; Umbani es solo app desde el 2026-10-09).

export default function NoDisponible() {
  return (
    // Se pinta como las otras puertas —sello, titular fuerte y explicación en
    // cuerpo de texto— porque para el cliente es la misma clase de noticia: no
    // puede pasar, y quiere saber por qué.
    <div className="animar-entrada mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      <SelloDePuerta><RiStore2Line size={26} /></SelloDePuerta>
      <h1 className="titulo-xl">Esta tienda no está disponible</h1>
      <p className="mt-3 text-[15px] leading-relaxed texto-cuerpo">
        Puede que el negocio la haya desactivado. Vuelve a Umbani y elige otro local.
      </p>
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
