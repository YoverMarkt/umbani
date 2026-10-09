import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { RiCloseLine } from '@remixicon/react'
import { ApiError, getStore, isBlocked, isLinkProblem } from './lib/api'
import { isMobileDevice } from './lib/device'
import { aplicarColorDeMarca } from './lib/marca'
import { readSlug } from './lib/session'
import { volverAUmbani } from './lib/umbani'
import type { Business, StoreStatus } from './lib/types'
import FoodStore from './screens/FoodStore'
import { Bienvenida } from './components/ui'

// ── LAS PUERTAS VIAJAN APARTE ──────────────────────────────────────────────
//
// Ninguna se ve en una visita normal, y se descargaban en la primera carga —la
// que se paga en clientes que cierran antes de que la tienda abra—:
//
//   · `DesktopGate` solo sale en una COMPUTADORA, y esta app es para el
//     teléfono: en el móvil es peso muerto al 100 %.
//   · `Gate` solo sale con un acceso que no vale.
//
// (Había una tercera, `Confirmar`, que pedía el número de WhatsApp para
// entrar con un enlace del chat. Se retiró el 2026-10-09: Umbani es solo app y
// la tienda se abre desde ella, con la cuenta.)
//
// ⚠️ Se difieren ESTAS y no la pantalla de pedido recibido, que era la otra
// candidata por tamaño. Aquella se pinta en el instante siguiente a confirmar
// un pedido: si el trozo no llegara, el cliente que acaba de comprar se
// quedaría sin su número de pedido y sin los datos para transferir. Aquí lo
// peor que pasa es que una pantalla que ya dice «esto no se puede usar» tarde
// un instante más en decirlo.
//
// Cada una en su propio trozo, no en uno común: quien se topa con una puerta
// no tiene por qué descargarse las otras.
const Gate = lazy(() => import('./screens/Gate'))
const DesktopGate = lazy(() => import('./screens/DesktopGate'))
// La cuarta puerta, y la más reciente (2026-08-29): el local bloqueó a esta
// persona. Se difiere igual que las otras — no se ve en una visita normal.
const Bloqueado = lazy(() => import('./screens/Bloqueado'))
// Y la quinta: la tienda no cargó. Distinto de que no exista — ver `cargar`.
const SinConexion = lazy(() => import('./screens/SinConexion'))
// Y la sexta. Vivía escrita a mano aquí, en el paquete principal, para una
// pantalla que en una visita normal no se ve nunca.
const NoDisponible = lazy(() => import('./screens/NoDisponible'))

// Armazón de la tienda.
//
// La decisión que se toma aquí es la importante: QUÉ flujo se pinta. No se
// mira el tipo de negocio, se miran sus capacidades.

type Estado =
  | { fase: 'cargando' }
  | { fase: 'no_disponible' }
  /**
   * No se pudo CARGAR, que no es lo mismo que no existir.
   *
   * Sin esta fase los dos casos caían en 'no_disponible', y esa pantalla dice
   * «puede que el negocio la haya desactivado»: se le echaba la culpa al local
   * por un problema del teléfono, y sin ofrecer reintentar.
   */
  | { fase: 'sin_conexion' }
  | { fase: 'escritorio'; business: Business | null }
  | { fase: 'bloqueada'; business: Business | null; motivo: string | null }
  /**
   * El LOCAL bloqueó a esta persona. Distinto de 'bloqueada', que habla del
   * enlace: aquí el enlace es válido y suyo, lo que no puede es comprar.
   */
  | {
    fase: 'vetado'
    business: Business | null
    until: string | null
    permanent: boolean
  }
  | {
    fase: 'lista'
    business: Business
    status: StoreStatus
    /**
     * El enlace dejó de valer con la tienda ya abierta. Se pinta ENCIMA para
     * no llevarse el carrito; sin esto la fase pasaba a 'bloqueada' y
     * `FoodStore` se desmontaba entero.
     */
    bloqueo?: { business: Business | null; motivo: string | null }
  }

export default function App() {
  const slug = readSlug()
  const [estado, setEstado] = useState<Estado>({ fase: 'cargando' })

  const cargar = useCallback(async () => {
    if (!slug) return setEstado({ fase: 'no_disponible' })

    // Se comprueba el dispositivo ANTES de pedir nada con sesión, y no es un
    // detalle de orden: la portada es pública y no consume el enlace, así que
    // un clic desde WhatsApp Web deja el enlace intacto para cuando la persona
    // lo abra en su teléfono.
    const enMovil = isMobileDevice()

    try {
      const datos = await getStore(slug)
      // El color del negocio se aplica en cuanto se conoce, antes de pintar el
      // catálogo: así nadie ve el verde por defecto y luego un salto de color.
      aplicarColorDeMarca(datos.business?.brandColor)

      // ⚠️ EL BLOQUEO GANA A TODO, y va antes de montar nada (2026-08-29).
      //
      // La portada es la única respuesta que recibe un bloqueado, y trae
      // `blocked` justo para esto. Si se comprobara más tarde —al pedir el
      // catálogo, o peor, al confirmar— esta persona ya habría recorrido la
      // carta entera buscando cómo pedir. Es exactamente lo que pasó el
      // 2026-08-29 con el pedido #74.
      if (datos.blocked) {
        return setEstado({
          fase: 'vetado',
          business: datos.business,
          until: datos.blocked.until,
          permanent: datos.blocked.permanent,
        })
      }

      // ⚠️ EL ENLACE MUERTO TAMPOCO MONTA LA TIENDA (2026-09-16).
      //
      // Por el mismo motivo que el bloqueo de arriba, y con el mismo síntoma:
      // hasta hoy la carta se veía con un enlace revocado, el cliente armaba
      // su carrito y escribía su dirección, y el aviso le saltaba al pagar.
      // El dueño: «si suben en el chat e ingresan, que les diga que el link
      // expiró y que no les deje ver el menú».
      //
      // ⚠️ Solo cuando el enlace VINO y ya no vale. Quien llega SIN enlace no
      // trae `expired` y sigue viendo la carta: la tienda es pública.
      if (datos.expired) {
        return setEstado({ fase: 'bloqueada', business: datos.business, motivo: 'revocada' })
      }

      if (!enMovil) return setEstado({ fase: 'escritorio', business: datos.business })
      // La carta se ve sin enlace: un enlace de comida se reenvía, se pega en
      // una historia y se busca, y quien llegue tiene que poder mirar antes de
      // dar su número. Pedir sí lo exige, y el 401 de esa petición es lo que
      // lleva a `Gate` o a confirmar el teléfono — ver `alFallarEnlace`.
      setEstado({ fase: 'lista', business: datos.business, status: datos.status })
    } catch (error) {
      // ⚠️ 404 y «no cargó» son cosas DISTINTAS (2026-08-30). El 404 significa
      // que el negocio no existe o está apagado, y ahí reintentar no arregla
      // nada. Cualquier otro fallo —sin datos, un 502, el servidor tardando—
      // es del camino, y decirle a esa persona «puede que el negocio la haya
      // desactivado» es culpar al local de un problema de su teléfono.
      if (error instanceof ApiError && error.status === 404) {
        return setEstado({ fase: 'no_disponible' })
      }
      // Ni siquiera se pudo leer la portada; en un PC igual toca decir por qué.
      if (!enMovil) return setEstado({ fase: 'escritorio', business: null })
      setEstado({ fase: 'sin_conexion' })
    }
  }, [slug])

  useEffect(() => { void cargar() }, [cargar])

  /**
   * Un 401 en cualquier pantalla significa lo mismo: el enlace no vale para
   * este teléfono. Se recupera la portada (que es pública) solo para poder
   * ofrecer el WhatsApp del negocio.
   */
  const alFallarEnlace = useCallback(async (error: unknown) => {
    // ⚠️ El bloqueo se mira PRIMERO y sustituye la tienda entera, al revés que
    // los problemas de enlace —que se pintan encima para no llevarse el
    // carrito—. Aquí llevárselo es lo correcto: ese carrito no va a poder
    // convertirse en un pedido, y dejarlo a la vista invita a intentarlo.
    if (isBlocked(error)) {
      const detalle = error instanceof ApiError ? error : null
      let business: Business | null = null
      try { business = (await getStore(slug)).business } catch { business = null }
      setEstado({
        fase: 'vetado',
        business,
        until: detalle?.until ?? null,
        permanent: detalle?.permanent === true,
      })
      return true
    }
    if (!isLinkProblem(error)) return false
    const motivo = error instanceof ApiError ? error.reason : null
    let business: Business | null = null
    try {
      business = (await getStore(slug)).business
    } catch { business = null }
    // 'necesita_telefono' (este teléfono aún no demostró el acceso) va por el
    // mismo camino que los demás: a la app, que es quien abre las tiendas.
    // ⚠️ ENCIMA de la tienda, no en lugar de ella (2026-08-27).
    //
    // `fase: 'bloqueada'` desmonta `FoodStore`, y con él se va el CARRITO. El
    // momento en que esto salta es el peor posible: la tienda es pública, así
    // que quien llega sin enlace mira la carta, elige, escribe su dirección…
    // y el 401 aparece justo ahí. Perdía todo lo que llevaba y aterrizaba en
    // una pantalla sin vuelta.
    //
    // Es exactamente el fallo que ya se corrigió con la confirmación del
    // teléfono —«va ENCIMA de la tienda, no en lugar de ella»—, y volvía a
    // estar aquí por el otro camino.
    //
    // ⚠️ Se pinta encima SOLO si la tienda ya está montada. Si el 401 llega
    // durante la carga inicial no hay nada que conservar, y sustituir es lo
    // correcto: una tienda a medias detrás de un aviso sería peor.
    setEstado(actual => (
      actual.fase === 'lista'
        ? { ...actual, bloqueo: { business, motivo } }
        : { fase: 'bloqueada', business, motivo }
    ))
    return true
  }, [slug])

  // ⚠️ AQUÍ HABÍA UN `return null` con la nota «el esqueleto del HTML sigue a
  // la vista», y NO ES CIERTO (2026-09-02). `createRoot(...).render()` VACÍA
  // el contenedor al montar: la bienvenida del `index.html` desaparece en ese
  // instante y, devolviendo `null`, no la sustituye nada.
  //
  // Medido contra producción con red móvil lenta, que es como se abre esto:
  //
  //     0,9 – 3,3 s   «Bienvenido a Umbani»
  //     3,5 – 6,8 s   PANTALLA EN BLANCO      ← 3,3 segundos
  //     7,1 s         la tienda
  //
  // El dueño lo describió exacto: «sale muy rápido y luego se queda en blanco
  // un buen rato». Tres segundos en blanco desde el navegador de WhatsApp es
  // tiempo de sobra para cerrar la app.
  //
  // Se pinta la MISMA bienvenida, con las mismas clases del `index.html`, así
  // que el relevo no se nota: la marca se ve durante toda la carga en vez de
  // parpadear. No se añade ni un milisegundo de espera artificial — dura lo
  // que de verdad tarde en llegar la portada.
  if (estado.fase === 'cargando') return <Bienvenida />

  if (estado.fase === 'no_disponible') {
    return (
      <Suspense fallback={null}>
        <NoDisponible />
      </Suspense>
    )
  }

  // Sin `fallback`: lo correcto mientras baja el trozo es que no se vea nada.
  // Un esqueleto que aparece y desaparece en un cuarto de segundo molesta más
  // que el propio cuarto de segundo — misma decisión que en `DireccionRapida`.
  if (estado.fase === 'sin_conexion') {
    return (
      <Suspense fallback={null}>
        <SinConexion onReintentar={() => { void cargar() }} />
      </Suspense>
    )
  }

  if (estado.fase === 'escritorio') {
    return (
      <Suspense fallback={null}>
        <DesktopGate business={estado.business} />
      </Suspense>
    )
  }

  if (estado.fase === 'bloqueada') {
    return (
      <Suspense fallback={null}>
        <Gate business={estado.business} motivo={estado.motivo} />
      </Suspense>
    )
  }

  if (estado.fase === 'vetado') {
    return (
      <Suspense fallback={null}>
        <Bloqueado
          business={estado.business}
          until={estado.until}
          permanent={estado.permanent}
          // Cumplido el plazo se recarga de verdad: el estado del bloqueo lo
          // decide el servidor, y volver a preguntárselo es lo único honesto.
          onReintentar={() => { void cargar() }}
        />
      </Suspense>
    )
  }

  const { business, status } = estado

  /**
   * El enlace dejó de valer con la tienda ya abierta.
   *
   * ⚠️ Lleva CERRAR, y no es un adorno: sin salida, esto sería la pantalla
   * 'bloqueada' de siempre con otro nombre — el cliente se quedaría mirando un
   * aviso con su carrito intacto detrás y sin forma de volver a él. Cerrando
   * puede seguir viendo la carta, que es pública, y pedir su enlace cuando
   * quiera. Lo que no podrá es cerrar el pedido, y eso se lo dirá el servidor
   * otra vez.
   */
  const puertaDelEnlace = estado.bloqueo && (
    <div className="fixed inset-0 z-[60] overflow-y-auto superficie">
      <button
        onClick={() => setEstado(actual => (
          actual.fase === 'lista' ? { ...actual, bloqueo: undefined } : actual
        ))}
        // Etiqueta PROPIA, no un «Cerrar» más: la hoja del carrito que queda
        // debajo tiene la suya, y dos controles con el mismo nombre accesible
        // en la misma pantalla no se distinguen — ni con lector, ni al
        // probarlo. Además dice a dónde vuelve, que es lo que tranquiliza a
        // quien acaba de ver un aviso con su carrito detrás.
        aria-label="Cerrar y volver a la carta"
        className="absolute top-[calc(env(safe-area-inset-top)+1rem)] right-4 z-10 flex size-10 items-center justify-center rounded-full bg-black/5 transition active:scale-90"
      >
        <RiCloseLine size={20} />
      </button>
      <Suspense fallback={null}>
        <Gate business={estado.bloqueo.business || business} motivo={estado.bloqueo.motivo} />
      </Suspense>
    </div>
  )

  // ⚠️ La confirmación va ENCIMA, no en lugar de. Sustituyendo la tienda se
  // perdía el carrito entero: el cliente lo llenaba, tocaba confirmar,
  // escribía su número y volvía a una tienda vacía. Lo mismo valía para el
  // checkout a medio llenar.
  return (
    <>
      <FoodStore
        slug={slug}
        business={business}
        status={status}
        // La flecha de la portada vuelve a la app. Sin ella, con la app
        // instalada en un iPhone —sin botón de atrás— el cliente se quedaba
        // encerrado en la tienda.
        onVolver={volverAUmbani}
        onFalloEnlace={alFallarEnlace}
      />
      {puertaDelEnlace}
    </>
  )
}
