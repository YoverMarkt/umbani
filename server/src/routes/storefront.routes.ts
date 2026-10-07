import { createRouter } from '../middleware/async'
import { sesionLimiter, storeLimiter } from './tienda/comun'
import { registrarEntrada } from './tienda/entrada'
import { registrarCartaYDirecciones } from './tienda/carta'
import { registrarPedidos } from './tienda/pedidos'
import { registrarPagos } from './tienda/pagos'
import { registrarCotizar } from './tienda/cotizar'

// Rutas de la mini app del negocio.
//
// ⚠️ SON PÚBLICAS: no hay JWT. La credencial es el enlace que mandó el bot, y
// la valida `requireStorefrontSession`. Todo lo que no sea la portada exige
// sesión, y la portada no revela nada que no esté ya en el WhatsApp del local.
//
// El precio JAMÁS llega del cliente: la app manda ids y cantidades, y la RPC
//
// ⚠️ Partido por secciones el 2026-10-07 (`routes/tienda/`): ningún archivo
// pasa de 1.000 líneas. El router sigue siendo UNO —las pruebas leen su pila
// de rutas— y las secciones se registran EN EL MISMO ORDEN de antes: Express
// prueba las rutas en el orden en que se registraron, y cambiarlo cambiaría
// qué ruta contesta.

const router = createRouter()

router.use('/api/store', storeLimiter, sesionLimiter)
router.use('/s', storeLimiter)

registrarEntrada(router)
registrarCartaYDirecciones(router)
registrarPedidos(router)
registrarPagos(router)
registrarCotizar(router)

export = router
