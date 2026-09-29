import { expect, type Locator, type Page, type Route } from '@playwright/test'

export async function expectConnectedLabels(scope: Locator) {
  const issues = await scope.locator('label').evaluateAll(labels => labels.flatMap(label => {
    const text = label.textContent?.replace(/\s+/g, ' ').trim() || '(sin texto)'
    const controlId = label.getAttribute('for')
    if (controlId) {
      const control = label.ownerDocument.getElementById(controlId)
      return control?.matches('button, input, meter, output, progress, select, textarea, [role="checkbox"], [role="combobox"], [role="switch"]')
        ? []
        : [`${text} → #${controlId} no existe o no es un control`]
    }

    return label.querySelector('input, meter, output, progress, select, textarea')
      ? []
      : [`${text} → no tiene atributo for`]
  }))

  expect(issues).toEqual([])

  const unnamedControls = await scope
    .locator('input:not([type="hidden"]):not([aria-hidden="true"]), select:not([aria-hidden="true"]), textarea:not([aria-hidden="true"]), [role="checkbox"]:not([aria-hidden="true"]), [role="combobox"]:not([aria-hidden="true"]), [role="switch"]:not([aria-hidden="true"])')
    .evaluateAll(controls => controls.flatMap(control => {
      const id = control.getAttribute('id')
      const labelledBy = control.getAttribute('aria-labelledby')
      const hasLabelledBy = labelledBy?.split(/\s+/).some(labelId => {
        const label = control.ownerDocument.getElementById(labelId)
        return Boolean(label?.textContent?.trim())
      })
      const hasName = Boolean(
        control.getAttribute('aria-label')?.trim()
        || hasLabelledBy
        || (id && control.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`))
        || control.closest('label')
      )

      return hasName ? [] : [`${control.tagName.toLowerCase()}${id ? `#${id}` : ''} → sin nombre accesible`]
    }))

  expect(unnamedControls).toEqual([])
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

export async function mockClientApi(page: Page) {
  await page.route('**/api/client/**', async (route) => {
    const path = new URL(route.request().url()).pathname

    if (path === '/api/client/login') {
      return json(route, {
        token: 'e2e-client-token',
        business: { id: 'biz-e2e', name: 'Negocio E2E', type: 'tienda' },
        user: { name: 'Dueño E2E', role: 'owner', permissions: [] },
      })
    }
    if (path === '/api/client/business') return json(route, { id: 'biz-e2e', name: 'Negocio E2E', type: 'tienda' })
    if (path === '/api/client/stats') return json(route, { totalProducts: 1, totalConversations: 0, totalSales: 0 })
    if (path === '/api/client/dashboard') {
      return json(route, {
        period: 'semana', label: 'Esta semana',
        kpis: { total: 0, orders: 0, avg: 0, conversion: null, items: 0, clientes: 0, nuevos: 0, recurrentes: 0 },
        comparison: { curTotal: 0, prevTotal: 0, pct: null },
        top: [],
        stock: { disponible: 1, ultimas: 0, agotado: 0 },
        customersByStatus: { nuevos: 0, frecuentes: 0, activos: 0, inactivos: 0 },
        trend: { days: 7, rows: [] },
      })
    }
    if (path === '/api/client/alerts') return json(route, { alerts: [] })
    if (path === '/api/client/reports') {
      return json(route, {
        period: 'mes',
        summary: { label: 'este mes', total: 120, orders: 3, items: 5, avg: 40, nuevos: 2, recurrentes: 1, conversion: 50 },
        trend: { days: 7, total: 120, rows: [{ date: '2026-07-11', label: '11/07', total: 40, orders: 1 }, { date: '2026-07-12', label: '12/07', total: 80, orders: 2 }] },
        comparison: { label: 'este mes', curTotal: 120, curOrders: 3, prevTotal: 80, prevOrders: 2, pct: 50 },
        bySeller: { label: 'este mes', rows: [{ name: 'Dueño E2E', total: 120 }] },
        pending: { count: 0, rows: [] },
        top: { label: 'este mes', rows: [{ name: 'Producto E2E', qty: 5, rev: 120 }] },
        lowMovement: { label: 'este mes', rows: [] },
        lowStock: { rows: [] },
        recurring: { label: 'este mes', rows: [{ name: 'Cliente E2E', orders: 2, total: 80 }] },
        lostCustomers: { label: 'este mes', count: 0, noRespondio: 0, returning: 0, nuevos: 0, rows: [] },
        // ⚠️ Aquí vivían `mostConsulted`, `abandoned`, `faq` y `unanswered`:
        // se fueron el 2026-09-18 con sus tablas muertas. Lo que llega ahora
        // es cómo llega el cliente desde el número de Umbani.
        umbani: {
          embudo: [
            { paso: 'recibieron su enlace', orden: 1, clientes: 9 },
            { paso: 'abrieron su tienda', orden: 2, clientes: 5 },
            { paso: 'hicieron un pedido', orden: 3, clientes: 2 },
            { paso: 'recibieron su pedido', orden: 4, clientes: 2 },
          ],
          llegadas: [{ code: 'almuerzos', label: 'Almuerzos', veces: 7 }],
        },
      })
    }
    if (path === '/api/client/onboarding') return json(route, { done: 5, total: 5, pct: 100, steps: [] })
    if (path === '/api/client/products') return json(route, [{ id: 'product-e2e', name: 'Producto E2E', price: 10, stock: 5, active: true, status: 'disponible' }])
    // ⚠️ Se retiraron los simulacros de `/api/client/sessions`,
    // `/api/client/conversations` y `/api/client/tags` el 2026-08-23, con la
    // pantalla de Conversaciones. El servidor ya no sirve esas rutas.
    //
    // El directorio de Clientes SÍ tiene simulacro: es donde vive ahora el
    // bloqueo, y sin una fila no habría a quién bloquear.
    if (path === '/api/client/customers') {
      return json(route, [{
        name: 'Cliente E2E',
        phone: '+593999000111',
        orders: 2,
        total: 80,
        lastPurchase: '2026-07-12T18:00:00.000Z',
        daysSince: 3,
        status: 'frecuente',
      }])
    }
    if (path === '/api/client/blocked') return json(route, [])
    if (path === '/api/client/schedule') return json(route, [])
    // Devuelven LISTA, y eso importa: el respaldo de más abajo contesta `{}` a
    // lo que no reconozca, y un `{}` donde el panel espera una lista revienta
    // la pantalla al hacer `.map`. Este mock las descubrió así.
    if (path === '/api/client/categories' || path === '/api/client/variants') return json(route, [])
    // Personalización: sin estos, el respaldo contesta `{}` y la pestaña
    // revienta al hacer `.map`. Vacías por defecto; cada prueba que las
    // necesite las sobreescribe con `page.route` antes de navegar.
    if (path === '/api/client/option-groups' || path === '/api/client/options'
      || path === '/api/client/option-templates' || path === '/api/client/recommendations') {
      return json(route, [])
    }

    return json(route, {})
  })
}

export async function mockAdminApi(page: Page) {
  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname

    // El superadmin entra en dos pasos (2026-09-29): la contraseña da un pase,
    // y la sesión solo llega con el código.
    if (path === '/api/admin/login') return json(route, { paso: 'codigo', pase: 'e2e-pase' })
    if (path === '/api/admin/login/codigo') return json(route, { token: 'e2e-admin-token' })
    if (path === '/api/admin/verify-provider') return json(route, { ok: true, info: 'Canal verificado' })
    if (path === '/api/admin/stats') {
      return json(route, { totalClients: 1, activeClients: 1, suspendedClients: 0, messagesToday: 3 })
    }
    // Cómo usa la gente el menú de Umbani.
    if (path === '/api/admin/marketplace-usage') {
      return json(route, {
        dias: 7,
        embudo: [
          { paso: 'escribieron', orden: 1, clientes: 10 },
          { paso: 'vieron el menú', orden: 2, clientes: 10 },
          { paso: 'entraron a un cajón', orden: 3, clientes: 6 },
          { paso: 'eligieron un local', orden: 4, clientes: 3 },
          { paso: 'abrieron su tienda', orden: 5, clientes: 2 },
          { paso: 'pidieron', orden: 6, clientes: 1 },
        ],
        cajones: [
          { code: 'almuerzos', label: 'Almuerzos', entradas: 5, eligieron: 1, abandonaron: 4 },
          { code: 'pizzerias', label: 'Pizzerías', entradas: 3, eligieron: 2, abandonaron: 1 },
        ],
        busquedas: [
          { consulta: 'sushi de cangrejo', veces: 2, sin_nada: 2, entendido: 'Comida internacional' },
          { consulta: 'seco de chivo', veces: 1, sin_nada: 1, entendido: null },
          { consulta: 'pizza', veces: 4, sin_nada: 0, entendido: null },
        ],
      })
    }
    // Los cajones del menú del chat: el modal los pide al abrirse.
    if (path === '/api/admin/marketplace-categories') {
      return json(route, { categories: [
        { code: 'almuerzos', label: 'Almuerzos', emoji: '🍽️' },
        { code: 'restaurantes', label: 'Comida típica y restaurantes', emoji: '🍲' },
        { code: 'desayunos', label: 'Desayunos y café', emoji: '🍳' },
        { code: 'pizzerias', label: 'Pizzerías', emoji: '🍕' },
      ] })
    }
    if (path === '/api/admin/clients') {
      return json(route, [{
        id: 'biz-e2e', slug: 'negocio-e2e', name: 'Negocio E2E', type: 'tienda',
        whatsapp_number: null, whatsapp_provider: 'marketplace',
        active: true, bot_active: true, suspended: false,
        takes_orders: true, storefront_enabled: true, plan: 'basic',
        monthly_contact_limit: 200, monthly_outbound_message_limit: 1000,
        created_at: '2026-07-11T00:00:00.000Z', notes: null,
      }, {
        id: 'biz-limit', slug: 'negocio-limite', name: 'Negocio al límite', type: 'cafetería',
        whatsapp_number: null, whatsapp_provider: 'marketplace',
        active: true, bot_active: true, suspended: false,
        takes_orders: true, storefront_enabled: false, plan: 'micro',
        monthly_contact_limit: 50, monthly_outbound_message_limit: 250,
        created_at: '2026-07-10T00:00:00.000Z', notes: null,
      }])
    }
    if (path === '/api/admin/billing' && route.request().method() === 'GET') {
      return json(route, [{
        id: 'billing-e2e',
        business_id: 'biz-e2e',
        amount: 50,
        status: 'pending',
        period_start: '2026-07-01',
        period_end: '2026-07-31',
        paid_at: null,
        notes: null,
        businesses: { name: 'Negocio E2E' },
      }])
    }
    if (path.startsWith('/api/admin/billing/') && route.request().method() === 'PUT') {
      return json(route, { ok: true })
    }
    if (path === '/api/admin/usage') {
      return json(route, [{
        business_id: 'biz-e2e',
        period_start: '2026-07-01',
        period_end: '2026-07-31',
        active_contacts: 25,
        inbound_messages: 70,
        outbound_messages: 251,
        outbound_text_messages: 230,
        outbound_image_messages: 30,
        outbound_video_messages: 5,
        outbound_interactive_messages: 15,
        contact_limit: 50,
        outbound_message_limit: 250,
        contact_overage: 0,
        outbound_message_overage: 1,
        includes_history_estimate: false,
      }, {
        business_id: 'biz-limit',
        period_start: '2026-07-01',
        period_end: '2026-07-31',
        active_contacts: 50,
        inbound_messages: 100,
        outbound_messages: 250,
        outbound_text_messages: 250,
        outbound_image_messages: 0,
        outbound_video_messages: 0,
        outbound_interactive_messages: 0,
        contact_limit: 50,
        outbound_message_limit: 250,
        contact_overage: 0,
        outbound_message_overage: 0,
        includes_history_estimate: false,
      }])
    }

    // ⚠️ La salud del canal es un OBJETO con listas dentro, y el comodín de
    // abajo devolvía `{}`: el dashboard hacía `undefined.length` y no llegaba
    // a renderizarse. Las pruebas daban verde porque solo miraban la URL.
    // La ficha de un negocio: la que abre «Editar». Sin este simulacro el
    // comodín del final devolvía `{}` y el modal se abría vacío, así que
    // ninguna prueba podía mirar lo que enseña al editar.
    if (path === '/api/admin/clients/biz-e2e') {
      return json(route, {
        id: 'biz-e2e', slug: 'negocio-e2e', name: 'Negocio E2E', type: 'pizzería',
        whatsapp_number: null, whatsapp_provider: 'marketplace',
        owner_phone: '+593999999999',
        ycloud_number: null, ycloud_webhook_endpoint_id: null, meta_phone_id: null,
        active: true, bot_active: true, suspended: false,
        takes_orders: true, storefront_enabled: true, chat_mode: 'miniapp',
        plan: 'basic', monthly_rate: 49,
        monthly_contact_limit: 200, monthly_outbound_message_limit: 1000,
        created_at: '2026-07-11T00:00:00.000Z', notes: null,
        client_email: 'dueno@e2e.test',
      })
    }

    if (path === '/api/admin/channel-health') {
      // ⚠️ La forma REAL desde el 2026-08-23: el sujeto es el número de la
      // plataforma. `businesses` va vacío porque ningún local del marketplace
      // tiene canal propio — que es exactamente lo que devuelve producción.
      return json(route, {
        alert: null,
        silenceHours: 12,
        platform: {
          status: 'ok',
          lastInboundAt: '2026-08-23T13:31:36.696Z',
          hoursSinceLastInbound: 0.1,
          detail: 'Último mensaje hace 0.1 h',
        },
        businesses: [],
        recentFailures: [],
      })
    }

    return json(route, {})
  })
}

/**
 * Simulacro de `GET /api/client/orders` que RESPETA el filtro `?status=`,
 * igual que la ruta real.
 *
 * ⚠️ Ignorar ese filtro fue lo que dejó pasar el fallo del 2026-08-08: el mock
 * devolvía los pedidos cualquiera que fuese su estado, así que la prueba de la
 * alarma seguía en verde mientras en producción no sonaba nada. Un simulacro
 * más permisivo que el servidor no prueba el sistema: prueba el simulacro.
 *
 * Vive aquí, y no en cada prueba, porque dos copias de esto acabarían
 * separándose — que es exactamente la deriva que causó el fallo.
 */
export async function mockOrdersFilteredByStatus(
  page: Page,
  leerPedidos: () => Record<string, unknown>[],
) {
  await page.route('**/api/client/orders**', route => {
    const pedido = new URL(route.request().url()).searchParams.get('status')
    const filtro = pedido ? pedido.split(',') : null
    const pedidos = leerPedidos()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        filtro ? pedidos.filter(o => filtro.includes(String(o.status))) : pedidos,
      ),
    })
  })
}

export async function seedClientSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('client_token', 'e2e-client-token')
    localStorage.setItem('client_biz', JSON.stringify({ id: 'biz-e2e', name: 'Negocio E2E', type: 'tienda' }))
    localStorage.setItem('client_user', JSON.stringify({ name: 'Dueño E2E', role: 'owner', permissions: [] }))
  })
}

export async function seedAdminSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('admin_token', 'e2e-admin-token')
  })
}
