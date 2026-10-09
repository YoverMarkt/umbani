import { ChevronUp, ChevronDown as ChevronDownIcon } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'

// Las flechas para subir y bajar un grupo o una opción.
// Vivía en OptionsManager.tsx hasta el 2026-10-08 (ningún archivo pasa de 1.000 líneas).

/**
 * Las flechas de subir y bajar.
 *
 * ⚠️ Llevan `aria-label` con el nombre de lo que mueven. Una fila de flechas
 * idénticas es ilegible para quien navega por teclado o con lector: «subir» a
 * secas no dice subir qué, y en una lista de ocho grupos son dieciséis botones
 * que suenan igual.
 */
export function Flechas({ nombre, primero, ultimo, onSubir, onBajar, ocupado }: {
  nombre: string
  primero: boolean
  ultimo: boolean
  onSubir: () => void
  onBajar: () => void
  ocupado: boolean
}) {
  return (
    <div className="flex shrink-0">
      <Button
        variant="ghost" size="sm"
        aria-label={`Subir ${nombre}`}
        disabled={primero || ocupado}
        onClick={onSubir}
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        variant="ghost" size="sm"
        aria-label={`Bajar ${nombre}`}
        disabled={ultimo || ocupado}
        onClick={onBajar}
      >
        <ChevronDownIcon className="size-4" />
      </Button>
    </div>
  )
}
