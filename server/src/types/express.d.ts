declare global {
  namespace Express {
    interface ClientUserClaims {
      role: 'client'
      businessId: string
      urole?: 'owner' | 'employee'
      perms?: string[]
      userId?: string
      email?: string
    }

    interface AdminUserClaims {
      role: 'admin'
      email?: string
      /** Pasó el segundo paso (2026-09-29). Sin esto `authAdmin` no deja pasar. */
      mfa?: true
    }

    // Sesión de la mini app. No es un usuario del panel: el cliente entra con
    // el enlace que le mandó el bot, no con contraseña. El middleware la deja
    // ya resuelta para que ninguna ruta tenga que leer el token otra vez.
    interface StorefrontSession {
      businessId: string
      customerId: string
      contactPhone: string
      sessionId: string
    }

    interface Request {
      user?: ClientUserClaims | AdminUserClaims
      rawBody?: Buffer
      storefront?: StorefrontSession
      /**
       * El negocio de la URL, ya resuelto por su slug, en las rutas PÚBLICAS
       * de la tienda (el catálogo). Va aparte de `storefront` a propósito: si
       * un negocio sin sesión llegara dentro de `storefront`, una ruta que lea
       * `storefront.customerId` recibiría un objeto a medias y crearía un
       * pedido sin cliente. Aquí solo hay negocio, y no puede confundirse.
       */
      storeBusinessId?: string
      /**
       * El bloqueo de quien abre la PORTADA con su enlace.
       *
       * Va aparte de `storefront` porque la portada es la única pantalla que
       * un bloqueado SÍ debe recibir: es lo que permite pintarle el aviso con
       * el nombre y el logo del local en vez de un error pelado. El catálogo y
       * todo lo que escribe lo rechazan con 403 antes de llegar a la ruta.
       */
      storefrontBlock?: { blocked: boolean; permanent: boolean; until: string | null }
      /**
       * Quien abre la PORTADA trae un enlace que ya no vale (revocado o
       * caducado).
       *
       * Va por el mismo camino que `storefrontBlock` y por la misma razón: la
       * app decide con la portada si monta la tienda, así que es ahí donde
       * tiene que enterarse. Si se enterara al pedir la carta, la tienda ya
       * estaría montada y el aviso saldría encima de un menú vacío.
       */
      storefrontExpired?: boolean
    }
  }
}

export {}
