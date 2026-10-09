import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fuenteDeLaPantalla } from './fuente-de-la-pantalla.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// UMBANI ES SOLO APP: NADA MANDA AL CLIENTE A WHATSAPP (2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño: se entra con el correo, la tienda de un local se abre
// desde la app, el comprobante se sube allí y el pedido se sigue en «Mis
// pedidos». Ninguna pantalla —de la tienda ni de la app de clientes— ofrece ya
// un botón a WhatsApp. (Se lee el código como texto: la tienda prueba sus
// componentes sin navegador.)

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const leer = ruta => readFileSync(path.join(src, ruta), 'utf8')
const archivos = (dir) => readdirSync(dir).flatMap((nombre) => {
  const ruta = path.join(dir, nombre)
  if (statSync(ruta).isDirectory()) return archivos(ruta)
  return /\.(tsx?|css)$/.test(nombre) ? [ruta] : []
})
/** El código sin sus comentarios: la HISTORIA puede nombrar WhatsApp; la app, no. */
const sinComentarios = texto => texto
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(linea => !linea.trimStart().startsWith('//')).join('\n')

describe('ninguna pantalla manda a WhatsApp', () => {
  const codigo = archivos(src).map(ruta => [path.relative(src, ruta), sinComentarios(readFileSync(ruta, 'utf8'))])

  it('ni un enlace `wa.me` ni un icono de WhatsApp en la tienda o en la app', () => {
    // Si no leyera nada, este guardián no vigilaría nada.
    expect(codigo.length).toBeGreaterThan(40)
    const culpables = codigo.filter(([, texto]) => /wa\.me|RiWhatsapp/.test(texto)).map(([ruta]) => ruta)
    expect(culpables).toEqual([])
  })

  it('la confirmación del número por WhatsApp ya no existe', () => {
    expect(codigo.map(([ruta]) => ruta)).not.toContain(path.join('screens', 'Confirmar.tsx'))
    expect(codigo.filter(([, texto]) => /confirmarTelefono|session\/verify/.test(texto)).map(([r]) => r)).toEqual([])
  })
})

describe('todas las salidas llevan a la app', () => {
  it('las puertas (acceso que no vale, tienda apagada, bloqueado) tienen su botón a Umbani', () => {
    for (const puerta of ['screens/Gate.tsx', 'screens/NoDisponible.tsx', 'screens/Bloqueado.tsx']) {
      expect(leer(puerta), puerta).toContain('href={DIRECCION_DE_UMBANI}')
    }
  })

  it('la flecha de la portada vuelve a la app: sin ella, la app instalada no tiene salida', () => {
    expect(leer('App.tsx')).toContain('onVolver={volverAUmbani}')
    expect(fuenteDeLaPantalla()).toContain('onVolver={onVolver}')
  })

  it('después de pedir, o si se cancela, la salida es «Mis pedidos» de la app', () => {
    const pedido = leer('screens/OrderPlaced.tsx')
    expect(pedido.match(/href=\{DIRECCION_DE_MIS_PEDIDOS\}/g)).toHaveLength(2)
    expect(leer('lib/umbani.ts')).toContain("DIRECCION_DE_MIS_PEDIDOS = '/u#pedidos'")
    // Y la app abre directo ahí con esa marca.
    expect(leer('umbani/UmbaniApp.tsx')).toMatch(/hash !== '#pedidos'/)
  })
})

describe('el comprobante se sube en la app', () => {
  it('con transferencia, debajo de los datos para transferir, en su propio trozo', () => {
    const pedido = leer('screens/OrderPlaced.tsx')
    expect(pedido).toContain("const SubirComprobante = lazy(() => import('../components/SubirComprobante'))")
    const bloque = pedido.slice(pedido.indexOf('{transferencia && ('), pedido.indexOf('{transferencia && (') + 400)
    expect(bloque).toContain('<PagoPendiente slug={slug} />')
    expect(bloque).toContain('<SubirComprobante slug={slug} orderId={pedido.id} />')
  })

  it('va a la ruta del servidor, con la sesión de la tienda y sin `Content-Type` a mano', () => {
    const api = leer('lib/api.ts')
    const subida = api.slice(api.indexOf('export async function uploadPaymentProof'))
    expect(subida).toContain('/proof`')
    expect(subida).toContain("'x-storefront-token': readToken()")
    expect(subida.slice(0, subida.indexOf('body: datos'))).not.toContain("'Content-Type'")
  })
})
