import businesses = require('./repositories/businesses')
import users = require('./repositories/client-users')
import billing = require('./repositories/billing')
import products = require('./repositories/products')
import history = require('./repositories/conversation-history')
import sessions = require('./repositories/sessions')
import marketplaceConversations = require('./repositories/marketplace-conversations')
import marketplaceCatalog = require('./repositories/marketplace-catalog')
import outbox = require('./repositories/outbox')
import schedule = require('./repositories/schedule')
import sales = require('./repositories/sales')
import reporting = require('./repositories/reporting')
import orders = require('./repositories/orders')
import stats = require('./repositories/stats')
import webhookEvents = require('./repositories/webhook-events')
import menuModifiers = require('./repositories/menu-modifiers')
import usage = require('./repositories/usage')
import platformErrors = require('./repositories/platform-errors')
import storefront = require('./repositories/storefront')
import catalog = require('./repositories/catalog')
import productOptions = require('./repositories/product-options')
import pricingRules = require('./repositories/pricing-rules')
import payments = require('./repositories/payments')
import settlements = require('./repositories/settlements')
import appLogin = require('./repositories/app-login')
import couriers = require('./repositories/couriers')

// SIN anotación a propósito: aquí TypeScript infiere el tipo REAL de los 20
// repositorios juntos. Estuvo anotado como `Record<string, unknown>` y eso
// tiraba todos los tipos, obligando a cada consumidor a declarar su interfaz y
// AFIRMARLA con `as` —que el compilador no comprueba—. Así se coló en
// producción un `issueLink` que no existía (2026-08-02).
const database = {
  ...businesses,
  ...users,
  ...billing,
  ...products,
  ...history,
  ...sessions,
  ...marketplaceConversations,
  ...marketplaceCatalog,
  ...outbox,
  ...schedule,
  ...sales,
  ...reporting,
  ...orders,
  ...stats,
  ...webhookEvents,
  ...menuModifiers,
  ...usage,
  ...platformErrors,
  ...storefront,
  ...catalog,
  ...productOptions,
  ...pricingRules,
  ...payments,
  ...settlements,
  ...appLogin,
  ...couriers,
}

export = database
