import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fuenteDeLasRutasDeLocales } from './fuente-de-rutas.mjs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// EL ALTA DE UN LOCAL
//
// Pedía 21 campos para crear una pizzería que se atiende por el número de la
// plataforma. Se queda con los que de verdad hacen falta; el resto sigue vivo
// en la EDICIÓN, que es donde se usa el caso raro.
// ═══════════════════════════════════════════════════════════════════════════

const leer = ruta => readFileSync(
  fileURLToPath(new URL(ruta, import.meta.url)),
  'utf8',
)

describe('el modo de atención ya no se elige, ni a mano ni por API', () => {
  const ruta = fuenteDeLasRutasDeLocales()

  // ⚠️ Aquí había TRES pruebas sobre `CHAT_MODES`, la lista de modos que la
  // ruta aceptaba. Nacieron de un bug real: el defecto era `'ai'`, que el CHECK
  // de la base rechazaba, así que cualquier alta por API sin el campo reventaba
  // entera y desde el panel no se veía. Desde el 2026-09-16 no hay lista que
  // validar —hay un modo— y el bug es imposible por construcción.
  it('el alta fija el único modo que existe, sin lista que validar', () => {
    expect(ruta).toContain("chat_mode: 'miniapp'")
    expect(ruta).not.toContain('CHAT_MODES')
    expect(ruta).not.toMatch(/:\s*'ai'/)
  })

  it('y el panel ya no lo puede escribir por su cuenta', () => {
    // Fuera de `ALLOWED_BUSINESS_FIELDS`: con un solo modo, dejar que el panel
    // o la API lo manden solo sirve para volver a ponerlo mal.
    const permitidos = ruta.match(/const ALLOWED_BUSINESS_FIELDS = \[[\s\S]*?\] as const/)?.[0] || ''
    expect(permitidos.length).toBeGreaterThan(50)
    expect(permitidos).not.toContain("'chat_mode'")
    expect(permitidos).toContain("'storefront_enabled'")
  })
})

describe('la IA de este negocio se retira del alta', () => {
  it('el modal ya no la pide', () => {
    const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')
    // La IA conversacional se retiró el 2026-08-21: el campo no decidía nada.
    expect(modal).not.toContain('ai_provider')
    expect(modal).not.toContain('IA de este negocio')
  })

  it('la ruta ya no la acepta ni la guarda', () => {
    const ruta = fuenteDeLasRutasDeLocales()
    expect(ruta).not.toContain('ai_provider')
  })

  it('pero el ajuste GLOBAL sigue: transcripción y visión lo usan', () => {
    // ⚠️ Son dos cosas distintas y solo sobraba la del negocio.
    // `settings.get('ai_provider')` elige el motor de Whisper y de visión.
    // Soltar la columna obligaría además a recrear el onboarding entero.
    const settings = leer('../src/services/settings.ts')
    const ai = leer('../src/services/ai.ts')
    expect(settings).toContain("'ai_provider'")
    expect(ai).toContain("settings.get('ai_provider')")
  })
})


/**
 * El modal SIN sus comentarios.
 *
 * ⚠️ Hace falta: estas pruebas buscan cadenas en el archivo, y un comentario
 * que EXPLIQUE por qué se retiró algo contiene por fuerza el nombre de lo
 * retirado. Sin esto, documentar bien una retirada rompe la prueba que la
 * vigila — y el arreglo fácil sería borrar el comentario, que es exactamente
 * al revés de lo que conviene.
 */
const sinComentarios = (fuente) => fuente
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(linea => !linea.trimStart().startsWith('//'))
  .join('\n')

describe('lo que el alta deja de preguntar', () => {
  const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')

  /** El bloque solo se pinta al editar si está envuelto en `{id && (`. */
  const soloAlEditar = (marca) => {
    const desde = modal.lastIndexOf('{id && (', modal.indexOf(marca))
    const hasta = modal.indexOf(marca)
    return desde !== -1 && hasta > desde
  }

  // ⚠️ ESTA PRUEBA SE ENDURECIÓ EL 2026-09-03, y antes exigía menos: que el
  // bloque «Canal de WhatsApp» apareciera SOLO al editar. Los siete campos
  // —proveedor, número, 3 de YCloud, 2 de Meta, Telegram— ya se habían
  // retirado en agosto y lo que quedaba era un aviso explicando que el local
  // no tiene número propio.
  //
  // El dueño pidió quitarlo: «todo local va al marketplace, no le vemos la
  // razón de ser». Con cero negocios de canal propio, ese recuadro gastaba
  // cinco líneas del modal para decir lo que ya se da por supuesto, y hacía
  // que editar pareciera más complicado que crear.
  //
  // Ahora no puede aparecer en NINGUNA de las dos pantallas. La defensa de
  // verdad sigue siendo el disparador `businesses_numero_de_plataforma`, no
  // esta pantalla — pero si alguien reintroduce el canal por la UI, esto lo
  // para y le obliga a leer por qué se fue.
  it('el canal propio no se pide ni se explica en ningún sitio', () => {
    expect(sinComentarios(modal)).not.toContain('Canal de WhatsApp')
    // ⚠️ Se vigila la UI, NO el payload. Las columnas del canal siguen
    // enviándose desde el estado del formulario y eso es deliberado desde el
    // 2026-08-23: «ninguna se retira». Lo que no puede volver es un campo
    // VISIBLE que pida credenciales de una cuenta que el local no tiene.
    for (const etiqueta of ['API Key', 'Endpoint ID', 'Signing Secret', 'Phone ID']) {
      expect(sinComentarios(modal), etiqueta).not.toContain(etiqueta)
    }
  })

  it('el modo NO se pregunta en ningún sitio, ni al crear ni al editar', () => {
    // ⚠️ CAMBIADO EL 2026-08-23, y antes esta prueba exigía lo contrario: que
    // el desplegable existiera al EDITAR. Dejó de tener sentido cuando se
    // retiró el canal propio — `chat_mode` solo gobierna el canal propio de un
    // negocio, y dentro del marketplace la experiencia la decide el tamaño del
    // catálogo al elegir local (la regla de los 20).
    //
    // Un desplegable que enseña una decisión que el sistema no cumple es
    // exactamente cómo nació el fallo del número: la pantalla decía una cosa y
    // el enrutado hacía otra.
    const codigo = sinComentarios(modal)
    expect(codigo).not.toContain('Quién conduce la conversación')
    expect(codigo).not.toContain('client-chat-mode')
  })

  it('y el PAYLOAD tampoco lo manda ya: lo fija el servidor', () => {
    // ⚠️ Esta prueba exigía lo CONTRARIO hasta el 2026-09-16 —«el payload sigue
    // mandando chat_mode»— y tenía razón mientras hubo dos modos: dejar la
    // columna al defecto del servidor habría cambiado lo que se guardaba.
    //
    // Con un solo modo se da la vuelta: que el panel lo mande solo sirve para
    // volver a ponerlo mal. Lo fija el alta y lo hace cumplir el CHECK.
    expect(sinComentarios(modal)).not.toContain('chat_mode')
  })

  it('los tres derivados del plan pasan a una línea de resumen', () => {
    // Eran inputs `readOnly`: nadie podía tocarlos porque salen del plan.
    expect(modal).not.toContain('client-monthly-rate')
    expect(modal).not.toContain('client-contact-limit')
    expect(modal).not.toContain('client-outbound-limit')
    expect(modal).toContain('client-plan-summary')
  })

  it('pero el PAYLOAD sigue enviando los mismos valores del plan', () => {
    // Que dejen de ser campos no puede cambiar lo que se guarda.
    expect(modal).toContain('payload.monthly_rate')
    expect(modal).toContain('payload.monthly_contact_limit')
    expect(modal).toContain('payload.monthly_outbound_message_limit')
  })
})

describe('lo que el alta SIGUE pidiendo', () => {
  const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')

  it('los ocho campos que hacen falta para crear un local', () => {
    for (const campo of [
      'client-name',              // sin nombre no hay negocio
      'client-business-type',     // decide plantilla, prep_time, familia y modo
      'client-owner-phone',       // el ÚNICO número del local en marketplace
      // ⚠️ `client-sales-mode` y `client-storefront` se fundieron en
      // `client-marketplace` el 2026-08-23: la base exige LAS DOS columnas
      // para listar un local, así que por separado permitían un local que
      // «vendía» y no aparecía en ninguna categoría.
      'client-marketplace',       // takes_orders + storefront_enabled
      'client-plan',              // tarifa y cupos
      'client-owner-email',       // acceso al panel
      'client-owner-password',
      'client-internal-notes',
    ]) {
      expect(modal, `falta ${campo}`).toContain(campo)
    }
  })

  it('el WhatsApp del dueño sigue siendo obligatorio en el marketplace', () => {
    // Es con lo que pide sus reportes: sin él nace sin forma de alcanzarlo.
    expect(modal).toMatch(/sinCanalPropio && !id && !f\.owner_phone/)
  })

  // ⚠️ ESTA PRUEBA DECÍA LO CONTRARIO HASTA EL 2026-08-23, y el cambio nace de
  // un fallo real: Monster Pizza tenía el MISMO número que la plataforma, así
  // que `resolveBusinessChannel` la encontraba antes de llegar a la rama del
  // marketplace y escribir al número de Umbani contestaba con su mini app en
  // vez de las categorías. Todo lo construido para el número único —las 15
  // categorías, la búsqueda, el pedido en el chat— era inalcanzable.
  //
  // El caso raro que estos campos servían ya no existe: los locales viven en
  // el marketplace y no tienen cuenta propia que configurar.
  it('el canal propio se RETIRÓ del panel: ya no hay dónde dárselo a un local', () => {
    for (const campo of [
      'client-ycloud-api-key',
      'client-ycloud-endpoint-id',
      'client-ycloud-signing-secret',
      'client-meta-token',
      'client-meta-phone-id',
      'client-telegram-token',
      'client-whatsapp-provider',
    ]) {
      expect(sinComentarios(modal), `${campo} debería haberse retirado`).not.toContain(campo)
    }
  })

  it('y el envío fuerza marketplace, sin leer lo guardado', () => {
    // Un negocio que venga de la etapa anterior queda convertido al editarlo,
    // en vez de conservar en silencio un número que secuestraría el enrutado.
    expect(modal).toContain("whatsapp_provider: 'marketplace'")
  })

  it('⚠️ pero la defensa de verdad está en la BASE, no en esta pantalla', () => {
    // Quitar el campo evita el error de dedo. Solo la guarda impide que el
    // número vuelva a entrar por una API, un script o un `update` a mano.
    const migracion = leer('../migration-2026-08-23-el-numero-es-de-la-plataforma.sql')
    expect(migracion).toContain('businesses_numero_de_plataforma')
    expect(migracion).toContain('before insert or update')
    // Compara solo los DÍGITOS: el mismo teléfono se escribe «+593…» en un
    // sitio y «593…» en otro, y en crudo se colaría justo el caso que evita.
    expect(migracion).toMatch(/regexp_replace\([^)]*'\\D'/)
  })
})

// ⚠️ Aquí vivía «con qué modo NACE cada tipo de negocio»: siete pruebas sobre
// `PEDIDO_SIMPLE`, la lista de tipos que «se piden bien dentro del chat». Una
// almuercería sí, una pizzería no.
//
// Fue un criterio del dueño y bueno, pero el 2026-09-16 dejó de ser cierto:
// TODO local pide por su mini app. La prueba seguía fijando que «una
// almuercería y una cevichería piden por el CHAT», o sea que vigilaba —y
// protegía— una afirmación ya falsa. Un guardián que defiende lo que dejó de
// ser verdad es peor que ninguno.
//
// Lo que se conserva es lo que SÍ se le sigue diciendo al superadmin al crear
// un local, y está justo debajo: una línea, sin jerga y sin elegir nada.

describe('el alta ya no pregunta lo que se deduce del tipo', () => {
  const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')

  // ⚠️ ESTA PRUEBA FIJABA DOS DESPLEGABLES hasta el 2026-08-23, y ahora fija
  // uno. «Ventas por el bot» y «Mini app de la tienda» escribían dos columnas
  // que la base exige JUNTAS (`marketplace_categories_disponibles`), así que
  // por separado abrían un estado sin salida: el local creaba pedidos, no salía
  // en ninguna categoría, y el panel lo enseñaba «vendiendo». Y sus nombres
  // hablaban de un bot por local que no existe desde que se fueron la IA y el
  // canal propio.
  it('«Aparece en el marketplace» es solo de edición, y es UNA decisión', () => {
    const desde = modal.indexOf('{id ? (')
    expect(desde).toBeGreaterThan(-1)
    expect(modal.indexOf('client-marketplace')).toBeGreaterThan(desde)
    // Los dos nombres viejos no vuelven por ninguna puerta.
    //
    // ⚠️ Sobre el código SIN comentarios: el bloque que explica esta retirada
    // los nombra, y sin quitarlo la prueba se rompería por su propia
    // documentación. Es la misma trampa que ya mordió al guardián del canal.
    const codigo = sinComentarios(modal)
    expect(codigo).not.toContain('client-sales-mode')
    expect(codigo).not.toContain('client-storefront')
    expect(codigo).not.toContain('Ventas por el bot')
    expect(codigo).not.toContain('Mini app de la tienda')
  })

  // Las columnas NO se retiran: el control es derivado y el payload manda
  // exactamente lo mismo que antes.
  it('sigue escribiendo takes_orders y storefront_enabled', () => {
    expect(modal).toContain('takes_orders:')
    expect(modal).toContain('storefront_enabled:')
  })

  it('en su lugar dice cómo va a atender', () => {
    expect(modal).toContain('client-mode-summary')
    expect(modal).toContain('chatModeSummary')
  })

  it('y el resumen lo explica en español, sin jerga', () => {
    // ⚠️ UNA sola frase desde el 2026-09-16: el pedido por chat se retiró, así
    // que decirle a una almuercería «pedirá por el chat» sería mentirle al
    // superadmin justo al dar de alta.
    const tipos = leer('../../apps/admin/src/features/clients/business-types.ts')
    expect(tipos).toMatch(/Pedirá por su mini app/)
    expect(tipos).not.toMatch(/Pedirá por el chat/)
  })
})

describe('el plan solo pacta la mensualidad', () => {
  const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')

  it('ni el desplegable ni el resumen enseñan cupos', () => {
    // Los cupos se siguen guardando y Medición alerta los excesos; lo que se
    // pacta al dar de alta es la mensualidad y nada más.
    expect(modal).not.toContain('monthlyContactLimit.toLocaleString')
    expect(modal).not.toContain('contactos')
    expect(modal).not.toMatch(/\}\s*mensajes/)
  })

  it('pero el payload los sigue enviando', () => {
    expect(modal).toContain('payload.monthly_contact_limit')
    expect(modal).toContain('payload.monthly_outbound_message_limit')
  })
})

describe('el número del marketplace se puede verificar', () => {
  it('el panel tiene su botón', () => {
    const panel = leer('../../apps/admin/src/features/settings/ServerSettings.tsx')
    expect(panel).toContain('Verificar el número')
    expect(panel).toContain('verifyPlatformChannel')
  })

  it('y el servidor comprueba el número contra YCloud', () => {
    const ruta = leer('../src/routes/admin-providers.routes.ts')
    expect(ruta).toContain('/api/admin/verify-platform-channel')
    // Reutiliza la MISMA comprobación que un negocio con canal propio: el
    // canal es el mismo, solo cambia de dónde salen las credenciales.
    expect(ruta).toMatch(/verify-platform-channel[\s\S]{0,2000}?verifyProvider\(\{/)
  })

  it('le pasa el secreto y el endpoint de PLATAFORMA a la comprobación', () => {
    // ⚠️ El bug del 2026-08-22: `verifyProvider` mira `ycloud_webhook_*` —los
    // campos del NEGOCIO—, así que sin pasárselos decía «falta Signing Secret
    // y Endpoint ID» aunque estuvieran guardados en `platform_webhook_*`. El
    // resultado salía en rojo justo cuando la configuración era correcta.
    const ruta = leer('../src/routes/admin-providers.routes.ts')
    const bloque = ruta.match(
      /verify-platform-channel[\s\S]*?verifyProvider\(\{[\s\S]*?\}\)/,
    )?.[0] || ''
    expect(bloque).toContain('ycloud_webhook_secret: secret')
    expect(bloque).toContain('ycloud_webhook_endpoint_id: endpoint')
  })

  it('avisa de lo que YCloud no puede decir: falta el webhook', () => {
    // Sin signing secret ni endpoint id, el webhook rechaza en producción y
    // el número queda mudo aunque la key sea correcta.
    const ruta = leer('../src/routes/admin-providers.routes.ts')
    expect(ruta).toContain('Signing Secret')
    expect(ruta).toContain('Endpoint ID')
    expect(ruta).toMatch(/el bot no recibirá mensajes/)
  })

  it('exige autenticación de superadmin', () => {
    const ruta = leer('../src/routes/admin-providers.routes.ts')
    expect(ruta).toMatch(/verify-platform-channel', auth\.authAdmin/)
  })
})

describe('rechazar el comprobante avisa al cliente', () => {
  const ruta = leer('../src/routes/orders.routes.ts')

  it('se le manda un WhatsApp pidiendo otra foto', () => {
    // ⚠️ Hasta el 2026-08-22 no se avisaba. En la mini app el cliente lo veía
    // al recargar la pantalla de pago; quien pidió por el CHAT no se enteraba
    // nunca y se quedaba esperando un pedido devuelto a «esperando pago».
    expect(ruta).toContain('avisarQueFaltaOtroComprobante')
    expect(ruta).toMatch(/No pudimos leer tu comprobante/)
  })

  it('el mensaje dice QUÉ tiene que verse, no solo «manda otra»', () => {
    // Sin decirle qué falta, la segunda foto suele salir igual de mal.
    expect(ruta).toMatch(/valor/)
    expect(ruta).toMatch(/fecha/)
    expect(ruta).toMatch(/banco/)
  })

  it('y lleva el importe exacto del pedido', () => {
    expect(ruta).toMatch(/Number\(pedido\.total \|\| 0\)\.toFixed\(2\)/)
  })

  it('nunca lanza: el pedido ya volvió a esperar pago', () => {
    // Un fallo de envío no puede tumbar la respuesta al dueño, que ya hizo
    // lo que pidió.
    const bloque = ruta.match(
      /async function avisarQueFaltaOtroComprobante[\s\S]*?\n}/,
    )?.[0] || ''
    expect(bloque).toContain('try {')
    expect(bloque).toContain('catch')
  })

  it('sale sin await, como el resto de avisos', () => {
    expect(ruta).toMatch(/void avisarQueFaltaOtroComprobante/)
  })
})
