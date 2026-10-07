import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fuenteDeLaTienda } from './fuente-de-rutas.mjs'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import {
  crearRegistroDeComprobantes,
  huellaDelArchivo,
} from '../dist/services/receipt-ingest.js'

// ═══════════════════════════════════════════════════════════════════════════
// LA HUELLA DEL COMPROBANTE
//
// `orders.payment_proof_url` guardaba UN comprobante por pedido: el segundo
// machacaba al primero, no había forma de saber si esa imagen ya se había
// usado en otro pedido, y no había dónde guardar lo que se extrajera de ella.
//
// ⚠️ Esto NUNCA confirma un pago. Un comprobante limpio sigue siendo una
// imagen: pudo editarse, generarse o reutilizarse. Solo le da al dueño una
// señal más antes de que él decida.
// ═══════════════════════════════════════════════════════════════════════════

const leer = ruta => readFileSync(
  fileURLToPath(new URL(ruta, import.meta.url)),
  'utf8',
)

const IMAGEN = Buffer.from('una imagen de prueba')

const armar = (respuesta) => {
  const registerPaymentReceipt = vi.fn().mockResolvedValue(respuesta)
  const registrar = crearRegistroDeComprobantes({
    database: { registerPaymentReceipt },
    logger: { log: () => {} },
  })
  return { registrar, registerPaymentReceipt }
}

const entrada = {
  businessId: 'biz-1',
  orderId: 'ped-1',
  imagen: IMAGEN,
  fileUrl: 'https://res.cloudinary.com/x/comprobante.jpg',
  filePublicId: 'botpanel/biz-1/comprobantes/abc',
  perceptualHash: 'phash-abc',
}

describe('la huella del archivo', () => {
  it('es el SHA-256 real del contenido', () => {
    const esperado = crypto.createHash('sha256').update(IMAGEN).digest('hex')
    expect(huellaDelArchivo(IMAGEN)).toBe(esperado)
    expect(huellaDelArchivo(IMAGEN)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('cambia si cambia un solo byte', () => {
    // Es lo que hace que reenviar el archivo idéntico se cace siempre, y que
    // una imagen distinta no se confunda nunca con otra.
    expect(huellaDelArchivo(Buffer.from('a'))).not.toBe(huellaDelArchivo(Buffer.from('b')))
  })
})

describe('registrar un comprobante', () => {
  it('manda las dos huellas y el tamaño real', async () => {
    const { registrar, registerPaymentReceipt } = armar({
      data: { result: 'registered', receipt_id: 'r1', duplicado: false },
    })
    await registrar(entrada)

    expect(registerPaymentReceipt).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz-1',
      orderId: 'ped-1',
      sha256: huellaDelArchivo(IMAGEN),
      perceptualHash: 'phash-abc',
      fileSize: IMAGEN.length,
    }))
  })

  it('avisa del duplicado EXACTO y del pedido donde se usó', async () => {
    const { registrar } = armar({
      data: {
        result: 'registered', receipt_id: 'r2',
        duplicado: true, duplicado_exacto: true, duplicado_visual: false,
        pedido_previo: 10452,
      },
    })
    const huella = await registrar(entrada)

    expect(huella.duplicado).toBe(true)
    expect(huella.duplicadoExacto).toBe(true)
    expect(huella.pedidoPrevio).toBe(10452)
  })

  it('y del duplicado VISUAL, que es el que caza el reenvío por WhatsApp', async () => {
    // WhatsApp recomprime al reenviar, así que el SHA-256 cambia: solo la
    // huella perceptual reconoce la misma imagen.
    const { registrar } = armar({
      data: {
        result: 'registered', receipt_id: 'r3',
        duplicado: true, duplicado_exacto: false, duplicado_visual: true,
        pedido_previo: null,
      },
    })
    const huella = await registrar(entrada)

    expect(huella.duplicadoVisual).toBe(true)
    expect(huella.duplicadoExacto).toBe(false)
    // ⚠️ Sin pedido previo: el duplicado estaba en OTRO local, y ese pedido
    // no es asunto de este dueño.
    expect(huella.pedidoPrevio).toBe(null)
  })
})

describe('nunca puede tumbar el pago', () => {
  it('si la base falla, devuelve vacío en vez de lanzar', async () => {
    const { registrar } = armar({ error: { message: 'la base dijo que no' } })
    const huella = await registrar(entrada)
    expect(huella.registrado).toBe(false)
    expect(huella.duplicado).toBe(false)
  })

  it('si la RPC no reconoce el pedido, tampoco lanza', async () => {
    const { registrar } = armar({ data: { result: 'not_found' } })
    await expect(registrar(entrada)).resolves.toMatchObject({ registrado: false })
  })

  it('y si la llamada revienta entera, se traga el error', async () => {
    const registrar = crearRegistroDeComprobantes({
      database: {
        registerPaymentReceipt: vi.fn().mockRejectedValue(new Error('red caída')),
      },
      logger: { log: () => {} },
    })
    await expect(registrar(entrada)).resolves.toMatchObject({ registrado: false })
  })
})

describe('el registro va DESPUÉS de adjuntar, y sin await', () => {
  it('en el buzón del chat', () => {
    // El comprobante ya está donde tiene que estar: un fallo registrando su
    // huella no puede deshacerlo ni dejar sin respuesta a quien acaba de pagar.
    const fuente = leer('../src/services/payment-proof-inbox.ts')
    const adjuntado = fuente.indexOf("if (error) throw new Error(error.message || 'La base rechazó")
    const huella = fuente.indexOf('void dependencias.registrarHuella')
    expect(adjuntado).toBeGreaterThan(-1)
    expect(huella).toBeGreaterThan(adjuntado)
  })

  it('y en la mini app', () => {
    const fuente = fuenteDeLaTienda()
    // Sigue yendo sin bloquear la respuesta, ahora dentro de un bloque que
    // además analiza la imagen antes de registrarla.
    expect(fuente).toMatch(/void \(async \(\) => \{/)
    expect(fuente).toMatch(/ingest\.registrarComprobante/)
  })

  // ⚠️ EL ANÁLISIS TIENE QUE VIAJAR CON LA HUELLA (2026-09-13).
  //
  // Lo destapó una prueba de aceptación: se subió un comprobante por la mini
  // app y se quedó en `pendiente_analisis` para siempre. `registrarComprobante`
  // NO llama a la visión —la espera ya hecha, para que quien la llamó antes no
  // la pague dos veces— y esta ruta no se la pasaba.
  //
  // El efecto era que por esta puerta la huella SÍ se calculaba (el duplicado
  // se cazaba) pero nadie comprobaba el monto ni la cuenta de destino: las dos
  // únicas señales críticas del dinero. El chat sí lo hacía.
  //
  // Se comprueba leyendo el FUENTE y no con un doble, porque lo que falla aquí
  // no es la lógica —que funciona— sino que nadie la llame: el fallo de
  // «construido y desconectado» que este proyecto ha pagado nueve veces.
  it('la mini app ANALIZA la imagen y le pasa lo leído al registro', () => {
    const fuente = fuenteDeLaTienda()
    const analiza = fuente.indexOf('vision.analizarComprobante')
    const registra = fuente.indexOf('ingest.registrarComprobante')
    expect(analiza, 'la ruta no llama a la visión').toBeGreaterThan(-1)
    expect(registra).toBeGreaterThan(-1)
    // Primero se lee la imagen, después se registra lo leído.
    expect(analiza).toBeLessThan(registra)
    // Y lo leído viaja de verdad: sin estos dos campos el registro se queda
    // en `pendiente_analisis` aunque la visión haya corrido.
    const llamada = fuente.slice(registra, registra + 600)
    expect(llamada, 'no le pasa el análisis').toMatch(/\banalisis\b/)
    expect(llamada, 'no le pasa el pedido contra el que cuadrar').toMatch(/esperado:/)
  })

  it('y nada de eso puede tumbar la subida: falla ABIERTO', () => {
    const fuente = fuenteDeLaTienda()
    // La visión y la lectura del pedido se tragan su error por separado, y el
    // bloque entero tiene su propio catch: el comprobante ya está adjunto.
    expect(fuente).toMatch(/vision\.analizarComprobante\([^)]*\)\s*\n?\s*\.catch/)
    expect(fuente).toMatch(/getOrderForReceiptCheck\([^)]*\)\s*\n?\s*\.catch/)
  })

  it('el gancho del buzón es OPCIONAL: sin él se comporta como antes', () => {
    // Es una capa encima, no un punto único de fallo.
    const fuente = leer('../src/services/payment-proof-inbox.ts')
    expect(fuente).toMatch(/registrarHuella\?\(/)
    expect(fuente).toMatch(/if \(dependencias\.registrarHuella\)/)
  })
})

describe('la migración protege lo que importa', () => {
  const sql = leer('../migration-2026-08-22-huella-del-comprobante.sql')

  it('ningún estado del comprobante confirma un pago', () => {
    // ⚠️ La regla central: el análisis NO puede dar por cobrado nada. Eso lo
    // decide el dueño (`orders.payment_confirmed_at`) o, algún día, el banco.
    const estados = sql.match(/status in \([\s\S]*?\)/)?.[0] || ''
    expect(estados).toContain('pendiente_analisis')
    expect(estados).toContain('requiere_revision')
    expect(estados).not.toMatch(/confirmado|pagado|aprobado/)
    // Y no ESCRIBE en la columna que sí confirma. Se mira solo el código:
    // los comentarios la nombran justamente para explicar que no se toca.
    const codigo = sql.split('\n')
      .filter(linea => !linea.trimStart().startsWith('--'))
      .join('\n')
    expect(codigo).not.toContain('payment_confirmed_at')
  })

  it('no recrea las funciones del dinero', () => {
    expect(sql).not.toContain('create or replace function public.create_storefront_order')
    expect(sql).not.toContain('create or replace function public.set_order_status')
    // Ni la que adjunta el comprobante: esto va AL LADO del flujo de siempre.
    expect(sql).not.toContain('create or replace function public.attach_storefront_payment_proof')
  })

  it('las tres tablas nacen con business_id y RLS', () => {
    for (const tabla of [
      'payment_receipts',
      'payment_receipt_risk_flags',
      'payment_receipt_audit_logs',
    ]) {
      expect(sql).toMatch(new RegExp(`create table if not exists public\\.${tabla}`))
      expect(sql).toMatch(new RegExp(`alter table public\\.${tabla} enable row level security`))
    }
    // `business_id not null` en las tres.
    expect(sql.match(/business_id\s+uuid not null references public\.businesses/g)).toHaveLength(3)
  })

  it('y ni siquiera service_role las lee por defecto', () => {
    // La búsqueda de duplicados mira comprobantes de OTROS negocios, así que
    // esa consulta no puede quedar al alcance de nadie salvo del servidor.
    expect(sql.match(/from public, anon, authenticated, service_role/g)).toHaveLength(3)
  })

  it('la búsqueda de duplicados NO revela el negocio ajeno', () => {
    // ⚠️ Es la decisión delicada: buscar es global —el comprobante reutilizado
    // en otro local es el fraude que más pesa—, pero lo que se devuelve solo
    // nombra pedidos de ESTE negocio.
    const bloque = sql.match(/select o\.order_number into v_pedido_previo[\s\S]*?limit 1;/)?.[0] || ''
    expect(bloque).toContain('o.business_id = p_business_id')
  })

  it('las fronteras entre negocios están cerradas con foráneas compuestas', () => {
    // Lo cazó `verificar-fronteras.sql`: con foráneas simples, una fila podía
    // apuntar a un pedido o un usuario de otro negocio.
    expect(sql).toContain('foreign key (order_id, business_id)')
    expect(sql).toContain('foreign key (receipt_id, business_id)')
    expect(sql).toContain('foreign key (user_id, business_id)')
  })

  it('la auditoría no se sobrescribe: solo se puede insertar', () => {
    expect(sql).toMatch(/grant select, insert on table public\.payment_receipt_audit_logs/)
    expect(sql).not.toMatch(/grant[^;]*update[^;]*payment_receipt_audit_logs/)
  })
})
