import { useMemo, useState } from 'react'
import { agruparGrupos, moverEnSeccion } from './agrupar-grupos'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useBusinessInfo } from '../../lib/biz'
import { vocabularioDe } from './vocabulario'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { Badge } from '@botpanel/ui/components/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@botpanel/ui/components/collapsible'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@botpanel/ui/components/dialog'
import type {
  Category, OptionGroup, OptionGroupPayload, Product, ProductOption, RecommendationPayload,
} from './api'
import { grupoNuevo, resumen, moverEnLista, money } from './opciones'
import { Flechas } from './Flechas'
import { GrupoDialog } from './GrupoDialog'
import { OpcionDialog } from './OpcionDialog'
import * as catApi from './api'

// ═══════════════════════════════════════════════════════════════════════════
// EL CONSTRUCTOR DE OPCIONES
// ═══════════════════════════════════════════════════════════════════════════
//
// Aquí el dueño arma cómo se personaliza cada plato: el término de la carne,
// los ingredientes que se quitan, los cortes de una parrillada, la bebida
// incluida de un combo.
//
// Todo lo que se configure aquí sale EN LA MINI APP sin tocar código. Esa es
// la promesa entera del motor: la diferencia entre una pizzería y una
// heladería es la configuración, no un componente distinto.
//
// Hasta ahora esto solo se podía cargar con una plantilla al crear el negocio
// o escribiendo SQL a mano.

const adicionalVacio = (): RecommendationPayload => ({
  source_product_id: null,
  source_category_id: null,
  recommended_product_id: '',
  section: 'Agrega algo más',
  sort: 0,
  active: true,
})

const opcionNueva = (groupId: string): Omit<ProductOption, 'id'> => ({
  option_group_id: groupId,
  name: '',
  description: null,
  image_url: null,
  image_public_id: null,
  price_adjustment: 0,
  references_product_id: null,
  default_selected: false,
  stock: 'disponible',
  sort: 0,
  active: true,
})

export default function OptionsManager({
  productos, categorias,
}: {
  productos: Product[]
  categorias: Category[]
}) {
  const qc = useQueryClient()
  // Los ejemplos son del oficio del local, no de una pizzería.
  const voz = vocabularioDe(useBusinessInfo().data?.type)
  const [abierto, setAbierto] = useState<Record<string, boolean>>({})
  const [editandoGrupo, setEditandoGrupo] = useState<
    { grupo: OptionGroupPayload; id: string | null } | null
  >(null)
  const [editandoOpcion, setEditandoOpcion] = useState<
    {
      opcion: Omit<ProductOption, 'id'>
      id: string | null
      /**
       * Si viene, lo que se edita es un sabor de ESTA plantilla y no una opción
       * de un grupo. Se reutiliza el mismo diálogo porque los campos son los
       * mismos; lo único que cambia es adónde se guarda.
       */
      plantilla?: string
    } | null
  >(null)
  const [plantillaNueva, setPlantillaNueva] = useState<{ name: string } | null>(null)
  const [adicionalNuevo, setAdicionalNuevo] = useState<RecommendationPayload | null>(null)

  const grupos = useQuery({ queryKey: ['option-groups'], queryFn: catApi.getOptionGroups })
  const opciones = useQuery({ queryKey: ['options'], queryFn: catApi.getOptions })
  const plantillas = useQuery({ queryKey: ['option-templates'], queryFn: catApi.getOptionTemplates })
  // ⚠️ Estas funciones existían en la API desde el principio y NINGUNA pantalla
  // las usaba (2026-09-16): se podía crear una plantilla «Sabores», pero no había
  // forma de meterle un solo sabor. La sección prometía «al añadir una opción,
  // aparece en todos» y no dejaba añadir ninguna.
  const itemsDePlantilla = useQuery({
    queryKey: ['option-template-items'], queryFn: catApi.getOptionTemplateItems,
  })
  const adicionales = useQuery({ queryKey: ['recommendations'], queryFn: catApi.getRecommendations })

  const refrescar = () => {
    void qc.invalidateQueries({ queryKey: ['option-groups'] })
    void qc.invalidateQueries({ queryKey: ['options'] })
    void qc.invalidateQueries({ queryKey: ['option-templates'] })
    void qc.invalidateQueries({ queryKey: ['option-template-items'] })
    void qc.invalidateQueries({ queryKey: ['recommendations'] })
  }

  const alFallar = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : 'No se pudo guardar')
  }

  const guardarGrupo = useMutation({
    mutationFn: ({ grupo, id }: { grupo: OptionGroupPayload; id: string | null }) => (
      id ? catApi.updateOptionGroup(id, grupo) : catApi.createOptionGroup(grupo)
    ),
    onSuccess: () => {
      toast.success('Grupo guardado')
      setEditandoGrupo(null)
      refrescar()
    },
    onError: alFallar,
  })

  const borrarGrupo = useMutation({
    mutationFn: catApi.deleteOptionGroup,
    onSuccess: () => { toast.success('Grupo eliminado'); refrescar() },
    onError: alFallar,
  })

  const guardarOpcion = useMutation({
    mutationFn: ({ opcion, id, plantilla }: {
      opcion: Omit<ProductOption, 'id'>; id: string | null; plantilla?: string
    }) => {
      if (plantilla) {
        // El diálogo trae `option_group_id` porque edita una opción; un sabor
        // de plantilla no cuelga de ningún grupo, así que se quita. La base
        // se encarga de copiarlo a todos los grupos que la usan.
        const { option_group_id: _grupo, option_template_item_id: _copia, ...campos } = opcion
        const item = { ...campos, option_template_id: plantilla }
        return id
          ? catApi.updateOptionTemplateItem(id, item)
          : catApi.createOptionTemplateItem(item)
      }
      return id ? catApi.updateOption(id, opcion) : catApi.createOption(opcion)
    },
    onSuccess: () => {
      toast.success('Opción guardada')
      setEditandoOpcion(null)
      refrescar()
    },
    onError: alFallar,
  })

  /**
   * Reordenar es OPTIMISTA: la lista se mueve en pantalla al instante y solo
   * se deshace si el servidor dice que no. Esperar un viaje de red por cada
   * toque en una flecha convierte ordenar ocho grupos en ocho esperas.
   */
  const ordenarGrupos = useMutation({
    mutationFn: catApi.reorderOptionGroups,
    onMutate: async (ids: string[]) => {
      await qc.cancelQueries({ queryKey: ['option-groups'] })
      const antes = qc.getQueryData<OptionGroup[]>(['option-groups'])
      if (antes) {
        const posicion = new Map(ids.map((id, indice) => [id, indice]))
        qc.setQueryData<OptionGroup[]>(['option-groups'], [...antes].sort(
          (a, b) => (posicion.get(a.id) ?? 0) - (posicion.get(b.id) ?? 0),
        ))
      }
      return { antes }
    },
    onError: (error, _ids, contexto) => {
      if (contexto?.antes) qc.setQueryData(['option-groups'], contexto.antes)
      alFallar(error)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['option-groups'] }),
  })

  const ordenarOpciones = useMutation({
    mutationFn: ({ groupId, ids }: { groupId: string; ids: string[] }) =>
      catApi.reorderOptions(groupId, ids),
    onMutate: async ({ ids }) => {
      await qc.cancelQueries({ queryKey: ['options'] })
      const antes = qc.getQueryData<ProductOption[]>(['options'])
      if (antes) {
        const posicion = new Map(ids.map((id, indice) => [id, indice]))
        qc.setQueryData<ProductOption[]>(['options'], [...antes].sort(
          (a, b) => (posicion.get(a.id) ?? 0) - (posicion.get(b.id) ?? 0),
        ))
      }
      return { antes }
    },
    onError: (error, _vars, contexto) => {
      if (contexto?.antes) qc.setQueryData(['options'], contexto.antes)
      alFallar(error)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['options'] }),
  })

  const borrarOpcion = useMutation({
    mutationFn: catApi.deleteOption,
    onSuccess: () => { toast.success('Opción eliminada'); refrescar() },
    onError: alFallar,
  })

  const borrarItemDePlantilla = useMutation({
    mutationFn: catApi.deleteOptionTemplateItem,
    onSuccess: () => { toast.success('Sabor quitado de la plantilla y de sus grupos'); refrescar() },
    onError: alFallar,
  })

  const crearPlantilla = useMutation({
    mutationFn: (nombre: string) => catApi.createOptionTemplate({ name: nombre, description: null }),
    onSuccess: () => { toast.success('Plantilla creada'); setPlantillaNueva(null); refrescar() },
    onError: alFallar,
  })

  const borrarPlantilla = useMutation({
    mutationFn: catApi.deleteOptionTemplate,
    onSuccess: () => { toast.success('Plantilla eliminada'); refrescar() },
    onError: alFallar,
  })

  const crearAdicional = useMutation({
    mutationFn: catApi.createRecommendation,
    onSuccess: () => { toast.success('Adicional guardado'); setAdicionalNuevo(null); refrescar() },
    onError: alFallar,
  })

  const borrarAdicional = useMutation({
    mutationFn: catApi.deleteRecommendation,
    onSuccess: () => { toast.success('Adicional eliminado'); refrescar() },
    onError: alFallar,
  })

  const [verOcultos, setVerOcultos] = useState(false)

  const opcionesPorGrupo = useMemo(() => {
    const mapa = new Map<string, ProductOption[]>()
    for (const opcion of opciones.data || []) {
      mapa.set(opcion.option_group_id, [...mapa.get(opcion.option_group_id) || [], opcion])
    }
    return mapa
  }, [opciones.data])

  /** Dónde cuelga cada grupo, dicho como lo entiende el dueño. */
  const dondeCuelga = (grupo: OptionGroup): string => {
    if (grupo.product_id) {
      return productos.find(p => p.id === grupo.product_id)?.name || 'Producto eliminado'
    }
    if (grupo.category_id) {
      const nombre = categorias.find(c => c.id === grupo.category_id)?.name
      return nombre ? `Toda la categoría ${nombre}` : 'Categoría eliminada'
    }
    return 'Sin asignar'
  }

  // ⚠️ Memoizada, no `grupos.data || []` a secas: mientras carga, ese `||`
  // devuelve un array NUEVO en cada render y el reparto de abajo se
  // recalcularía siempre. Lo avisó el lint.
  const lista = useMemo(() => grupos.data || [], [grupos.data])

  // El reparto vive aparte y probado en `agrupar-grupos.ts`.
  //
  // ⚠️ Va aquí, ANTES de los `return` de carga y error, y no junto al render
  // que lo usa: un `useMemo` detrás de un return temprano se salta en el
  // primer render y React se encuentra un hook de más en el siguiente. Lo cazó
  // el lint (`react-hooks/rules-of-hooks`), no una prueba.
  const { secciones, ocultos } = useMemo(
    () => agruparGrupos(
      lista,
      id => (opcionesPorGrupo.get(id) || []).length,
      productos,
      categorias,
    ),
    [lista, opcionesPorGrupo, productos, categorias],
  )

  if (grupos.isLoading || opciones.isLoading) {
    return <div className="space-y-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-24 w-full" />)}</div>
  }
  if (grupos.error) return <QueryError onRetry={() => void grupos.refetch()} />

  /** Una tarjeta de grupo. `hermanos` son los de su misma sección: las
      flechas ordenan dentro del producto, que es el orden que ve el cliente. */
  const tarjetaGrupo = (
    grupo: OptionGroup,
    indice: number,
    hermanos: OptionGroup[],
    // En una sección la cabecera ya dice de quién cuelga, y el orden importa.
    // En el cajón de los ocultos es al revés: ahí conviven grupos de productos
    // distintos —hay que nombrarlos— y ordenar lo que nadie ve es ruido.
    cajon = false,
  ) => {
    const suyas = opcionesPorGrupo.get(grupo.id) || []
    const desplegado = abierto[grupo.id]
    return (
          <Card key={grupo.id} className="overflow-hidden">
            {/* `contents`: la raíz del desplegable no pinta caja propia, así la
                cabecera y el cuerpo siguen siendo hijos directos de la tarjeta. */}
            <Collapsible
              className="contents"
              open={Boolean(desplegado)}
              onOpenChange={abrir => setAbierto({ ...abierto, [grupo.id]: abrir })}
            >
            <div className="flex flex-wrap items-start justify-between gap-3 p-4">
              <CollapsibleTrigger className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
                {desplegado
                  ? <ChevronDown className="mt-0.5 size-4 shrink-0" />
                  : <ChevronRight className="mt-0.5 size-4 shrink-0" />}
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{grupo.name}</span>
                    {grupo.required && <Badge variant="default">Obligatorio</Badge>}
                    {!grupo.active && <Badge variant="outline">Inactivo</Badge>}
                    {grupo.pricing_strategy === 'highest_selected' && (
                      <Badge variant="secondary">Cobra la más cara</Badge>
                    )}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {cajon && `${dondeCuelga(grupo)} · `}
                    {resumen(grupo)} · {suyas.length} opciones
                    {!suyas.length && ' — sin opciones, tu cliente no lo ve'}
                  </span>
                </span>
              </CollapsibleTrigger>
              <div className="flex shrink-0 items-center gap-1.5">
                {/* El orden decide cómo se lee el plato: en la ficha del
                    cliente, en el carrito, en el pedido y en su WhatsApp. */}
                {!cajon && (
                  <Flechas
                    nombre={grupo.name}
                    primero={indice === 0}
                    ultimo={indice === hermanos.length - 1}
                    ocupado={ordenarGrupos.isPending}
                    onSubir={() => ordenarGrupos.mutate(moverEnSeccion(lista, hermanos, indice, -1))}
                    onBajar={() => ordenarGrupos.mutate(moverEnSeccion(lista, hermanos, indice, 1))}
                  />
                )}
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setEditandoGrupo({ grupo: { ...grupo }, id: grupo.id })}
                >
                  <Pencil className="size-4" />
                </Button>
                <ConfirmAction
                  title="¿Eliminar este grupo?"
                  description="Se borran también todas sus opciones. Los pedidos ya hechos no cambian."
                  destructive
                  onConfirm={() => borrarGrupo.mutate(grupo.id)}
                  trigger={
                    <Button variant="ghost" size="sm"><Trash2 className="size-4" /></Button>
                  }
                />
              </div>
            </div>

              <CollapsibleContent className="border-t bg-muted/30 p-4">
                <div className="space-y-2">
                  {suyas.map((opcion, puesto) => (
                    <div
                      key={opcion.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{opcion.name}</span>
                        {opcion.default_selected && (
                          <Badge variant="outline" className="ml-2">Por defecto</Badge>
                        )}
                        {opcion.stock === 'agotado' && (
                          <Badge variant="outline" className="ml-2">Agotado</Badge>
                        )}
                        {opcion.option_template_item_id && (
                          <Badge variant="secondary" className="ml-2">De la plantilla</Badge>
                        )}
                      </span>
                      <span className="text-sm font-semibold">
                        {money(opcion.price_adjustment)}
                      </span>
                      {/* ⚠️ Una COPIA de plantilla no se edita suelta: la base la
                          mantiene al día y pisaría el cambio. Se dice dónde se
                          cambia en vez de dejar tocarla — el servidor también
                          lo rechaza, esto evita que el dueño lo intente. */}
                      {opcion.option_template_item_id ? (
                        <span className="text-xs text-muted-foreground">se cambia en la plantilla</span>
                      ) : (
                      <span className="flex items-center gap-1">
                        {/* Aquí se ordenan los 19 sabores: el cliente los ve
                            en este orden en la ficha del producto. */}
                        <Flechas
                          nombre={opcion.name}
                          primero={puesto === 0}
                          ultimo={puesto === suyas.length - 1}
                          ocupado={ordenarOpciones.isPending}
                          onSubir={() => ordenarOpciones.mutate({
                            groupId: grupo.id, ids: moverEnLista(suyas, puesto, -1),
                          })}
                          onBajar={() => ordenarOpciones.mutate({
                            groupId: grupo.id, ids: moverEnLista(suyas, puesto, 1),
                          })}
                        />
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => setEditandoOpcion({
                            opcion: { ...opcion }, id: opcion.id,
                          })}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <ConfirmAction
                          title="¿Eliminar esta opción?"
                          description="Desaparece de la mini app. Los pedidos ya hechos no cambian."
                          destructive
                          onConfirm={() => borrarOpcion.mutate(opcion.id)}
                          trigger={
                            <Button variant="ghost" size="sm"><Trash2 className="size-3.5" /></Button>
                          }
                        />
                      </span>
                      )}
                    </div>
                  ))}
                  {!suyas.length && (
                    <p className="py-2 text-sm text-muted-foreground">
                      Este grupo aún no tiene opciones.
                      {grupo.required && ' Es obligatorio, así que sin opciones el producto no se podrá pedir.'}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline" size="sm" className="mt-3"
                  onClick={() => setEditandoOpcion({ opcion: opcionNueva(grupo.id), id: null })}
                >
                  <Plus className="mr-1.5 size-3.5" /> Agregar opción
                </Button>
              </CollapsibleContent>
            </Collapsible>
          </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Grupos de opciones</h3>
          <p className="text-sm text-muted-foreground">
            Cómo se personaliza cada plato. Todo lo que configures aquí aparece en tu mini app.
          </p>
        </div>
        <Button onClick={() => setEditandoGrupo({ grupo: grupoNuevo(), id: null })}>
          <Plus className="mr-1.5 size-4" /> Nuevo grupo
        </Button>
      </div>

      {!lista.length && (
        <Card className="p-8 text-center">
          <Layers className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">Todavía no hay grupos de opciones</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Un grupo es «elige el tamaño», «agrega extras» o «retira ingredientes».
            Cuélgalo de un producto concreto o de una categoría entera.
          </p>
        </Card>
      )}

      {/* ── El catálogo, agrupado por lo que el cliente ve ─────────────
          Antes esto era una lista plana de grupos. Con un almuerzo armado por
          partes eso significaba CUATRO tarjetas llamadas «Sopa» seguidas, que
          solo se distinguían por una línea pequeña diciendo de dónde colgaba
          cada una — y el dueño no tenía forma de saber cuál veía su cliente.
          Ahora cada grupo vive bajo su producto, y el producto dice en una
          línea lo que el cliente va a elegir. */}
      <div className="space-y-6">
        {secciones.map(seccion => (
          <section key={seccion.clave} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
              <h4 className="font-semibold">
                {seccion.esCategoria && (
                  <span className="mr-1.5 text-muted-foreground">Toda la categoría</span>
                )}
                {seccion.titulo}
              </h4>
              <p className="text-sm text-muted-foreground">{seccion.pie}</p>
            </div>
            <div className="space-y-3">
              {seccion.grupos.map((grupo, indice) => (
                tarjetaGrupo(grupo, indice, seccion.grupos)
              ))}
            </div>
          </section>
        ))}

        {/* ⚠️ Lo apagado y lo vacío NO desaparece: se aparta. Un grupo sin
            opciones tampoco lo ve el cliente (la tienda los filtra), así que
            mezclarlo con lo vivo es lo que hacía imposible saber qué estaba
            en pie. Aquí se ve, se dice por qué no cuenta, y se puede borrar. */}
        {ocultos.length > 0 && (
          <Collapsible asChild open={verOcultos} onOpenChange={setVerOcultos}>
          <section className="space-y-3">
            <CollapsibleTrigger className="flex w-full items-center gap-2 border-b pb-2 text-left">
              {verOcultos ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              <span className="font-semibold">Tu cliente no ve estos</span>
              <Badge variant="outline">{ocultos.length}</Badge>
              <span className="text-sm text-muted-foreground">
                — apagados o sin opciones dentro
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3">
              {ocultos.map((grupo, indice) => tarjetaGrupo(grupo, indice, ocultos, true))}
            </CollapsibleContent>
          </section>
          </Collapsible>
        )}
      </div>

      {/* ── Plantillas ───────────────────────────────────────────────── */}
      <div className="border-t pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Plantillas reutilizables</h3>
            <p className="text-sm text-muted-foreground">
              Una lista que se usa en varios sitios. Defines «Sabores» una vez y sirve para la
              cada paso del combo a la vez: al añadir una opción, aparece en todos.
            </p>
          </div>
          <Button variant="outline" onClick={() => setPlantillaNueva({ name: '' })}>
            <Plus className="mr-1.5 size-4" /> Nueva plantilla
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          {(plantillas.data || []).map(plantilla => {
            const suyos = (itemsDePlantilla.data || [])
              .filter(item => item.option_template_id === plantilla.id)
              .sort((a, b) => a.sort - b.sort)
            const clave = `tpl:${plantilla.id}`
            const desplegada = abierto[clave]
            return (
              <Card key={plantilla.id} className="overflow-hidden">
                <Collapsible
                  className="contents"
                  open={Boolean(desplegada)}
                  onOpenChange={abrir => setAbierto({ ...abierto, [clave]: abrir })}
                >
                <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    {desplegada
                      ? <ChevronDown className="size-4 shrink-0" />
                      : <ChevronRight className="size-4 shrink-0" />}
                    <span className="font-medium">{plantilla.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {suyos.length} opcion{suyos.length === 1 ? '' : 'es'} ·{' '}
                      {plantilla.used_by_groups
                        ? `usada en ${plantilla.used_by_groups} grupo${plantilla.used_by_groups > 1 ? 's' : ''}`
                        : 'sin usar todavía'}
                    </span>
                  </CollapsibleTrigger>
                  <ConfirmAction
                    title="¿Eliminar esta plantilla?"
                    description={plantilla.used_by_groups
                      ? `La usan ${plantilla.used_by_groups} grupos. Perderán las opciones que venían de ella; las que agregaste a mano en cada grupo se quedan.`
                      : 'No la usa ningún grupo.'}
                    destructive
                    onConfirm={() => borrarPlantilla.mutate(plantilla.id)}
                    trigger={
                      <Button variant="ghost" size="sm"><Trash2 className="size-4" /></Button>
                    }
                  />
                </div>

                {/* ⚠️ ESTO NO EXISTÍA (2026-09-16). Se podía crear «Sabores»,
                    pero no meterle un solo sabor: las funciones estaban en la
                    API y ninguna pantalla las llamaba. Lo que se agrega aquí lo
                    copia la base a todos los grupos que usan la plantilla. */}
                  <CollapsibleContent className="border-t bg-muted/30 p-3">
                    <div className="space-y-2">
                      {suyos.map(item => (
                        <div
                          key={item.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="font-medium">{item.name}</span>
                            {item.stock === 'agotado' && (
                              <Badge variant="outline" className="ml-2">Agotado</Badge>
                            )}
                          </span>
                          <span className="text-sm font-semibold">{money(item.price_adjustment)}</span>
                          <span className="flex items-center gap-1">
                            <Button
                              variant="ghost" size="sm"
                              aria-label={`Editar ${item.name}`}
                              onClick={() => setEditandoOpcion({
                                opcion: { ...item, option_group_id: plantilla.id },
                                id: item.id,
                                plantilla: plantilla.id,
                              })}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <ConfirmAction
                              title={`¿Quitar ${item.name}?`}
                              description="Desaparece de la plantilla y de todos los grupos que la usan. Los pedidos ya hechos no cambian."
                              destructive
                              onConfirm={() => borrarItemDePlantilla.mutate(item.id)}
                              trigger={
                                <Button variant="ghost" size="sm" aria-label={`Quitar ${item.name}`}>
                                  <Trash2 className="size-3.5" />
                                </Button>
                              }
                            />
                          </span>
                        </div>
                      ))}
                      {!suyos.length && (
                        <p className="py-2 text-sm text-muted-foreground">
                          Esta plantilla está vacía. Agrégale opciones y aparecerán en cada grupo que la use.
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline" size="sm" className="mt-3"
                      onClick={() => setEditandoOpcion({
                        opcion: { ...opcionNueva(plantilla.id), sort: suyos.length },
                        id: null,
                        plantilla: plantilla.id,
                      })}
                    >
                      <Plus className="mr-1.5 size-3.5" /> Agregar opción
                    </Button>
                  </CollapsibleContent>
                </Collapsible>
              </Card>
            )
          })}
          {!(plantillas.data || []).length && (
            <p className="text-sm text-muted-foreground">Todavía no hay plantillas.</p>
          )}
        </div>
      </div>

      {/* ── Adicionales ──────────────────────────────────────────────── */}
      <div className="border-t pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Agrega algo más</h3>
            <p className="text-sm text-muted-foreground">
              Otros productos que se ofrecen junto a este. <strong>No</strong> son opciones del
              plato: entran al carrito por su cuenta, como algo más que preparar.
            </p>
          </div>
          <Button variant="outline" onClick={() => setAdicionalNuevo(adicionalVacio())}>
            <Plus className="mr-1.5 size-4" /> Nuevo adicional
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          {(adicionales.data || []).map((reco) => {
            const ofrecido = productos.find(p => p.id === reco.recommended_product_id)
            const desde = reco.source_product_id
              ? productos.find(p => p.id === reco.source_product_id)?.name
              : reco.source_category_id
                ? `la categoría ${categorias.find(c => c.id === reco.source_category_id)?.name || '—'}`
                : 'todo el catálogo'
            return (
              <Card key={reco.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <span className="min-w-0">
                  <span className="font-medium">{ofrecido?.name || 'Producto eliminado'}</span>
                  <span className="ml-2 text-sm text-muted-foreground">
                    en «{reco.section}», desde {desde}
                  </span>
                </span>
                <ConfirmAction
                  title="¿Quitar este adicional?"
                  description="Deja de ofrecerse. El producto sigue en tu catálogo."
                  destructive
                  onConfirm={() => borrarAdicional.mutate(reco.id)}
                  trigger={<Button variant="ghost" size="sm"><Trash2 className="size-4" /></Button>}
                />
              </Card>
            )
          })}
          {!(adicionales.data || []).length && (
            <p className="text-sm text-muted-foreground">Todavía no ofreces nada además.</p>
          )}
        </div>
      </div>

      <Dialog
        open={Boolean(adicionalNuevo)}
        onOpenChange={abierta => !abierta && setAdicionalNuevo(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nuevo adicional</DialogTitle>
            <DialogDescription>
              Aparece en la ficha del producto con un «+». Al tocarlo, entra al carrito
              como una línea aparte.
            </DialogDescription>
          </DialogHeader>

          {adicionalNuevo && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>¿Qué se ofrece?</Label>
                <Select
                  value={adicionalNuevo.recommended_product_id}
                  onValueChange={v => setAdicionalNuevo({
                    ...adicionalNuevo, recommended_product_id: v,
                  })}
                >
                  <SelectTrigger><SelectValue placeholder="Elige un producto" /></SelectTrigger>
                  <SelectContent>
                    {productos.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>¿Dónde se ofrece?</Label>
                <Select
                  value={adicionalNuevo.source_product_id
                    ? `p:${adicionalNuevo.source_product_id}`
                    : adicionalNuevo.source_category_id
                      ? `c:${adicionalNuevo.source_category_id}`
                      : 'todo'}
                  onValueChange={(valor) => {
                    const [tipo, id] = valor.split(':')
                    setAdicionalNuevo({
                      ...adicionalNuevo,
                      source_product_id: tipo === 'p' ? id : null,
                      source_category_id: tipo === 'c' ? id : null,
                    })
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todo">En todo el catálogo</SelectItem>
                    {categorias.map(c => (
                      <SelectItem key={`c:${c.id}`} value={`c:${c.id}`}>
                        En la categoría {c.name}
                      </SelectItem>
                    ))}
                    {productos.map(p => (
                      <SelectItem key={`p:${p.id}`} value={`p:${p.id}`}>Solo con {p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="reco-seccion">Título de la sección</Label>
                <Input
                  id="reco-seccion"
                  value={adicionalNuevo.section}
                  onChange={e => setAdicionalNuevo({ ...adicionalNuevo, section: e.target.value })}
                  placeholder="Agrega bebidas"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAdicionalNuevo(null)}>Cancelar</Button>
            <Button
              disabled={!adicionalNuevo?.recommended_product_id || crearAdicional.isPending}
              onClick={() => adicionalNuevo && crearAdicional.mutate(adicionalNuevo)}
            >
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GrupoDialog
        estado={editandoGrupo}
        productos={productos}
        categorias={categorias}
        plantillas={plantillas.data || []}
        onCerrar={() => setEditandoGrupo(null)}
        onGuardar={valor => guardarGrupo.mutate(valor)}
        guardando={guardarGrupo.isPending}
      />

      <OpcionDialog
        estado={editandoOpcion}
        productos={productos}
        onCerrar={() => setEditandoOpcion(null)}
        onGuardar={valor => guardarOpcion.mutate({ ...valor, plantilla: editandoOpcion?.plantilla })}
        guardando={guardarOpcion.isPending}
      />

      <Dialog open={Boolean(plantillaNueva)} onOpenChange={abierta => !abierta && setPlantillaNueva(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nueva plantilla</DialogTitle>
            <DialogDescription>
              Por ejemplo «{voz.ejemploGrupo}». Después le agregas sus opciones y la usas
              en todos los grupos que quieras.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="plantilla-nombre">Nombre</Label>
            <Input
              id="plantilla-nombre"
              value={plantillaNueva?.name || ''}
              onChange={e => setPlantillaNueva({ name: e.target.value })}
              placeholder={voz.ejemploGrupo}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlantillaNueva(null)}>Cancelar</Button>
            <Button
              disabled={!plantillaNueva?.name.trim() || crearPlantilla.isPending}
              onClick={() => crearPlantilla.mutate(plantillaNueva!.name.trim())}
            >
              Crear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── El formulario del grupo ────────────────────────────────────────────────
//
// Las reglas se explican EN el formulario, no en un error después de guardar:
// «obligatorio» pone el mínimo en 1 solo, y «elegir uno» fija el máximo en 1.
// El servidor las vuelve a comprobar, pero aquí el dueño entiende por qué.
