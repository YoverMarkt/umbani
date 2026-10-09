# La API de Umbani para las apps

| Servidor | Base | Para qué |
|---|---|---|
| **PRUEBAS** | `https://umbani-pruebas.up.railway.app` | **Aquí se desarrolla.** Datos de mentira: la pizzería de prueba (`demo`). |
| Producción | `https://web-production-3433c.up.railway.app` | Clientes reales. **Nunca** se desarrolla contra ella. |

El de pruebas lleva abajo a la izquierda la franja «STAGING · datos de mentira».
No manda correos de verdad: el código para entrar vuelve en la respuesta (mira §1a).

**Ciudades (2026-10-05):** cada cliente ve solo los locales de SU ciudad, y la
app la saca del **GPS**: `GET /api/v1/ciudades/aqui?lat=&lng=`. Sin permiso de
ubicación, la lista de `GET /api/v1/ciudades`. Se guarda con
`PUT /api/v1/yo/ciudad`; `GET /api/v1/marketplace` exige `?ciudad=` (sin ella,
`400`). La entrega tiene que caer dentro de la ciudad del local. Pantalla por
pantalla en [APP-CLIENTE.md §1b](APP-CLIENTE.md). El local de pruebas está en Chone.

## 1. La sesión, en dos niveles

**a) La sesión de la app (quién es el cliente).** Se entra con el **CORREO**,
sin contraseña (decisión del dueño, 2026-10-06: las apps ya NO entran por
WhatsApp). Google y Apple llegarán después, cuando estén sus credenciales: la
pantalla de entrada tiene que ser un módulo **aislado** que termina devolviendo
el `token`, porque el resto de la app no cambiará — todas las rutas solo miran
`Authorization: Bearer <token>`.

1. `POST /api/v1/auth/correo` con `{ correo }` → `201 { enviado, expiraEn }`.
   Llega un código de **6 números** a ese correo (vale 10 minutos).
2. `POST /api/v1/auth/correo/verificar` con `{ correo, codigo }`:
   - `200 { token, correo }` → listo. Guarda `token` de forma segura.
   - `401` → código incorrecto: gasta uno de sus **5 intentos**.
   - `410` → venció, se usó o agotó sus intentos: vuelve al paso 1.
   Solo vale el **último** código pedido. Como mucho **5 códigos por hora** por
   correo (`429`). Y un tope para toda la plataforma: si se llena (un bot
   pidiendo códigos), el paso 1 responde `503` con `Retry-After` en segundos —
   muestra su `error` y deja reintentar pasado ese tiempo.
3. **El número.** Una cuenta de correo nace SIN teléfono, y sin él no se puede
   pedir: `POST /api/v1/locales/{slug}/sesion` responde `409 { falta: 'telefono' }`.
   La app pregunta UNA vez «¿a qué número te llama el repartidor?» y lo manda
   con `PUT /api/v1/yo/telefono` `{ telefono }` (acepta `0991234567`; responde
   en dígitos con el código del país). ⚠️ El número se reclama en **EXCLUSIVA**:
   de él cuelgan «Mis pedidos», los reclamos y la tienda, así que si ya es de
   otra persona (o hay pedidos con él) responde `409` y no se dice de quién.
   `GET /api/v1/yo` → `{ telefono, correo, ciudadId }` (`telefono` null = falta).
4. En adelante: `Authorization: Bearer <token>` en las rutas `/api/v1/*`. Dura
   30 días; con `401`, vuelve al paso 1. Un `503` en cualquier ruta autenticada
   quiere decir que no se pudo comprobar la sesión: reintenta en unos segundos,
   no la borres.

🤖 **El captcha (Cloudflare Turnstile, 2026-10-09).** Antes del paso 1, llama
a `GET /api/v1/auth/config`. Si trae `turnstile: { claveDeSitio }`, el paso 1
exige además `turnstile`: la ficha que da el widget de Turnstile pintado con
esa clave y la acción `entrar-correo` (en Flutter, dentro de un WebView). Cada
ficha vale **una vez** y 5 minutos: una nueva por cada petición, también al
«mandarme otro código». Sin ficha, o si Cloudflare no la da por buena, `403
{ falta: 'turnstile' }`. Con `turnstile: null` no hay captcha. Hoy está
apagado en producción (se enciende con el dominio); el servidor de pruebas
lleva las claves de PRUEBA de Cloudflare, que pasan siempre.

🧪 **En PRUEBAS no se mandan correos** (el proveedor de correo es de las
credenciales que llegan al final): el paso 1 devuelve además
`codigoDePruebas` con el código, para poder probar. En producción ese campo no
existe nunca —el servidor lo impide—, y sin proveedor la puerta responde `503`.

🚫 **La entrada por WhatsApp está RETIRADA** (2026-10-09: Umbani es solo app).
`/api/v1/auth/whatsapp` y `/verificar` responden siempre `410` con un `error`
para mostrar. Las sesiones por teléfono que ya se emitieron valen hasta que
caducan; las nuevas, solo con correo.

**b) La sesión de tienda (en qué local está).** Para entrar en un local:
`POST /api/v1/locales/{slug}/sesion` → `{ token }`. Con ese token la app usa
la **API de la tienda** (`/api/store/{slug}/*`), la misma que la mini app web.

La sesión de tienda queda atada al dispositivo. En **todas** las peticiones a
`/api/store/*` y a `/sesion` manda siempre las mismas cabeceras:

| Cabecera | Valor |
|---|---|
| `x-storefront-token` | el token de la sesión de tienda (no en `/sesion`) |
| `x-storefront-device` | un id aleatorio del dispositivo, generado una vez y guardado (≥ 8 caracteres) |
| `User-Agent` | fijo por versión de la app, p. ej. `UmbaniApp/1.0 (Android)` |
| `Accept-Language` | fijo, p. ej. `es-EC` |

Si cambian, la sesión deja de valer (`401`): pide una sesión nueva para ese
local. Entrar en OTRO local revoca la anterior (un enlace vivo a la vez).

## 2. Errores

Siempre `{ error: "texto para el cliente" }`, en español y listo para enseñar.
Algunos traen `reason`:

| Código | Qué hacer |
|---|---|
| `401` | Sesión vencida o cerrada: enseña el texto y pide otra (de app o de tienda). |
| `503` | No se pudo comprobar la sesión: reintenta en unos segundos, sin borrarla. |
| `403` + `reason: "bloqueado"` | El cliente está bloqueado: enseña el texto, sin reintentar. |
| `409` | El local está cerrado, no recibe pedidos o el pedido ya no se puede pagar. |
| `429` | Demasiadas peticiones: espera unos segundos. |

## 3. El dinero

- Todo importe llega **en dólares con dos decimales** desde el servidor. La app
  no suma, no redondea y no aplica porcentajes.
- Antes de confirmar, `POST /api/store/{slug}/quote` devuelve el desglose
  oficial, y **siempre suma**:

  | Campo | Se enseña como |
  |---|---|
  | `lines[]` (`name`, `quantity`, `lineTotal`) | cada producto, con su importe |
  | `subtotal` | «Productos» |
  | `shipping` | «Envío» (si es 0 y es a domicilio: «Envío gratis») |
  | `serviceFee` | «Tarifa de servicio» — **solo si es mayor que 0** |
  | `total` | «Total» |

  `subtotal + shipping + serviceFee = total`, y las líneas suman el `subtotal`.
- Los precios que llegan son los del **cliente** (los de la carta). El precio
  del local y lo que gana Umbani **no viajan** a la app (decisión del dueño,
  2026-10-01): no los busques, no están.
- El `total` que devuelve `POST /api/store/{slug}/orders` es **el que se
  cobra**. Si difiere de la cotización, manda el del pedido.

## 4. Pagar con tarjeta

1. Crear el pedido con `paymentMethod: "tarjeta"` (solo si el local la ofrece en
   `business.paymentMethods`).
2. `POST /api/store/{slug}/orders/{id}/tarjeta` → `{ url, urlApp }`.
3. **Abre `urlApp` en el navegador del sistema** (no en un WebView: PayPhone lo
   rechaza). Es una página de Umbani con un botón que lleva a PayPhone.
4. Cuando la app vuelve al primer plano, pregunta
   `GET /api/store/{slug}/orders/{id}/tarjeta` cada 2 s hasta que
   `pagado: true` o un `estado` final (`rechazado`, `caducado`, `devuelto`…).
   El servidor confirma el pago aunque el cliente no vuelva nunca.

Si `business.paymentMethods` trae la tarjeta con `test_mode: true`, enseña una
franja visible «PAGOS DE PRUEBA»: no se cobra dinero real.

## 4b. Pagar por transferencia: el comprobante se SUBE en la app

Desde el 2026-10-09 ya no se manda por WhatsApp. Con `paymentMethod:
"transferencia"` el pedido nace en `esperando_pago`:

1. Enseña los datos para transferir: `GET /api/store/{slug}/payment-info`.
2. El cliente transfiere desde su banco y sube la captura:
   `POST /api/store/{slug}/orders/{id}/proof`, **multipart** con el campo
   `file` (una imagen de hasta **5 MB**; si es una foto de cámara más grande,
   redúcela antes en el teléfono). `200 { ok: true }`. El pedido pasa a
   `pago_en_revision` y el local lo revisa; los errores traen su `error` para
   mostrar (`413` si pasa de 5 MB).
3. Recuérdale que **la transferencia tiene que estar a su nombre**.

## 5. «Mis pedidos»

⚠️ **Es el ÚNICO sitio donde el cliente sigue su pedido**: desde el 2026-10-09
ya no se le manda ningún aviso por WhatsApp, y las notificaciones push llegarán
después. Refresca el estado al volver a primer plano.


`GET /api/v1/pedidos` (con la sesión de la **app**, no la de tienda) devuelve
los pedidos de ese teléfono en **todos** los locales, los 30 más recientes:
`{ pedidos: [...] }`. Cada uno trae `local: { nombre, slug }`, su `status`, sus
líneas (`order_items[].line_total`, lo que pagó el cliente) y el desglose
`subtotal`, `shipping`, `service_fee`, `total` — que suma igual que la
cotización. El detalle, con la línea de tiempo de sus estados:
`GET /api/v1/pedidos/{id}`. Un pedido de otro teléfono responde `404`, igual que
uno que no existe.
