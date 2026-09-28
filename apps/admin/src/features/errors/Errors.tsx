import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getPlatformErrors, type PlatformError } from '../clients/api'
import { Download, TriangleAlert } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'

const CATEGORIES = [
  { id: '', label: 'Todos' },
  { id: 'canal', label: 'Canal' },
  { id: 'ia', label: 'IA' },
  { id: 'envio', label: 'Envío' },
  { id: 'servidor', label: 'Servidor' },
  { id: 'pagos', label: 'Pagos' },
] as const

const CATEGORY_STYLE: Record<PlatformError['category'], string> = {
  canal: 'bg-destructive/10 text-destructive',
  ia: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  envio: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  servidor: 'bg-muted text-muted-foreground',
  // El dinero: un descuadre o una devolución pendiente se ve de lejos.
  pagos: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
}

const fmt = (iso: string) => new Date(iso).toLocaleString('es-EC', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
})

export default function Errors() {
  const [category, setCategory] = useState('')
  const { data: errors = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['adm-errors', category],
    queryFn: () => getPlatformErrors(category || undefined),
    refetchInterval: 60_000,
  })

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Errores</h1>
          <p className="text-sm text-muted-foreground">
            Fallos agrupados de los últimos 30 días. Sin datos personales ni credenciales: se puede compartir.
          </p>
        </div>
        <Button variant="outline" asChild>
          <a href="/api/admin/errors/export" download>
            <span className="inline-flex items-center gap-1.5">
              <Download className="h-4 w-4" /> Descargar CSV
            </span>
          </a>
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {CATEGORIES.map(c => (
          <Button
            key={c.id}
            size="sm"
            variant={category === c.id ? 'default' : 'outline'}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <Card className="gap-3 p-4">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
        </Card>
      ) : isError ? (
        <QueryError onRetry={() => { void refetch() }} />
      ) : !errors.length ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Sin errores registrados. Es la mejor noticia posible.
          </p>
        </Card>
      ) : (
        <Card className="w-full flex-1 gap-0 overflow-hidden py-0">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>Última vez</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Veces</TableHead>
                <TableHead>Código</TableHead>
                <TableHead>Detalle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {errors.map(e => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {fmt(e.last_seen_at)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className={CATEGORY_STYLE[e.category]}>{e.category}</Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {e.occurrences > 1 ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-destructive">
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> {e.occurrences}
                      </span>
                    ) : e.occurrences}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground/80">{e.code || '—'}</TableCell>
                  <TableCell className="text-sm text-foreground">{e.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
