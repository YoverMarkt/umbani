import { RiCloseLine, RiSmartphoneLine } from '@remixicon/react'
import { useInstalar } from '../lib/app-instalable'

/**
 * «Instala la app»: la tarjeta que ofrece poner `/u` o `/r` en el teléfono
 * (ver `lib/app-instalable.ts`).
 *
 * Solo sale cuando instalar es posible DE VERDAD —Android con su aviso, o el
 * iPhone en su navegador— y nunca dentro de la app ya instalada. «Ahora no» la
 * esconde dos semanas: una tarjeta que vuelve en cada visita se aprende a no
 * mirar.
 *
 * ⚠️ SOLO ICONOS QUE LA TIENDA YA USA. Los de Remix viven en un único módulo
 * que cae en el trozo COMPARTIDO con la tienda: un icono nuevo aquí lo paga
 * también quien abre una tienda desde WhatsApp. Medido el 2026-10-06: el de
 * «Compartir» del iPhone le sumaba 100 bytes a la tienda, por eso esa
 * instrucción va en palabras.
 */
export function InstalarApp({ nombre }: { nombre: string }) {
  const { ofrecer, instalar, descartar } = useInstalar()
  if (ofrecer === 'nada') return null

  return (
    <section aria-label={`Instalar ${nombre}`} className="superficie mb-4 flex items-start gap-3 rounded-(--radius-tarjeta) px-4 py-3.5 shadow-tarjeta">
      <span className="tinta flex size-10 shrink-0 items-center justify-center rounded-xl">
        <RiSmartphoneLine size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-bold">Instala {nombre} en tu teléfono</p>
        {ofrecer === 'iphone'
          ? (
              <p className="texto-cuerpo mt-0.5 text-[13px] leading-snug">
                En Safari, toca <b>Compartir</b> y luego «Agregar a inicio».
              </p>
            )
          : <p className="texto-cuerpo mt-0.5 text-[13px] leading-snug">Ábrela desde tu pantalla de inicio, como cualquier app.</p>}
        {ofrecer === 'boton' && (
          <button type="button" onClick={() => void instalar()} className="tinta mt-2.5 rounded-full px-4 py-2 text-[14px] font-bold shadow-alzada transition active:scale-[0.98]">
            Instalar
          </button>
        )}
      </div>
      <button type="button" onClick={descartar} aria-label="Ahora no" className="texto-tenue -mt-1.5 -mr-2 flex size-10 shrink-0 items-center justify-center rounded-full">
        <RiCloseLine size={20} />
      </button>
    </section>
  )
}
