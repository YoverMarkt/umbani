import { describe, expect, it, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fuenteDeLasRutasDeLocales } from './fuente-de-rutas.mjs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createBotConversation } = require('../dist/services/bot-conversation')
const enlace = require('../dist/services/storefront-link')

// ═══════════════════════════════════════════════════════════════════════════
// EL CANAL PROPIO TAMBIÉN PIDE POR LA MINI APP
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño (2026-09-16): «lo único que no quiero son locales por menú
// chat, no es la mejor experiencia de usuario; que todos sean mini app». Ayer
// se retiró el pedido por chat del MARKETPLACE; el motor siguió en pie porque
// lo usaba el modo menú del canal PROPIO de un negocio.
//
// ⚠️ Ese camino no lo recorría nadie, y se midió antes de borrar una línea:
//   · `business_channel_identifiers` — 0 filas (ningún local tiene canal propio)
//   · `conversation_sessions` — 3 filas, todas de WhatsApp y la última del
//     2026-08-17, o sea que `bot-conversation` llevaba un mes sin ejecutarse
//   · ninguna sesión `tg_*` jamás: Telegram —que NO pasa por
//     `business_channel_identifiers`, porque resuelve por slug— tampoco entró
//
// Lo que SIGUE por WhatsApp es todo lo demás: elegir local, la bienvenida, las
// categorías, la búsqueda, el enlace, los comprobantes, los avisos de «tu
// pedido está en camino» con su mapa, la ubicación y MENÚ.

const leer = ruta => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), 'utf8')
const existe = ruta => existsSync(fileURLToPath(new URL(ruta, import.meta.url)))

/**
 * El código SIN comentarios.
 *
 * ⚠️ Hace falta porque los bloques que explican esta retirada nombran lo
 * retirado —`miniappConfigurationError`, `chat_mode`— y sin esto la prueba se
 * rompería por su propia documentación. Es la trampa que ya mordió al guardián
 * del canal y al del alta.
 */
const sinComentarios = fuente => fuente
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(linea => !linea.trimStart().startsWith('//'))
  .join('\n')

// ───────────────────────────────────────────────────────────────────────────
// LO QUE NO PUEDE PERDERSE: el inventario de lo que el camino hacía DE PASO
// ───────────────────────────────────────────────────────────────────────────
//
// Retirar un modo no es solo borrar su rama. `runMenuMode` hacía seis cosas
// además de conducir el menú, y quien se queda con esos clientes —el modo mini
// app— tiene que seguir haciéndolas. Es la lección del 2026-08-03: nueve
// pruebas en verde sobre lo nuevo, y el check azul perdido porque nadie miró
// lo que dejó de ocurrir.

const negocio = {
  id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
  chat_mode: 'miniapp', storefront_enabled: true, takes_orders: true,
  bot_active: true, suspended: false,
}

function montar(overrides = {}) {
  const guardados = []
  const sendTyping = vi.fn(async () => ({}))
  const database = {
    getSession: async () => ({ manual_mode: false, contact_name: 'Ana' }),
    saveMessage: vi.fn(async (_businessId, _phone, role, content) => {
      guardados.push({ role, content })
    }),
    upsertSession: vi.fn(async () => ({})),
    getSchedule: async () => [],
    getPolicies: async () => ({}),
    getProducts: async () => [],
    resolveCustomer: vi.fn(async () => ({ id: 'cust-1' })),
    claimMiniappReply: vi.fn(async () => ({ permitido: true, motivo: 'ok', respuestas: 1 })),
    claimStorefrontLinkSend: vi.fn(async () => true),
    ...overrides.database,
  }
  const conversation = createBotConversation({
    database,
    reports: { handleOwnerMessage: async () => ({ handled: false, reply: '' }) },
    schedule: { isOutsideHours: () => false, buildScheduleMessage: () => '' },
    tags: { isInsultMessage: () => false },
    storefrontLink: {
      issueLink: vi.fn(async () => 'https://ejemplo.com/s/tok'),
      storefrontInvite: enlace.storefrontInvite,
      storefrontInviteButton: enlace.storefrontInviteButton,
    },
    logger: { log: () => {}, error: () => {} },
    sleep: async () => {},
    ...overrides.deps,
  })
  return { conversation, database, guardados, sendTyping }
}

const procesar = async (m, texto, business = negocio) => {
  const enviados = []
  await m.conversation.processMessage({
    business, phone: '593999111222', text: texto,
    send: async t => { enviados.push(t); return {} },
    sendTyping: m.sendTyping,
  })
  return enviados
}

describe('lo que el canal propio hacía de paso sigue ocurriendo', () => {
  it('guarda el entrante, marca leído, resuelve al cliente y manda el enlace', async () => {
    const m = montar()
    const enviados = await procesar(m, 'hola, ¿tienen pizza hawaiana?')

    // 1. El mensaje del cliente queda en el historial: el dueño abre su panel
    //    para saber qué le escribieron, aunque el bot no converse.
    expect(m.guardados.some(g => g.role === 'user' && g.content.includes('hawaiana'))).toBe(true)
    // 2. El check azul. `sendTyping` marca LEÍDO además de pintar «escribiendo…».
    expect(m.sendTyping).toHaveBeenCalled()
    // 3. El cliente se resuelve: sin esto no hay techo anti-molestias ni ficha.
    expect(m.database.resolveCustomer).toHaveBeenCalled()
    // 4. La ventana de 24 h se reclama en la BASE, no en un Map del proceso.
    expect(m.database.claimMiniappReply).toHaveBeenCalled()
    // 5. Y sale el enlace, que es la respuesta entera de este modo.
    expect(enviados.join('\n')).toContain('https://ejemplo.com/s/tok')
    // 6. Lo respondido también se guarda: un mensaje que salió sin quedar
    //    escrito es un hueco en la conversación que lee el dueño.
    expect(m.guardados.some(g => g.role === 'assistant')).toBe(true)
  })

  it('un modo que ya no existe sigue callando, no inventando', async () => {
    // Fallo cerrado, igual que antes: una configuración rota se registra y se
    // ve, no se tapa con un mensaje genérico al cliente.
    const m = montar()
    expect(await procesar(m, 'hola', { ...negocio, chat_mode: 'menu' })).toEqual([])
    expect(await procesar(m, 'hola', { ...negocio, chat_mode: null })).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// LO QUE SE VA, Y NO PUEDE VOLVER POR NINGUNA PUERTA
// ───────────────────────────────────────────────────────────────────────────

describe('el motor del menú y su cadena se retiraron del repositorio', () => {
  // ⚠️ El motor no se iba solo. `bot-conversation` era el ÚNICO importador de
  // `bot-actions` (el ejecutor del pedido por chat), y `bot-actions` el único
  // de `money.ts` (su cálculo). `bot-media` llevaba tiempo peor: se inyectaba
  // y no se llamaba nunca.
  it.each([
    ['el motor del menú', '../src/services/bot-menu-flow.ts'],
    ['el ejecutor del pedido por chat', '../src/services/bot-actions.ts'],
    ['el cálculo del pedido por chat', '../src/services/money.ts'],
    ['la media del catálogo por chat', '../src/services/bot-media.ts'],
  ])('%s ya no existe', (_nombre, ruta) => {
    expect(existe(ruta)).toBe(false)
  })

  it('la conversación no nombra ni el motor ni su cadena', () => {
    const fuente = sinComentarios(leer('../src/services/bot-conversation.ts'))
    expect(fuente).not.toMatch(/bot-menu-flow|menuFlow|advanceMenuFlow/)
    expect(fuente).not.toMatch(/bot-actions|bot-media|require\('\.\/money'\)/)
    // `runMenuMode` y su andamiaje
    expect(fuente).not.toMatch(/runMenuMode|renderMenuOptions|mentionedProductIds/)
  })

  it('el repositorio ya no ofrece los modificadores «que consume el bot»', () => {
    // `getAllMenuModifiers` y el CRUD del panel SE QUEDAN: la tabla sigue viva
    // y su pantalla se retiró aparte. Lo que se va es la lectura que solo
    // servía al menú del chat.
    const repo = sinComentarios(leer('../src/db/repositories/menu-modifiers.ts'))
    expect(repo).not.toMatch(/^const getMenuModifiers = /m)
    expect(repo).toMatch(/getAllMenuModifiers/)
  })
})

describe('un local nuevo no puede nacer en modo chat', () => {
  it('la base solo admite un modo, y lo rechaza en vez de dejar un local mudo', () => {
    const schema = leer('../schema.sql')
    // Un CHECK de un solo valor no es un adorno: es lo que impide que código
    // viejo, un script o la API vuelvan a escribir 'menu' y dejen a un negocio
    // sin nadie que le conteste.
    expect(schema).toContain("check (chat_mode in ('miniapp'))")
    expect(schema).toContain("chat_mode           text not null default 'miniapp'")
  })

  it('el alta por API tampoco: el RPC solo acepta miniapp', () => {
    const migracion = leer('../migration-2026-09-16-el-canal-propio-tambien-es-mini-app.sql')
    expect(migracion).toContain("v_chat_mode not in ('miniapp')")
    expect(migracion).toContain("'chat_mode'), ''), 'miniapp')")
    // ⚠️ Y el alta DEJA de exigir pedidos y tienda para ese modo. Con un solo
    // modo, esa regla significaría «todo local tiene que vender», que es falso:
    // un local oculto mientras carga su catálogo no vende y tiene que poder
    // guardarse igual.
    expect(migracion).not.toContain('El modo miniapp requiere pedidos y tienda habilitados')
  })

  it('el panel del superadmin no menciona el modo por ninguna parte', () => {
    const modal = sinComentarios(leer('../../apps/admin/src/features/clients/ClientModal.tsx'))
    const tipos = sinComentarios(leer('../../apps/admin/src/features/clients/business-types.ts'))
    // Ocultar un local dejó de necesitar tocar `chat_mode` para esquivar una
    // validación que ya no existe.
    expect(modal).not.toContain('chat_mode')
    expect(tipos).not.toContain('PEDIDO_SIMPLE')
    expect(tipos).not.toContain('recommendedChatModeForBusinessType')
    // Pero lo que SÍ se le dice al superadmin al crear se queda: una línea que
    // explica cómo va a atender, sin jerga y sin pedirle que elija nada.
    expect(tipos).toContain('chatModeSummary')
    expect(tipos).toMatch(/Pedirá por su mini app/)
    expect(modal).toContain('client-mode-summary')
  })

  it('la ruta del alta deja de elegir modo y de validar el de la mini app', () => {
    const ruta = sinComentarios(fuenteDeLasRutasDeLocales())
    expect(ruta).not.toContain('CHAT_MODES')
    expect(ruta).not.toContain('invalidChatMode')
    expect(ruta).not.toContain('miniappConfigurationError')
    // Y el alta fija el único modo que existe, sin preguntar.
    expect(ruta).toContain("chat_mode: 'miniapp'")
  })
})
