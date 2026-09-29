# Dónde conseguir cada credencial

---

## SUPABASE_URL y SUPABASE_KEY
1. supabase.com → New project
2. Settings → API:
   - "Project URL"  → SUPABASE_URL
   - "anon public"  → SUPABASE_KEY

---

## JWT_SECRET
Lo inventas tú (mínimo 32 caracteres).
Ejemplo: `botpanel2024_mi_clave_secreta_abc123xyz`

---

## ADMIN_EMAIL y ADMIN_PASSWORD
Tus credenciales para entrar a /admin. Los inventas tú.

Desde el 2026-09-29 no bastan: el superadmin pide además el código de 6 dígitos de una **app de códigos** (Google Authenticator o similar), que se configura la primera vez que entras. Su clave NO es una variable de entorno: vive en la base, separada de la contraseña, para que quien se lleve una sola de las dos no entre. Si pierdes el móvil: `npm run admin:reiniciar-codigos -w @botpanel/server -- --borrar`, y configúrala de nuevo en seguida.

---

## ANTHROPIC_API_KEY
1. console.anthropic.com → API Keys → Create Key
2. Empieza con `sk-ant-api03-...`

---

## YCLOUD_API_KEY (proveedor principal WhatsApp)
YCloud es partner oficial de Meta — más fácil que Meta directo.

1. Crea cuenta en **ycloud.com**
2. Dashboard → Settings → API Keys → Create API Key
3. Copia la key (empieza con `yc_live_...`)
4. En el dashboard también registra tu número de WhatsApp Business
5. Configura el Webhook URL en YCloud → Webhook → Add Endpoint:
   - URL: `https://TU_DOMINIO/webhook/ycloud`
   - Eventos: `whatsapp.inbound_message.received`
   - Copia el **Endpoint ID** y el **signing secret** del endpoint
   - YCloud incluirá `X-Webhook-Endpoint-ID` y `YCloud-Signature` en cada solicitud

**Por negocio en el admin (campos YCloud):**
- `YCloud API Key`: la misma key o una por workspace
- `YCloud Phone Number`: el número de WhatsApp del negocio (ej: `+593991234567`)
- `YCloud Webhook Endpoint ID`: el ID exacto del endpoint creado para ese negocio
- `YCloud Webhook Signing Secret`: el secreto oficial del endpoint; se guarda protegido y no forma parte de la URL

`YCLOUD_WEBHOOK_ENDPOINT_ID` y `YCLOUD_WEBHOOK_SECRET` pueden configurarse juntos en el servidor como fallback global opcional, pero los valores propios por negocio tienen prioridad y evitan compartir una credencial entre clientes.

---

## META_TOKEN y META_PHONE_ID (por negocio)
Solo si algún cliente tiene Meta Business directo.

1. developers.facebook.com → tu App → WhatsApp → API Setup
2. Webhook URL: `https://TU_DOMINIO/webhook`

`META_VERIFY_TOKEN` y `META_APP_SECRET` son globales para la aplicación Meta y se configuran en el entorno del servidor, no dentro de cada negocio. El backend usa Graph API `v25.0`; `META_GRAPH_API_VERSION` permite cambiarla de forma explícita cuando Meta publique y se valide una migración posterior.

---

## TELEGRAM_BOT_TOKEN (para pruebas)
1. Abre Telegram y escribe a **@BotFather**
2. Envía `/newbot`
3. Elige nombre y username para el bot
4. BotFather te da el token: `1234567890:ABCxxxxxxxxxxxxxxxxx`
5. Pégalo en el .env como `TELEGRAM_BOT_TOKEN`

**Cómo usar para pruebas:**
- El bot arranca automáticamente con el servidor
- Escríbele a tu bot en Telegram
- Envía `/start` para ver la lista de negocios
- Envía `/start [slug-del-negocio]` para conectarte a uno específico
- El bot responde con la misma IA que WhatsApp

---

## CAL.COM (reservas / citas)
Cal.com permite que el bot envíe **enlaces de reserva** al cliente.

1. Crea cuenta en **cal.com**
2. Crea un "Event Type" (ej: "Consulta — 30 minutos")
3. Tu enlace de reserva quedará así: `https://cal.com/tu-usuario/consulta`
4. En el admin, al crear/editar un negocio, pega ese enlace en el campo **Cal.com**
5. El bot detecta automáticamente si el cliente quiere agendar y envía el enlace

**Negocios que activan el calendario automáticamente:**
Barbería, peluquería, spa, clínica, consultorio, odontología, psicología, gym, restaurante (con reserva)

**Negocios sin calendario:** Perfumería, tienda de ropa, farmacia, etc.

---

## Resumen de webhooks por proveedor

| Proveedor | URL del webhook |
|-----------|----------------|
| YCloud    | `/webhook/ycloud` |
| Meta      | `/webhook` |
| Telegram  | Automático (polling) |

---

## Ejemplo de .env completo

```
SUPABASE_URL=https://abcdefghij.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxx
JWT_SECRET=botpanel2024_secreto_muy_largo_abc123xyz
ADMIN_EMAIL=genesis@mibotpanel.com
ADMIN_PASSWORD=MiPassword2024Seguro
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxx
YCLOUD_API_KEY=yc_live_xxxxxxxxxxxxxxxxx
YCLOUD_WEBHOOK_ENDPOINT_ID=
YCLOUD_WEBHOOK_SECRET=                 # fallback global opcional
META_TOKEN=
META_PHONE_ID=
META_VERIFY_TOKEN=
TELEGRAM_BOT_TOKEN=1234567890:ABCxxxxxxxxxxxxxxxxx
PORT=3000
```
