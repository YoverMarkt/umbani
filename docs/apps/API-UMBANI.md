# La API de Umbani para las apps

Base: `https://web-production-3433c.up.railway.app` (producción). Para
desarrollar, un servidor de pruebas (staging) cuando esté listo — **nunca**
desarrolles contra producción.

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

El teléfono lo prueba WhatsApp (es el remitente del mensaje), no el cliente
escribiendo un número.

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
| `401` | Sesión vencida: pide otra (de app o de tienda). |
| `403` + `reason: "bloqueado"` | El cliente está bloqueado: enseña el texto, sin reintentar. |
| `409` | El local está cerrado, no recibe pedidos o el pedido ya no se puede pagar. |
| `429` | Demasiadas peticiones: espera unos segundos. |

## 3. El dinero

- Todo importe llega **en dólares con dos decimales** desde el servidor. La app
  no suma, no redondea y no aplica porcentajes.
- Antes de confirmar, `POST /api/store/{slug}/quote` devuelve el desglose
  oficial: `subtotal`, `shipping`, `serviceFee` (tarifa de servicio), `total`.
  Enseña esas líneas tal cual.
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
