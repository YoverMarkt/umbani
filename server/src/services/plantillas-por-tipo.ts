import type {
  BusinessTemplate,
  TemplateCategory,
  TemplateGroup,
  TemplateList,
  TemplateProduct,
} from '../db/types'

// ══════════════════════════════════════════════════════════════════════════
// PLANTILLAS POR TIPO DE NEGOCIO
//
// Con qué catálogo NACE un negocio recién creado: sus categorías, los grupos
// de opciones típicos y UN producto de ejemplo armado como se arma de verdad
// en ese tipo. Es lo que convierte «dar de alta una hamburguesería» en cargar
// datos en vez de escribirlo todo a mano.
//
// ⚠️ Hasta el 2026-09-16 no había producto de ejemplo: todo colgaba de la
// CATEGORÍA. El dueño veía «Sopa, Segundo… lo heredan 0 productos», piezas
// sueltas que no enseñaban cómo se juntan. Y en los almuerzos era imposible:
// una parte del plato solo puede colgar de un PRODUCTO, así que la plantilla no
// podía dejar el plato por partes y todo almuercero acababa con dos juegos de
// grupos («en el panel tengo como 4 sopas»).
//
// Dónde va cada grupo, y es la regla que evita volver a duplicarlos:
//   · De la CATEGORÍA, lo que comparten TODOS sus productos: el término de
//     cualquier hamburguesa, el tamaño de cualquier café.
//   · Del PRODUCTO, lo que solo tiene sentido en él: las partes de un
//     almuerzo, los pasos de un combo. Nunca las dos cosas para lo mismo.
//   · Como LISTA, lo que se repite en varios productos: los sabores de una
//     pizzería, que eligen la pizza y cada pizza del combo.
//
// El producto de ejemplo NACE AGOTADO siempre —lo impone la base, no esto—
// porque su precio es inventado: su dueño lo ve y lo edita, y nadie lo puede
// pedir hasta que lo marque disponible. ⚠️ Agotado y NO inactivo: en este
// sistema un producto inactivo es un producto BORRADO, y el panel no lo lista.
//
// ⚠️ El tipo solo RECOMIENDA al crear. La RPC `apply_business_template` no
// toca un negocio que ya tenga catálogo, así que esto jamás pisa decisiones
// manuales ni negocios existentes. Es la misma regla de `takes_orders`,
// `chat_mode` y `storefront_enabled`.
//
// Los nombres de tipo tienen que existir en el desplegable del panel
// (`apps/admin/src/features/clients/business-types.ts`) o el tipo no se puede
// elegir y la plantilla queda muerta. Lo vigila `plantillas-negocio.test.js`.
//
// ⚠️ AUTÓNOMO: solo `import type` (2026-10-07). `tests/sql/plantillas-reales.mjs`
// lo carga con Node SIN compilar —el CI del esquema no instala nada— y Node no
// resuelve un import relativo sin extensión. Un `import` de valores aquí
// rompería esa guardia. Los tiempos de preparación viven en `business-templates.ts`.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Misma normalización que usa el panel: minúsculas, sin espacios de sobra y
 * sin acentos, para que «Hamburguesería» y «hamburgueseria» sean el mismo
 * tipo. Se duplica a propósito —son cinco líneas— porque el panel es un
 * paquete aparte y no comparte código con el servidor.
 */
export const normalizeBusinessType = (value: string): string => value
  .trim()
  .toLocaleLowerCase('es')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

// ── Grupos que se repiten en muchas cartas ────────────────────────────────

const terminoDeLaCarne: TemplateGroup = {
  nombre: 'Término de la carne',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Término medio' },
    { nombre: 'Tres cuartos' },
    { nombre: 'Bien cocida' },
  ],
}

const extrasHamburguesa: TemplateGroup = {
  nombre: 'Extras',
  tipo: 'multiple',
  max: 6,
  opciones: [
    { nombre: 'Queso extra', recargo: 0.75 },
    { nombre: 'Tocino', recargo: 1 },
    { nombre: 'Huevo', recargo: 0.75 },
    { nombre: 'Doble carne', recargo: 2.5 },
    { nombre: 'Aguacate', recargo: 1 },
  ],
}

/**
 * Quitar ingredientes no cuesta nada, pero tiene que poder pedirse: si el
 * cliente no encuentra «sin cebolla» lo escribe en las notas, y las notas no
 * las lee la cocina hasta que el pedido ya está armado.
 */
const retirarIngredientes: TemplateGroup = {
  nombre: 'Retira ingredientes',
  tipo: 'multiple',
  max: 8,
  opciones: [
    { nombre: 'Sin cebolla' },
    { nombre: 'Sin tomate' },
    { nombre: 'Sin lechuga' },
    { nombre: 'Sin salsas' },
    { nombre: 'Sin pepinillos' },
  ],
}

const puntoDePicante: TemplateGroup = {
  nombre: 'Punto de picante',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Sin picante' },
    { nombre: 'Suave' },
    { nombre: 'Picante' },
    { nombre: 'Muy picante' },
  ],
}

const tamanoPorcion: TemplateGroup = {
  nombre: 'Tamaño',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Pequeño', recargo: 0 },
    { nombre: 'Mediano', recargo: 1.5 },
    { nombre: 'Grande', recargo: 3 },
  ],
}

const acompananteIncluido: TemplateGroup = {
  nombre: 'Acompañante',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Papas fritas' },
    { nombre: 'Arroz' },
    { nombre: 'Ensalada' },
    { nombre: 'Menestra' },
    { nombre: 'Patacones' },
  ],
}

const bebidaIncluida: TemplateGroup = {
  nombre: 'Bebida incluida',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Jugo natural' },
    { nombre: 'Cola personal' },
    { nombre: 'Agua' },
    { nombre: 'Té helado' },
  ],
}

// ── Categorías que se repiten ─────────────────────────────────────────────

const bebidas = (orden: number): TemplateCategory => ({ nombre: 'Bebidas', orden })
const postres = (orden: number): TemplateCategory => ({ nombre: 'Postres', orden })
const acompanantes = (orden: number): TemplateCategory => ({ nombre: 'Acompañantes', orden })

/** Lo que lee el dueño en el producto de ejemplo, que nace agotado. */
const COMO_USAR_EL_EJEMPLO = 'Ejemplo para guiarte: cámbiale el nombre, el precio y las opciones, '
  + 'y márcalo disponible cuando esté listo. Mientras siga agotado, nadie lo puede pedir.'

const ejemplo = (producto: TemplateProduct): TemplateProduct => ({
  descripcion: COMO_USAR_EL_EJEMPLO,
  tipo: producto.grupos?.length ? 'configurable' : 'simple',
  ...producto,
})

/**
 * El almuerzo de una familia, armado POR PARTES como lo tiene La Abuelita: una
 * sopa y un segundo forman un plato al precio del producto, y cada parte se
 * vende también suelta a su precio. La bebida no es parte —va gratis— y la
 * base la topa a una por plato (#363).
 *
 * ⚠️ Cuelga del PRODUCTO a la fuerza: `option_groups_parte_del_plato_check`
 * rechaza una parte colgada de una categoría. La plantilla de antes ponía
 * Sopa, Segundo, Guarnición y Bebida en la categoría, y por eso ningún
 * almuercero podía nacer con el plato que de verdad usa.
 */
const almuerzoPorPartes = (nombre: string): TemplateProduct => ejemplo({
  nombre,
  precio: 3.5,
  tipo: 'daily_menu',
  grupos: [
    {
      nombre: 'Sopa',
      tipo: 'quantity',
      obligatorio: true,
      min: 1,
      max: 100,
      cobro: 'included',
      parte: true,
      precioSuelto: 1.5,
      opciones: [{ nombre: 'Caldo de pollo' }, { nombre: 'Crema de zapallo' }],
    },
    {
      nombre: 'Segundo',
      tipo: 'quantity',
      obligatorio: true,
      min: 1,
      max: 100,
      cobro: 'included',
      parte: true,
      precioSuelto: 2.5,
      opciones: [
        { nombre: 'Seco de pollo' },
        { nombre: 'Carne asada' },
        { nombre: 'Pescado frito' },
      ],
    },
    {
      nombre: 'Bebida',
      // ⚠️ `max: 100` a propósito: el tope real es uno por plato y lo calcula
      // la base según lo que se pida. Un número fijo aquí sería el equivocado
      // en cuanto alguien pida dos almuerzos.
      tipo: 'quantity',
      obligatorio: true,
      min: 1,
      max: 100,
      cobro: 'included',
      opciones: [{ nombre: 'Jugo del día' }, { nombre: 'Limonada' }],
    },
  ],
})

/**
 * Arma una plantilla dejando el ORDEN puesto.
 *
 * ⚠️ El orden ya estaba escrito y se tiraba: `grupos: [terminoDeLaCarne,
 * extrasHamburguesa, retirarIngredientes]` dice exactamente cómo se piensa una
 * hamburguesa —primero el término, luego lo que se agrega, al final lo que se
 * quita— y como nadie rellenaba `orden`, la RPC los insertaba TODOS en cero.
 * Con todo empatado, el pedido y la ficha caían al desempate alfabético:
 * «Extras, Retira ingredientes, Término». El dueño podía arreglarlo con las
 * flechas de su panel, pero tenía que descubrirlo él.
 *
 * La posición en el array ES la intención, así que se usa. Un `orden` puesto a
 * mano gana, para poder intercalar sin renumerar lo demás.
 */
const ordenar = <T extends { orden?: number }>(lista: T[] | undefined, puesto: (item: T) => T) => (
  lista?.map((item, posicion) => puesto({ ...item, orden: item.orden ?? posicion }))
)

const ordenarGrupo = (grupo: TemplateGroup): TemplateGroup => ({
  ...grupo,
  opciones: ordenar(grupo.opciones, opcion => opcion),
})

const plantilla = (categorias: TemplateCategory[], listas?: TemplateList[]): BusinessTemplate => ({
  ...(listas ? {
    listas: listas.map(lista => ({
      ...lista,
      opciones: ordenar(lista.opciones, opcion => opcion) ?? [],
    })),
  } : {}),
  categorias: ordenar(categorias, categoria => ({
    ...categoria,
    grupos: ordenar(categoria.grupos, ordenarGrupo),
    productos: ordenar(categoria.productos, producto => ({
      ...producto,
      grupos: ordenar(producto.grupos, ordenarGrupo),
    })),
  })) ?? [],
})

// ── El catálogo, tipo por tipo ────────────────────────────────────────────
// La clave va normalizada: así entra igual «Hamburguesería» que lo que el
// panel manda de verdad.

const PLANTILLAS: Record<string, BusinessTemplate> = {
  hamburgueseria: plantilla([
    {
      nombre: 'Hamburguesas',
      orden: 0,
      grupos: [terminoDeLaCarne, extrasHamburguesa, retirarIngredientes],
      productos: [ejemplo({ nombre: 'Hamburguesa clásica', precio: 5.5, tipo: 'configurable' })],
    },
    { nombre: 'Combos', orden: 1, grupos: [acompananteIncluido, bebidaIncluida] },
    acompanantes(2),
    bebidas(3),
  ]),

  'comida rapida': plantilla([
    {
      nombre: 'Hamburguesas',
      orden: 0,
      grupos: [extrasHamburguesa, retirarIngredientes],
      productos: [ejemplo({ nombre: 'Hamburguesa sencilla', precio: 3.5, tipo: 'configurable' })],
    },
    { nombre: 'Salchipapas', orden: 1, grupos: [tamanoPorcion, retirarIngredientes] },
    { nombre: 'Hot dogs', orden: 2, grupos: [retirarIngredientes] },
    { nombre: 'Combos', orden: 3, grupos: [acompananteIncluido, bebidaIncluida] },
    bebidas(4),
  ]),

  // ⚠️ Sin un solo grupo en la categoría: el plato vive entero en su producto.
  // Los que había aquí son los que se duplicaban con «Armarlo por partes».
  almuerzos: plantilla([
    { nombre: 'Almuerzos', orden: 0, productos: [almuerzoPorPartes('Almuerzo del día')] },
    { nombre: 'Platos a la carta', orden: 1 },
    bebidas(2),
    postres(3),
  ]),

  'menu ejecutivo': plantilla([
    {
      nombre: 'Menú ejecutivo',
      orden: 0,
      productos: [{ ...almuerzoPorPartes('Menú ejecutivo del día'), precio: 5 }],
    },
    { nombre: 'Platos a la carta', orden: 1 },
    bebidas(2),
    postres(3),
  ]),

  'comida tipica': plantilla([
    {
      nombre: 'Platos típicos',
      orden: 0,
      grupos: [tamanoPorcion, acompananteIncluido],
      productos: [ejemplo({ nombre: 'Seco de chivo', precio: 6, tipo: 'configurable' })],
    },
    { nombre: 'Sopas y caldos', orden: 1, grupos: [tamanoPorcion] },
    acompanantes(2),
    bebidas(3),
  ]),

  desayunos: plantilla([
    {
      nombre: 'Desayunos',
      orden: 0,
      grupos: [
        {
          nombre: 'Huevos',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Revueltos' },
            { nombre: 'Fritos' },
            { nombre: 'Tortilla' },
            { nombre: 'Sin huevos', recargo: -0.5 },
          ],
        },
        bebidaIncluida,
      ],
      productos: [ejemplo({ nombre: 'Desayuno completo', precio: 3.5, tipo: 'configurable' })],
    },
    { nombre: 'Bolones y tigrillos', orden: 1, grupos: [retirarIngredientes] },
    { nombre: 'Panadería', orden: 2 },
    bebidas(3),
  ]),

  asadero: plantilla([
    {
      nombre: 'Asados',
      orden: 0,
      grupos: [terminoDeLaCarne, acompananteIncluido],
      productos: [ejemplo({ nombre: 'Asado de res', precio: 8, tipo: 'configurable' })],
    },
    { nombre: 'Combos familiares', orden: 1, grupos: [acompananteIncluido, bebidaIncluida] },
    acompanantes(2),
    bebidas(3),
  ]),

  parrillada: plantilla([
    {
      nombre: 'Parrilladas',
      orden: 0,
      grupos: [
        // El caso de `quantity`: una parrillada de cuatro porciones se arma
        // repartiéndolas entre cortes, no eligiendo uno solo.
        {
          nombre: 'Elige tus cortes',
          tipo: 'quantity',
          obligatorio: true,
          min: 1,
          max: 8,
          opciones: [
            { nombre: 'Lomo fino', recargo: 2 },
            { nombre: 'Chuleta' },
            { nombre: 'Chorizo' },
            { nombre: 'Morcilla' },
            { nombre: 'Pollo' },
            { nombre: 'Costilla', recargo: 1.5 },
          ],
        },
        terminoDeLaCarne,
      ],
      productos: [ejemplo({ nombre: 'Parrillada para dos', precio: 22, tipo: 'configurable' })],
    },
    { nombre: 'Platos individuales', orden: 1, grupos: [terminoDeLaCarne, acompananteIncluido] },
    acompanantes(2),
    bebidas(3),
  ]),

  'pollo asado': plantilla([
    {
      nombre: 'Pollo asado',
      orden: 0,
      grupos: [
        {
          nombre: 'Presa',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          // ⚠️ Iban las tres sin recargo: un pollo entero costaba lo mismo que
          // un cuarto. Con el producto de ejemplo delante se habría visto a la
          // primera; sin productos, nadie lo miró. El precio base es el cuarto.
          opciones: [
            { nombre: 'Cuarto de pollo' },
            { nombre: 'Medio pollo', recargo: 3 },
            { nombre: 'Pollo entero', recargo: 9 },
          ],
        },
        acompananteIncluido,
      ],
      productos: [ejemplo({ nombre: 'Pollo asado', precio: 3.5, tipo: 'configurable' })],
    },
    { nombre: 'Broaster', orden: 1, grupos: [acompananteIncluido] },
    acompanantes(2),
    bebidas(3),
  ]),

  marisqueria: plantilla([
    {
      nombre: 'Ceviches',
      orden: 0,
      grupos: [tamanoPorcion, puntoDePicante],
      productos: [ejemplo({ nombre: 'Ceviche de camarón', precio: 7, tipo: 'configurable' })],
    },
    { nombre: 'Encebollados', orden: 1, grupos: [tamanoPorcion] },
    { nombre: 'Arroces y platos marinos', orden: 2, grupos: [acompananteIncluido] },
    { nombre: 'Sopas', orden: 3, grupos: [tamanoPorcion] },
    bebidas(4),
  ]),

  sushi: plantilla([
    {
      nombre: 'Rolls',
      orden: 0,
      grupos: [
        {
          nombre: 'Salsas',
          tipo: 'multiple',
          max: 4,
          opciones: [
            { nombre: 'Soya' },
            { nombre: 'Teriyaki' },
            { nombre: 'Acevichada', recargo: 0.5 },
            { nombre: 'Sriracha' },
          ],
        },
        { ...retirarIngredientes, opciones: [{ nombre: 'Sin palta' }, { nombre: 'Sin queso crema' }, { nombre: 'Sin ajonjolí' }] },
      ],
      productos: [ejemplo({ nombre: 'California roll', precio: 8, tipo: 'configurable' })],
    },
    { nombre: 'Combos', orden: 1 },
    { nombre: 'Entradas', orden: 2 },
    bebidas(3),
  ]),

  'comida mexicana': plantilla([
    {
      nombre: 'Tacos',
      orden: 0,
      grupos: [puntoDePicante, retirarIngredientes],
      productos: [ejemplo({ nombre: 'Tacos al pastor', precio: 6, tipo: 'configurable' })],
    },
    { nombre: 'Burritos y quesadillas', orden: 1, grupos: [puntoDePicante, retirarIngredientes] },
    { nombre: 'Nachos', orden: 2, grupos: [puntoDePicante] },
    bebidas(3),
  ]),

  'comida china': plantilla([
    {
      nombre: 'Chaulafán',
      orden: 0,
      grupos: [tamanoPorcion],
      productos: [ejemplo({ nombre: 'Chaulafán especial', precio: 5.5, tipo: 'configurable' })],
    },
    { nombre: 'Tallarines', orden: 1, grupos: [tamanoPorcion] },
    { nombre: 'Chifa combinados', orden: 2, grupos: [tamanoPorcion, acompananteIncluido] },
    bebidas(3),
  ]),

  'comida saludable': plantilla([
    {
      nombre: 'Bowls',
      orden: 0,
      grupos: [
        {
          nombre: 'Base',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Quinua' },
            { nombre: 'Arroz integral' },
            { nombre: 'Hojas verdes' },
          ],
        },
        {
          nombre: 'Proteína',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Pollo' },
            { nombre: 'Atún' },
            { nombre: 'Tofu' },
            { nombre: 'Sin proteína', recargo: -1 },
          ],
        },
        {
          nombre: 'Toppings',
          tipo: 'multiple',
          max: 5,
          opciones: [
            { nombre: 'Aguacate', recargo: 1 },
            { nombre: 'Semillas' },
            { nombre: 'Queso', recargo: 0.75 },
            { nombre: 'Frutos secos', recargo: 1 },
          ],
        },
      ],
      productos: [ejemplo({ nombre: 'Bowl de la casa', precio: 7, tipo: 'configurable' })],
    },
    { nombre: 'Ensaladas', orden: 1 },
    { nombre: 'Wraps', orden: 2 },
    bebidas(3),
  ]),

  // Los sabores son LISTA, no grupo de la categoría: los eligen el helado de
  // una bola, el de dos y la copa, cada uno con su cuenta de bolas. Con la
  // lista, un sabor nuevo se escribe una vez y aparece en todos.
  heladeria: plantilla([
    {
      nombre: 'Helados',
      orden: 0,
      productos: [ejemplo({
        nombre: 'Helado de 2 bolas',
        precio: 2.5,
        grupos: [
          {
            nombre: 'Sabores',
            descripcion: 'Elige 2 bolas: pueden ser del mismo sabor.',
            tipo: 'quantity',
            obligatorio: true,
            // Tantas bolas como dice el nombre. Un helado de 3 bolas es otro
            // producto con su propio grupo enlazado a la misma lista.
            min: 2,
            max: 2,
            lista: 'Sabores',
          },
          {
            nombre: 'Toppings',
            tipo: 'multiple',
            max: 4,
            opciones: [
              { nombre: 'Chispas' },
              { nombre: 'Salsa de chocolate', recargo: 0.5 },
              { nombre: 'Galleta', recargo: 0.5 },
              { nombre: 'Crema chantillí', recargo: 0.75 },
            ],
          },
        ],
      })],
    },
    { nombre: 'Copas y sundaes', orden: 1 },
    { nombre: 'Malteadas', orden: 2 },
  ], [
    {
      nombre: 'Sabores',
      opciones: [
        { nombre: 'Vainilla' },
        { nombre: 'Chocolate' },
        { nombre: 'Frutilla' },
        { nombre: 'Mora' },
        { nombre: 'Ron pasas' },
      ],
    },
  ]),

  pasteleria: plantilla([
    {
      nombre: 'Tortas',
      orden: 0,
      grupos: [
        {
          nombre: 'Tamaño',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: '10 porciones' },
            { nombre: '20 porciones', recargo: 12 },
            { nombre: '30 porciones', recargo: 24 },
          ],
        },
        {
          nombre: 'Relleno',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Manjar' },
            { nombre: 'Chocolate' },
            { nombre: 'Frutas' },
            { nombre: 'Sin relleno' },
          ],
        },
      ],
      productos: [ejemplo({ nombre: 'Torta de la casa', precio: 15, tipo: 'configurable' })],
    },
    { nombre: 'Porciones individuales', orden: 1 },
    { nombre: 'Bocaditos', orden: 2 },
    bebidas(3),
  ]),

  postres: plantilla([
    {
      nombre: 'Postres',
      orden: 0,
      grupos: [tamanoPorcion],
      productos: [ejemplo({ nombre: 'Tres leches', precio: 2.5, tipo: 'configurable' })],
    },
    { nombre: 'Tortas', orden: 1 },
    bebidas(2),
  ]),

  batidos: plantilla([
    {
      nombre: 'Batidos',
      orden: 0,
      grupos: [
        {
          nombre: 'Frutas',
          tipo: 'multiple',
          obligatorio: true,
          min: 1,
          max: 3,
          opciones: [
            { nombre: 'Frutilla' },
            { nombre: 'Mora' },
            { nombre: 'Banana' },
            { nombre: 'Mango' },
            { nombre: 'Maracuyá' },
          ],
        },
        {
          nombre: 'Con qué se prepara',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Leche' },
            { nombre: 'Agua', recargo: -0.25 },
            { nombre: 'Yogurt', recargo: 0.5 },
          ],
        },
        tamanoPorcion,
      ],
      productos: [ejemplo({ nombre: 'Batido de frutas', precio: 3, tipo: 'configurable' })],
    },
    { nombre: 'Jugos', orden: 1, grupos: [tamanoPorcion] },
    { nombre: 'Snacks', orden: 2 },
  ]),

  jugos: plantilla([
    {
      nombre: 'Jugos naturales',
      orden: 0,
      grupos: [
        {
          nombre: 'Fruta',
          tipo: 'multiple',
          obligatorio: true,
          min: 1,
          max: 3,
          opciones: [
            { nombre: 'Naranja' },
            { nombre: 'Mora' },
            { nombre: 'Maracuyá' },
            { nombre: 'Tomate de árbol' },
            { nombre: 'Papaya' },
          ],
        },
        tamanoPorcion,
      ],
      productos: [ejemplo({ nombre: 'Jugo natural', precio: 2, tipo: 'configurable' })],
    },
    { nombre: 'Batidos', orden: 1, grupos: [tamanoPorcion] },
    { nombre: 'Desayunos', orden: 2 },
  ]),

  carniceria: plantilla([
    {
      nombre: 'Cortes de res',
      orden: 0,
      grupos: [
        {
          nombre: 'Preparación',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Entero' },
            { nombre: 'En bistec' },
            { nombre: 'En trozos' },
            { nombre: 'Molido' },
          ],
        },
      ],
      productos: [ejemplo({ nombre: 'Lomo de res (libra)', precio: 4.5, tipo: 'configurable' })],
    },
    { nombre: 'Cortes de cerdo', orden: 1 },
    { nombre: 'Pollo', orden: 2 },
    { nombre: 'Embutidos', orden: 3 },
    { nombre: 'Preparados y adobados', orden: 4 },
  ]),

  'emprendimiento de comida': plantilla([
    {
      nombre: 'Nuestros platos',
      orden: 0,
      grupos: [tamanoPorcion, retirarIngredientes],
      productos: [ejemplo({ nombre: 'Plato de la casa', precio: 5, tipo: 'configurable' })],
    },
    { nombre: 'Combos', orden: 1, grupos: [bebidaIncluida] },
    bebidas(2),
  ]),

  // Los que ya existían en el desplegable y también son cocina.
  //
  // Armada como quedó Monster Pizza el 2026-09-16, que es lo que se aprendió
  // ahí: los sabores son UNA lista que usan la pizza y cada pizza del combo; el
  // combo pide un sabor POR pizza («Sabor de la 1.ª pizza», «… de la 2.ª»), y
  // nada de pasos falsos como «1. Elige tu pizza» que no eligen nada.
  pizzeria: plantilla([
    {
      nombre: 'Pizzas',
      orden: 0,
      productos: [ejemplo({
        nombre: 'Pizza',
        precio: 6,
        grupos: [
          {
            nombre: 'Tamaño',
            tipo: 'single',
            obligatorio: true,
            min: 1,
            max: 1,
            opciones: [
              { nombre: 'Personal' },
              { nombre: 'Mediana', recargo: 4 },
              { nombre: 'Familiar', recargo: 8 },
            ],
          },
          {
            nombre: 'Masa',
            tipo: 'single',
            obligatorio: true,
            min: 1,
            max: 1,
            opciones: [
              { nombre: 'Tradicional' },
              { nombre: 'Delgada' },
              { nombre: 'Borde de queso', recargo: 1.5 },
            ],
          },
          {
            nombre: 'Sabor',
            descripcion: 'Hasta 2 sabores, mitad y mitad: se cobra el más caro.',
            tipo: 'multiple',
            obligatorio: true,
            min: 1,
            max: 2,
            cobro: 'highest_selected',
            lista: 'Sabores',
          },
          {
            nombre: 'Ingredientes extra',
            tipo: 'multiple',
            max: 6,
            opciones: [
              { nombre: 'Queso extra', recargo: 1.5 },
              { nombre: 'Peperoni', recargo: 1.5 },
              { nombre: 'Champiñones', recargo: 1 },
              { nombre: 'Jamón', recargo: 1.5 },
            ],
          },
        ],
      })],
    },
    {
      nombre: 'Combos',
      orden: 1,
      productos: [ejemplo({
        nombre: 'Combo pareja',
        precio: 15,
        tipo: 'combo',
        grupos: [
          {
            nombre: 'Sabor de la 1.ª pizza',
            tipo: 'single',
            obligatorio: true,
            min: 1,
            max: 1,
            lista: 'Sabores',
          },
          {
            nombre: 'Sabor de la 2.ª pizza',
            tipo: 'single',
            obligatorio: true,
            min: 1,
            max: 1,
            lista: 'Sabores',
          },
          { ...bebidaIncluida, opciones: [{ nombre: 'Cola 1 litro' }, { nombre: 'Agua' }, { nombre: 'Té helado' }] },
        ],
      })],
    },
    acompanantes(2),
    bebidas(3),
  ], [
    {
      nombre: 'Sabores',
      opciones: [
        { nombre: 'Margarita' },
        { nombre: 'Hawaiana' },
        { nombre: 'Peperoni' },
        { nombre: 'Vegetariana' },
        { nombre: 'Pollo con champiñones' },
        { nombre: 'Mexicana', recargo: 1 },
        { nombre: 'Cuatro quesos', recargo: 1.5 },
      ],
    },
  ]),

  restaurante: plantilla([
    { nombre: 'Entradas', orden: 0 },
    {
      nombre: 'Platos fuertes',
      orden: 1,
      grupos: [acompananteIncluido],
      productos: [ejemplo({ nombre: 'Lomo a la plancha', precio: 9, tipo: 'configurable' })],
    },
    { nombre: 'Sopas', orden: 2, grupos: [tamanoPorcion] },
    postres(3),
    bebidas(4),
  ]),

  cafeteria: plantilla([
    {
      nombre: 'Café',
      orden: 0,
      grupos: [
        {
          nombre: 'Tamaño',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Pequeño' },
            { nombre: 'Mediano', recargo: 0.5 },
            { nombre: 'Grande', recargo: 1 },
          ],
        },
        {
          nombre: 'Tipo de leche',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Entera' },
            { nombre: 'Deslactosada' },
            { nombre: 'De almendras', recargo: 0.75 },
            { nombre: 'Sin leche' },
          ],
        },
      ],
      productos: [ejemplo({ nombre: 'Capuchino', precio: 2.5, tipo: 'configurable' })],
    },
    { nombre: 'Panadería', orden: 1 },
    postres(2),
    { nombre: 'Sánduches', orden: 3, grupos: [retirarIngredientes] },
  ]),

  panaderia: plantilla([
    { nombre: 'Pan del día', orden: 0, productos: [ejemplo({ nombre: 'Pan de yuca', precio: 0.4 })] },
    { nombre: 'Pastelería', orden: 1 },
    { nombre: 'Bocaditos', orden: 2 },
    bebidas(3),
  ]),
}

/**
 * La plantilla del tipo, o `null` si ese tipo no tiene ninguna —que es lo
 * normal: una ferretería o una perfumería no traen carta.
 *
 * Casa primero por tipo exacto y después por contención, igual que las
 * recomendaciones del panel: un tipo escrito a mano como «hamburguesería
 * gourmet» debe nacer con la carta de hamburguesería. Ante varias plantillas
 * candidatas gana la de nombre más largo, que es la más específica: «comida
 * rápida» no puede perder contra un hipotético «comida».
 */
export const templateForBusinessType = (type?: string | null): BusinessTemplate | null => {
  const normalized = normalizeBusinessType(type || '')
  if (!normalized) return null

  const exacta = PLANTILLAS[normalized]
  if (exacta) return exacta

  const candidatas = Object.keys(PLANTILLAS)
    .filter(clave => normalized.includes(clave))
    .sort((a, b) => b.length - a.length)

  return candidatas.length ? PLANTILLAS[candidatas[0]] as BusinessTemplate : null
}

/** Los tipos con plantilla. Lo usa la prueba que los contrasta con el panel. */
export const businessTypesWithTemplate = (): string[] => Object.keys(PLANTILLAS)
