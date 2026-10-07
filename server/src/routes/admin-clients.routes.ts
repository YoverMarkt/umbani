import { createRouter } from '../middleware/async'
import { registrarPlataforma } from './locales/plataforma'
import { registrarFichasDeLosLocales } from './locales/fichas'

// Las rutas de locales del superadmin. ⚠️ Partidas por secciones el 2026-10-07
// (`routes/locales/`): el router sigue siendo UNO —las pruebas leen su pila de
// rutas— y las secciones se registran EN EL MISMO ORDEN de antes.

const router = createRouter()

registrarPlataforma(router)
registrarFichasDeLosLocales(router)

export = router
