# DEPLOY — BotPanel en Railway

Guía para pasar de local (túnel Cloudflare) a producción 24/7 en **Railway** con dominio propio. La base de datos ya está en Supabase: Railway no la migra automáticamente y deben verificarse las migraciones pendientes antes del deploy.

---

## 1. Antes de empezar

- Cuenta en [Railway](https://railway.com) (conecta tu GitHub `YoverMarkt/umbani`).
- Un dominio (Namecheap, GoDaddy, Cloudflare, etc.).
- Tener a mano las credenciales de Supabase y del superadmin.

---

## 2. Crear el servicio en Railway

1. **New Project → Deploy from GitHub repo →** elige `YoverMarkt/umbani`, rama `main`.
2. **Settings → Root Directory:** deja **vacío** (raíz).
   - La raíz contiene los cuatro workspaces y un solo `package-lock.json`.
3. `railway.json` fija Railpack con **Build Command:** `npm run build` y **Start Command:** `node server/dist/index.js`. La configuración del repositorio prevalece sobre el dashboard y genera el servidor y ambos paneles.

---

## 3. Variables de entorno (Railway → Variables)

**Críticas (sin estas el login/panel NO funciona):**

| Variable | Valor |
|---|---|
| `SUPABASE_URL` | `https://xxxx.supabase.co` |
| `SUPABASE_KEY` | anon / publishable |
| `SUPABASE_SERVICE_KEY` | service_role (secreta, solo servidor) |
| `JWT_SECRET` | secreto aleatorio de 32+ caracteres (ver abajo) |
| `ADMIN_EMAIL` | tu correo de superadmin |
| `ADMIN_PASSWORD` | contraseña de superadmin de 12+ caracteres |
| `NODE_ENV` | `production` |

**Producción (obligatorias):**

| Variable | Valor |
|---|---|
| `BASE_URL` | tu dominio final, sin `/` al final (ej. `https://tubot.com`). **Desactiva el túnel local.** |
| `PORT` | **NO la pongas** — Railway la inyecta sola |
| `HEALTH_DETAIL_TOKEN` | Token del vigía externo, 32+ caracteres aleatorios. Tiene que valer **lo mismo** que el secret `HEALTH_DETAIL_TOKEN` del repositorio en GitHub. Sin él, `/api/health/detalle` responde 404 y el vigía pierde de vista el saldo y las credenciales |

**Pago con tarjeta (PayPhone), opcional:** `PAYPHONE_TOKEN` (PayPhone Developer → tu aplicación → Credenciales → «Token para <RUC>») y `PAYPHONE_MODO` (`pruebas` o `produccion`, **igual que el interruptor de la aplicación en PayPhone**, que es el que decide si se cobra de verdad). `PAYPHONE_STORE_ID` es opcional: sin él PayPhone usa la tienda del token, y el «Identificador» de Credenciales NO es el Store ID (error 100). Van SOLO en Railway, nunca en el panel: el token decide a qué cuenta entra el dinero. Sin token o con otro modo, la tarjeta no aparece en ningún local. En `pruebas` PayPhone aprueba todo sin cobrar, por eso la tarjeta solo se ofrece en los locales que el superadmin marcó «Pruebas». La «Url de respuesta» registrada en PayPhone es `<BASE_URL>/pagos/payphone/retorno`.

**Si usas YCloud:** guarda el Endpoint ID y el signing secret oficial en cada negocio. `YCLOUD_WEBHOOK_ENDPOINT_ID` + `YCLOUD_WEBHOOK_SECRET` quedan disponibles juntos solo como fallback global opcional para una cuenta compartida. **Si usas Meta:** configura también `META_VERIFY_TOKEN` (handshake) y `META_APP_SECRET` (firma HMAC); el backend usa Graph API `v25.0` y admite `META_GRAPH_API_VERSION` para una actualización futura controlada. **Si usas Telegram:** configura `TELEGRAM_BOT_TOKEN` y `TELEGRAM_WEBHOOK_SECRET` (aleatorio, 32+ caracteres). Las keys de IA normalmente se cargan desde el panel admin.

**Generar un `JWT_SECRET` seguro:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```
> ⚠️ Si cambias `JWT_SECRET` después, todos los usuarios tendrán que volver a iniciar sesión (los tokens viejos dejan de valer).

El servidor valida estas variables antes de abrir el puerto. Una variable faltante, un secreto débil o una `BASE_URL` insegura detiene el despliegue; con todo correcto verás `✅ Variables de entorno críticas: OK`.

---

## 4. Primer deploy y verificación

1. Railway despliega solo al hacer push a `main`.
2. Abre la URL temporal de Railway (`https://xxx.up.railway.app`):
   - `/` → redirige a `/app-admin` (login superadmin).
   - `/app` → login de negocios.
3. En los logs debe aparecer `🚀 BotPanel corriendo…` y NO debe intentar túnel (porque `BASE_URL` está puesta).
4. Abre `/api/health`: debe responder `200`, con `webhook_inbox.ready: true` y una fecha en `last_database_success_at`. Un `503` indica que el worker todavía no pudo acceder a las RPC del inbox (por ejemplo, si falta la última migración).

---

## 5. Dominio propio

1. Compra el dominio.
2. Railway → tu servicio → **Settings → Networking → Custom Domain →** agrega `tubot.com` (o `app.tubot.com`).
3. Railway te da un registro **CNAME**; ponlo en el DNS de tu proveedor.
4. Espera la propagación (minutos a horas). Railway emite el HTTPS solo.
5. Actualiza la variable `BASE_URL` a tu dominio final y **redeploy**.

---

## 6. Webhooks (WhatsApp / Meta)

La URL del webhook cambia a tu dominio fijo (ya no cambia en cada reinicio 🎉).

- **YCloud:** crea el endpoint `https://tubot.com/webhook/ycloud`. Copia su Endpoint ID y signing secret al negocio correspondiente en el panel. YCloud envía `X-Webhook-Endpoint-ID` y `YCloud-Signature`; el servidor valida ambos y rechaza firmas alteradas o antiguas. No agregues secretos a la URL.
- **Meta:** `https://tubot.com/webhook`; usa `META_VERIFY_TOKEN` para el handshake y `META_APP_SECRET` para verificar cada firma.
- **Telegram:** con `BASE_URL`, `TELEGRAM_BOT_TOKEN` y `TELEGRAM_WEBHOOK_SECRET`, el bot registra un webhook que valida la cabecera secreta oficial de Telegram.
- **Cobros al cliente:** se coordinan manualmente fuera de la plataforma.

> El panel del superadmin (Conexiones) muestra la URL limpia del webhook. Los secretos se guardan en los campos protegidos de cada negocio, no en la URL.

---

## 7. Checklist final antes de vender

- [ ] Deploy verde en Railway, logs con `✅ Variables… OK`.
- [ ] `/api/health` responde `200` y confirma `webhook_inbox.ready: true`.
- [ ] `/app-admin` y `/app` cargan por el dominio propio (HTTPS).
- [ ] Login superadmin y login de un negocio funcionan.
- [ ] Webhook de WhatsApp apuntando al dominio (probar un mensaje real).
- [ ] Peticiones sin secreto/firma reciben `401` en webhooks.
- [ ] El webhook Telegram rechaza peticiones sin `X-Telegram-Bot-Api-Secret-Token` válido.
- [ ] Un negocio de prueba con productos + prompt + horario (usa el **checklist de onboarding** del panel).
- [ ] Números/keys de WhatsApp de cada negocio cargados desde el panel admin.
- [ ] Cada negocio YCloud tiene su Endpoint ID y signing secret guardados, y una prueba real recibe `YCloud-Signature` válida.
- [ ] En una base nueva se aplicó `schema.sql` una sola vez; en una base existente **no se usó como upgrade**.
- [ ] `migration-preparacion-produccion.sql` aplicada antes de las migraciones nuevas.
- [ ] `migration-modo-menu.sql` aplicada (crea `chat_mode` y el modo `menu`, que sigue vivo).
- [ ] `migration-2026-08-19-miniapp-exige-tienda.sql` aplicada: el modo mini app deja de poder encenderse sin pedidos ni tienda.
- [ ] `migration-modificadores-menu.sql` aplicada después de la anterior y con RLS/permisos cerrados.
- [ ] `migration-eliminar-kapso-retell.sql` aplicada antes de `migration-identificadores-canales.sql`.
- [ ] `migration-firmas-webhooks.sql` aplicada después de identificadores y antes del despliegue.
- [ ] `migration-inbox-webhooks.sql` aplicada después de firmas y antes de habilitar el worker.
- [ ] `migration-agrupado-webhooks.sql` aplicada después del inbox; en una actualización activa, después de retirar la réplica anterior.
- [ ] `migration-2026-08-20-negocio-sin-canal-propio.sql` aplicada **después** de `migration-identificadores-canales.sql` y de `migration-2026-08-19-miniapp-exige-tienda.sql`: recrea las funciones de esas dos, así que aplicadas al revés la sobrescribirían y volvería a exigirse número al dar de alta.
- [ ] `migration-2026-08-20-conversacion-del-marketplace.sql` aplicada: solo AÑADE una tabla, un disparador y una función nuevas; no depende de ninguna otra migración y ninguna la sobrescribe.
- [ ] `migration-2026-08-21-categorias-del-marketplace.sql` aplicada: solo AÑADE dos tablas de catálogo y dos funciones de lectura; no depende de ninguna otra.
- [ ] `migration-2026-08-21-marketplace-busqueda.sql` aplicada **después** de las categorías (sus alias apuntan a ellas). Crea `pg_trgm` y `unaccent` en el esquema `extensions`.
- [ ] `migration-2026-08-21-outbox-de-avisos.sql` aplicada: solo AÑADE la cola de avisos y sus cuatro funciones. Alerta de logs para `status = 'dead'` en `outbox_events`: son avisos que no llegaron al cliente.
- [ ] `migration-2026-08-21-retirar-el-modo-ia.sql` aplicada **después del código**: convierte a `menu` los negocios en `ai` y estrecha el CHECK. El código nuevo ya no sabe atender `ai`, así que aplicarla antes dejaría una ventana en la que un negocio en ese modo no recibe respuesta.
- [ ] `migration-2026-08-21-mensaje-de-bienvenida.sql` aplicada **después** de retirar la IA. Convierte los prompts en saludos y suelta `bot_prompt`/`bot_instructions`: **repasa el saludo de cada negocio en el panel** — lo que no dio un saludo extraíble quedó en el de por defecto.
- [ ] **ENSAYO antes de aplicar nada:** `bash server/tests/sql/ensayo-de-migraciones.sh <commit-vivo> server/migration-AAAA-MM-DD-*.sql`. El CI aplica `schema.sql` sobre una base vacía y NUNCA reproduce la cadena, así que sale verde sobre una ficción. Este ensayo parte del esquema que hay aplicado hoy y corre lo pendiente **en el orden alfabético real del ejecutor** — que ya ha roto dos veces: `retirar-citas` antes que `retirar-hospedaje` (2026-08-20) y `busqueda-del-marketplace` antes que `categorias-del-marketplace` (2026-08-21).
- [ ] Alerta de logs configurada para `Inbox webhook [dead:`; esos eventos requieren revisión antes de que venza su retención de 7 días.
- [ ] Cobro manual verificado; el bot no envía enlaces automáticamente.

Para actualizar una instancia que ya está atendiendo webhooks, despliega primero
el runtime compatible, espera que Railway retire la réplica anterior y aplica
después `migration-agrupado-webhooks.sql`. En una instalación nueva, ejecuta
todas las migraciones antes de habilitar el worker.

---

## Notas

- **Supabase** ya es tu base 24/7 (Railway no migra nada al deploy). Ejecuta solo
  las migraciones pendientes y respeta este orden final:
  `preparacion-produccion` → `modo-menu` → `modificadores-menu` →
  `eliminar-kapso-retell` → `identificadores-canales` → `firmas-webhooks` →
  `inbox-webhooks`.
- **No reejecutes `migration-eliminar-kapso-retell.sql`** sobre una base que ya
  completó identificadores, firmas e inbox. Es destructiva y puede reinstalar
  contratos transitorios reemplazados después.
- **No ejecutes `schema.sql` como upgrade** de una base existente; se reserva
  para una base nueva y vacía.
- Los errores HTTP se aíslan por petición. Ante un error fatal, el proceso cierra ordenadamente para que Railway lo reinicie en un estado limpio.
- `trust proxy` está activado para que el rate-limit funcione detrás del proxy de Railway.
