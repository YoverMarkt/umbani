import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  buildStorefrontCatalog,
  canOrder,
  publicBusiness,
  storefrontCapabilities,
  storefrontStatus,
} = require('../dist/services/storefront')

const negocio = (extra = {}) => ({
  id: 'biz-1',
  name: 'Pizzería Roma',
  slug: 'pizza-roma',
  active: true,
  suspended: false,
  storefront_enabled: true,
  takes_orders: true,
  whatsapp_number: '+593991716574',
  ...extra,
})

describe('la tienda del negocio', () => {
  describe('cuándo se puede pedir', () => {
    it('abierta si el negocio tiene tienda y está en horario', () => {
      const estado = storefrontStatus({ business: negocio(), outsideHours: false })
      expect(estado).toBe('abierta')
      expect(canOrder(estado)).toBe(true)
    })

    // Se puede mirar el menú de madrugada; encargar una pizza que nadie hará, no.
    it('cerrada fuera de horario: se ve, pero no se pide', () => {
      const estado = storefrontStatus({ business: negocio(), outsideHours: true })
      expect(estado).toBe('cerrada')
      expect(canOrder(estado)).toBe(false)
    })

    it('no disponible si el negocio no tiene tienda activada', () => {
      const estado = storefrontStatus({
        business: negocio({ storefront_enabled: false }),
        outsideHours: false,
      })
      expect(estado).toBe('no_disponible')
      expect(canOrder(estado)).toBe(false)
    })

    it('suspendida si el negocio está suspendido', () => {
      expect(storefrontStatus({
        business: negocio({ suspended: true }),
        outsideHours: false,
      })).toBe('suspendida')
    })

    it('no disponible si el negocio no existe o está inactivo', () => {
      expect(storefrontStatus({ business: null, outsideHours: false })).toBe('no_disponible')
      expect(storefrontStatus({
        business: negocio({ active: false }),
        outsideHours: false,
      })).toBe('no_disponible')
    })

    // El caso de la barbería: enciende la tienda sin vender nada y el cliente
    // abriría una app vacía. Mejor no existir que existir rota.
    it('no disponible si el negocio no vende, aunque tenga la tienda activada', () => {
      const barberia = negocio({ takes_orders: false })
      expect(storefrontStatus({ business: barberia, outsideHours: false })).toBe('no_disponible')
    })
  })

  // La app NO adivina el flujo por el tipo de negocio: manda la bandera.
  describe('qué sabe hacer la tienda', () => {
    it('una pizzería hace pedidos', () => {
      expect(storefrontCapabilities(negocio())).toEqual({ orders: true })
    })

    it('el tipo de negocio no decide nada por su cuenta', () => {
      // Una pizzería es lo más «vende» que hay y aun así no hace pedidos si el
      // dueño no los activó: la bandera manda sobre el tipo, siempre.
      expect(storefrontCapabilities(negocio({
        type: 'pizzería', takes_orders: false,
      })).orders).toBe(false)
    })

    it('sin negocio no hay capacidades', () => {
      expect(storefrontCapabilities(null)).toEqual({ orders: false })
    })

    it('la portada le dice a la app qué flujo pintar', () => {
      expect(publicBusiness(negocio()).capabilities).toEqual({ orders: true })
    })
  })

  describe('el catálogo que ve el cliente', () => {
    const entrada = {
      categories: [
        { id: 'cat-1', name: 'Pizzas', image_url: 'https://cdn/pizzas.jpg', sort: 1 },
        { id: 'cat-2', name: 'Vacía', sort: 2 },
      ],
      products: [
        {
          id: 'prod-1', name: 'Pizza Pepperoni', price: '12.50',
          category_id: 'cat-1', stock: 'disponible', tags: ['pizzas'],
          image_url: 'https://cdn/pepperoni.jpg',
        },
        {
          id: 'prod-2', name: 'Gaseosa', price: '2.00',
          category_id: null, stock: 'agotado', tags: [],
        },
      ],
      variants: [
        { id: 'v-1', product_id: 'prod-1', name: 'Personal', price: '8.50', sort: 1 },
        { id: 'v-2', product_id: 'prod-1', name: 'Mediana', price: '12.50', sort: 2 },
        { id: 'v-3', product_id: 'prod-1', name: 'Familiar', price: '16.50', sort: 3 },
        { id: 'v-4', product_id: 'prod-1', name: 'Agotada', price: '20.00', stock: 'agotado', sort: 4 },
      ],
      extras: [
        { id: 'e-1', product_id: 'prod-1', group_label: 'Extras', name: 'Queso extra', price_delta: '1.00' },
        { id: 'e-2', product_id: null, category_tag: 'pizzas', group_label: 'Extras', name: 'Orégano', price_delta: '0.50' },
      ],
    }

    it('arma cada producto con sus variantes y extras', () => {
      const catalogo = buildStorefrontCatalog(entrada)
      const pizza = catalogo.products.find(p => p.id === 'prod-1')
      expect(pizza.hasVariants).toBe(true)
      expect(pizza.variants.map(v => `${v.name} $${v.price}`)).toEqual([
        'Personal $8.5', 'Mediana $12.5', 'Familiar $16.5',
      ])
    })

    it('no ofrece variantes agotadas', () => {
      const pizza = buildStorefrontCatalog(entrada).products.find(p => p.id === 'prod-1')
      expect(pizza.variants.map(v => v.name)).not.toContain('Agotada')
    })

    it('el precio del producto con variantes es "desde" la más barata', () => {
      const pizza = buildStorefrontCatalog(entrada).products.find(p => p.id === 'prod-1')
      expect(pizza.priceFrom).toBe(8.5)
    })

    it('suma los extras del producto y los de su categoría, sin repetir', () => {
      const pizza = buildStorefrontCatalog(entrada).products.find(p => p.id === 'prod-1')
      expect(pizza.extras.map(e => e.name).sort()).toEqual(['Orégano', 'Queso extra'])
    })

    // ── El mismo grupo NO puede salir dos veces ──────────────────────────
    //
    // Los extras vienen de `menu_modifiers` (la tabla vieja, que el bot sigue
    // usando) y los grupos de opciones del motor nuevo. Al construir el motor
    // se COPIARON los modificadores sin retirar los originales, así que un
    // negocio con las dos cosas mandaba las mismas opciones por los dos campos
    // y la ficha las pintaba DOS VECES: pasó con los 19 sabores de pizza.
    it('un grupo que ya sirve el motor de opciones no se repite como extra', () => {
      const conAmbos = {
        ...entrada,
        extras: [
          ...entrada.extras,
          { id: 'e-3', product_id: null, category_tag: 'pizzas', group_label: 'Sabor', name: 'Hawaiana', price_delta: '0' },
          { id: 'e-4', product_id: null, category_tag: 'pizzas', group_label: 'Sabor', name: 'Mexicana', price_delta: '0' },
        ],
        optionGroups: [
          { id: 'g-1', name: 'Sabor', category_id: 'cat-1', selection_type: 'multiple', max_selectable: 1 },
        ],
        options: [
          { id: 'o-1', option_group_id: 'g-1', name: 'Hawaiana', stock: 'disponible' },
          { id: 'o-2', option_group_id: 'g-1', name: 'Mexicana', stock: 'disponible' },
        ],
      }
      const pizza = buildStorefrontCatalog(conAmbos).products.find(p => p.id === 'prod-1')

      // El sabor sale UNA vez, y por el motor nuevo: es el que sabe de
      // obligatorios, mínimos y estrategias de precio.
      expect(pizza.optionGroups.map(g => g.name)).toEqual(['Sabor'])
      expect(pizza.extras.map(e => e.group)).not.toContain('Sabor')
      // Y los extras que NO chocan con ningún grupo siguen saliendo.
      expect(pizza.extras.map(e => e.name).sort()).toEqual(['Orégano', 'Queso extra'])
    })

    // El plural NO se resuelve quitando la «s»: «sabores» daría «sabore», que
    // no casa con «sabor», y el duplicado volvía a colarse. Y quitar «es»
    // rompe «bordes» → «bord». Por eso se comparan las formas posibles.
    it('reconoce el mismo grupo escrito en singular y en plural', () => {
      for (const [enElMotor, enLaTablaVieja] of [
        ['Sabor', 'Sabores'],
        ['Borde', 'Bordes'],
        ['Ingrediente', 'Ingredientes'],
        ['Extra', 'Extras'],
      ]) {
        const conAmbos = {
          ...entrada,
          extras: [{
            id: 'e-9', product_id: 'prod-1', group_label: enLaTablaVieja,
            name: 'Uno', price_delta: '0',
          }],
          optionGroups: [{
            id: 'g-9', name: enElMotor, product_id: 'prod-1',
            selection_type: 'single', max_selectable: 1,
          }],
          options: [{ id: 'o-9', option_group_id: 'g-9', name: 'Uno', stock: 'disponible' }],
        }
        const pizza = buildStorefrontCatalog(conAmbos).products.find(p => p.id === 'prod-1')
        expect(pizza.optionGroups.map(g => g.name)).toEqual([enElMotor])
        expect(
          pizza.extras.map(e => e.group),
          `«${enLaTablaVieja}» debería reconocerse como «${enElMotor}»`,
        ).not.toContain(enLaTablaVieja)
      }
    })

    // Un negocio que solo tenga la tabla vieja no puede perder sus extras.
    it('sin grupos del motor, los extras salen tal cual', () => {
      const pizza = buildStorefrontCatalog(entrada).products.find(p => p.id === 'prod-1')
      expect(pizza.extras.map(e => e.name).sort()).toEqual(['Orégano', 'Queso extra'])
    })

    it('marca como no disponible el producto agotado', () => {
      const gaseosa = buildStorefrontCatalog(entrada).products.find(p => p.id === 'prod-2')
      expect(gaseosa.available).toBe(false)
      expect(gaseosa.hasVariants).toBe(false)
    })

    // Una categoría vacía en la tienda parece un error del negocio.
    it('esconde las categorías sin productos', () => {
      const catalogo = buildStorefrontCatalog(entrada)
      expect(catalogo.categories.map(c => c.name)).toEqual(['Pizzas'])
    })

    it('cuenta los productos sin categoría para que la app los agrupe', () => {
      expect(buildStorefrontCatalog(entrada).uncategorized).toBe(1)
    })

    it('respeta el precio de oferta cuando no hay variantes', () => {
      const catalogo = buildStorefrontCatalog({
        ...entrada,
        products: [{ id: 'p', name: 'Combo', price: '20.00', price_sale: '15.00', stock: 'disponible' }],
        variants: [],
        extras: [],
      })
      expect(catalogo.products[0].priceFrom).toBe(15)
    })
  })

  describe('lo que se publica del negocio', () => {
    // El dueño lo pone según su producto más barato: la plataforma no sabe si
    // $5 sobra en una pizzería o cierra una heladería.
    it('publica el mínimo que puso el dueño, y el cero como «sin mínimo»', () => {
      expect(publicBusiness(negocio({ min_order_amount: 7.5 })).minOrderAmount).toBe(7.5)
      expect(publicBusiness(negocio({ min_order_amount: 0 })).minOrderAmount).toBe(0)
      // Una fila anterior a la migración no puede publicar `NaN` ni negativo:
      // el carrito lo restaría del subtotal y el botón se bloquearía solo.
      expect(publicBusiness(negocio({ min_order_amount: null })).minOrderAmount).toBe(0)
      expect(publicBusiness(negocio({ min_order_amount: -3 })).minOrderAmount).toBe(0)
      expect(publicBusiness(negocio({ min_order_amount: 'roto' })).minOrderAmount).toBe(0)
    })

    it('expone lo justo para pintar la portada', () => {
      const publico = publicBusiness(negocio({ slogan: 'La mejor pizza' }))
      expect(publico).toEqual({
        id: 'biz-1',
        // La tarifa de servicio (2026-09-28): 0 si no se pasa, que es apagada.
        serviceFee: 0,
        name: 'Pizzería Roma',
        slug: 'pizza-roma',
        type: null,
        slogan: 'La mejor pizza',
        description: null,
        address: null,
        // ⚠️ Sin número de plataforma configurado, NULL — aunque el negocio
        // tenga el suyo en la ficha (2026-09-07). En Umbani el cliente escribe
        // siempre a la plataforma; un local sin ella no tiene a dónde mandar a
        // nadie, y enseñar el número del dueño sería mandarlo a un sitio donde
        // su pedido no existe. La app esconde los botones, que es peor que
        // tenerlos pero mejor que mandar a nadie a la puerta equivocada.
        phone: null,
        // ⚠️ El punto del local, añadido el 2026-09-10. Es PÚBLICO y no filtra
        // nada: la dirección de un comercio está en su fachada, y sin él quien
        // retira solo sabe el nombre del negocio. Lo que sigue sin salir de
        // aquí es el teléfono del dueño — eso sí es un dato personal.
        latitude: null,
        longitude: null,
        phoneIsPlatform: false,
        capabilities: { orders: true },
        brandColor: null,
        logoUrl: null,
        coverUrl: null,
        deliveryFee: 0,
        // Sin valor en la base se cae al defecto en vez de publicar `null`:
        // la portada tiene que poder decir un tiempo siempre.
        prepTimeMinutes: 25,
        // ⚠️ El mínimo VIAJA AL CATÁLOGO, no solo al confirmar. La base lo
        // exige igualmente —eso es lo que manda—, pero si el cliente se
        // enterara solo ahí habría armado el carrito entero para que se lo
        // rechacen al final: el mismo error que ya se corrigió con el bloqueo
        // y el enlace del local.
        minOrderAmount: 0,
        deliveryExtraMinutes: 0,
      })
    })

    // ── La bandera del número (2026-08-30) ──────────────────────────────
    //
    // El enlace de la mini app NACE de elegir un local dentro del chat de
    // Umbani: el cliente escribe, el bot enseña las categorías, elige, y ahí
    // se le emite su sesión. Quien llega sin enlace necesita que se lo digan
    // ASÍ. Decirle «escríbele al negocio» lo manda a buscar un WhatsApp que en
    // el marketplace ningún local tiene.
    it('el WhatsApp es SIEMPRE el de la plataforma', () => {
      const sinCanal = { id: 'b1', name: 'Monster Pizza', slug: 'monster-pizza' }
      expect(publicBusiness(sinCanal, null, '+593991716574')).toMatchObject({
        phone: '+593991716574', phoneIsPlatform: true,
      })
      // ⚠️ Ni siquiera con un número propio cargado en la ficha (2026-09-07).
      // El canal propio se retiró del panel el 2026-08-23 —«todos los locales
      // viven en el marketplace»— y el dueño lo cerró del todo: «todo tiene
      // que pasar por Umbani, todo; chat, menú, mini app, absolutamente todo».
      // Una columna que sobrevive a la pantalla que la llenaba no puede seguir
      // decidiendo a dónde se manda al cliente.
      expect(publicBusiness({ ...sinCanal, whatsapp_number: '+593900111222' }, null, '+593991716574'))
        .toMatchObject({ phone: '+593991716574', phoneIsPlatform: true })
      // ⚠️ Pero `businesses.phone` NO cuenta como canal (2026-09-07). El
      // enrutado va por `business_channel_identifiers`, nunca por este campo:
      // es un dato de CONTACTO del dueño, el mismo con el que pide reportes.
      // Darlo al cliente lo mandaría a un número que no atiende pedidos, y en
      // Umbani el comprobante, la ubicación y el seguimiento viajan todos por
      // el número de la plataforma.
      expect(publicBusiness({ ...sinCanal, phone: '+593900333444' }, null, '+593991716574'))
        .toMatchObject({ phone: '+593991716574', phoneIsPlatform: true })
      // Sin plataforma configurada no hay número ni bandera que levantar.
      expect(publicBusiness(sinCanal, null, null))
        .toMatchObject({ phone: null, phoneIsPlatform: false })
    })

    // Este número no solo se pinta: es el mismo con el que el servidor calcula
    // las franjas programables. Si la portada dijera 15 y las franjas usaran
    // 40, el cliente elegiría una hora que su propio pedido va a rechazar.
    it('publica el tiempo del negocio, saneado', () => {
      expect(publicBusiness(negocio({ prep_time_minutes: 40 })).prepTimeMinutes).toBe(40)
      expect(publicBusiness(negocio({ delivery_extra_minutes: 15 })).deliveryExtraMinutes).toBe(15)
      // Un cero de preparación prometería el pedido en el acto.
      expect(publicBusiness(negocio({ prep_time_minutes: 0 })).prepTimeMinutes).toBe(25)
      expect(publicBusiness(negocio({ prep_time_minutes: -5 })).prepTimeMinutes).toBe(1)
      // El del envío SÍ puede ser cero: hay quien entrega en su cuadra.
      expect(publicBusiness(negocio({ delivery_extra_minutes: 0 })).deliveryExtraMinutes).toBe(0)
    })

    // El color acaba dentro de un estilo de la mini app: solo sale de aquí si
    // es un hex de 6 dígitos. Cualquier otra cosa se descarta.
    it('solo publica un color de marca con forma de hex', () => {
      expect(publicBusiness(negocio({ brand_color: '#d9f950' })).brandColor).toBe('#D9F950')
      expect(publicBusiness(negocio({ brand_color: 'rojo' })).brandColor).toBeNull()
      expect(publicBusiness(negocio({ brand_color: '#fff' })).brandColor).toBeNull()
      expect(
        publicBusiness(negocio({ brand_color: 'red;background:url(x)' })).brandColor,
      ).toBeNull()
    })

    // La portada acaba en el mismo <img> público que el logo, así que pasa por
    // el mismo filtro. Se comprueba aparte porque son dos columnas: arreglar
    // una y olvidar la otra deja el agujero abierto por el lado nuevo.
    it('solo publica una portada servida por https', () => {
      expect(publicBusiness(negocio({ cover_url: 'https://cdn/portada.jpg' })).coverUrl)
        .toBe('https://cdn/portada.jpg')
      expect(publicBusiness(negocio({ cover_url: 'http://cdn/portada.jpg' })).coverUrl).toBeNull()
      expect(publicBusiness(negocio({ cover_url: 'javascript:alert(1)' })).coverUrl).toBeNull()
      expect(publicBusiness(negocio({ cover_url: '' })).coverUrl).toBeNull()
    })

    // El logo acaba en un <img> de una app pública: nada de http ni javascript:.
    it('solo publica un logo servido por https', () => {
      expect(publicBusiness(negocio({ logo_url: 'https://res.cloudinary.com/x/logo.png' })).logoUrl)
        .toBe('https://res.cloudinary.com/x/logo.png')
      expect(publicBusiness(negocio({ logo_url: 'http://inseguro.test/logo.png' })).logoUrl).toBeNull()
      expect(publicBusiness(negocio({ logo_url: 'javascript:alert(1)' })).logoUrl).toBeNull()
    })

    it('publica el costo de envío como número, nunca negativo', () => {
      expect(publicBusiness(negocio({ delivery_fee: '2.50' })).deliveryFee).toBe(2.5)
      expect(publicBusiness(negocio({ delivery_fee: -5 })).deliveryFee).toBe(0)
      expect(publicBusiness(negocio({ delivery_fee: null })).deliveryFee).toBe(0)
    })

    // La tienda es pública: una credencial filtrada aquí sería un incidente.
    it('nunca filtra credenciales del negocio', () => {
      const publico = publicBusiness(negocio({
        ycloud_api_key: 'clave-secreta',
        ycloud_webhook_secret: 'whsec_secreto',
        telegram_bot_token: 'token-secreto',
        meta_token: 'meta-secreto',
      }))
      const texto = JSON.stringify(publico)
      expect(texto).not.toMatch(/secreta|secreto|whsec/)
      expect(Object.keys(publico)).not.toContain('ycloud_api_key')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE SALE DE LA BASE HACIA EL SEGUIMIENTO
// ═══════════════════════════════════════════════════════════════════════════
//
// El seguimiento es la única pantalla de la tienda que devuelve datos de UN
// pedido concreto, así que es la que más cuidado pide con lo que saca de la
// base. Se comprueba leyendo el código porque es una decisión sobre la
// consulta, no sobre su resultado: con datos de prueba pasaría igual el día
// que alguien la abra de más.
describe('la consulta del seguimiento', () => {
  const repositorio = readFileSync(
    path.join(
      fileURLToPath(new URL('..', import.meta.url)),
      'src', 'db', 'repositories', 'storefront.ts',
    ),
    'utf8',
  )
  const select = repositorio.slice(
    repositorio.indexOf('const CAMPOS_DEL_SEGUIMIENTO'),
    repositorio.indexOf('const getStorefrontOrder'),
  )

  it('trae las líneas del pedido, o el cliente no sabe qué pidió', () => {
    expect(select).toContain('order_items(')
    for (const campo of ['product_name', 'variant_name', 'quantity', 'line_total']) {
      expect(select, `falta ${campo}`).toContain(campo)
    }
  })

  // `order_items(*)` sacaría también `product_id`, `unit_price` y los ids
  // internos. Nada de eso se pinta, y el precio unitario de un pedido con
  // opciones no coincide con lo que el cliente eligió: enseñarlo confunde y
  // guardarlo en una respuesta pública no aporta nada.
  it('nombra los campos en vez de pedirlos todos', () => {
    expect(select).not.toContain('order_items(*)')
    for (const interno of ['product_id', 'unit_price', 'order_id']) {
      expect(select, `${interno} no debería salir de la base`).not.toContain(interno)
    }
  })

  // Concatenar el select con `+` lo convierte en un `string` cualquiera y
  // supabase-js deja de inferir la forma de la respuesta: el `data` sale sin
  // tipo y la función no compila. Se arregló con un cast la primera vez, que
  // es justo lo que se había quitado de esta capa.
  it('el select es un literal, no una concatenación', () => {
    expect(select).toContain('as const')
    expect(select).not.toMatch(/'\s*\+\s*$/m)
  })
})
