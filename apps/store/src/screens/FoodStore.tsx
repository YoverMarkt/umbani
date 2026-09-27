import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RiHome5Fill,
  RiSearchFill,
  RiShoppingCart2Fill,
  RiUser3Fill,
  RiAddLine,
  RiArrowDownSLine,
  RiArrowLeftSLine,
  RiEBikeLine,
  RiHome5Line,
  RiMapPin2Line,
  RiRestaurantLine,
  RiSearchLine,
  RiShoppingBag3Line,
  RiShoppingCart2Line,
  RiTimeLine,
  RiUser3Line,
} from '@remixicon/react'
import {
  createAddress, createOrder, deleteAddress, getCatalog, getMe, getOrder, isLinkProblem,
  setAddressLocation,
} from '../lib/api'
import {
  ENTREGA_POR_DEFECTO, addLine, cartCount, cartTotal, claveDelPlato, claveSuelta,
  lineTotal, needsAddress, orderTotal, seArma, setQuantity, unitPrice,
} from '../lib/cart'
import { Aviso, Bienvenida, EstadoVacio, Foto } from '../components/ui'
import { resumenDesdeCarrito, resumenDesdePedido } from '../lib/resumen'
import { money, rangoDeEspera, cuandoAbre, rangoDeHoy } from '../lib/format'
import { foto } from '../lib/imagen'
import { randomId } from '../lib/session'
import { quePedir } from '../lib/que-pedir'
import ProductSheet from '../components/ProductSheet'
import CartSheet from '../components/CartSheet'
import OrderPlaced from './OrderPlaced'
import type { PedidoRecibido } from './OrderPlaced'
import type { NuevaDireccion } from '../components/CartSheet'
import type { Ubicacion } from '../lib/ubicacion'
const Account = lazy(() => import('./Account'))
const Buscar = lazy(() => import('./Buscar'))
// Diferida como `Account`: solo aparece en el PRIMER «Agregar» de quien no
// tiene dirección guardada, así que no tiene por qué viajar en la primera
// carga —que es la que se paga en clientes que cierran antes de que abra—.
const DireccionRapida = lazy(() => import('../components/DireccionRapida'))
import type {
  Business, CartLine, Catalog, Fulfillment, Me, PaymentMethod, Product, StoreStatus,
  TrackedOrder,
} from '../lib/types'

// Flujo de comida, bebidas y retail: portada → categorías → producto → carrito.
// Es el patrón que la gente ya tiene aprendido de las apps de delivery, y por
// eso no se inventa nada nuevo aquí.

export default function FoodStore({
  slug, business, status, sesionesNuevas, onVolver, onFalloEnlace,
}: {
  slug: string
  business: Business
  status: StoreStatus
  /**
   * Sube cada vez que se estrena sesión (al confirmar el teléfono). Dispara
   * volver a preguntar QUIÉN ES — ver el efecto de más abajo.
   */
  sesionesNuevas?: number
  onVolver?: () => void
  onFalloEnlace: (error: unknown) => Promise<boolean>
}) {
  const [catalogo, setCatalogo] = useState<Catalog | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [lineas, setLineas] = useState<CartLine[]>([])
  const [elegido, setElegido] = useState<Product | null>(null)
  const [carritoAbierto, setCarritoAbierto] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [categoriaActiva, setCategoriaActiva] = useState<string | null>(null)
  /**
   * Si la pantalla de Buscar está abierta. Lo que se escribe vive DENTRO de
   * ella (`screens/Buscar.tsx`): al cerrarla se olvida, y la carta de debajo
   * no se entera de nada.
   */
  const [buscando, setBuscando] = useState(false)
  /**
   * El pedido que se acaba de enviar. Vive aquí y no en el seguimiento porque
   * el resumen sale del CARRITO —que se vacía al confirmar— y del total
   * oficial que devolvió el servidor.
   */
  const [recienHecho, setRecienHecho] = useState<
    { pedido: PedidoRecibido; nombre: string; transferencia: boolean } | null
  >(null)
  /** El pedido que se dejó a medio pagar. Alimenta el aviso de la portada. */
  const [pagoPendiente, setPagoPendiente] = useState<TrackedOrder | null>(null)
  /** Si el cliente tocó ese aviso y está en la pantalla de pago. */
  const [abrirPago, setAbrirPago] = useState(false)
  const [enCuenta, setEnCuenta] = useState(false)
  /**
   * La hoja que pide la dirección en el PRIMER «Agregar».
   *
   * ⚠️ Se ofrece UNA vez por visita (`yaPedimosDireccion`), no cada vez que se
   * añade algo: repetirla en el segundo producto es acoso, no captación. Quien
   * la cierre la vuelve a ver en el checkout, donde sí es obligatoria.
   */
  const [pidiendoDireccion, setPidiendoDireccion] = useState(false)
  const yaPedimosDireccion = useRef(false)
  /**
   * Si ya se avisó de que esta persona no tiene sesión. SEPARADA de la de
   * arriba, y esa separación arregla que a un cliente NUEVO no se le pidiera
   * nunca la dirección.
   *
   * ⚠️ Las dos marcas eran una sola, y `necesita_telefono` no es un caso
   * raro: es «la primera apertura de TODO enlace nuevo» (lo dice
   * `middleware/storefront.ts`). Así que al cliente nuevo le pasaba esto:
   *
   *   1. agrega algo → todavía no hay sesión → se le pide el número, y la
   *      marca se gasta AQUÍ;
   *   2. confirma su número y sigue, ya identificado y sin direcciones;
   *   3. el efecto vuelve a correr → la marca ya está puesta → **la pantalla
   *      de dirección no sale**, y se entera al ir a pagar.
   *
   * Se veía con los platos que se ARMAN (una pizza, un almuerzo) y no con los
   * sueltos, y esa diferencia despistó: lo que cambia no es el producto, es
   * el TIEMPO. Armando el plato da tiempo a que `/me` conteste 401 antes de
   * agregar, así que al agregar ya se entra por la rama de la sesión y la
   * marca se gasta. Con un producto suelto se agrega antes de que conteste.
   *
   * Lo cazó el dueño probando en staging (2026-09-20): «elijo una pizza y me
   * deja entrar sin pedirme dirección; tengo que escoger un producto solo
   * para que salga la pantalla».
   */
  const yaAvisamosDeLaSesion = useRef(false)
  /**
   * El error de `GET /me`, cuando es un problema de ENLACE (401).
   *
   * No es lo mismo que `me === null`: eso también vale mientras la petición
   * viaja. Guardar el error deja saber que esta persona **no tiene sesión**, y
   * es lo que permite avisarle en el primer «Agregar» en vez de dejarla llenar
   * el carrito entero para enterarse al guardar la dirección.
   */
  const [sinSesion, setSinSesion] = useState<unknown>(null)
  // Una portada que no carga se descarta: mejor la cabecera de siempre que el
  // icono de imagen rota como primera impresión de la tienda.
  const [portadaRota, setPortadaRota] = useState(false)
  // Cómo lo recibe. Vive AQUÍ y no en el carrito porque ahora se elige en la
  // portada: los dos sitios tienen que enseñar y cambiar lo mismo.
  const [entrega, setEntrega] = useState<Fulfillment>(ENTREGA_POR_DEFECTO)

  const secciones = useRef<Record<string, HTMLElement | null>>({})
  const pestanas = useRef<Record<string, HTMLElement | null>>({})
  /** Recibe el foco DENTRO del toque de «Buscar». Ver la barra de abajo. */
  const enfocarAntes = useRef<HTMLInputElement>(null)
  // Durante un salto programático el scroll atraviesa secciones intermedias y
  // la pestaña activa iría saltando por el camino. Se ignora hasta que llega.
  const saltando = useRef(false)
  // La clave del pedido en curso. Vive en un ref porque no pinta nada: si
  // estuviera en el estado, cambiarla repintaría la tienda entera.
  const claveDelPedido = useRef<string | null>(null)

  const revisarPagoPendiente = useCallback(() => {
    let guardado: string | null = null
    try { guardado = localStorage.getItem(`pedido:${slug}`) } catch { /* modo privado */ }
    if (!guardado) return

    /**
     * ⚠️ Quien todavía DEBE dinero aterriza en la pantalla de pago, no en el
     * seguimiento.
     *
     * Los datos para transferir viven en la pantalla posterior a confirmar. Si
     * el cliente cierra la app antes de pagar —que es lo normal: va a su banco,
     * transfiere, y vuelve con la captura— al regresar caía en el seguimiento y
     * ahí ya no tenía dónde subirla. Se quedaba con el pedido en el aire y sin
     * más salida que escribir por WhatsApp.
     *
     * Si falla la consulta no se hace nada: la tienda abre como siempre. Un
     * pedido viejo no puede impedir que alguien mire la carta.
     */
    getOrder(slug, guardado)
      .then((pedido) => {
        // Se APAGA también: quien vuelve del pago con el comprobante enviado
        // no puede seguir viendo «Falta tu comprobante».
        const debe = pedido.status === 'esperando_pago' && !pedido.payment_confirmed_at
        setPagoPendiente(debe ? pedido : null)
      })
      .catch(() => { /* sin conexión o pedido borrado: la tienda abre igual */ })
  }, [slug])

  // ⚠️ No solo al abrir (2026-09-26). Se calculaba UNA vez, así que quien
  // pedía por transferencia y tocaba «Volver al menú» no veía el aviso hasta
  // recargar la app. Lo vio el dueño en producción. Ahora se vuelve a mirar al
  // salir del pedido recibido y de la pantalla de pago.
  useEffect(() => { revisarPagoPendiente() }, [revisarPagoPendiente])

  useEffect(() => {
    // ⚠️ El fallo de `me` se GUARDA en vez de tragarse. `null` no distinguía
    // «todavía no respondió» de «no hay sesión», y por eso la hoja del primer
    // «Agregar» no le salía nunca a quien más la necesita: el que llegó sin
    // enlace. Con el error a mano, la app sabe cuál de las dos cosas es.
    Promise.all([
      getCatalog(slug),
      getMe(slug).then(
        quien => ({ quien, fallo: null as unknown }),
        fallo => ({ quien: null, fallo }),
      ),
    ])
      .then(([datos, sesion]) => {
        setCatalogo(datos)
        setMe(sesion.quien)
        setSinSesion(isLinkProblem(sesion.fallo) ? sesion.fallo : null)
      })
      .catch(error => void onFalloEnlace(error))
  }, [slug, onFalloEnlace])

  /**
   * Quién es, PREGUNTADO OTRA VEZ al estrenar sesión.
   *
   * ⚠️ Este es el arreglo de un fallo que el cliente sufría en cada pedido:
   * quien llega sin sesión ve fallar `GET /me`, confirma su teléfono… y `me`
   * se quedaba en el `null` de aquel fallo. Con él se quedaba vacía su libreta
   * de direcciones, así que la persona escribía su casa de nuevo — y acababa
   * con la misma dirección repetida tantas veces como pedidos hizo.
   *
   * Solo se recarga ESTO. El catálogo no: recargarlo entero es lo que en su día
   * vaciaba el carrito, y aquí el cliente suele tener el suyo lleno.
   *
   * No corre en el primer pintado (`sesionesNuevas` empieza en 0): de eso ya se
   * encarga el efecto de arriba, y pedirlo dos veces al abrir sería un viaje
   * de más en la carga que más se paga.
   */
  useEffect(() => {
    if (!sesionesNuevas) return
    getMe(slug)
      .then((quien) => { setMe(quien); setSinSesion(null) })
      // Si falla, la tienda sigue como estaba: el checkout volverá a pedir lo
      // que haga falta. Perder la carta por no saber el nombre sería peor.
      .catch(() => { /* sin sesión todavía: el checkout lo resolverá */ })
  }, [slug, sesionesNuevas])

  const puedePedir = catalogo?.canOrder ?? (status === 'abierta')

  // Productos por categoría, respetando el orden del negocio y dejando al
  // final los que no tienen categoría asignada.
  const grupos = useMemo(() => {
    if (!catalogo) return []
    const porCategoria = catalogo.categories.map(categoria => ({
      id: categoria.id,
      nombre: categoria.name,
      imagen: categoria.imageUrl,
      productos: catalogo.products.filter(producto => producto.categoryId === categoria.id),
    }))
    const sueltos = catalogo.products.filter(producto => !producto.categoryId)
    return (sueltos.length
      ? [...porCategoria, { id: 'otros', nombre: 'Más productos', imagen: null, productos: sueltos }]
      : porCategoria
    ).filter(grupo => grupo.productos.length > 0)
  }, [catalogo])

  // La pantalla de Buscar viaja aparte. Se trae en segundo plano en cuanto hay
  // carta, para que al tocar «Buscar» ya esté y no haya espera ni pantallazo.
  useEffect(() => {
    if (!catalogo) return
    const precarga = window.setTimeout(() => { void import('./Buscar') }, 1500)
    return () => window.clearTimeout(precarga)
  }, [catalogo])

  /**
   * La pestaña activa la decide el SCROLL, no solo el toque. Sin esto, quien
   * recorre la carta con el pulgar ve «Pizzas» subrayado mientras mira las
   * bebidas, y la barra deja de explicar dónde está.
   *
   * La línea de lectura es una franja justo debajo de las pestañas: lo que la
   * cruza es lo que el cliente tiene delante.
   */
  // ⚠️ La carta se DESMONTA mientras se ve la cuenta, el pago o el pedido
  // recibido, y al volver nace con secciones nuevas (2026-09-26). El vigilante
  // se armaba una sola vez y seguía mirando las secciones viejas, ya fuera de
  // la página: la barra se quedaba en «Pizzas» aunque el cliente estuviera en
  // Bebidas. Lo vio el dueño en producción al volver de «Mi cuenta». Con esto
  // se vuelve a armar cada vez que la carta reaparece.
  const cartaALaVista = !enCuenta && !(pagoPendiente && abrirPago) && !recienHecho
  useEffect(() => {
    if (!grupos.length || !cartaALaVista) return
    // Qué secciones cruzan la línea de lectura. Vive dentro del efecto porque
    // no sobrevive a él: al cambiar la carta se empieza a contar de cero.
    const visibles = new Set<string>()
    const observador = new IntersectionObserver(
      entradas => {
        for (const entrada of entradas) {
          const id = entrada.target.getAttribute('data-categoria')
          if (!id) continue
          if (entrada.isIntersecting) visibles.add(id)
          else visibles.delete(id)
        }
        // El conjunto se mantiene al día siempre; lo que se congela durante un
        // salto es solo el subrayado, para que no parpadee por el camino.
        if (saltando.current) return
        const primera = grupos.find(grupo => visibles.has(grupo.id))
        if (primera) setCategoriaActiva(primera.id)
      },
      { rootMargin: '-132px 0px -66% 0px' },
    )
    for (const grupo of grupos) {
      const nodo = secciones.current[grupo.id]
      if (nodo) observador.observe(nodo)
    }
    return () => observador.disconnect()
  }, [grupos, cartaALaVista])

  // La pestaña activa se trae a la vista sola: con seis categorías, la que
  // manda puede haber quedado fuera de la pantalla por la derecha.
  useEffect(() => {
    if (!categoriaActiva) return
    pestanas.current[categoriaActiva]?.scrollIntoView({
      behavior: 'smooth', inline: 'center', block: 'nearest',
    })
  }, [categoriaActiva])

  /**
   * Un adicional entra al carrito como LÍNEA PROPIA. Se resuelve contra el
   * catálogo —no contra lo que venga en la recomendación— porque el precio y
   * la disponibilidad mandan desde el producto, igual que si se pidiera solo.
   *
   * Si el producto trae obligatorios no se puede agregar de un toque: se abre
   * su ficha para completarlos, que es lo que la base va a exigir igual.
   */
  const agregarAdicional = useCallback((productId: string) => {
    const producto = catalogo?.products.find(item => item.id === productId)
    if (!producto || !producto.available) return

    // Un producto con variantes, con un obligatorio o por partes no entra de un
    // toque: la base lo rechazaría, así que se abre su ficha. La regla vive en
    // `cart.ts` porque la ficha la necesita para lo mismo.
    if (seArma(producto)) return setElegido(producto)

    setLineas(actuales => addLine(actuales, {
      key: claveSuelta(producto),
      product: producto,
      variant: null,
      extras: [],
      options: [],
      quantity: 1,
      note: '',
      unitPrice: unitPrice(producto, null, [], []),
    }))
  }, [catalogo])

  /**
   * Los acompañamientos que el cliente marcó dentro de la ficha de otro plato.
   * Entran JUNTOS al tocar «Agregar», cada uno como su propia línea.
   *
   * ⚠️ En una sola pasada de `setLineas`. Una llamada por producto haría que
   * React encadenara actualizaciones sobre estados intermedios y se perdieran
   * líneas por el camino.
   */
  const agregarAdicionales = useCallback((cantidades: Record<string, number>) => {
    setLineas((actuales) => {
      let siguientes = actuales
      for (const [productId, cantidad] of Object.entries(cantidades)) {
        if (cantidad <= 0) continue
        const producto = catalogo?.products.find(item => item.id === productId)
        if (!producto || !producto.available) continue
        siguientes = addLine(siguientes, {
          key: claveSuelta(producto),
          product: producto,
          variant: null,
          extras: [],
          options: [],
          quantity: Math.min(99, cantidad),
          note: '',
          unitPrice: unitPrice(producto, null, [], []),
        })
      }
      return siguientes
    })
  }, [catalogo])

  /** ¿Ese adicional hay que armarlo? La misma regla que usa `agregarAdicional`. */
  const adicionalSeArma = useCallback((productId: string): boolean => {
    const producto = catalogo?.products.find(item => item.id === productId)
    return producto ? seArma(producto) : false
  }, [catalogo])

  /**
   * El momento de pedir lo que falta: cuando el carrito deja de estar vacío.
   *
   * Se pide AQUÍ y no al entrar porque quien acaba de tocar «Agregar» ya
   * decidió comprar —dar sus datos es parte de lo que vino a hacer—, mientras
   * que al entrar sería un peaje antes de saber si le interesa. Ver el
   * encabezado de `DireccionRapida.tsx`.
   *
   * ⚠️ Son DOS peticiones con DOS marcas, y esa separación es un arreglo, no
   * una elegancia: con una marca compartida, pedir el número gastaba el turno
   * de pedir la dirección y el cliente nuevo no la veía nunca. Todo el
   * razonamiento está en `lib/que-pedir.ts`.
   *
   * ⚠️ En cuanto la sesión se estrena, esto vuelve a correr solo —`me` está en
   * las dependencias—, así que quien acaba de confirmar su número ve la
   * pantalla de dirección sin tener que agregar otra cosa.
   */
  useEffect(() => {
    // ⚠️ La decisión vive en `quePedir` (`lib/que-pedir.ts`) y está probada
    // allí: dentro de un efecto no se puede comprobar, y esta mezcla ya se
    // rompió una vez —el cliente nuevo no veía nunca la pantalla de dirección.
    const toca = quePedir({
      hayLineas: lineas.length > 0,
      sinSesion: Boolean(sinSesion),
      yaAvisamosDeLaSesion: yaAvisamosDeLaSesion.current,
      yaPedimosDireccion: yaPedimosDireccion.current,
      entrega,
      // `me` en nulo aquí ya solo significa «todavía no contestó»: si no
      // hubiera sesión, `sinSesion` lo habría dicho.
      tieneDirecciones: me ? Boolean(me.addresses?.length) : null,
    })

    if (toca === 'sesion') {
      yaAvisamosDeLaSesion.current = true
      // No destruye el carrito: `onFalloEnlace` lo pinta ENCIMA de la tienda.
      void onFalloEnlace(sinSesion)
      return
    }

    if (toca === 'direccion') {
      yaPedimosDireccion.current = true
      setPidiendoDireccion(true)
    }
  }, [lineas.length, entrega, me, sinSesion, onFalloEnlace])

  const irACategoria = (id: string) => {
    saltando.current = true
    setCategoriaActiva(id)
    secciones.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // Lo que tarda el desplazamiento suave en llegar. Al soltarlo, el
    // observador retoma el mando desde donde quedó el scroll.
    window.setTimeout(() => { saltando.current = false }, 700)
  }

  const confirmar = useCallback(async (datos: {
    fulfillment: Fulfillment
    addressId: string | null
    name: string
    paymentMethod: PaymentMethod
    deliveryNotes: string | null
  }) => {
    setEnviando(true)
    setError(null)
    try {
      // Una clave POR CARRITO, no por intento: si el envío falla y se reintenta
      // —o el cliente toca «Confirmar» dos veces— el servidor devuelve el mismo
      // pedido en vez de crear dos comandas. Se renueva al vaciar el carrito,
      // porque ese ya es otro pedido.
      // ⚠️ `randomId` y NO `crypto.randomUUID`: esa función no existe en los
      // WebView viejos de Android —justo los que abre WhatsApp en teléfonos
      // modestos— y aquí no degradaba, REVENTABA: la excepción salta antes de
      // llamar al servidor, así que el cliente no podía pedir. El respaldo ya
      // estaba escrito en `lib/session.ts` para el id de dispositivo; esto
      // solo lo usa.
      if (!claveDelPedido.current) claveDelPedido.current = randomId()
      const pedido = await createOrder(slug, {
        lines: lineas, ...datos, idempotencyKey: claveDelPedido.current,
      })
      // El total oficial llega en la respuesta (incluye el envío que calculó
      // la base); el del carrito solo sirve de respaldo si no viniera.
      // El id se guarda en el navegador para detectar al abrir si quedó un
      // pago pendiente. Ya no alimenta ninguna pestaña: la lista de pedidos la
      // trae el servidor en la pantalla de Cuenta.
      if (pedido.id) {
        try { localStorage.setItem(`pedido:${slug}`, String(pedido.id)) } catch { /* modo privado */ }
      }
      // El resumen se arma ANTES de vaciar: después ya no hay carrito del que
      // sacarlo, y volver a pedírselo al servidor sería un viaje por algo que
      // se acaba de tener en la mano.
      const resumen: PedidoRecibido = {
        id: String(pedido.id || ''),
        order_number: pedido.order_number ?? null,
        total: pedido.total ?? null,
        subtotal: cartTotal(lineas),
        envio: needsAddress(datos.fulfillment) ? (business.deliveryFee || 0) : 0,
        // El detalle sale de `lib/resumen.ts`, el mismo sitio que lo arma
        // cuando el cliente VUELVE a un pedido guardado: dos caminos, una
        // sola forma. El importe se pone aquí porque el dinero no se calcula
        // en ese módulo, ni siquiera para pintar.
        lineas: resumenDesdeCarrito(lineas).map((resumen, indice) => ({
          ...resumen,
          importe: lineTotal(lineas[indice]),
        })),
      }
      setLineas([])
      claveDelPedido.current = null
      setCarritoAbierto(false)
      // ⚠️ Pasa por «recibido» y no directo al seguimiento. La pantalla que se
      // retiró el 2026-08-08 mentía —decía «confirmado» cuando el negocio ni lo
      // había mirado— y era estática. Esta dice «recibido», que es verdad
      // siempre, y no promete nada que pueda cambiar: lo que cambia está en el
      // seguimiento, a un toque.
      if (pedido.id) {
        setRecienHecho({
          pedido: resumen,
          nombre: datos.name,
          transferencia: datos.paymentMethod === 'transferencia',
        })
      }
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError(error instanceof Error ? error.message : 'No pudimos enviar tu pedido')
    } finally {
      setEnviando(false)
    }
  }, [slug, lineas, business.deliveryFee, onFalloEnlace])

  /**
   * Guarda una dirección nueva y DEVUELVE su id.
   *
   * ⚠️ El id no es un extra: quien acaba de escribir una dirección en el
   * checkout la está escribiendo para ESTE pedido. Como no se seleccionaba,
   * seguía elegida la anterior —la marcada por defecto, o la primera de la
   * lista— y el pedido salía a la casa vieja. La app decía «guardada» y el
   * repartidor iba a otro sitio.
   */
  const nuevaDireccion = useCallback(async (datos: NuevaDireccion) => {
    try {
      const creada = await createAddress(slug, datos)
      setMe(await getMe(slug))
      return creada?.id || null
    } catch (error) {
      if (await onFalloEnlace(error)) return null
      setError('No pudimos guardar la dirección')
      return null
    }
  }, [slug, onFalloEnlace])

  const borrarDireccion = useCallback(async (addressId: string) => {
    try {
      await deleteAddress(slug, addressId)
      setMe(await getMe(slug))
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError('No pudimos eliminar la dirección')
    }
  }, [slug, onFalloEnlace])

  /**
   * El pin de una dirección que ya existía.
   *
   * Si falla NO se corta nada: la dirección sigue guardada y el pedido se puede
   * hacer igual, solo que el repartidor irá con el texto. El pin es una ayuda,
   * no un requisito.
   */
  const ubicarDireccion = useCallback(async (addressId: string, ubicacion: Ubicacion) => {
    try {
      await setAddressLocation(slug, addressId, {
        latitude: ubicacion.latitude,
        longitude: ubicacion.longitude,
        accuracy: ubicacion.accuracy,
      })
      setMe(await getMe(slug))
    } catch (error) {
      if (await onFalloEnlace(error)) return
      setError('No pudimos guardar la ubicación')
    }
  }, [slug, onFalloEnlace])

  if (enCuenta) {
    return (
      <Suspense fallback={null}>
        <Account
          slug={slug}
          me={me}
          onVolver={() => setEnCuenta(false)}
          onBorrarDireccion={borrarDireccion}
          onFalloEnlace={onFalloEnlace}
          sesionesNuevas={sesionesNuevas}
        />
      </Suspense>
    )
  }

  // ⚠️ Un pedido a medio pagar YA NO secuestra la app al abrirla. Antes se
  // entraba directo aquí; ahora se abre la tienda con un aviso donde estaban
  // los círculos de categoría, y se entra tocándolo. El recordatorio queda a
  // la vista en el sitio más visible, y quien abrió la app para mirar la carta
  // puede mirarla.
  if (pagoPendiente && abrirPago) {
    return (
      <OrderPlaced
        slug={slug}
        business={business}
        pedido={{
          id: pagoPendiente.id,
          order_number: pagoPendiente.order_number,
          total: pagoPendiente.total,
          // ⚠️ El envío sale del PEDIDO, no de un cero. Estaba fijado a 0, así
          // que el desglose enseñaba «1× Burger Pack $12.09» y debajo «Total
          // $14.09» sin decir de dónde salían los $2.00 del reparto — y este
          // es el número que el cliente está a punto de transferir.
          //
          // El subtotal se deriva restando: así los dos renglones suman
          // exactamente el total oficial, en vez de tomar el `subtotal` de la
          // fila, que es lo del COMERCIO y no incluye el margen.
          envio: Number(pagoPendiente.shipping) || 0,
          subtotal: (Number(pagoPendiente.total) || 0) - (Number(pagoPendiente.shipping) || 0),
          // Lo que pidió, tal como lo congeló la base —y ya agrupado por el
          // servidor—. Aquí no hay carrito del que sacarlo: el cliente cerró
          // la app hace rato.
          lineas: resumenDesdePedido(pagoPendiente.order_items || []),
        }}
        nombre=""
        entrega={pagoPendiente.fulfillment || entrega}
        transferencia
        volviendo
        onVolver={() => { setAbrirPago(false); revisarPagoPendiente() }}
      />
    )
  }

  // ⚠️ Aquí había una pantalla de SEGUIMIENTO —línea de tiempo, estados,
  // despedida— y se retiró el 2026-08-12. El pedido se sigue por WhatsApp, con
  // los tres avisos de `services/order-notify.ts`, que es donde el cliente ya
  // está mirando: no hay que enseñarle a volver a una app para enterarse de
  // algo que le llega solo. La despedida de Umbani no se perdió, viaja idéntica
  // en el aviso de `completado`. Lo que queda en la app es la lista de Cuenta,
  // que dice el estado en texto para quien quiera comprobarlo.
  if (recienHecho) {
    return (
      <OrderPlaced
        slug={slug}
        business={business}
        pedido={recienHecho.pedido}
        nombre={recienHecho.nombre}
        entrega={entrega}
        transferencia={recienHecho.transferencia}
        onVolver={() => { setRecienHecho(null); revisarPagoPendiente() }}
      />
    )
  }

  // ⚠️ AQUÍ ESTABA EL SEGUNDO BLANCO (2026-09-03). `App` ya tiene la portada
  // y monta esta pantalla, pero el CATÁLOGO es otra petición: hasta que llega,
  // este `return null` dejaba el contenedor VACÍO. Medido contra producción
  // con red móvil lenta: tres segundos en blanco entre la bienvenida y la
  // carta, justo lo que el dueño describió.
  //
  // Se arregló primero el `return null` de `App` y el fallo SIGUIÓ, porque son
  // dos esperas seguidas y cada una tenía el suyo. La medición local no lo vio
  // porque se cortaba antes de llegar a esta fase — la lección es medir hasta
  // que la tienda aparece, no hasta que desaparece el fallo anterior.
  if (!catalogo) return <Bienvenida />

  // Con el envío ya incluido: el modo de entrega se elige arriba, así que la
  // barra puede decir el número final en vez de uno que crecerá al abrir el
  // carrito. Es el mismo que enseña el desglose del checkout.
  const total = orderTotal(lineas, entrega, business.deliveryFee)
  const unidades = cartCount(lineas)
  const horario = catalogo.todaysHours
  // Solo viene con la tienda cerrada; abierta es `null` y manda el rango.
  const apertura = catalogo.nextOpen
  /* La dirección que se enseña arriba. La primera guardada es la que usa el
     checkout por defecto, así que es la que hay que mostrar: enseñar otra
     prometería una entrega donde no va a ir. Sin ninguna guardada NO se
     inventa un «Casa» que no existe — la barra invita a elegir. */
  const direccionActiva = me?.addresses?.[0]?.address || null
  const portada = portadaRota ? null : foto(business.coverUrl, 'portada')
  const abierto = status === 'abierta'

  // ── La tarjeta de la rejilla ──────────────────────────────────────────────
  // Foto arriba a sangre y el `+` sobre ella. Se declara una vez porque la usan
  // la carta y los resultados de búsqueda, y dos copias se desincronizan.
  const tarjeta = (producto: Product) => (
    <div
      key={producto.id}
      className={`relative transition ${producto.available ? '' : 'opacity-55'}`}
    >
      {/* ⚠️ La foto y los textos NO van dentro de un botón, y el `+` tampoco:
          serían botones anidados, que es HTML inválido. Lo que abre la ficha
          es una CAPA sobre la tarjeta entera (`absolute inset-0`), declarada
          ANTES que el `+` para que el `+` quede encima sin pelear por
          z-index. Así se puede tocar la tarjeta completa y el `+` sigue
          haciendo lo suyo. */}

      {/* ⚠️ SIN caja blanca ni sombra (2026-09-06, referencia del dueño). La
          foto es un bloque redondeado sobre el gris de la app y el texto va
          suelto debajo, sobre el blanco de la sección. Es al revés que antes
          —tarjeta blanca sobre gris— y hace que en la rejilla mande la
          fotografía y no el contorno de la caja.

          ⚠️ El `overflow-hidden` va SOLO en la foto, no en la tarjeta: el `+`
          sobresale de ella a propósito y aquí lo recortaría por la mitad. */}
      <div className="fondo-app relative overflow-hidden rounded-(--radius-tarjeta)">
        <Foto url={producto.imageUrl} alto="h-36" uso="tarjeta" nombre={producto.name} />
        {!producto.available && (
          <span className="absolute top-2 left-2 max-w-[90%] truncate rounded-full bg-black/70 px-2 py-0.5 text-[10.5px] font-bold text-white">
            {producto.availableHint || 'Agotado'}
          </span>
        )}

        {/* El `+` agrega de un toque lo que no exige elegir nada. Si el
            producto trae obligatorios, `agregarAdicional` abre su ficha en vez
            de meterlo a ciegas: la base lo rechazaría igual.

            ⚠️ VA DENTRO DE LA FOTO, y se probó lo contrario el 2026-09-06.
            Montado a caballo del borde —como parecía en la referencia— dejaba
            un hueco de 32 px antes del nombre para que el círculo no se lo
            comiera, y la rejilla quedaba desarmada. Es la misma cicatriz que
            ya estaba escrita aquí: «Doble Cheese Burguer» quedaba debajo del
            círculo. En la referencia el círculo también está dentro; lo que de
            verdad cambia es su COLOR.

            ⚠️ Círculo BLANCO, no del color de marca. Sobre una foto clara lo
            que lo separa del fondo es la sombra, no el color, así que la lleva
            fuerte. El icono va en tinta para leerse sobre el blanco.

            ⚠️ El icono `Plus`, no el CARÁCTER «+»: con el carácter, lo que el
            flex centra es la caja de línea y la cruz queda alta en el círculo. */}
        {producto.available && (
          <button
            onClick={() => agregarAdicional(producto.id)}
            disabled={!puedePedir}
            aria-label={`Agregar ${producto.name}`}
            className="superficie absolute right-2.5 bottom-2.5 z-10 flex size-11 items-center justify-center rounded-full text-(--texto) ring-1 ring-black/5 shadow-flotante transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
          >
            <RiAddLine size={24} />
          </button>
        )}
      </div>

      {/* ⚠️ El orden es NOMBRE → PRECIO → DESCRIPCIÓN (2026-09-06). Antes la
          descripción se colaba entre el nombre y el precio, y en una rejilla
          de dos columnas eso deja el dato que decide la compra —cuánto
          cuesta— al final de un bloque de texto gris. La referencia del dueño
          lo pone justo bajo el nombre, que es donde el ojo ya está. */}
      <div className="pt-2.5 pr-1">
        <p className="text-[15.5px] leading-snug font-bold tracking-tight line-clamp-2">
          {producto.name}
        </p>
        {/* El precio en TINTA, no en el naranja de la referencia: allí ese
            color señala una rebaja, y aquí no hay descuentos que señalar
            —`Product` no lleva precio promocional—. Naranja permanente sería
            color sin significado, y además `--ascua` da 3,49:1 sobre blanco,
            por debajo del 4,5 que exige AA para texto. */}
        <p className="mt-1 text-[15px] leading-none font-semibold tabular-nums">
          {producto.hasVariants && (
            <span className="text-[11px] font-semibold texto-tenue">desde </span>
          )}
          {money(producto.priceFrom)}
        </p>
        {producto.description && (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug texto-cuerpo">
            {producto.description}
          </p>
        )}
      </div>

      <button
        onClick={() => setElegido(producto)}
        aria-label={`Ver ${producto.name}`}
        className="absolute inset-0 rounded-(--radius-tarjeta)"
      />

    </div>
  )

  return (
    // El hueco de abajo crece con el carrito: ahora «Ver pedido» se APILA
    // sobre la barra en vez de taparla, así que entre las dos ocupan más y el
    // último producto de la carta quedaría debajo.
    <div className={`mx-auto min-h-full max-w-lg ${unidades > 0 ? 'pb-48' : 'pb-32'}`}>
      {/* ══ EL HÉROE ════════════════════════════════════════════════════
          Portada a sangre y ALTA, con el logo del negocio centrado
          solapando el borde. Es la ficha de local de cualquier app de
          reparto grande, y sustituye al banner pequeño del 2026-08-25 por
          decisión del dueño (2026-08-26): aquel confirmaba dónde estabas,
          pero no daba ninguna sensación de marca.

          ⚠️ La foto llega al borde FÍSICO de la pantalla a propósito
          —`viewport-fit=cover` en el index.html—, así que el héroe pasa por
          debajo de la barra de estado y solo el botón de volver respeta el
          `safe-area`. Si el héroe respetara el inset quedaría una franja
          del color del fondo sobre la foto, que es justo lo que se ve roto.

          ⚠️ Sin portada NO se deja un hueco gris: va un degradado del color
          del negocio. Hoy Monster Pizza sí tiene una cargada. */}
      <header className="relative">
        {/* ⚠️ PROPORCIÓN, no alto fijo. Con `h-56` el marco cambiaba de forma
            según el ancho de la pantalla —1,75:1 en un iPhone y 2,29:1 en el
            `max-w-lg`—, así que la misma portada se recortaba distinto en cada
            teléfono. En 16:9 el marco es siempre el mismo, y coincide con el
            recorte que ya viene hecho de Cloudinary (`RECORTE` en
            `lib/imagen.ts`): la foto llega con la forma exacta del hueco, así
            que `object-cover` no tiene nada que recortar por su cuenta. */}
        {/* Sin redondeo abajo, por decisión del dueño (2026-08-26): la portada
            corta recta y el logo se apoya sobre esa línea. */}
        <div className="relative aspect-video overflow-hidden">
          {portada
            ? (
                <img
                  src={portada}
                  alt=""
                  // Si el dueño la borró de Cloudinary se retira sola y queda
                  // el degradado de marca: el icono de imagen rota no puede
                  // ser la primera impresión de la tienda.
                  onError={() => setPortadaRota(true)}
                  className="size-full object-cover"
                />
              )
            : (
                <div
                  className="size-full"
                  style={{
                    backgroundImage:
                      'linear-gradient(150deg, color-mix(in srgb, var(--acento) 90%, black) 0%,'
                      + ' color-mix(in srgb, var(--acento) 40%, black) 100%)',
                  }}
                />
              )}
          {/* El velo no es adorno: sin él, una portada clara deja el botón
              de volver invisible, y el negocio elige qué sube. */}
          <div className="absolute inset-0 bg-linear-to-b from-black/45 via-black/5 to-black/25" />

          {onVolver && (
            <button
              onClick={onVolver}
              aria-label="Volver"
              className="absolute left-4 top-[calc(env(safe-area-inset-top)+0.75rem)] flex size-10 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition active:scale-95"
            >
              <RiArrowLeftSLine size={20} />
            </button>
          )}
        </div>

        {/* El logo, CENTRADO y solapando el borde del héroe. El anillo es
            del color de la superficie, no blanco fijo, para que el recorte
            siga siendo limpio si algún día la superficie cambia. */}
        {/* ⚠️ `relative z-10`: sin contexto de apilado propio, el héroe —que es
            `relative`— se pinta ENCIMA y le come la mitad de arriba al logo.
            El margen negativo solapa, pero no decide quién va delante. */}
        <div className="relative z-10 -mt-12 flex justify-center">
          <div className="superficie size-24 rounded-full p-1 shadow-alzada">
            {business.logoUrl
              ? (
                  <img
                    src={foto(business.logoUrl, 'miniatura') || undefined}
                    alt=""
                    className="size-full rounded-full object-cover"
                  />
                )
              : (
                  <span className="marcador flex size-full items-center justify-center rounded-full text-[2rem] leading-none font-black opacity-40 select-none">
                    {business.name.trim().charAt(0).toUpperCase()}
                  </span>
                )}
          </div>
        </div>
      </header>

      {/* ── Quién es, y si atiende ahora ───────────────────────────────
          Nombre centrado bajo el logo y, debajo, el ESTADO con su horario.

          ⚠️ Aquí la referencia pinta «★ 4,8 (1.652) · FoodyPro+ · 0,1 mi» y
          NADA de eso existe en este proyecto: no hay reseñas, ni programa
          de fidelidad, ni distancia. Se toma el SITIO y la jerarquía —una
          línea de metadatos centrada bajo el nombre— y se llena con lo
          único que ahí es verdad: si el local está abierto y hasta qué
          hora. Inventar un 4,8 sería el control que no controla nada, pero
          además mintiéndole al cliente. */}
      <div className="px-5 pt-3 text-center">
        <h1 className="titulo-xl">{business.name}</h1>
        {business.slogan && (
          <p className="mt-1.5 text-[13.5px] texto-cuerpo">{business.slogan}</p>
        )}
        {/* ── Abierto / Cerrado, diciendo HASTA CUÁNDO ──────────────────
            Antes era la píldora y al lado el rango pelado «09:00 – 03:00»,
            que obliga al cliente a mirar la hora de su teléfono y comparar.
            Ahora la píldora dice lo único que necesita saber: si está
            abierto, a qué hora cierra; si está cerrado, a qué hora abre.
            ⚠️ El punto LATE solo con el local abierto, y solo ahí: un
            indicador que parpadea sobre «Cerrado» diría que algo pasa. Se
            apaga solo con `prefers-reduced-motion` (regla global). */}
        <div className="mt-3 flex justify-center">
          <span
            className={`inline-flex items-center gap-2 rounded-full py-1.5 pr-4 pl-3 text-[13px] font-bold shadow-tarjeta ${
              abierto ? 'bg-emerald-50 text-emerald-800' : 'superficie texto-cuerpo'
            }`}
          >
            <span className="relative flex size-2">
              {abierto && (
                <span className="latido absolute inline-flex size-full rounded-full bg-emerald-500" />
              )}
              <span className={`relative inline-flex size-2 rounded-full ${
                abierto ? 'bg-emerald-500' : 'bg-current opacity-40'
              }`}
              />
            </span>
            {abierto ? 'Abierto' : 'Cerrado'}
            {/* ⚠️ ABIERTA enseña el rango; CERRADA, cuándo vuelve a abrir
                (2026-09-02). El comentario de aquí ya prometía esto —«si está
                cerrado, a qué hora abre»— y el código enseñaba el rango en los
                dos casos.

                Y no era cosmético: con un horario que cruza la medianoche
                —miércoles 08:00–02:00— la píldora decía «Cerrado · 8:00 AM –
                2:00 AM» a la 01:10, y eso se lee como un fallo de la app. El
                estado era correcto (esa madrugada es del martes, que cerró a
                las 22:00), pero nadie lo deduce de un rango. El dueño lo vio
                en su teléfono y preguntó cuál era el error. */}
            {(abierto ? horario : apertura) && (
              <>
                <span className="opacity-30">·</span>
                <span className="font-semibold tabular-nums opacity-80">
                  {abierto ? rangoDeHoy(horario) : cuandoAbre(apertura)}
                </span>
              </>
            )}
          </span>
        </div>
      </div>

      {/* ── Cómo llega, y a dónde ──────────────────────────────────────
          La tarjeta de servicio de la referencia, con NUESTROS datos
          reales: el tiempo sale de las dos columnas que pone el dueño, el
          envío de `delivery_fee` y el mínimo de `min_order_amount`.

          ⚠️ Aquí VIVE el selector Entrega/Retiro, que es la misma decisión
          que la del carrito, no dos. Ya estuvo a punto de perderse una vez
          al rediseñar la cabecera: sin él el cliente paga envío sin poder
          elegir retiro. La referencia lo dibuja igual —dos iconos de modo
          dentro de la píldora—, así que el sitio es el suyo.

          ⚠️ La dirección solo aparece en ENTREGA: en retiro la fila entera
          desaparece en vez de pedir un dato que nadie va a usar. */}
      <div className="px-4 pt-4">
        <div className="superficie rounded-[1.75rem] shadow-tarjeta">
          <div className="flex items-center gap-3 p-2.5">
            <div className="flex shrink-0 gap-1 rounded-full bg-black/5 p-1">
              {([
                { id: 'delivery' as const, icono: RiEBikeLine, etiqueta: 'Entrega a domicilio' },
                { id: 'pickup' as const, icono: RiShoppingBag3Line, etiqueta: 'Retiro en el local' },
              ]).map(({ id, icono: Icono, etiqueta }) => (
                <button
                  key={id}
                  onClick={() => setEntrega(id)}
                  aria-label={etiqueta}
                  aria-pressed={entrega === id}
                  className={`flex size-11 items-center justify-center rounded-full transition active:scale-95 ${
                    entrega === id ? 'acento shadow-acento' : 'texto-cuerpo'
                  }`}
                >
                  <Icono size={18} />
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1 pr-1">
              <p className="titulo-m">
                {entrega === 'delivery' ? 'Entrega' : 'Retiro'}
                {' · '}
                {rangoDeEspera(
                  business.prepTimeMinutes
                  + (entrega === 'delivery' ? business.deliveryExtraMinutes : 0),
                )}
              </p>
              <p className="caption mt-0.5 texto-cuerpo">
                {entrega === 'delivery'
                  ? `Envío ${business.deliveryFee > 0 ? money(business.deliveryFee) : 'gratis'}`
                  : 'Sin costo de envío'}
                {business.minOrderAmount > 0 && ` · Mínimo ${money(business.minOrderAmount)}`}
              </p>
            </div>
          </div>

          {entrega === 'delivery' && (
            <button
              onClick={() => setEnCuenta(true)}
              className="flex w-full items-center gap-2.5 border-t borde-tema px-4 py-3 text-left transition active:bg-black/5"
            >
              <RiMapPin2Line size={17} className="shrink-0 texto-cuerpo" />
              <span className="min-w-0 flex-1">
                <span className="caption block texto-tenue">Entregar en</span>
                <span className="block truncate text-[14px] font-bold tracking-tight">
                  {direccionActiva || 'Elige tu dirección'}
                </span>
              </span>
              <RiArrowDownSLine size={18} className="shrink-0 texto-tenue" />
            </button>
          )}
        </div>
      </div>

      {!puedePedir && (
        <div className="px-4 pt-3">
          <Aviso
            tono="alerta"
            icono={<RiTimeLine size={18} />}
            titulo={status === 'cerrada' ? 'Ahora está cerrado' : 'No está recibiendo pedidos'}
          >
            {/* «volver cuando abra» no dice cuándo, y era la mitad del
                problema: el cliente tiene que adivinar a qué hora volver. */}
            {status === 'cerrada' && apertura ? `${cuandoAbre(apertura)}. ` : ''}
            Puedes ver la carta mientras tanto.
          </Aviso>
        </div>
      )}

      {/* ⚠️ Aquí había una fila de CÍRCULOS de categoría, y se retiró: pintaba
          exactamente la misma lista (`grupos`) que las pestañas pegajosas de
          justo debajo. Dos veces lo mismo, una encima de la otra.

          El sitio se gana lo que vale: es lo primero que se ve bajo la
          tarjeta de servicio, y ahí va el aviso del pago pendiente. */}
      {pagoPendiente && (
        <div className="px-4 pt-4">
          <Aviso
            tono="alerta"
            icono={<RiTimeLine size={18} />}
            titulo="Falta tu comprobante"
            onClick={() => setAbrirPago(true)}
          >
            Tu pedido #{pagoPendiente.order_number} está guardado. Toca para pagarlo.
          </Aviso>
        </div>
      )}

      {/* ── Pestañas de categoría, pegadas arriba ───────────────────────
          ⚠️ La activa va en TINTA, texto y subrayado, como la referencia —
          no en el color del negocio. El subrayado era `border-(--acento)`:
          con el lima de la plataforma eso es 1,19:1 contra el blanco, o
          sea una pestaña «activa» sin marca visible. Un elemento gráfico
          que porta información necesita 3:1, y el acento del negocio no lo
          garantiza porque lo elige él. */}
      {grupos.length > 1 && (
        <nav className="superficie sticky top-0 z-30 mt-4 border-b borde-tema">
          <div className="sin-barra flex gap-1 overflow-x-auto px-4">
            {grupos.map(grupo => (
              <button
                key={grupo.id}
                ref={(nodo) => { pestanas.current[grupo.id] = nodo }}
                onClick={() => irACategoria(grupo.id)}
                className={`shrink-0 border-b-[3px] px-3 py-3.5 text-[14.5px] font-bold tracking-tight whitespace-nowrap transition ${
                  categoriaActiva === grupo.id
                    ? 'border-(--tinta) text-(--texto)'
                    : 'border-transparent texto-tenue'
                }`}
              >
                {grupo.nombre}
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* ── Carta ── */}
      {grupos.map((grupo, indice) => (
        <section
          key={grupo.id}
          data-categoria={grupo.id}
          ref={(nodo) => { secciones.current[grupo.id] = nodo }}
          className="scroll-mt-14"
        >
          {/* La banda separa una sección de otra sin que haya que leer nada.
              La primera no la lleva: iría pegada a las pestañas. */}
          {indice > 0 && <div className="banda h-2.5" />}
          {/* ⚠️ La sección va en BLANCO (2026-09-06). Antes las tarjetas eran
              blancas sobre el gris de la app; ahora es al revés, y lo gris son
              la foto y las bandas que separan secciones. Sin este fondo, una
              foto con fondo gris sobre una app gris no tiene contorno y la
              rejilla se deshace. */}
          <div className="superficie px-4 pt-5 pb-6">
            <h2 className="mb-3.5 text-[22px] leading-none font-extrabold tracking-tight">
              {grupo.nombre}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {grupo.productos.map(tarjeta)}
            </div>
          </div>
        </section>
      ))}

      {!grupos.length && (
        <div className="px-4">
          <EstadoVacio icono={<RiRestaurantLine size={28} />} titulo="Todavía no hay carta">
            El negocio aún no cargó sus productos. Vuelve a mirar en un rato.
          </EstadoVacio>
        </div>
      )}

      {buscando && (
        <Suspense fallback={null}>
          <Buscar
            slug={slug}
            negocio={business.name}
            grupos={grupos}
            tarjeta={tarjeta}
            onCerrar={() => setBuscando(false)}
            onIrACategoria={(id) => {
              setBuscando(false)
              // Al pintado siguiente: la carta ya está a la vista.
              requestAnimationFrame(() => irACategoria(id))
            }}
          />
        </Suspense>
      )}
      {/* El campo que recibe el foco en el toque de «Buscar». Invisible pero
          enfocable: con `display: none` iOS no le daría el foco. 16 px para
          que Safari no amplíe la página al enfocarlo. */}
      <input
        ref={enfocarAntes}
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none fixed top-0 left-0 size-px text-[16px] opacity-0"
      />

      {/* ══ EL PIE: «Ver pedido» ENCIMA de la barra, no tapándola ═══════
          ⚠️ Esto era un fallo, no una decisión. La barra del carrito estaba
          `fixed bottom-0 z-50` y la de navegación `fixed bottom-0 z-40`: con
          una sola cosa en el carrito, «Ver pedido» se pintaba ENCIMA y hacía
          desaparecer Inicio · Buscar · Carrito · Cuenta. El cliente añadía un
          producto y perdía el menú de la app.

          Ahora las dos viven en el MISMO contenedor fijo, apiladas, así que
          el carrito se apoya sobre la barra sin números mágicos: nada de
          calcular a mano el alto de la navegación, que se desincroniza en
          cuanto alguien le cambia un padding. */}
      <div className="fixed inset-x-0 bottom-0 z-40">
        {unidades > 0 && (
          <div className="mx-auto max-w-lg px-4 pb-2">
            <button
              onClick={() => setCarritoAbierto(true)}
              className="tinta flex w-full items-center justify-between rounded-[1.75rem] px-5 py-4 shadow-flotante transition active:scale-[0.99]"
            >
              <span className="flex items-center gap-2.5 text-[15px] font-bold tracking-tight">
                <span className="acento flex size-7 items-center justify-center rounded-full text-[12px] font-extrabold tabular-nums">
                  {unidades}
                </span>
                Ver pedido
              </span>
              <span className="flex items-center gap-2 text-[19px] font-extrabold tracking-tight tabular-nums">
                {money(total)}
                <RiShoppingCart2Line size={18} />
              </span>
            </button>
          </div>
        )}

        {/* ⚠️ La barra activa RELLENA el icono, y esto es lo que separa una
            app de una plantilla. Con todo en línea, las cuatro pestañas pesan
            igual y ninguna dice dónde estás; el relleno lo dice sin leer, que
            es como funcionan las barras de las apps grandes.

            Se pasó de lucide a Remix el 2026-08-27 precisamente por esto:
            lucide es SOLO línea —no tiene rellenos—, así que este estado no
            se podía dibujar. Y de paso deja de ser el set por defecto de las
            herramientas de IA, que era la queja del dueño. */}
        <nav className="superficie border-t borde-tema">
          <div className="mx-auto flex max-w-lg items-stretch px-2 pt-1.5 pb-seguro">
            {([
              {
                id: 'inicio',
                icono: RiHome5Line,
                iconoActivo: RiHome5Fill,
                texto: 'Inicio',
                accion: () => {
                  setBuscando(false)
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                },
              },
              // Abre la pantalla de Buscar (2026-09-26). Antes abría una barra
              // DENTRO de la portada, con el héroe encima y los resultados
              // en el sitio de la carta: parecía la portada rota.
              {
                id: 'buscar',
                icono: RiSearchLine,
                iconoActivo: RiSearchFill,
                texto: 'Buscar',
                accion: () => {
                  // ⚠️ El foco, DENTRO del toque: iOS solo abre el teclado
                  // así. El campo de verdad está en la pantalla de Buscar, que
                  // se monta después; este campo escondido lo recibe ya y se
                  // lo pasa (ver `screens/Buscar.tsx`). De un campo a otro,
                  // iOS mantiene el teclado abierto.
                  enfocarAntes.current?.focus()
                  setBuscando(true)
                },
              },
              // ⚠️ Abre SIEMPRE, también con el carrito vacío. Estaba como
              // `unidades > 0 && setCarritoAbierto(true)`: con el carrito
              // vacío el botón no hacía absolutamente nada —ni abría, ni
              // avisaba— y se sentía roto. La hoja ya sabe decir «Tu carrito
              // está vacío», que es una respuesta; el silencio no lo es.
              {
                id: 'carrito',
                icono: RiShoppingCart2Line,
                iconoActivo: RiShoppingCart2Fill,
                texto: 'Carrito',
                accion: () => setCarritoAbierto(true),
                contador: unidades,
              },
              // ⚠️ Antes decía «Pedido» y abría el ÚLTIMO directamente. Servía
              // mientras solo hubiera uno del que preocuparse; quien ha pedido
              // cinco veces no tiene «un pedido», tiene un historial.
              {
                id: 'cuenta',
                icono: RiUser3Line,
                iconoActivo: RiUser3Fill,
                texto: 'Cuenta',
                accion: () => setEnCuenta(true),
              },
            ]).map(({ id, icono: Linea, iconoActivo: Relleno, texto, accion, contador }) => {
              // Cuál está activa. `inicio` lo está mientras no haya nada
              // abierto encima: es la pantalla en la que se está de verdad.
              const activa = id === 'buscar' ? buscando
                : id === 'carrito' ? carritoAbierto
                  : id === 'inicio' ? !buscando && !carritoAbierto
                    : false
              const Icono = activa ? Relleno : Linea
              return (
              <button
                key={id}
                onClick={accion}
                aria-current={activa ? 'page' : undefined}
                className={`relative flex flex-1 flex-col items-center gap-1 py-1.5 text-[10.5px] font-bold transition active:scale-95 ${
                  activa ? '' : 'texto-tenue'
                }`}
              >
                <span className="relative">
                  <Icono size={22} />
                  {Boolean(contador) && (
                    <span className="acento absolute -top-1.5 -right-2.5 flex min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] leading-4.5 font-extrabold tabular-nums">
                      {contador}
                    </span>
                  )}
                </span>
                {texto}
              </button>
              )
            })}
          </div>
        </nav>
      </div>

      {/* Sin `fallback`: mientras baja, lo correcto es que no se vea nada.
          Un esqueleto de hoja apareciendo y desapareciendo sobre la carta
          molesta más que el cuarto de segundo que tarda. */}
      {pidiendoDireccion && (
        <Suspense fallback={null}>
          <DireccionRapida
            abierta
            onCerrar={() => setPidiendoDireccion(false)}
            onGuardar={nuevaDireccion}
          />
        </Suspense>
      )}

      <ProductSheet
        product={elegido}
        abierto={Boolean(elegido)}
        onCerrar={() => setElegido(null)}
        onAgregar={linea => setLineas(actuales => addLine(actuales, linea))}
        onAgregarSuelto={agregarAdicional}
        onAgregarAdicionales={agregarAdicionales}
        seArmaElAdicional={adicionalSeArma}
        puedePedir={puedePedir}
        lineaEnCarrito={elegido
          ? lineas.find(linea => linea.key === claveDelPlato(elegido)) ?? null
          : null}
      />

      <CartSheet
        paymentMethods={business.paymentMethods || []}
        abierta={carritoAbierto}
        onCerrar={() => setCarritoAbierto(false)}
        lines={lineas}
        onCantidad={(key, cantidad) => setLineas(actuales => setQuantity(actuales, key, cantidad))}
        onEditar={(producto) => {
          setCarritoAbierto(false)
          setElegido(producto)
        }}
        me={me}
        puedePedir={puedePedir}
        enviando={enviando}
        error={error}
        deliveryFee={business.deliveryFee}
        minOrderAmount={business.minOrderAmount}
        entrega={entrega}
        onEntrega={setEntrega}
        onConfirmar={confirmar}
        onNuevaDireccion={nuevaDireccion}
        onUbicarDireccion={ubicarDireccion}
        onBorrarDireccion={borrarDireccion}
      />
    </div>
  )
}
