# App del cliente — pantalla por pantalla

Cada pantalla dice qué llama y qué enseña. Los textos de cara al cliente, en
español neutro (Ecuador/Colombia). Ver [API-UMBANI.md](API-UMBANI.md) para la
sesión, las cabeceras y los errores.

## 1. Bienvenida e inicio de sesión
- **Llama:** `POST /api/v1/auth/whatsapp`, luego `POST /api/v1/auth/whatsapp/verificar` cada 2–3 s.
- **Enseña:** «Inicia sesión con WhatsApp», el código grande y el botón «Abrir WhatsApp» (abre `enlace`). Mientras espera: «Esperando tu mensaje…». Si vence: «El código venció, pide otro».
- **Guarda:** el `token` en almacenamiento seguro (Keychain / Keystore).

## 2. Inicio: el marketplace
- **Llama:** `GET /api/v1/marketplace`.
- **Enseña:** las categorías (`nombre`, `emoji`) y sus locales. `abierto: false` → «Cerrado»; `conCarta: false` → «Sin carta a esta hora» (y `cartaDesde` si viene). `null` = no se sabe: píntalo abierto.

## 3. El local
- **Al entrar:** `POST /api/v1/locales/{slug}/sesion` → guarda el token de tienda de ese local.
- **Llama:** `GET /api/store/{slug}` (portada: logo, horario, `status`, `canOrder`, métodos de pago, envío, tarifa) y `GET /api/store/{slug}/catalog` (categorías, productos, variantes, grupos de opciones).
- **Enseña:** la carta. Los precios YA vienen con todo; no sumes nada. Si `canOrder` es falso, el local se ve pero no deja pedir.

## 4. El producto
- **Enseña:** variantes y grupos de opciones con sus reglas (`required`, `min_selectable`, `max_selectable`, `selection_type`, `free_selections`). El precio que se cobra lo dice la cotización, no la pantalla.

## 5. El carrito y el checkout
- **Llama:** `POST /api/store/{slug}/quote` cada vez que cambia el carrito o la entrega → enseña `subtotal`, `shipping` («Envío»), `serviceFee` («Tarifa de servicio», solo si > 0) y `total`.
- **Direcciones:** `GET /api/store/{slug}/me` (nombre y direcciones guardadas), `POST /api/store/{slug}/addresses`, `DELETE .../addresses/{id}`, `PUT .../addresses/{id}/location` (el pin).
- **Métodos de pago:** los de `business.paymentMethods`. `pago_al_retirar` solo si retira en el local.
- **Confirmar:** `POST /api/store/{slug}/orders` con una `idempotencyKey` por carrito (si reintentas, manda la misma: no se crean dos pedidos).

## 6. Después de pedir
- **Efectivo / al retirar:** «Recibimos tu pedido #N». El local lo confirma y el cliente recibe los avisos por WhatsApp.
- **Transferencia:** `GET /api/store/{slug}/payment-info` → la cuenta del local para transferir. El comprobante se manda por el chat de WhatsApp de Umbani.
- **Tarjeta:** ver «Pagar con tarjeta» en API-UMBANI.md. Pantalla «Confirmando tu pago…» → «¡Pago recibido!» o «No se completó el pago» (con «Intentar de nuevo»).

## 7. Mis pedidos
- **Llama:** `GET /api/store/{slug}/orders` y `GET /api/store/{slug}/orders/{id}`.
- **Enseña:** número, estado dicho para el cliente, lo que pidió y el total. Los estados: `esperando_pago` «Falta tu pago», `pago_en_revision` «Revisando tu pago», `pendiente` «Recibido», `confirmado`/`aceptado`/`preparacion` «En preparación», `listo_para_retiro` «Listo para retirar», `en_camino` «En camino», `completado` «Entregado», `cancelado`/`rechazado` «Cancelado», `expirado` «Se venció el tiempo de pago».
