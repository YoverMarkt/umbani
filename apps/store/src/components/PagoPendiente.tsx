import { useEffect, useState } from 'react'
import {
  RiBankLine,
  RiFileCopyLine,
} from '@remixicon/react'
import { getPaymentInfo } from '../lib/api'
import type { BankAccount } from '../lib/types'

// ── A DÓNDE TRANSFERIR ─────────────────────────────────────────────────────
//
// Los datos bancarios del negocio, y nada más.
//
// La subida del comprobante va JUSTO DEBAJO, en su propio componente
// (`SubirComprobante`, 2026-10-09): este bloque solo informa. Entre el
// 2026-08-12 y esa fecha no había subida —el comprobante se mandaba por el
// chat de WhatsApp—; desde que Umbani es solo app, vuelve a subirse aquí.

const lineasBanco = (cuenta: BankAccount) => [
  { etiqueta: 'Banco', valor: cuenta.bank_name },
  { etiqueta: 'Tipo', valor: cuenta.account_type },
  { etiqueta: 'Número', valor: cuenta.account_number, copiable: true },
  { etiqueta: 'Titular', valor: cuenta.holder_name },
  { etiqueta: 'Cédula / RUC', valor: cuenta.holder_id, copiable: true },
].filter(linea => Boolean(linea.valor))

export default function PagoPendiente({ slug }: { slug: string }) {
  const [cuenta, setCuenta] = useState<BankAccount | null>(null)
  const [copiado, setCopiado] = useState('')

  useEffect(() => {
    getPaymentInfo(slug).then(setCuenta).catch(() => setCuenta(null))
  }, [slug])

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado(texto)
      setTimeout(() => setCopiado(''), 1800)
    } catch { /* sin portapapeles: el número está a la vista igual */ }
  }

  const filas = cuenta ? lineasBanco(cuenta) : []
  // Sin datos cargados no se pinta un título con un hueco debajo.
  if (filas.length === 0) return null

  return (
    <section className="w-full text-left">
      <h2 className="titulo-l mb-2.5 flex items-center gap-2 px-1">
        <RiBankLine size={18} className="texto-tenue" />
        Para transferir
      </h2>

      <div className="superficie divide-y divide-(--linea) overflow-hidden rounded-(--radius-tarjeta) shadow-tarjeta">
        {filas.map(({ etiqueta, valor, copiable }) => (
          <div key={etiqueta} className="flex items-center justify-between gap-3 px-4 py-3.5">
            <span className="caption texto-tenue">{etiqueta}</span>
            <span className="flex items-center gap-2 text-right text-[14.5px] font-semibold">
              {String(valor)}
              {copiable && (
                <button
                  onClick={() => copiar(String(valor))}
                  aria-label={`Copiar ${etiqueta}`}
                  className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-full transition active:scale-90"
                >
                  {/* ⚠️ El «copiado» va en `acento` SÓLIDO, no con el acento de
                      letra: un icono de 15 px en el lima de la plataforma da
                      1,19:1 sobre blanco y desaparece justo cuando su trabajo
                      es confirmar que el número de cuenta ya está copiado.
                      Antes se distinguían por un color que no se veía; ahora,
                      por la pastilla, que se ve sin mirar. */}
                  <span className={`flex size-7 items-center justify-center rounded-full transition ${
                    copiado === String(valor) ? 'acento shadow-acento' : 'texto-tenue'
                  }`}
                  >
                    <RiFileCopyLine size={15} />
                  </span>
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
