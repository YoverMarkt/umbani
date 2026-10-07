# App del cliente — pantalla por pantalla

Cada pantalla dice qué llama y qué enseña. Los textos de cara al cliente, en
español neutro (Ecuador/Colombia). Ver [API-UMBANI.md](API-UMBANI.md) para la
sesión, las cabeceras y los errores.

> 🌐 **La app web de clientes es la referencia viva** (2026-10-05): abre
> `https://umbani-pruebas.up.railway.app/u` en el móvil mientras construyes. Hace
> exactamente este recorrido —ubicación, inicio de la ciudad, entrar con
> WhatsApp, el local, «Mis pedidos»— con la MISMA API, y su código está en
> `apps/store/src/umbani/` (`api.ts` es cada llamada, con sus cabeceras). Si
> algo de aquí no te cuadra, mira cómo lo hace ella. Una prueba vigila que
> todas sus rutas estén en `openapi.yaml`.

## 1. Bienvenida e inicio de sesión
- **Llama:** `POST /api/v1/auth/whatsapp`, luego `POST /api/v1/auth/whatsapp/verificar` cada 2–3 s.
- **Enseña:** «Inicia sesión con WhatsApp», el código grande y el botón «Abrir WhatsApp» (abre `enlace`). Mientras espera: «Esperando tu mensaje…». Si vence: «El código venció, pide otro».
- **Guarda:** el `token` en almacenamiento seguro (Keychain / Keystore).

## 1b. La ciudad, por la ubicación (2026-10-05)
Umbani atiende ciudad por ciudad (hoy Chone) y **cada cliente ve solo los locales de la suya**, como en las grandes: no se le pregunta, se le enseña lo de donde está.
1. **Pide permiso de ubicación** y llama a `GET /api/v1/ciudades/aqui?lat={lat}&lng={lng}` (manda también la cabecera `x-umbani-dispositivo` con el id de instalación).
   - `{ ciudad: { id, nombre }, conLocales: true }` → sigue al inicio con esa ciudad.
   - `{ ciudad: {…}, conLocales: false }` → «Pronto llegamos a {nombre} 🛵».
   - `{ ciudad: null, cercana: { nombre, km } }` → «Todavía no llegamos a tu zona» (y si quieres, «la más cercana es {nombre}, a {km} km»). Queda anotado en Umbani para decidir la próxima ciudad.
2. **Sin permiso de ubicación:** `GET /api/v1/ciudades` y que elija de la lista.
3. **Guárdala** con `PUT /api/v1/yo/ciudad` (`{ ciudadId }`) y ponla arriba del inicio («📍 Chone ▾») para cambiarla.
4. ⚠️ **Al pedir, la dirección de entrega tiene que caer dentro de la ciudad del local.** Si no, el pedido responde con el motivo («Esa dirección está fuera de la zona de reparto de Chone…»): enséñalo tal cual.

## 2. Inicio: el marketplace
- **Llama:** `GET /api/v1/marketplace?ciudad={ciudadId}`. ⚠️ Sin `ciudad` responde `400`: un cliente de Chone no puede ver los locales de Portoviejo.
- **Enseña:** las categorías (`nombre`, `emoji`) y sus locales. `abierto: false` → «Cerrado»; `conCarta: false` → «Sin carta a esta hora» (y `cartaDesde` si viene). `null` = no se sabe: píntalo abierto.

## 3. El local
- **Al entrar:** `POST /api/v1/locales/{slug}/sesion` → guarda el token de tienda de ese local.
- **Llama:** `GET /api/store/{slug}` (portada: logo, horario, `status`, `canOrder`, métodos de pago, envío, tarifa) y `GET /api/store/{slug}/catalog` (categorías, productos, variantes, grupos de opciones).
- **Enseña:** la carta. Los precios YA vienen con todo; no sumes nada. Si `canOrder` es falso, el local se ve pero no deja pedir.

## 4. El producto
- **Enseña:** variantes y grupos de opciones con sus reglas (`required`, `min_selectable`, `max_selectable`, `selection_type`, `free_selections`). El precio que se cobra lo dice la cotización, no la pantalla.

## 5. El carrito y el checkout
- **Llama:** `POST /api/store/{slug}/quote` cada vez que cambia el carrito o la entrega → enseña cada línea (`lineTotal`), `subtotal` («Productos»), `shipping` («Envío»), `serviceFee` («Tarifa de servicio», solo si > 0) y `total`. Siempre suma; ver API-UMBANI.md §3.
- **Direcciones:** `GET /api/store/{slug}/me` (nombre y direcciones guardadas), `POST /api/store/{slug}/addresses`, `DELETE .../addresses/{id}`, `PUT .../addresses/{id}/location` (el pin).
- **Métodos de pago:** los de `business.paymentMethods`. `pago_al_retirar` solo si retira en el local.
- **Confirmar:** `POST /api/store/{slug}/orders` con una `idempotencyKey` por carrito (si reintentas, manda la misma: no se crean dos pedidos).

## 6. Después de pedir
- **Efectivo / al retirar:** «Recibimos tu pedido #N». El local lo confirma y el cliente recibe los avisos por WhatsApp.
- **Transferencia:** `GET /api/store/{slug}/payment-info` → la cuenta del local para transferir. El comprobante se manda por el chat de WhatsApp de Umbani.
- **Tarjeta:** ver «Pagar con tarjeta» en API-UMBANI.md. Pantalla «Confirmando tu pago…» → «¡Pago recibido!» o «No se completó el pago» (con «Intentar de nuevo»).

## 7. Mis pedidos
- **Llama:** `GET /api/v1/pedidos` (los de TODOS los locales, con `local.nombre`) y, al tocar uno, `GET /api/v1/pedidos/{id}`. Con la sesión de la app; no hace falta abrir la tienda de cada local.
- **Para volver a pedir en ese local:** `local.slug` → `POST /api/v1/locales/{slug}/sesion`.
- **Enseña:** el local, número, estado dicho para el cliente, lo que pidió (cada línea con su `line_total`) y el desglose `subtotal` / `shipping` / `service_fee` (solo si > 0) / `total`. Los estados: `esperando_pago` «Falta tu pago», `pago_en_revision` «Revisando tu pago», `pendiente` «Recibido», `confirmado`/`aceptado`/`preparacion` «En preparación», `listo_para_retiro` «Listo para retirar», `en_camino` «En camino», `completado` «Entregado», `cancelado`/`rechazado` «Cancelado», `expirado` «Se venció el tiempo de pago».

## 7b. «¿Llegó todo bien?» (2026-10-06)
Como las grandes: al recibir, el cliente dice «Todo bien» o reporta qué faltó, qué vino mal o que no llegó. **Una vez por pedido y en las 48 horas siguientes a la entrega.** La web de referencia lo hace en la mini app: «Mi cuenta → Mis pedidos».
- **Cuándo enseñarlo:** cada pedido de `GET /api/v1/pedidos` trae `confirmacion`. Enseña la pregunta y sus dos botones **solo si `confirmacion.reclamableHasta` no es null**: el plazo lo decide el servidor, la app no cuenta horas.
- **«Sí, todo bien»:** `POST /api/v1/pedidos/{id}/todo-bien`. Después enseña «Nos dijiste que llegó todo bien» (`confirmacion.todoBien`).
- **«Algo salió mal»:** el cliente elige **Faltó algo** (`falta_producto`), **Algo vino mal** (`vino_mal`) o **No llegó mi pedido** (`no_llego`). Con las dos primeras elige qué líneas y cuántas unidades (un contador de 0 a la cantidad pedida, con el `id` de cada línea de `order_items`), y una nota opcional. Manda `POST /api/v1/pedidos/{id}/reclamo` con `{ tipo, lineas: [{ item, cantidad }], nota }`.
- **Lo que le corresponde lo calcula el servidor** (`sugeridoCents`): lo que pagó por esas unidades, nunca más que el total; si no llegó nada, el pedido entero. **No le prometas esa cifra**: Umbani lo revisa y decide.
- **Después:** `confirmacion.reclamo` dice `estado` (`abierta` «Lo estamos revisando», `resuelta` «Umbani te compensa $X» con `compensacionCents`, `descartada` «Lo revisamos»).
- **Errores:** `409` con el texto para el cliente (aún no se entregó, ya lo reportó, o pasaron 48 h), `400` si los datos no cuadran. Repite el texto del servidor.
