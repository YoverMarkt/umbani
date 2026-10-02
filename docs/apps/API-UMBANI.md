# La API de Umbani para las apps

| Servidor | Base | Para qué |
|---|---|---|
| **PRUEBAS** | `https://umbani-pruebas.up.railway.app` | **Aquí se desarrolla.** Datos de mentira: la pizzería de prueba (`demo`). |
| Producción | `https://web-production-3433c.up.railway.app` | Clientes reales. **Nunca** se desarrolla contra ella. |

El de pruebas lleva abajo a la izquierda la franja «STAGING · datos de mentira».
No tiene número de WhatsApp de verdad: mira §1a para iniciar sesión ahí.

## 1. La sesión, en dos niveles

**a) La sesión de la app (quién es el cliente).** Se inicia con WhatsApp, sin
contraseña ni SMS:

1. `POST /api/v1/auth/whatsapp` → `{ codigo, enlace, expiraEn }`.
2. La app enseña el código y un botón que abre `enlace` (WhatsApp con el
   mensaje «Mi código de Umbani: XXXXXX» ya escrito hacia el número de Umbani).
   El cliente solo toca **enviar**.
3. Mientras tanto, la app pregunta cada 2–3 s `POST /api/v1/auth/whatsapp/verificar`
   con `{ codigo }`:
   - `202 { pendiente: true }` → todavía no llegó el mensaje, sigue esperando.
   - `200 { token, telefono }` → listo. Guarda `token` de forma segura.
   - `410` → el código venció (10 minutos): pide otro.
4. En adelante: `Authorization: Bearer <token>` en las rutas `/api/v1/*`. Dura
   30 días; con `401`, vuelve al paso 1.

⚠️ **El cliente puede cerrar la sesión desde WhatsApp** (2026-09-29): el mensaje
de «iniciaste sesión» le dice que escriba **CERRAR SESIÓN** si no fue él —la
estafa de «mándame el código que te llegó»—. Desde ese momento TODAS las
sesiones de la app de su número responden `401` con
`«Tu sesión se cerró desde WhatsApp. Inicia sesión otra vez.»`: enseña ese
texto y vuelve al paso 1. Se cierran también sus sesiones de tienda (como con
MENÚ), salvo la del local donde un pedido espera su pago. Un `503` en
cualquier ruta autenticada quiere decir que no se pudo comprobar la sesión:
reintenta en unos segundos, no la borres.

El teléfono lo prueba WhatsApp (es el remitente del mensaje), no el cliente
escribiendo un número.

🧪 **En PRUEBAS no hay WhatsApp de verdad.** El paso 2 se hace a mano: entra al
superadmin de pruebas (`https://umbani-pruebas.up.railway.app/app-admin`, la
cuenta te la da el dueño) → **Simulador** → escribe `Mi código de Umbani: XXXXXX`
con el código que enseña la app. El simulador es el teléfono `000000000000`:
con él inicias sesión como cliente de prueba (y como repartidor de prueba, que
tiene ese mismo número).

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
| `401` | Sesión vencida o cerrada desde WhatsApp: enseña el texto y pide otra (de app o de tienda). |
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

## 5. «Mis pedidos»

`GET /api/v1/pedidos` (con la sesión de la **app**, no la de tienda) devuelve
los pedidos de ese teléfono en **todos** los locales, los 30 más recientes:
`{ pedidos: [...] }`. Cada uno trae `local: { nombre, slug }`, su `status`, sus
líneas (`order_items[].line_total`, lo que pagó el cliente) y el desglose
`subtotal`, `shipping`, `service_fee`, `total` — que suma igual que la
cotización. El detalle, con la línea de tiempo de sus estados:
`GET /api/v1/pedidos/{id}`. Un pedido de otro teléfono responde `404`, igual que
uno que no existe.
