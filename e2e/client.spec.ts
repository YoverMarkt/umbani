import { expect, test } from './fixtures'
import {
  expectConnectedLabels, mockClientApi, mockOrdersFilteredByStatus, seedClientSession,
} from './helpers'

const clientUrl = 'http://127.0.0.1:4173/app/'

test('protege rutas privadas y muestra el login accesible', async ({ page }) => {
  await page.goto(`${clientUrl}#/catalog`)

  await expect(page).toHaveURL(/#\/login$/)
  await expect(page.getByRole('heading', { name: 'Panel de tu negocio' })).toBeVisible()
  await expect(page.getByLabel('Correo')).toBeVisible()
  await expect(page.getByLabel('Contraseña')).toBeVisible()
  await expect(page.locator('label[for="email"]')).toHaveCSS('margin-bottom', '8px')
})

test('inicia sesión y entra al panel del negocio', async ({ page }) => {
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/login`)

  await page.getByLabel('Correo').fill('dueno@e2e.test')
  await page.getByLabel('Contraseña').fill('segura-e2e')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page).toHaveURL(/#\/$/)
  await expect(page.getByText('Negocio E2E').first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('client_token'))).toBe('e2e-client-token')
})

test('navega en móvil mediante el Sheet de shadcn', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(clientUrl)

  await expect(page.getByRole('button', { name: 'Abrir navegación' })).toBeVisible()
  await page.getByRole('button', { name: 'Abrir navegación' }).click()
  await page.getByRole('link', { name: /Catálogo/ }).click()

  await expect(page).toHaveURL(/#\/catalog$/)
  await expect(page.getByRole('heading', { name: 'Catálogo' })).toBeVisible()
  await expect(page.getByText('Producto E2E')).toBeVisible()
})

test('el formulario de catálogo asocia cada etiqueta con su control', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/catalog`)

  await page.getByRole('button', { name: 'Agregar producto' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nuevo producto' })
  await expect(dialog).toBeVisible()
  await expectConnectedLabels(dialog)
})

test('el formulario del producto enseña lo esencial y pliega el resto', async ({ page }) => {
  // ⚠️ Pedido del dueño (2026-09-14): «quiero un panel realmente sencillo de
  // agregar o crear productos, que sea intuitivo». El formulario pedía DOCE
  // campos de golpe, y para un local de diez platos eso es un muro.
  //
  // `brand` y `external_sku` ni siquiera llegan al cliente —los usa el bot para
  // BUSCAR fotos en catálogos de retail, y están vacíos en los 23 productos de
  // producción—. No se borran (un supermercado los necesita): se pliegan.
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/catalog`)

  await page.getByRole('button', { name: 'Agregar producto' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nuevo producto' })
  await expect(dialog).toBeVisible()

  // Lo esencial, sin tener que abrir nada.
  for (const etiqueta of [/^Nombre/, /^Precio \*/, /^Categoría/, /^Tipo de producto/]) {
    await expect(dialog.getByLabel(etiqueta)).toBeVisible()
  }

  // Y lo de siempre, fuera de la vista hasta que se pida.
  await expect(dialog.getByLabel('Marca')).toBeHidden()
  await expect(dialog.getByLabel('SKU')).toBeHidden()

  await dialog.getByText('Más opciones').click()
  await expect(dialog.getByLabel('Marca')).toBeVisible()
  await expect(dialog.getByLabel('SKU')).toBeVisible()
})

test('oculta a un empleado las secciones que no tiene permitidas', async ({ page }) => {
  let alertsRequests = 0
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/client/alerts') alertsRequests += 1
  })
  await page.addInitScript(() => {
    localStorage.setItem('client_token', 'e2e-employee-token')
    localStorage.setItem('client_biz', JSON.stringify({ id: 'biz-e2e', name: 'Negocio E2E', type: 'tienda' }))
    // ⚠️ Era `conversaciones`, y ese permiso se quedó sin pantalla el
    // 2026-08-23. Se prueba con `catalogo`, que sí abre una sección: lo que
    // fija esta prueba es que un empleado ve SOLO lo suyo, no qué permiso.
    localStorage.setItem('client_user', JSON.stringify({ name: 'Empleado E2E', role: 'employee', permissions: ['catalogo'] }))
  })
  await mockClientApi(page)
  await page.goto(clientUrl)

  await expect(page.getByRole('link', { name: /Catálogo/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Conversaciones' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Reportes' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Ajustes' })).toHaveCount(0)
  expect(alertsRequests).toBe(0)
})

test('un negocio normal conserva horarios y no puede abrir reservas', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(clientUrl)

  await expect(page.getByRole('link', { name: 'Horarios' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Reservas' })).toHaveCount(0)
  // La agenda salió el 2026-08-16: su ruta ya no existe y cae en el inicio.
  await page.goto(`${clientUrl}#/bookings`)
  await expect(page).toHaveURL(/#\/$/)
  await page.goto(`${clientUrl}#/schedule`)
  await expect(page.getByRole('heading', { name: 'Horarios de atención' })).toBeVisible()
  await expect(page.getByText('Duración de cada cita')).toHaveCount(0)
})

test('horarios expone nombres accesibles en controles dinámicos', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('client_token', 'e2e-client-token')
    localStorage.setItem('client_biz', JSON.stringify({
      id: 'biz-e2e', name: 'Panadería E2E', type: 'panadería',
    }))
    localStorage.setItem('client_user', JSON.stringify({
      name: 'Dueño E2E', role: 'owner', permissions: [],
    }))
  })
  await mockClientApi(page)
  await page.route('**/api/client/business', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'biz-e2e', name: 'Panadería E2E', type: 'panadería',
      takes_orders: false,
    }),
  }))
  await page.route('**/api/client/schedule', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      day_of_week: 1,
      open_time: '09:00:00',
      close_time: '18:00:00',
      slot_duration: 60,
      is_active: true,
    }]),
  }))
  await page.goto(`${clientUrl}#/schedule`)

  await expect(page.getByRole('checkbox', { name: 'Lunes' })).toBeChecked()
  await expect(page.getByLabel('Hora de apertura del Lunes')).toHaveValue('09:00')
  await expect(page.getByLabel('Hora de cierre del Lunes')).toHaveValue('18:00')
  await expectConnectedLabels(page.locator('main'))
})

// El test que vivía aquí comprobaba que una clínica veía «Servicios» en vez de
// «Catálogo». Se fue el 2026-08-20 con `isServiceBiz`: retirados los tipos de
// servicios, salud y hospedaje, todo negocio de Umbani tiene catálogo. Lo que
// sí se sigue probando está repartido: que la barra lateral lleva a «Catálogo»
// en la primera prueba del archivo, y que no ofrece Reservas en la de horarios.

test('el sidebar cliente queda fijo y solo se desplaza el contenido', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(clientUrl)

  const main = page.locator('main')
  const aside = page.locator('aside')
  const topBefore = (await aside.boundingBox())?.y
  await main.evaluate(element => {
    const filler = document.createElement('div')
    filler.style.height = '2200px'
    element.appendChild(filler)
    element.scrollTop = 500
  })

  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect((await aside.boundingBox())?.y).toBe(topBefore)
})

test('reportes renderiza gráficos shadcn sin desbordar en móvil', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/reports`)

  await expect(page.getByRole('heading', { name: 'Reportes del negocio' })).toBeVisible()

  // 7 datasets del mock traen datos (trend, comparación, vendedor, top,
  // recurrentes y los DOS de «cómo llegan», que reemplazaron a consultados y
  // FAQ); los vacíos muestran su estado sin chart.
  await expect(page.locator('[data-slot="chart"]')).toHaveCount(7)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // ⚠️ La pestaña «Cómo llegan» reemplazó a «Bot» el 2026-09-18: el bot por
  // chat se retiró y sus tarjetas llevaban meses vacías. Lo que el dueño
  // necesita hoy es de dónde le llega el cliente que escribe a Umbani. Los
  // pasos viven dentro del gráfico —texto SVG que en móvil se recorta—, así
  // que aquí se comprueba que la pestaña existe y pinta sus dos bloques.
  await expect(page.getByRole('tab', { name: 'Bot' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Cómo llegan' }).click()
  await expect(page.getByText('Cómo llegan tus clientes')).toBeVisible()
  await expect(page.getByText('Dónde te encontraron')).toBeVisible()
})

test('un pedido recorre confirmación, preparación y reparto sin generar cobros automáticos', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  let orderStatus = 'pendiente'
  let statusPayload: Record<string, unknown> | null = null

  // `**` tras "orders" para cubrir también /orders/:id/status (`*` no cruza `/`).
  await page.route('**/api/client/orders**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/client/orders/order-e2e/status' && route.request().method() === 'PUT') {
      statusPayload = route.request().postDataJSON() as Record<string, unknown>
      const requested = route.request().postDataJSON() as { status: string }
      orderStatus = requested.status
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    if (path === '/api/client/orders' && route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'order-e2e', contact_phone: '+593999000111', contact_name: 'Cliente pedido',
          status: orderStatus, subtotal: 25, discount: 0, total: 25, currency: 'USD',
          created_at: '2026-07-14T10:00:00.000Z',
          // ⚠️ CON `id`, como en la realidad: `order_items.id` es clave
          // primaria y siempre viene. Sin él aquí, la tarjeta pintaba la lista
          // con una clave indefinida y React avisaba — lo cazó esta misma
          // prueba al añadir la checklist de preparación (2026-09-24).
          order_items: [{
            id: 'order-item-e2e',
            product_id: 'product-e2e', product_name: 'Producto E2E',
            quantity: 1, unit_price: 25, line_total: 25,
          }],
        }]),
      })
    }
    return route.fallback()
  })
  await page.goto(`${clientUrl}#/orders`)

  // El flujo entero de una pizzería, un paso por pantalla. El refetch desmonta
  // el diálogo en cuanto responde el PUT; dispatchEvent evita que Playwright
  // reintente un click que ya funcionó sobre un nodo retirado.
  const avanzar = async (boton: string, esperado: string) => {
    await page.getByRole('button', { name: boton, exact: true }).click()
    const dialogo = page.getByRole('alertdialog').filter({ hasText: boton })
    await dialogo.getByRole('button', { name: boton, exact: true }).dispatchEvent('click')
    await expect.poll(() => statusPayload).toEqual({ status: esperado })
  }

  // ⚠️ Aceptar y preparar es UN paso desde el 2026-08-08. Eran dos —aceptar y
  // luego poner en preparación— y para una cocina son la misma decisión: quien
  // acepta es quien manda hacerlo. El paso intermedio dejaba al cliente
  // mirando un «aceptado» que no duraba nada.
  await avanzar('Aceptar y preparar', 'preparacion')
  await avanzar('Marcar en camino', 'en_camino')
  await avanzar('Marcar entregado', 'completado')
})

// Regresión del pedido perdido: la alarma existía y era sorda a `orders`.
// Aquí se comprueba que un pedido que entra ESTANDO el panel abierto enciende
// el banner solo, sin recargar, y lleva a donde se atiende.
test('la alarma se enciende sola cuando entra un pedido pendiente', async ({ page }) => {
  test.setTimeout(45_000)   // el panel consulta cada 12 s
  await seedClientSession(page)
  await mockClientApi(page)
  let orders: Record<string, unknown>[] = []

  await page.route('**/api/client/business', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'biz-e2e', name: 'Pizzería E2E', type: 'pizzería',
      takes_orders: true,
    }),
  }))
  await mockOrdersFilteredByStatus(page, () => orders)
  await page.goto(clientUrl)

  // Un negocio que recibe pedidos tiene su sección propia en el menú: sin ella
  // los pedidos quedaban escondidos dentro de Ventas y nadie los veía llegar.
  await expect(page.getByRole('link', { name: 'Pedidos' })).toBeVisible()

  // ⚠️ «Conversaciones» se retiró el 2026-08-23: el dueño de un local del
  // marketplace no tiene chats que leer — sus clientes escriben al número de
  // Umbani y esa conversación no pasa por `conversation_history`.
  await expect(page.getByRole('link', { name: 'Conversaciones' })).toHaveCount(0)

  // Sin pedidos pendientes el panel calla (si no, el dueño la silenciaría siempre).
  await expect(page.getByText('¡Nuevo pedido!')).toHaveCount(0)

  orders = [{
    id: 'order-alarma', contact_phone: '+593999000111', contact_name: 'Cliente pedido',
    status: 'pendiente', subtotal: 25, discount: 0, total: 25, currency: 'USD',
    created_at: '2026-08-02T10:00:00.000Z',
  }]

  await expect(page.getByText('¡Nuevo pedido!')).toBeVisible({ timeout: 25_000 })
  await expect(page.getByText('1 pedido por confirmar')).toBeVisible()
  await page.getByRole('button', { name: 'Atender' }).click()
  await expect(page).toHaveURL(/#\/orders$/)
})

// ── El pedido que se pagó y nadie oyó ──────────────────────────────────────
//
// El caso real del 2026-08-08: el cliente pide por transferencia, sube su
// comprobante y el pedido pasa a `pago_en_revision`. Nunca fue «pendiente»,
// así que la alarma —que solo vigilaba ese estado— no sonó. Cuatro pedidos
// pagados esa noche y ni una campana.
test('la alarma suena cuando llega el comprobante de una transferencia', async ({ page }) => {
  test.setTimeout(45_000)
  await seedClientSession(page)
  await mockClientApi(page)
  let orders: Record<string, unknown>[] = []

  await page.route('**/api/client/business', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'biz-e2e', name: 'Pizzería E2E', type: 'pizzería',
      takes_orders: true,
    }),
  }))
  await page.route('**/api/client/orders**', route => {
    const pedidos = new URL(route.request().url()).searchParams.get('status')
    const filtro = pedidos ? pedidos.split(',') : null
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        filtro ? orders.filter(o => filtro.includes(String(o.status))) : orders,
      ),
    })
  })
  await page.goto(clientUrl)
  await expect(page.getByRole('link', { name: 'Pedidos' })).toBeVisible()

  // Esperando el pago NO suena: el dueño no puede hacer nada hasta que el
  // cliente pague, y una alarma sin trabajo detrás enseña a ignorarla.
  orders = [{
    id: 'order-transferencia', contact_phone: '+593999000222', contact_name: 'Cliente que paga',
    status: 'esperando_pago', subtotal: 12.5, discount: 0, total: 12.5, currency: 'USD',
    created_at: '2026-08-08T04:40:00.000Z',
  }]
  await page.waitForTimeout(14_000)
  await expect(page.getByText('¡Comprobante por revisar!')).toHaveCount(0)
  await expect(page.getByText('¡Nuevo pedido!')).toHaveCount(0)

  // Sube el comprobante: ahora sí hay algo que mirar, y tiene que sonar.
  orders = [{ ...orders[0], status: 'pago_en_revision' }]
  await expect(page.getByText('¡Comprobante por revisar!')).toBeVisible({ timeout: 25_000 })
  await expect(page.getByText('1 comprobante por revisar')).toBeVisible()
  await page.getByRole('button', { name: 'Atender' }).click()
  await expect(page).toHaveURL(/#\/orders$/)
})

// ⚠️ Aquí vivían CINCO pruebas de la pantalla de Conversaciones —el móvil sin
// desbordamiento, el fallo de la lista de bloqueados, el envío manual que
// devuelve el texto, los modales de nombre y etiquetas, y el recordatorio de
// venta—. Se van con la pantalla el 2026-08-23: el dueño de un local del
// marketplace no tiene chats que leer.
//
// La única que seguía protegiendo algo se REESCRIBE justo debajo: el bloqueo
// se mudó a Clientes, y con él la misma forma de romperse.

// ⚠️ REGRESIÓN del 2026-08-15, que sigue viva en su nueva casa. La lista de
// bloqueados es una petición más de la pantalla, y cuando devolvió `{}` en vez
// de una lista, `new Set({})` reventó y se llevó por delante la pantalla
// ENTERA: el dueño se quedó sin poder leer a sus clientes por un dato
// accesorio.
//
// El caso no es teórico ni de laboratorio: pasa con un 502 del proxy, con un
// error de la base, o con un despliegue a medias. Un dato de adorno no puede
// tumbar lo importante.
test('un fallo en la lista de bloqueados no deja Clientes en blanco', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.route('**/api/client/blocked', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }))
  await page.goto(`${clientUrl}#/customers`)

  // El directorio se sigue leyendo, que es para lo que existe la pantalla.
  await expect(page.getByRole('heading', { name: 'Clientes' })).toBeVisible()
  await expect(page.getByText('Cliente E2E').first()).toBeVisible()
})

// ⚠️ EL CASO QUE DE VERDAD IMPORTA, y que el botón de la tabla NO cubre: el
// directorio sale de `sales` —quien COMPRÓ y recibió su pedido— y quien pide
// para molestar nunca llega ahí, porque su pedido se cancela. Sin esta casilla
// el dueño solo podía bloquear a sus buenos clientes.
test('se puede bloquear un número que nunca compró', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  let bloqueado: string | null = null
  // ⚠️ La lista devuelve OBJETOS con su plazo desde el 2026-08-29, no
  // teléfonos sueltos: el panel tiene que distinguir el bloqueo del dueño
  // —que no caduca— del automático de Umbani, que se va solo.
  await page.route('**/api/client/blocked', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(
      bloqueado ? [{ phone: bloqueado, until: null, permanent: true }] : [],
    ),
  }))
  await page.route('**/api/client/blocked/*', route => {
    bloqueado = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || '')
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ blocked: true }),
    })
  })
  await page.goto(`${clientUrl}#/customers`)

  const campo = page.getByLabel('Bloquear un número')
  await expect(campo).toBeVisible()

  // Un número a medias no puede acabar bloqueando a otra persona.
  await campo.fill('5939')
  await expect(page.getByText(/número completo con su código de país/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bloquear', exact: true })).toBeDisabled()

  await campo.fill('+593 99 555 4433')
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click()
  await page.getByRole('button', { name: 'Bloquear', exact: true }).last().click()

  await expect(page.getByText('Cliente bloqueado')).toBeVisible()
  // Se manda solo en dígitos: el mismo teléfono llega con `+` por un canal y
  // sin él por otro, y dos formas de escribirlo serían dos clientes.
  expect(bloqueado).toBe('593995554433')
  await expect(page.getByText('593995554433')).toBeVisible()
})

// El bloqueo es la única defensa del dueño frente a quien pide para molestar,
// y se mudó de Conversaciones a Clientes con la pantalla que lo alojaba.
test('desde Clientes se puede bloquear y desbloquear', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  let bloqueados: { phone: string; until: string | null; permanent: boolean }[] = []
  await page.route('**/api/client/blocked', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(bloqueados),
  }))
  await page.route('**/api/client/blocked/*', route => {
    // `permanent: true` = lo bloqueó el DUEÑO, que es lo que acaba de pasar.
    // Por eso el botón que sale después dice «Desbloquear» y no «Levantar
    // ahora»: ese segundo es para el automático, que caduca solo.
    bloqueados = [{ phone: '593999000111', until: null, permanent: true }]
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ blocked: true }),
    })
  })
  await page.goto(`${clientUrl}#/customers`)

  await page.getByRole('button', { name: /Bloquear a Cliente E2E/ }).click()
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click()
  await expect(page.getByText('Cliente bloqueado')).toBeVisible()
  // Y al recargar la lista sale marcado, con su salida a mano.
  await expect(page.getByRole('button', { name: /Desbloquear/ }).first()).toBeVisible()
})


test('cambiar de sesión no hereda módulos ni datos del negocio anterior', async ({ page }) => {
  await mockClientApi(page)
  // Pedidos es lo que ahora distingue a un negocio de otro: la agenda, que era
  // el otro módulo que los separaba, se retiró el 2026-08-16.
  const bizFor = (vende: boolean) => ({
    id: vende ? 'biz-tienda' : 'biz-informa',
    name: vende ? 'Tienda E2E' : 'Negocio E2E',
    type: vende ? 'tienda' : 'negocio',
    takes_orders: vende,
  })
  await page.route('**/api/client/login', route => {
    const { email } = route.request().postDataJSON() as { email: string }
    const vende = email.startsWith('tienda')
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        token: vende ? 'token-tienda' : 'token-informa',
        business: bizFor(vende),
        user: { name: 'Dueño E2E', role: 'owner', permissions: [] },
      }),
    })
  })
  await page.route('**/api/client/business', route => {
    const vende = (route.request().headers().authorization || '').includes('token-tienda')
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bizFor(vende)) })
  })

  await page.goto(`${clientUrl}#/login`)
  await page.getByLabel('Correo').fill('tienda@e2e.test')
  await page.getByLabel('Contraseña').fill('segura-e2e')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('link', { name: 'Pedidos' })).toBeVisible()

  // Cambio de negocio SIN recargar: el panel debe entrar limpio
  await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await page.getByLabel('Correo').fill('informa@e2e.test')
  await page.getByLabel('Contraseña').fill('segura-e2e')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page.getByText('Negocio E2E').first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Pedidos' })).toHaveCount(0)
})

test('el tema oscuro arranca con el theme-boot externo (compatible con el CSP)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bp-theme-client', 'dark'))
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/`)

  // El HTML servido referencia theme-boot.js y el archivo existe con la key correcta
  const html = await (await page.request.get(clientUrl)).text()
  expect(html).toContain('theme-boot.js')
  const boot = await page.request.get(`${clientUrl}theme-boot.js`)
  expect(boot.ok()).toBe(true)
  expect(await boot.text()).toContain('bp-theme-client')
  await expect(page.locator('html')).toHaveClass(/dark/)
})

test('el dueño arma un almuerzo por partes desde la ficha del producto', async ({ page }) => {
  // ⚠️ Pedido del dueño (2026-09-14): «que para todo local de menú pequeño sea
  // fácil de armar lo que vendo: un almuerzo vale 3 dólares, y al pedirlo que
  // me salga qué sopa quiero y qué segundo». El editor vive DENTRO del
  // formulario del producto, y eso trae el fallo que esta prueba vigila: un
  // botón sin `type="button"` —o un Enter en un campo— envía el formulario del
  // producto, guarda y cierra la ficha en mitad del armado.
  await seedClientSession(page)
  await mockClientApi(page)

  const grupos: Record<string, unknown>[] = []
  const opciones: Record<string, unknown>[] = []
  const guardados: Record<string, unknown>[] = []

  await page.route('**/api/client/option-groups**', async (route) => {
    const peticion = route.request()
    const cuerpo = () => JSON.parse(peticion.postData() || '{}') as Record<string, unknown>
    if (peticion.method() === 'POST') {
      const grupo = { id: `g${grupos.length + 1}`, ...cuerpo() }
      grupos.push(grupo)
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(grupo) })
    }
    if (peticion.method() === 'PUT') {
      const id = new URL(peticion.url()).pathname.split('/').pop()
      const cambios = cuerpo()
      guardados.push(cambios)
      const indice = grupos.findIndex(grupo => grupo.id === id)
      if (indice >= 0) grupos[indice] = { ...grupos[indice], ...cambios }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(grupos) })
  })

  await page.route('**/api/client/options**', async (route) => {
    const peticion = route.request()
    if (peticion.method() === 'POST') {
      const opcion = { id: `o${opciones.length + 1}`, ...JSON.parse(peticion.postData() || '{}') }
      opciones.push(opcion)
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(opcion) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opciones) })
  })

  await page.goto(`${clientUrl}#/catalog`)
  await page.getByRole('button', { name: 'Editar' }).first().click()
  const ficha = page.getByRole('dialog', { name: 'Editar producto' })
  await expect(ficha).toBeVisible()

  // Todavía no se arma por partes: se ofrece con el ejemplo del almuerzo.
  await ficha.getByRole('button', { name: 'Armarlo por partes' }).click()

  // Las dos partes, y la regla dicha como la leerá el cliente.
  //
  // ⚠️ `exact: true`, y era un fallo de la PRUEBA que costó varias vueltas de CI
  // (2026-09-16). `getByLabel` busca por SUBCADENA, así que «Parte» casaba
  // también con los botones «Quitar la parte Sopa» y «Quitar la parte Segundo»:
  // 4 coincidencias para 2 partes. Y parpadeaba porque esos botones se pintan
  // un instante después que los campos — si la aserción llegaba en esa
  // ventana veía 2 y pasaba; en un CI lento ya veía 4. Se demostró contando
  // los POST: siempre fueron 2. La app nunca creó partes de más.
  await expect(ficha.getByLabel('Parte', { exact: true })).toHaveCount(2)
  await expect(ficha.getByText('Sopa + Segundo = un plato completo a $10.00')).toBeVisible()

  // Un plato dentro de una parte, agregado con Enter.
  await ficha.getByLabel('Agregar a Sopa').fill('Caldo de res')
  await ficha.getByLabel('Agregar a Sopa').press('Enter')
  await expect(ficha.getByText('Caldo de res')).toBeVisible()

  // ⚠️ Lo que de verdad se vigila: la ficha SIGUE ABIERTA. Si un botón o el
  // Enter enviaran el formulario, aquí el producto ya estaría guardado y el
  // dueño habría perdido el hilo a media mesa.
  await expect(ficha).toBeVisible()

  // El precio por separado se escribe con coma, como se escribe aquí.
  await ficha.getByLabel('Por separado ($)').first().fill('1,50')
  await ficha.getByLabel('Agregar a Sopa').click()
  await expect.poll(() => guardados.at(-1)?.loose_price).toBe(1.5)
  await expect(ficha).toBeVisible()
})

// ═══════════════════════════════════════════════════════════════════════════
// PERSONALIZACIÓN: EL DUEÑO TIENE QUE SABER QUÉ VE SU CLIENTE
// ═══════════════════════════════════════════════════════════════════════════
//
// Caso REAL del 2026-09-16. El dueño de La Abuelita: «en la mini app tengo 2
// sopas y unos 5 segundos, pero en el panel tengo como 4 sopas… ¿o soy yo el
// que no entiende?». No era él: tenía DOCE grupos para seis productos y la
// pantalla los listaba en plano, así que cuatro tarjetas decían «Sopa».
//
// ⚠️ Esta pestaña no la tocaba ningún E2E, y el simulacro de la API ni siquiera
// respondía a sus rutas — el respaldo devolvía `{}` donde el panel espera una
// lista. O sea que un fallo de render aquí no lo habría visto nadie.
test('Personalización agrupa por producto y aparta lo que el cliente no ve', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)

  const grupo = (o: Record<string, unknown>) => ({
    product_id: null, category_id: null, active: true, description: null,
    selection_type: 'single', required: true, min_selectable: 1, max_selectable: 1,
    pricing_strategy: 'included', free_selections: 0, is_meal_part: false,
    template_id: null, loose_price: null, sort: 0, ...o,
  })
  await page.route('**/api/client/products', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([
      { id: 'almuerzo', name: 'Almuerzo del día', price: 3.5, stock: 'disponible', active: true, category_id: 'cat-alm' },
      { id: 'agua', name: 'Agua', price: 0.75, stock: 'disponible', active: true, category_id: 'cat-beb' },
    ]),
  }))
  await page.route('**/api/client/option-groups', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([
      grupo({ id: 'g1', name: 'Sopa', product_id: 'almuerzo' }),
      grupo({ id: 'g2', name: 'Segundo', product_id: 'almuerzo' }),
      // Resto apagado de la plantilla del alta.
      grupo({ id: 'g3', name: 'Sopa', category_id: 'cat-alm', active: false }),
      // Fantasma: activo, pero sin una sola opción dentro.
      grupo({ id: 'g4', name: 'Sopa', product_id: 'agua' }),
    ]),
  }))
  await page.route('**/api/client/options', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([
      { id: 'o1', option_group_id: 'g1', name: 'Caldo de res', price_adjustment: 0, sort: 0, stock: 'disponible', default_selected: false, description: null, image_url: null, image_public_id: null, references_product_id: null, active: true },
      { id: 'o2', option_group_id: 'g2', name: 'Pollo', price_adjustment: 0, sort: 0, stock: 'disponible', default_selected: false, description: null, image_url: null, image_public_id: null, references_product_id: null, active: true },
      { id: 'o3', option_group_id: 'g3', name: 'Sopa del día', price_adjustment: 0, sort: 0, stock: 'disponible', default_selected: false, description: null, image_url: null, image_public_id: null, references_product_id: null, active: true },
    ]),
  }))

  await page.goto(`${clientUrl}#/catalog`)
  await page.getByRole('tab', { name: 'Personalización' }).click()

  // El producto encabeza, y dice lo que su cliente va a elegir EN ORDEN. Es la
  // línea que faltaba: el orden de los grupos ya decidía los pasos de la ficha,
  // pero en ningún sitio del panel se leía como pasos.
  await expect(page.getByText('tu cliente elige: 1 Sopa · 2 Segundo')).toBeVisible()

  // Los dos que el cliente NO ve —el apagado y el vacío— quedan apartados y
  // contados, no mezclados con los vivos.
  const cajon = page.getByRole('button', { name: /Tu cliente no ve estos/ })
  await expect(cajon).toBeVisible()
  await expect(cajon).toContainText('2')

  // Y el cajón nace PLEGADO: lo muerto no compite por la atención con lo vivo.
  await expect(page.getByText('sin opciones, tu cliente no lo ve')).toBeHidden()
  await cajon.click()
  await expect(page.getByText('sin opciones, tu cliente no lo ve')).toBeVisible()
})

// ═══════════════════════════════════════════════════════════════════════════
// LAS PLANTILLAS SE PUEDEN LLENAR, Y SUS COPIAS NO SE TOCAN SUELTAS
// ═══════════════════════════════════════════════════════════════════════════
//
// 2026-09-16. La sección «Plantillas reutilizables» prometía «defines Sabores
// una vez y sirve para cada paso del combo», y no dejaba meter ni un sabor: las
// funciones estaban en la API y ninguna pantalla las llamaba. Ahora la
// plantilla se despliega con sus opciones, y la base las copia a cada grupo.
test('una plantilla enseña sus opciones y sus copias salen marcadas en el grupo', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)

  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  const opcion = (o: Record<string, unknown>) => ({
    description: null, image_url: null, image_public_id: null, references_product_id: null,
    default_selected: false, stock: 'disponible', sort: 0, active: true,
    option_template_item_id: null, ...o,
  })

  await page.route('**/api/client/products', r => r.fulfill(json([
    { id: 'combo', name: 'Combo Panas', price: 11.99, stock: 'disponible', active: true, category_id: 'cat' },
  ])))
  await page.route('**/api/client/option-groups', r => r.fulfill(json([{
    id: 'g1', name: 'Sabor de la 1.ª pizza', product_id: 'combo', category_id: null, active: true,
    description: null, selection_type: 'single', required: true, min_selectable: 1, max_selectable: 1,
    pricing_strategy: 'sum', free_selections: 0, is_meal_part: false,
    template_id: null, option_template_id: 'tpl', loose_price: null, sort: 0,
  }])))
  // Dos COPIAS que mantiene la base, y una opción que el dueño escribió a mano.
  await page.route('**/api/client/options', r => r.fulfill(json([
    opcion({ id: 'c1', option_group_id: 'g1', name: 'Hawaiana', option_template_item_id: 'i1' }),
    opcion({ id: 'c2', option_group_id: 'g1', name: 'Monster', price_adjustment: 2.5, option_template_item_id: 'i2', sort: 1 }),
    opcion({ id: 'm1', option_group_id: 'g1', name: 'Mitad y mitad', price_adjustment: 1, sort: 2 }),
  ])))
  await page.route('**/api/client/option-templates', r => r.fulfill(json([
    { id: 'tpl', name: 'Sabores', description: null, active: true, used_by_groups: 1 },
  ])))
  await page.route('**/api/client/option-template-items', r => r.fulfill(json([
    { id: 'i1', option_template_id: 'tpl', name: 'Hawaiana', description: null, image_url: null, image_public_id: null, price_adjustment: 0, references_product_id: null, default_selected: false, stock: 'disponible', sort: 0, active: true },
    { id: 'i2', option_template_id: 'tpl', name: 'Monster', description: null, image_url: null, image_public_id: null, price_adjustment: 2.5, references_product_id: null, default_selected: false, stock: 'disponible', sort: 1, active: true },
  ])))

  await page.goto(`${clientUrl}#/catalog`)
  await page.getByRole('tab', { name: 'Personalización' }).click()

  // ── La plantilla se despliega y enseña sus opciones ────────────────────
  await page.getByRole('button', { name: /Sabores.*2 opciones/ }).click()
  await expect(page.getByRole('button', { name: 'Editar Hawaiana' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Quitar Monster' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Agregar opción' }).last()).toBeVisible()

  // ── En el grupo, las copias salen marcadas y SIN botones sueltos ───────
  // ⚠️ Anclado al INICIO: las flechas se llaman «Subir Sabor de la 1.ª pizza»
  // y «Bajar …», así que sin `^` el nombre casa con tres botones. Es la misma
  // trampa de subcadena que hizo parpadear el E2E de «armar por partes».
  await page.getByRole('button', { name: /^Sabor de la 1\.ª pizza/ }).click()
  await expect(page.getByText('De la plantilla')).toHaveCount(2)
  await expect(page.getByText('se cambia en la plantilla')).toHaveCount(2)
  // …y la opción MANUAL conserva los suyos: el freno es solo para las copias.
  await expect(page.getByText('Mitad y mitad')).toBeVisible()
})

test('el dueño le pone horario a un producto: el menú con reloj', async ({ page }) => {
  // ⚠️ Pedido del dueño (2026-09-17): «hay restaurantes que ofrecen almuerzos y
  // otros que ofrecen desde el desayuno, almuerzo y meriendas». No son tres
  // locales: es uno con tres franjas, como en las apps grandes. Las columnas
  // existían desde hacía meses y NO las leía nadie — tampoco este formulario.
  await seedClientSession(page)
  await mockClientApi(page)

  let guardado: Record<string, unknown> | null = null
  await page.route('**/api/client/products/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    guardado = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })

  await page.goto(`${clientUrl}#/catalog`)
  await page.getByRole('button', { name: 'Editar' }).first().click()
  const ficha = page.getByRole('dialog', { name: 'Editar producto' })
  await expect(ficha).toBeVisible()

  // Sin franja, el producto se pide siempre: es como viven todos hoy.
  await expect(ficha.getByText('se puede pedir siempre que el local esté abierto')).toBeVisible()

  await ficha.getByRole('button', { name: 'lunes' }).click()
  await ficha.getByRole('button', { name: 'martes' }).click()
  await ficha.getByLabel('Desde').fill('07:00')
  await ficha.getByLabel('Hasta').fill('11:00')
  await expect(ficha.getByText('Fuera de esta franja el cliente lo ve en la carta')).toBeVisible()

  await ficha.getByRole('button', { name: 'Guardar producto' }).click()

  await expect.poll(() => guardado?.available_days).toEqual([1, 2])
  await expect.poll(() => guardado?.available_from).toBe('07:00')
  await expect.poll(() => guardado?.available_until).toBe('11:00')
})

// Los locales de DEMOSTRACIÓN (2026-09-30): nadie puede confundir sus montos
// con dinero de verdad, ni quien enseña la demo ni quien la mira.
test('un local de demostración lo dice en todo el panel y en su estado de cuenta', async ({ page }) => {
  await mockClientApi(page)
  await page.route('**/api/client/mis-pagos', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      demo: true,
      semana: { pedidos: 2, pedidosTarjeta: 1, tuyoCents: 2796, yaCobrasteCents: 1518, deAntesCents: 0, comisionCents: 240, netoCents: 1278 },
      pedidos: [], depositos: [],
    }),
  }))
  await seedClientSession(page)
  await page.addInitScript(() => {
    localStorage.setItem('client_biz', JSON.stringify({ id: 'biz-e2e', name: 'Burger Brava', type: 'hamburguesería', demo: true }))
  })
  await page.goto(`${clientUrl}#/pagos`)

  await expect(page.getByRole('note').filter({ hasText: 'Local de demostración.' })).toBeVisible()
  await expect(page.getByText('Umbani no los cobra ni los paga.')).toBeVisible()
  await expect(page.getByText(/Estado de cuenta de ejemplo/)).toBeVisible()
})

test('un local de verdad no lleva la franja de demostración', async ({ page }) => {
  await mockClientApi(page)
  await seedClientSession(page)
  await page.goto(`${clientUrl}#/`)
  await expect(page.getByText('BotPanel').first().or(page.getByText('Negocio E2E').first())).toBeVisible()
  await expect(page.getByText('Local de demostración.')).toHaveCount(0)
})
