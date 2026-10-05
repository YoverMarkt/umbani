import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const cliente = require('../dist/db/client')

// ═══════════════════════════════════════════════════════════════════════════
// BUSCAR SIN IA
//
// El comportamiento se prueba de verdad contra PostgreSQL en
// `verificar-esquema.sql` —es donde vive la lógica—. Aquí se vigila lo que un
// refactor puede llevarse sin que nada falle: el ámbito, las tres capas y la
// calificación de esquema que evita el fallo del search_path.
// ═══════════════════════════════════════════════════════════════════════════

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const SQL = readFileSync(`${serverDir}/migration-2026-08-21-marketplace-busqueda.sql`, 'utf8')
const SCHEMA = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const sinComentarios = sql => sql.replace(/--[^\n]*/g, '')

afterEach(() => { vi.restoreAllMocks() })

describe('el diccionario que distingue «no entiendo» de «no tengo»', () => {
  // Devuelve la etiqueta de la categoría a la que apunta el alias, o null.
  const conFilas = (alias, categoria) => {
    vi.spyOn(cliente, 'from').mockImplementation((tabla) => {
      if (tabla === 'marketplace_search_aliases') {
        return {
          select: () => ({ in: () => ({ limit: async () => ({ data: alias, error: null }) }) }),
        }
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: categoria, error: null }) }) }),
      }
    })
  }

  it('«quiero pollo asado» se reconoce y devuelve su categoría', async () => {
    conFilas([{ category_code: 'asados' }], { label: 'Asados y parrilladas' })
    await expect(db.marketplaceKnownTerm('quiero pollo asado'))
      .resolves.toEqual({ code: 'asados', label: 'Asados y parrilladas' })
  })

  // Palabra por palabra, no la frase entera: el alias es «pollo», no «quiero
  // pollo asado». Es el mismo motivo por el que existe la normalización.
  it('busca por palabras y descarta las cortas', async () => {
    const capturado = []
    vi.spyOn(cliente, 'from').mockImplementation(() => ({
      select: () => ({
        in: (_col, valores) => { capturado.push(...valores); return { limit: async () => ({ data: [], error: null }) } },
      }),
    }))
    await db.marketplaceKnownTerm('me das un POLLO, con papas')
    // Sin tildes, en minúsculas, sin puntuación y sin palabras de 1-2 letras.
    expect(capturado).toContain('pollo')
    expect(capturado).toContain('papas')
    expect(capturado).not.toContain('me')
    expect(capturado).not.toContain('un')
  })

  it('una tontería no casa con nada', async () => {
    conFilas([], null)
    await expect(db.marketplaceKnownTerm('asdfghjkl')).resolves.toBeNull()
  })

  it('un texto vacío no gasta ni una consulta', async () => {
    const from = vi.spyOn(cliente, 'from')
    await expect(db.marketplaceKnownTerm('   ')).resolves.toBeNull()
    expect(from).not.toHaveBeenCalled()
  })

  // Falla hacia null: el llamador responde entonces lo de siempre.
  it('un fallo de la base devuelve null, no lanza', async () => {
    vi.spyOn(cliente, 'from').mockImplementation(() => ({
      select: () => ({ in: () => ({ limit: async () => ({ data: null, error: { message: 'caída' } }) }) }),
    }))
    await expect(db.marketplaceKnownTerm('pollo')).resolves.toBeNull()
  })
})

describe('el ámbito de la búsqueda', () => {
  it('en global busca locales y no productos sueltos', async () => {
    const rpc = vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: [], error: null })
    await db.searchMarketplaceBusinesses('quiero ceviche')
    // ⚠️ Sin ciudad viaja `null`, y la base no devuelve nada (falla cerrado).
    expect(rpc).toHaveBeenCalledWith('marketplace_buscar_negocios', {
      p_query: 'quiero ceviche', p_limite: 8, p_city_id: null,
    })
    await db.searchMarketplaceBusinesses('quiero ceviche', 8, 'ciudad-chone')
    expect(rpc).toHaveBeenLastCalledWith('marketplace_buscar_negocios', {
      p_query: 'quiero ceviche', p_limite: 8, p_city_id: 'ciudad-chone',
    })
  })

  it('dentro de un local, el negocio viaja SIEMPRE a la base', async () => {
    // ⚠️ Sin `p_business_id`, «también quiero una Coca Cola» traería la de otro
    // local — y un carrito solo puede tener productos de un negocio.
    const rpc = vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: [], error: null })
    await db.searchMarketplaceProducts('biz-1', 'coca cola')
    expect(rpc).toHaveBeenCalledWith('marketplace_buscar_productos', {
      p_business_id: 'biz-1', p_query: 'coca cola', p_limite: 8,
    })
  })

  it('un fallo de la base sube, no devuelve «no encontré nada»', async () => {
    // Decirle «no hay» a quien sí tiene dónde pedir es peor que un error.
    vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: null, error: { message: 'caída' } })
    await expect(db.searchMarketplaceBusinesses('ceviche')).rejects.toThrow('caída')
    await expect(db.searchMarketplaceProducts('b', 'x')).rejects.toThrow('caída')
  })
})

describe('las tres capas', () => {
  it('están las tres, y por eso «cebiche» encuentra «ceviche»', () => {
    // El diccionario español reduce «ceviche» a 'cevich' y «cebiche» a
    // 'cebich': por texto NO casan. Quitar la capa de parecido dejaría fuera
    // media clientela sin que ninguna prueba de texto se enterase.
    expect(SQL).toContain('marketplace_search_aliases')
    expect(SQL).toContain("to_tsvector('spanish'")
    expect(SQL).toContain('extensions.similarity')
  })

  it('el parecido compara palabra por palabra, no la frase entera', () => {
    // Medido: «cebiche» contra «ceviche de camarones» da 0.217 con el nombre
    // completo —bajo el umbral de 0.3— y 0.455 con su mejor palabra.
    expect(SQL).toMatch(/unnest\(string_to_array\(lower\(p\.name\), ' '\)\)/)
  })

  it('normaliza la frase antes de buscar', () => {
    // «quiero ceviche» sin normalizar encontraba UN local de tres: el alias no
    // casa con la frase entera y `plainto_tsquery` exige TODAS las palabras.
    expect(SQL).toContain('marketplace_normalizar_consulta')
    for (const muletilla of ['quiero', 'tienen', 'hola', 'favor']) {
      expect(SQL, muletilla).toContain(`'${muletilla}'`)
    }
  })

  it('el alias se prueba también palabra por palabra', () => {
    // La lista de muletillas nunca estará completa; sin esto, una sola que se
    // cuele deja la capa más barata sin casar.
    expect(SQL).toMatch(/a\.term = any\(string_to_array\(c\.texto, ' '\)\)/)
  })
})

describe('el fallo que dejó el canal mudo cinco días no se repite', () => {
  it('las funciones de pg_trgm se llaman calificadas con su esquema', () => {
    // Supabase instala las extensiones fuera de `public`. Llamarlas sin
    // calificar depende del search_path, y eso es exactamente lo que reventó
    // en julio de 2026 con digest() de pgcrypto.
    const ejecutable = sinComentarios(SQL)
    const sinCalificar = [...ejecutable.matchAll(/(?<!extensions\.)\b(similarity|unaccent)\s*\(/g)]
    expect(
      sinCalificar.map(m => m[1]),
      'Estas llamadas dependen del search_path en vez de calificar su esquema',
    ).toEqual([])
  })

  it('crea las extensiones en el esquema donde Supabase las pone', () => {
    for (const ext of ['pg_trgm', 'unaccent']) {
      expect(SQL, ext).toMatch(
        new RegExp(`create extension if not exists ${ext} with schema extensions`),
      )
    }
  })

  it('el índice de trigramas califica también su clase de operadores', () => {
    // `gin_trgm_ops` se resuelve por search_path al crear el índice.
    expect(SQL).toContain('extensions.gin_trgm_ops')
  })
})

describe('la búsqueda respeta lo que puede atender', () => {
  it('excluye lo que no puede recibir un pedido ahora', () => {
    // Encontrar un local que no puede atender es peor que no encontrar
    // ninguno: el cliente ya eligió y gastó un mensaje.
    const disponibles = SQL.slice(SQL.indexOf('disponibles as ('), SQL.indexOf('por_alias'))
    for (const condicion of ['b.active', 'b.suspended is not true', 'b.takes_orders', 'b.storefront_enabled']) {
      expect(disponibles, condicion).toContain(condicion)
    }
  })

  it('schema.sql y la migración dicen lo mismo', () => {
    for (const funcion of [
      'marketplace_normalizar_consulta',
      'marketplace_buscar_negocios',
      'marketplace_buscar_productos',
    ]) {
      expect(SCHEMA, funcion).toContain(`function public.${funcion}`)
    }
  })

  it('no recrea ninguna función del dinero', () => {
    expect(sinComentarios(SQL)).not.toMatch(/create_storefront_order|set_order_status/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Y AHORA SÍ LA LLAMA ALGUIEN (2026-08-25)
//
// Hasta esta fecha la búsqueda estaba CONSTRUIDA Y DESCONECTADA: tres capas,
// su migración, sus pruebas… y ni un llamador fuera de su repositorio.
// `marketplace-entry.ts` no la mencionaba, así que «quiero ceviche» recibía
// «🙏 No te entendí» aunque la base supiera resolverlo. Octavo caso del
// patrón; por eso estas pruebas ejercen la función REAL, no leen el archivo.
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIAS = [{ city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]
const CEVICHERIA = { id: 'biz-9', slug: 'el-puerto', name: 'El Puerto', type: 'marisquería' }

const armarEntrada = ({ hits = [], buscar, conocido = null } = {}) => {
  const conversacion = { valor: null }
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: null }),
    getConversation: vi.fn(async () => conversacion.valor),
    advanceConversation: vi.fn(async (_id, patch) => {
      conversacion.valor = {
        current_state: patch.state || 'navegando',
        selected_business_id: patch.clearBusiness ? null : (patch.businessId ?? null),
        shopping_locked: Boolean(patch.shoppingLocked),
        flow_state: patch.flowState ?? null,
        version: (conversacion.valor?.version || 0) + 1,
      }
      return { conflicto: false }
    }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    // ⚠️ RESPONDE SEGÚN LA CATEGORÍA, no siempre lo mismo (2026-09-23).
    //
    // Antes devolvía Monster Pizza para CUALQUIER código, y eso escondía un
    // caso real: cuando el chat entiende «pizzza» y va a buscar los locales de
    // esa categoría, un simulacro que contesta a todo haría pasar por bueno
    // enseñar una pizzería como si fuera un asadero.
    getMarketplaceBusinesses: vi.fn(async (code) => (
      code === 'pizzerias'
        ? [{ id: 'biz-1', slug: 'monster-pizza', name: 'Monster Pizza', type: 'pizzería', prep_min: 30 }]
        : []
    )),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-9', name: 'El Puerto', slug: 'el-puerto',
      storefront_enabled: true, takes_orders: true,
    }),
    getPolicies: vi.fn().mockResolvedValue({ welcome_message: null }),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido: true, respuestas: 1 }),
    isContactBlocked: vi.fn().mockResolvedValue(false),
    claimPlatformBlockState: vi.fn().mockResolvedValue({ bloqueado: false }),
    claimBlockedNotice: vi.fn().mockResolvedValue(false),
    searchMarketplaceBusinesses: buscar || vi.fn().mockResolvedValue(hits),
    // ⚠️ Desde el 2026-09-18 devuelve {code, label}: el chat enseña la
    // etiqueta y el registro del menú guarda el código, que es lo que
    // convierte «no lo tengo» en demanda medible.
    // ⚠️ El CÓDIGO importa desde el 2026-09-23: es con él con lo que se buscan
    // los locales de la categoría entendida. Se admite una cadena —el código
    // cae en `asados`, como siempre— o un `{code, label}` explícito.
    marketplaceKnownTerm: vi.fn().mockResolvedValue(
      typeof conocido === 'string'
        ? { code: 'asados', label: conocido }
        : (conocido || null),
    ),
  }
  return {
    database,
    enviados,
    deps: {
      database,
      send: async (reply, options) => { enviados.push({ reply, options }) },
      issueLink: vi.fn().mockResolvedValue('https://umbani.test/s/token'),
      tipoPideEnChat: vi.fn().mockResolvedValue(false),
      avanzarMenu: vi.fn(), crearPedido: vi.fn(), crearPedidoCompleto: vi.fn(),
    },
  }
}

const escribir = async (deps, texto) => {
  const { handleMarketplaceMessage } = await import('../dist/services/marketplace-entry.js')
  await handleMarketplaceMessage({ from: '593900000825', text: texto }, deps)
}

describe('la búsqueda, conectada al flujo', () => {
  it('«quiero ceviche» encuentra el local en vez de reprochar', async () => {
    const { deps, enviados, database } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero ceviche')

    // En la ciudad del cliente (2026-10-05).
    expect(database.searchMarketplaceBusinesses).toHaveBeenCalledWith('quiero ceviche', 9, 'ciudad-chone')
    const texto = enviados.map(e => e.reply).join('\n')
    expect(texto).not.toContain('no te puedo ayudar por aquí')
    // El local va en las OPCIONES: en WhatsApp es una fila de la lista, no
    // texto del mensaje.
    expect(enviados.flatMap(e => e.options)).toContain('El Puerto')
    // Se dice QUÉ se buscó: si no, una lista de locales tras escribir una
    // frase parece que el bot cambió de tema.
    expect(texto).toContain('quiero ceviche')
  })

  // El menú MANDA. Si se buscara primero, quien está eligiendo de la lista
  // acabaría en una búsqueda de texto libre.
  it('elegir del menú NO dispara la búsqueda', async () => {
    const { deps, database } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    await escribir(deps, '🍕 Pizzerías')
    expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
  })

  it('tocar un resultado entra en ese local, como si viniera del menú', async () => {
    const { deps, enviados } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    await escribir(deps, 'quiero ceviche')
    enviados.length = 0
    await escribir(deps, 'El Puerto')

    expect(deps.issueLink).toHaveBeenCalled()
    expect(enviados.map(e => e.reply).join('')).toContain('umbani.test/s/token')
  })

  // Sin resultados, el cliente recibe exactamente lo de antes.
  it('si no encuentra nada, responde como siempre', async () => {
    const { deps, enviados } = armarEntrada({ hits: [] })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero sushi de wagyu')
    expect(enviados.map(e => e.reply).join('')).toContain('no te puedo ayudar por aquí')
  })

  // La búsqueda es una MEJORA sobre «no te entendí»: un fallo suyo no puede
  // dejar al cliente sin respuesta.
  it('si la búsqueda revienta, el cliente recibe su respuesta igual', async () => {
    const { deps, enviados } = armarEntrada({
      buscar: vi.fn().mockRejectedValue(new Error('trigramas caídos')),
    })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero ceviche')
    expect(enviados.map(e => e.reply).join('')).toContain('no te puedo ayudar por aquí')
  })

  // Dentro de un local el ámbito es ese local: traerle el ceviche de otro
  // negocio metería en el carrito un producto que no puede estar ahí.
  it('con local elegido NO busca en todo el marketplace', async () => {
    const { deps, database } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    await escribir(deps, '🍕 Pizzerías')
    await escribir(deps, 'Monster Pizza')
    database.searchMarketplaceBusinesses.mockClear()
    await escribir(deps, 'quiero ceviche')
    expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
  })

  // Un saludo no es una búsqueda: no se gasta una consulta en «hola».
  it('un saludo no dispara la búsqueda', async () => {
    const { deps, database } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
  })

  // ⚠️ Y un saludo DENTRO de una búsqueda vuelve a la portada (2026-09-13).
  //
  // Lo vio el dueño en su teléfono: escribió «Hola buenas» y recibió
  // «🔎 Esto encontré para *Quiero comer pizza*» — la búsqueda anterior,
  // repintada, dos veces seguidas porque lo intentó otra vez.
  //
  // La cabecera de una búsqueda AFIRMA QUE PREGUNTASTE ALGO, y repintarla ante
  // un saludo le atribuye al cliente una frase que no escribió. Desde su lado
  // se lee como que el bot no lo escuchó — justo el reproche que `esSaludo`
  // nació para evitar. (En la lista de LOCALES sí se repinta: «🍕 Pizzerías ·
  // elige un local» solo dice dónde estás, no te atribuye nada.)
  it('un saludo DENTRO de una búsqueda devuelve la portada, no la búsqueda vieja', async () => {
    const { deps, database, enviados } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    await escribir(deps, 'quiero ceviche')
    enviados.length = 0
    database.searchMarketplaceBusinesses.mockClear()

    await escribir(deps, 'Hola buenas')

    const texto = enviados.map(e => e.reply).join('\n')
    // 1. No se le atribuye la pregunta de antes.
    expect(texto, texto).not.toContain('Esto encontré')
    expect(texto, texto).not.toContain('ceviche')
    // 2. Se le recibe, que es lo que pedía el saludo.
    expect(texto, texto).toContain('Bienvenido')
    // 3. Y no se gasta una consulta en repetir una búsqueda que nadie pidió.
    expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
  })

  // ⚠️ Una FOTO tampoco (2026-09-06). «[foto]» es el marcador que pone el
  // webhook cuando llega una imagen que no es comprobante —sin pedido
  // esperando pago la media ni se descarga—, y se estaba mandando a la
  // búsqueda como si el cliente hubiera escrito la palabra: DOS consultas a
  // la base por cada foto suelta, los locales y el diccionario, que no pueden
  // encontrar nada. El dueño lo destapó subiendo una foto cualquiera.
  it('una foto, una nota de voz o una ubicación NO disparan la búsqueda', async () => {
    for (const marcador of ['[foto]', '[nota de voz]', '[ubicación]']) {
      const { deps, database, enviados } = armarEntrada({ hits: [CEVICHERIA] })
      await escribir(deps, 'hola')
      enviados.length = 0
      await escribir(deps, marcador)

      expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
      expect(database.marketplaceKnownTerm).not.toHaveBeenCalled()
      // Y no se queda callado: se le nombra lo que mandó y se le repiten las
      // categorías, que es lo que sí puede tocar.
      const texto = enviados.map(e => e.reply).join('\n')
      expect(texto).not.toContain('no te puedo ayudar por aquí')
      expect(enviados.flatMap(e => e.options)).toContain('🍕 Pizzerías')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// «NO TE ENTENDÍ» vs «TE ENTIENDO, PERO NO LO TENGO» (2026-08-25)
//
// El dueño lo probó y lo vio: escribir «pollo» devolvía «🙏 No te entendí».
// Y «pollo» SE ENTIENDE — el alias existe y apunta a `asados`; lo que falta es
// un asadero dado de alta. Llamarle tonto a quien escribió bien es de las
// cosas que hacen que una app parezca tonta, y le pasa justo al cliente que
// sabe lo que quiere.
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// CUANDO SE ENTIENDE **Y SÍ HAY** LOCALES (2026-09-23)
//
// El caso que lo pidió: el dueño escribió «Parrilladas» (plural) y luego
// preguntó por «pizzza», «seviche». Se decidió NO pedirle al cliente que
// escriba mejor —las apps grandes no lo hacen— sino entender y actuar.
//
// ⚠️ EL RIESGO DE ESTE CAMBIO, y por eso esta prueba: si el término se
// entiende pero se responde «todavía no tenemos Pizzerías» TENIENDO una, se le
// estaría mintiendo — y es la peor mentira, la que manda al cliente a otra app
// a buscar lo que aquí sí hay.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuando se entiende y SÍ hay locales', () => {
  it('enseña los locales en vez de decir que no los hay', async () => {
    const { deps, enviados } = armarEntrada({
      hits: [], conocido: { code: 'pizzerias', label: 'Pizzerías' },
    })
    await escribir(deps, 'hola')
    enviados.length = 0
    // La búsqueda literal no lo encuentra (es una errata), pero el término sí
    // se reconoce.
    await escribir(deps, 'pizzza')

    const texto = enviados.map(e => e.reply).join('\n')
    expect(texto).not.toContain('Todavía no tenemos')
    expect(texto).not.toContain('no te puedo ayudar por aquí')
    // Se dice lo que se entendió, en una línea y sin regañar.
    expect(texto).toContain('Pizzerías')
    // Y se le enseña el local de verdad, que es a lo que venía.
    expect(enviados.flatMap(e => e.options).join(' ')).toContain('Monster Pizza')
  })

  it('NO le pide que escriba mejor: nunca se le regaña', async () => {
    const { deps, enviados } = armarEntrada({
      hits: [], conocido: { code: 'pizzerias', label: 'Pizzerías' },
    })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'pizzza')

    const texto = enviados.map(e => e.reply).join('\n').toLowerCase()
    for (const regano of ['escribe bien', 'escriba bien', 'error', 'incorrecto', 'mal escrito']) {
      expect(texto, `no puede regañar con «${regano}»`).not.toContain(regano)
    }
  })
})

describe('cuando se entiende pero no hay locales', () => {
  it('lo dice con su nombre, y ofrece lo que sí hay', async () => {
    const { deps, enviados } = armarEntrada({ hits: [], conocido: 'Asados y parrilladas' })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero pollo asado')

    const texto = enviados.map(e => e.reply).join('\n')
    expect(texto).not.toContain('no te puedo ayudar por aquí')
    expect(texto).toContain('Asados y parrilladas')
    // No es una calle sin salida: se le enseña lo que sí puede pedir.
    expect(enviados.flatMap(e => e.options)).toContain('🍕 Pizzerías')
  })

  // Una tontería SÍ merece «no te entendí»: ahí no hay nada que ofrecer que
  // tenga que ver con lo que escribió.
  it('una tontería sigue recibiendo «no te entendí»', async () => {
    const { deps, enviados } = armarEntrada({ hits: [], conocido: null })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'asdfghjkl')
    expect(enviados.map(e => e.reply).join('')).toContain('no te puedo ayudar por aquí')
  })

  // Primero se busca de verdad: si hay locales, se enseñan. Este mensaje es
  // solo para cuando la búsqueda vino vacía.
  it('con resultados NO se dice que no hay', async () => {
    const { deps, enviados } = armarEntrada({
      hits: [CEVICHERIA], conocido: 'Mariscos y ceviches',
    })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero ceviche')
    const texto = enviados.map(e => e.reply).join('\n')
    expect(texto).not.toMatch(/Todavía no tenemos/)
    expect(enviados.flatMap(e => e.options)).toContain('El Puerto')
  })

  // Falla hacia el mensaje de siempre: esto es una mejora del trato, no un
  // camino del que dependa la respuesta.
  it('si el diccionario revienta, responde como antes', async () => {
    const m = armarEntrada({ hits: [] })
    m.database.marketplaceKnownTerm = vi.fn().mockRejectedValue(new Error('caído'))
    await escribir(m.deps, 'hola')
    m.enviados.length = 0
    await escribir(m.deps, 'quiero pollo')
    expect(m.enviados.map(e => e.reply).join('')).toContain('no te puedo ayudar por aquí')
  })
})
