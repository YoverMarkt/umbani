# CLAUDE.md — BotPanel SaaS

Guía obligatoria para trabajar en este proyecto sin romper la arquitectura ni el trabajo existente. Léela completa antes de actuar.

**Este archivo es lo que hay que tener en la cabeza SIEMPRE.** Lo demás vive
aparte y se consulta cuando la tarea lo toca — así esta guía se puede leer
entera de verdad, que era el problema cuando todo estaba junto:

| Documento | Cuándo leerlo |
|---|---|
| **[DECISIONES.md](DECISIONES.md)** | **Antes de tocar CUALQUIER pieza con historia** — la tienda, los comprobantes, el marketplace, los frenos de abuso, el motor de opciones, la salud del canal… Desde el 2026-08-25 vive aquí también el razonamiento de las 62 piezas que antes estaba en la sección 7 de este archivo. Casi cada apartado existe porque algo falló: lo que parece complejidad de más suele ser una cicatriz. |
| **[VERIFICACION.md](VERIFICACION.md)** | Antes de tocar el CI, el esquema, las migraciones o las dos capas que vigilan producción (el vigía externo y el respaldo diario). Qué comprueba cada capa, qué **no**, y de qué incidente nació. |
| **[PENDIENTE.md](PENDIENTE.md)** | Cuando surja "¿y si añadimos…?". Lista de módulos futuros y de decisiones de **no** construir todavía. |
| **[ARQUITECTURA.md](ARQUITECTURA.md)** | Antes de crear archivos o features nuevas. |
| **[DISENO-MINIAPP.md](DISENO-MINIAPP.md)** | Antes de tocar la apariencia de la tienda. Es el respaldo escrito del diagrama aprobado: estructura de las once pantallas, los tres selectores y qué NO se copia. La imagen manda si la tienes; esto existe para que la referencia no se pierda entre sesiones. |

---

## AL INICIAR CUALQUIER TAREA (flujo obligatorio)

1. **ORIENTARTE** — Ten presente estas reglas y el **MAPA DE SKILLS** (sección 9). Identifica qué skills aplican al pedido y consúltalas ANTES de actuar.
2. **ACOTAR** — Reformula en una frase qué se va a cambiar y qué **NO** se va a tocar. Si el pedido es ambiguo, **pregunta antes de asumir**.
3. **PROTEGER** — Si el cambio toca base de datos, RLS, auth, etiquetas/tools del bot o multi-tenancy → consulta **arquitecto-saas** (y **base-de-datos** / **seguridad-saas** si corresponde) antes de seguir.
4. **PLAN** — Propón un plan breve (qué archivos se tocan y cómo) y **espera aprobación del usuario**. No escribas código hasta que el plan sea aprobado.
5. **CAMBIO MÍNIMO** — Haz el cambio más pequeño que cumpla el pedido. No reescribas archivos enteros ni borres funciones, campos, endpoints o validaciones que no se pidieron.
   - Si el cambio **corta un flujo** (un modo nuevo, un atajo, un `return` temprano): antes de escribirlo, lista **qué HACÍA de paso** el camino que saltas — marcar leído, guardar el mensaje, actualizar la sesión, registrar consumo, liberar un lock. Conserva todo lo que no sea "pensar", y añade una prueba por cada efecto que conservas. Ver **cambios-seguros**. Así se perdió el check azul el 2026-08-03: nueve pruebas en verde comprobando lo nuevo, y nadie miró lo que dejó de ocurrir.
6. **VERIFICAR** — Corre las verificaciones según **tester-saas** (carga de módulos, sintaxis, arranque, smoke test).
   - **Si el cambio se ve en pantalla (mini app o paneles), pasa por STAGING antes de producción.** `npm run staging:actualizar` y que el dueño lo mire en el móvil. Decidido el 2026-09-19 tras tres arreglos seguidos de la tienda que fueron directos a producción: el `+` mudo, las dos cuentas y los nombres cortados. Ninguno era un error que salte —el CI estuvo verde en los tres— y los tres los encontró el dueño con clientes pudiendo entrar. Ver [VERIFICACION.md](VERIFICACION.md#cómo-se-trabaja-con-él-decidido-2026-09-19).
   - Si el cambio abre una **rama nueva** de comportamiento (un modo, una configuración, un camino de entrada), aplica además **camino-real**: demuestra que la configuración REAL de producción llega hasta el código nuevo, y qué corre ANTES que podría ganarle. Cinco veces en este proyecto el CI estuvo verde sobre código al que nadie llegaba.
7. **REPORTAR** — Di qué archivos cambiaron, qué se verificó y qué **NO** se tocó.

> Ante la duda, para y pregunta. Es preferible una pregunta de más que romper algo que ya funcionaba.

---

## 1. QUÉ ES EL PROYECTO

> 📐 **Arquitectura objetivo y plan de migración:** ver **`ARQUITECTURA.md`** (decidido 2026-07-06: migración GRADUAL a monorepo con server ordenado en routes/services + paneles en React+Vite+TS; patrón estrangulador, nunca big-bang; regla: todo lo NUEVO nace en la estructura nueva). Leerlo antes de crear archivos o features nuevas.

**BotPanel** es un SaaS **multi-empresa** que ofrece bots de atención al cliente con IA en **WhatsApp y Telegram**. Sirve a negocios de comida y retail que reparten a domicilio: cada negocio tiene su propio bot (prompt, catálogo, horarios), su mini app, su panel de cliente, y un panel de administración central (el dueño del SaaS) gestiona todos los negocios, sus credenciales y la facturación. El bot responde texto, voz e imágenes, vende, y deriva a un humano cuando hace falta.

---

## 2. STACK OFICIAL (no se cambia sin pedido explícito)

> 🧾 **La lista de dependencias con sus versiones se retiró el 2026-08-29.**
> `package.json` la dice entera y siempre al día, mientras que una copia aquí
> envejece en silencio. Lo que NO dice el manifiesto —y por eso se queda— es
> la regla: **este stack está cerrado.** Node ≥ 22 + Express, Supabase con
> pgvector, JWT + bcrypt, WhatsApp por YCloud y Meta, Telegram por telegraf,
> React + Vite + TypeScript + Tailwind + shadcn/ui. Cambiar cualquiera de esas
> piezas —o añadir una sexta librería para algo que ya resuelve una de ellas—
> necesita **pedido explícito del dueño**, no la conveniencia de una tarea.

---

## 3. ESTRUCTURA DEL PROYECTO

> 🗂️ **El árbol de directorios y el índice de las 110 migraciones se retiraron
> de aquí el 2026-08-25.** Eran 165 líneas que un `ls` reconstruye en un
> segundo, y cada `.sql` ya lleva dentro su propia cabecera explicando qué
> hace y por qué — que es donde de verdad se lee. Costaban ~4.300 tokens en
> CADA sesión para decir lo que el repositorio dice solo.
>
> · Backend: `server/src/` (`db/` repositorios · `services/` lógica ·
>   `routes/` endpoints · `integrations/` proveedores externos).
> · Paneles: `apps/admin` (superadmin) · `apps/client` (dueño) ·
>   `apps/store` (mini app, más las apps web `/u` y `/r`) ·
>   `apps/cooperativa` (cooperativas de reparto, en `/cooperativa`) ·
>   `packages/ui` (shadcn compartido).
> · Apps móviles (Flutter, 2026-10-01): `mobile/cliente` y `mobile/motorizado`.
>   Solo consumen la API (`docs/apps/`); sus reglas, en `mobile/CLAUDE.md`.
> · Migraciones: `server/migration-*.sql`, en orden por fecha. `schema.sql`
>   es el consolidado vivo y **toda tabla o función nueva tiene que llegar
>   ahí** (lo vigila `verify:drift`).
>
> ⚠️ **Tres migraciones del canal se aplican EN ESTE ORDEN y no en otro**, que
> es lo único de la estructura que no se deduce mirando el repositorio:
> `migration-firmas-webhooks.sql` → `migration-inbox-webhooks.sql` →
> `migration-agrupado-webhooks.sql`. Cada una construye sobre la anterior, y
> aplicarlas al revés deja el canal a medias. Hay guardianes que comprueban
> que este orden siga escrito aquí, en el README, en PASOS-INSTALACION.md y
> en DEPLOY.md — si borras estas líneas, fallan.

- **La llave de tenant es `business_id`** (en código, `req.user.businessId`). Cuando estas reglas digan "client_id", en este proyecto es **`business_id`**.

## 4. REGLAS INVIOLABLES

1. **Aislamiento multi-tenant:** TODA consulta de datos de un negocio se filtra por **`business_id`**. En endpoints de cliente, el `business_id` SIEMPRE sale del JWT (`req.user.businessId`), **nunca** de un parámetro que el cliente pueda manipular. Toda tabla nueva nace con columna `business_id` + RLS. **Nunca** se desactiva ni se debilita una política RLS.
2. **Service role key solo en el servidor.** `SUPABASE_SERVICE_KEY` jamás se expone al frontend ni se envía a `admin/` o `client/`. El frontend nunca habla directo con Supabase.
3. **Nunca hardcodear secretos ni claves.** Usa variables de entorno o la tabla `server_settings` mediante `server/src/services/settings.ts`. Las keys de IA y de WhatsApp por cliente se guardan en BD, no en código.
4. **No reescribir archivos completos por cambios pequeños.** No borrar funciones, campos, endpoints ni validaciones que no se pidió tocar. Edición quirúrgica.
5. **Las etiquetas/tools del bot siempre operan sobre el `business_id` de la conversación.** El bot resuelve el negocio por el canal (slug de Telegram o número de WhatsApp) y SOLO usa datos de ese negocio (catálogo, horarios, políticas, historial).
6. **Cobro manual, salvo la TARJETA.** Efectivo y transferencia se cobran fuera de la plataforma, como siempre. **Desde el 2026-09-27 la tarjeta se cobra por PayPhone en la cuenta de Umbani** (decisión del dueño): el monto sale de `orders.total` en la base, se confirma en el servidor (nunca en el teléfono) y solo se da por pagado si cuadra AL CENTAVO (`settle_card_payment`). Las credenciales viven SOLO en variables de Railway. Ver [DECISIONES.md](DECISIONES.md#el-pago-con-tarjeta-entra-en-la-cuenta-de-umbani).
7. **El bot nunca inventa datos.** Precios, productos y horarios salen solo de los datos del negocio inyectados en el prompt.
8. **El CÓDIGO calcula (núcleo de dinero).** Ningún monto que vea el cliente se redacta: totales, precios y márgenes se calculan SOLO server-side. Desde el 2026-09-16 el núcleo vive **en PostgreSQL**: `create_storefront_order` cierra el pedido revalidando negocio, producto, stock y precio en la misma transacción, `order_markup_by_line` aplica el margen y `quoteCart` (`services/storefront.ts`) cotiza **en centavos enteros** replicando esa misma regla. Los descuentos, si algún día existen, serán regla de código/panel.
   - ⚠️ **`server/src/services/money.ts` se retiró el 2026-09-16**, y es un cambio de puntero, no de principio: calculaba el total del pedido **por chat**, y desde que todo local pide por su mini app ese camino no tiene puerta. Se fue con el modo menú, su único llamador (vía `bot-actions.ts`). Hay **una sola puerta** para crear un pedido y la vigila `las-defensas-son-para-todos.test.js`.

> 🔍 **Las capas de verificación (qué comprueba cada una, qué NO, y de qué incidente nació) están en [VERIFICACION.md](VERIFICACION.md).** Léelo antes de tocar el CI, el esquema o las migraciones.

> ⚠️ **«Desplegado» solo se dice después de `verify:deploy`.** El 2026-08-29
> cuatro despliegues se quedaron colgados en Railway y producción sirvió el
> código de la mañana durante horas — con un arreglo de DINERO entre lo que se
> creía en vivo, que el dueño descubrió probando la app. Engañó que
> `gh api deployments` los listaba: esa API devuelve el último despliegue
> **pedido**, no el que corre. Ahora `/api/health` informa del commit vivo y
> `npm run verify:deploy -w @botpanel/server -- <url>` lo compara con `HEAD`.
> **Comprobar que EXISTE un despliegue no es comprobar que su código CORRE.**


## 5. COMANDOS DEL PROYECTO

Los scripts están en `package.json` (raíz y cada workspace); `npm run check`
es el que corre todo. Lo que el manifiesto NO dice:

- Los workspaces son `@botpanel/server`, `@botpanel/client`, `@botpanel/admin`,
  `@botpanel/store`, `@botpanel/cooperativa` y `@botpanel/ui`. **Un solo lockfile y un solo `npm install`**
  para todo el monorepo.
- El servidor en local levanta un **túnel Cloudflare automático**; en producción
  la URL pública sale de `BASE_URL`.
- El CI corre lint, tipos, tests y builds **en cada PR** (siete checks). El
  séptimo son los **recorridos de punta a punta**: servidor de verdad contra
  Supabase de verdad, pedido entero con el dinero al centavo
  (`npm run test:recorridos -w @botpanel/server`; en local necesita
  `npm run staging:up` y ⚠️ vacía el staging). Ver
  [VERIFICACION.md](VERIFICACION.md#los-recorridos-de-punta-a-punta-2026-10-01).
- `npm run test:e2e` necesita Chromium: la primera vez, `npm run test:e2e:install`.
- **Staging local:** `npm run staging:up` levanta el stack de Supabase en Docker
  y siembra; `npm run dev:staging -w @botpanel/server` arranca el servidor
  contra él.
- **Staging en internet** (2026-10-01): proyecto de Railway APARTE + Supabase
  gratis. `npm run staging:subir` despliega la rama en revisión. 🔐 Un servidor
  con `UMBANI_ENTORNO=staging` NO arranca si su base no lleva la marca de
  staging, y producción no arranca si la lleva. Ver
  [VERIFICACION.md](VERIFICACION.md#el-staging-en-internet-y-el-candado-de-la-base-2026-10-01). ⚠️ **`server/.env` apunta a PRODUCCIÓN**, así que arrancar en local
  sin más procesaría mensajes reales y a los 30 s cancelaría pedidos de
  clientes: `config/tareas-de-fondo.ts` lo impide y lo avisa al arrancar.

## 6. CONVENCIONES DE CÓDIGO

- **Todo el acceso a Supabase pasa por `server/src/db/`** — no consultes `sb.from(...)` desde rutas, servicios o `src/index.ts`; agrega/usa una función en el repositorio correspondiente y expórtala desde `src/db/index.ts`.
- **Las keys de IA se leen siempre mediante `server/src/services/ai.ts` y `settings.get('...')`** (panel > .env).
- **Comentarios y logs en español.** Emojis en logs siguiendo el estilo existente (`✅ ❌ 🤖 📡 🛒 🤚 🔔`).
- **Textos de cara al cliente (bot y paneles) en español** neutro (mercado Ecuador/Colombia).
- **Los símbolos (✓ ✗ + −) se pintan como ICONO, nunca como carácter en el texto** — con el carácter se alinea la caja de línea de la fuente y el símbolo queda alto. Vale para las tres apps y lo vigila `iconos-guardian.test.js`. Ver [DISENO-MINIAPP.md](DISENO-MINIAPP.md#los-símbolos-son-iconos-nunca-caracteres).
- **Ningún archivo de código pasa de 1.000 líneas** (regla del dueño, 2026-10-06). Lo vigila `archivos-grandes-guardian.test.js` como trinquete: los que ya pasaban solo pueden encoger, y para tocar uno primero se parte por responsabilidades. Ver [DECISIONES.md](DECISIONES.md#ningún-archivo-pasa-de-1000-líneas).
- **Telegram (`server/src/integrations/telegram.ts`):** el negocio se selecciona/restaura por `slug`; la restauración consulta únicamente el `business_id` más reciente de `tg_<chatId>` mediante la capa `src/db` y luego valida que el negocio siga activo. La integración no crea clientes Supabase propios. Texto, voz y fotos entregan siempre `{ channel:'telegram', ctx, slug }` a `bot-entry.ts`.
- **Dinero (`create_storefront_order` + `order_markup_by_line` en la base, `quoteCart` en `services/storefront.ts`):** la RPC calcula el importe oficial revalidando negocio, producto, stock y precio en una sola transacción; el margen se aplica por línea y todo se computa en **centavos enteros** (JavaScript en coma flotante y PostgreSQL en `numeric` no redondean igual). El flujo es manual: la plataforma registra el pedido y su entrega, pero no procesa ni registra el cobro del cliente.
- **Capacidades por negocio:** `businesses.takes_orders` es la fuente de verdad de si el bot cierra pedidos; el tipo solo la recomienda al crear y nunca sobrescribe decisiones manuales ni negocios existentes. En modo informativo se responden precios, descripciones, stock, fotos y videos; solo la intención transaccional explícita deriva y jamás crea pagos o pedidos.
- **Arranque seguro:** `server/src/config/environment.ts` valida antes de abrir el puerto las credenciales críticas, `BASE_URL`, el fallback opcional `YCLOUD_WEBHOOK_SECRET` si existe y el secreto Telegram cuando aplica. El signing secret de YCloud se guarda preferentemente por negocio y valida la cabecera `YCloud-Signature`. Producción falla cerrado en vez de publicar un healthcheck verde con configuración incompleta.
- **Contraseñas nuevas:** superadmin, dueños y empleados usan un mínimo de 12 caracteres; siempre se almacenan con bcrypt y nunca se devuelven en APIs.
- **Sesiones cliente vigentes:** `activeClientGuard` revalida cada 15 segundos como máximo que usuario y negocio sigan activos, y reemplaza rol/permisos del JWT por los valores actuales de la base. Eliminar un usuario, suspender un negocio o revocar permisos falla cerrado sin esperar siete días.
- **Túnel local (`server/src/services/tunnel.ts`):** solo se usa en desarrollo; inicia y detiene `cloudflared` mediante dependencias inyectables, expone únicamente estado serializable (`url`, `active`, `provider`, `startedAt`) y nunca filtra el proceso hijo en respuestas administrativas. En producción la URL pública sale de `BASE_URL`.
- **Grafo interno del servidor:** los módulos bajo `server/src/` se enlazan directamente entre `db`, `services`, `integrations`, `middleware` y `routes`; comandos, pruebas y Railway ejecutan el resultado compilado en `server/dist/`.
  - ⚠️ **Al borrar un módulo hay que limpiar `dist/`**: `tsc` NO borra el `.js` de un `.ts` que ya no existe, así que las pruebas —que importan del compilado— pasan en local con código retirado y el CI falla. `rm -rf server/dist && npm run build -w @botpanel/server` antes de dar por buena la batería.



> 📚 **Las decisiones de implementación se movieron a [DECISIONES.md](DECISIONES.md) el 2026-08-25.**
> Eran 92.700 caracteres —unos 23.000 tokens— cargándose en CADA sesión para
> explicar piezas que solo se tocan de una en una. **No se recortó una palabra**:
> están enteras allí. Consulta la que toque tu tarea ANTES de tocarla —
> cada una existe porque algo falló.

> Los títulos de las 93 se listan con `grep '^## ' DECISIONES.md` — se retiró
> de aquí la copia el 2026-09-03 porque costaba ~1.100 tokens en CADA sesión
> para decir lo que ese comando dice en un segundo, y el archivo ya se señala
> dos veces: en la tabla de la cabecera y en la lista de piezas de abajo.


### Piezas con razonamiento largo — léelo ANTES de tocarlas

Cada una existe porque algo falló. Lo que parece complejidad de más suele ser una cicatriz:

- **Etiquetas del bot** → [DECISIONES.md](DECISIONES.md#etiquetas-del-bot)
- **Todo local pide por su mini app (el pedido por chat, RETIRADO)** → [DECISIONES.md](DECISIONES.md#todo-local-pide-por-su-mini-app-se-retira-el-pedido-por-chat) y [el canal propio](DECISIONES.md#el-canal-propio-también-pide-por-su-mini-app)
- **Reportes del dueño** → [DECISIONES.md](DECISIONES.md#reportes-del-dueño)
- **Salud del canal** → [DECISIONES.md](DECISIONES.md#salud-del-canal)
- **La cola de mensajes y por qué no espera al sondeo** → [DECISIONES.md](DECISIONES.md#el-chat-no-espera-al-sondeo)
- **Evals del bot** → [DECISIONES.md](DECISIONES.md#evals-del-bot)
- **Vigilante de precios** → [DECISIONES.md](DECISIONES.md#vigilante-de-precios)
- **Vigilancia de credenciales** → [DECISIONES.md](DECISIONES.md#vigilancia-de-credenciales)
- **Registro de errores** → [DECISIONES.md](DECISIONES.md#registro-de-errores)
- **Mini app de la tienda** → [DECISIONES.md](DECISIONES.md#mini-app-de-la-tienda)
- **La pantalla «Bienvenida», RETIRADA (y por qué el alta se rompe si se hace al revés)** → [DECISIONES.md](DECISIONES.md#la-pantalla-bienvenida-no-la-leía-nadie)
- **El «+» de los adicionales (y por qué el precio del plato NO sube)** → [DECISIONES.md](DECISIONES.md#el--de-los-adicionales-no-acusaba-el-toque)
- **El horario del dueño manda sobre todos los modos** → [DECISIONES.md](DECISIONES.md#el-horario-del-dueño-manda-sobre-todos-los-modos)
- **La carta del local se lee de su foto (y por qué `gpt-4o` y no el mini)** → [DECISIONES.md](DECISIONES.md#la-carta-del-local-se-lee-de-su-foto)
- **Lo que gana la plataforma (motor de margen)** → [DECISIONES.md](DECISIONES.md#lo-que-gana-la-plataforma)
- **Qué pide el alta de un negocio** → [DECISIONES.md](DECISIONES.md#el-alta-no-pregunta-lo-que-se-deduce-del-tipo)
- **Verificar el número del marketplace** → [DECISIONES.md](DECISIONES.md#el-número-del-marketplace-se-verifica)
- **El alta por API y sus modos de chat** → [DECISIONES.md](DECISIONES.md#el-alta-por-api-estaba-rota-y-nadie-lo-veía)
- **El motor de opciones del catálogo** → [DECISIONES.md](DECISIONES.md#el-dueño-configura-la-mini-app-obedece)
- **Los dos botones del pago** → [DECISIONES.md](DECISIONES.md#los-dos-botones-del-pago-no-hacen-lo-mismo)
- **El pago con tarjeta (PayPhone): confirmar sin el teléfono, cuadrar al centavo, el modo pruebas** → [DECISIONES.md](DECISIONES.md#el-pago-con-tarjeta-entra-en-la-cuenta-de-umbani)
- **Las cuentas de cada uno y el cierre semanal (libro por pedido, liquidaciones, el corte del 28-sep)** → [DECISIONES.md](DECISIONES.md#las-cuentas-de-cada-uno-y-el-cierre-semanal)
- **La tarifa de servicio (dentro de la parte de Umbani, la lee la base, congelada)** → [DECISIONES.md](DECISIONES.md#la-tarifa-de-servicio)
- **Las apps Flutter: usan la API de la tienda, login con WhatsApp, el contrato vigilado** → [docs/apps/](docs/apps/README.md) y [DECISIONES.md](DECISIONES.md#la-api-de-las-apps-flutter)
- **Los motorizados (tope de efectivo, carrera retenida, su liquidación, apagado por defecto)** → [DECISIONES.md](DECISIONES.md#los-motorizados)
- **Las ciudades (Chone y Portoviejo): sin ciudad un local no aparece, falla cerrado, el motorizado reparte en la suya** → [DECISIONES.md](DECISIONES.md#las-ciudades)
- **Las cooperativas de reparto (la tercera flota, la regla del reparto en un solo sitio, el teléfono del repartidor como lo ve WhatsApp)** → [DECISIONES.md](DECISIONES.md#las-cooperativas-de-reparto)
- **Las incidencias y el «¿Llegó todo bien?» (fase 1 sin dinero; 48 h; la base calcula lo que le corresponde)** → [DECISIONES.md](DECISIONES.md#las-incidencias-y-el-llegó-todo-bien)
- **Cuánto tarda el negocio (prep_time)** → [DECISIONES.md](DECISIONES.md#cuánto-tarda-el-negocio)
- **Pedidos programados (retirados)** → [DECISIONES.md](DECISIONES.md#pedidos-programados-retirados-el-2026-08-07)
- **Cómo se suma el margen al precio** → [DECISIONES.md](DECISIONES.md#el-margen-se-suma-al-precio-no-se-le-quita-al-dueño)
- **El plato por partes (almuerzo de una familia)** → [DECISIONES.md](DECISIONES.md#el-plato-por-partes-el-almuerzo-de-una-familia)
- **Cortar un flujo (modos, atajos, `return` temprano)** → [cambios-seguros](.claude/skills/cambios-seguros/SKILL.md#cortar-un-flujo-el-inventario-de-lo-que-hacía-de-paso)
- **Construido y desconectado (el fallo que las pruebas no ven)** → [camino-real](.claude/skills/camino-real/SKILL.md)
- **Los vigías, el parte diario y el respaldo (lo que vigila producción YA desplegada)** → [VERIFICACION.md](VERIFICACION.md#las-dos-capas-que-vigilan-lo-que-ya-está-en-producción-2026-09-18)
- **El staging local y el freno de tareas de fondo** → [VERIFICACION.md](VERIFICACION.md#el-staging-local-y-el-freno-que-lo-hizo-necesario-2026-09-19)
- **Los tipos generados de la base (y por qué generarlos no basta)** → [VERIFICACION.md](VERIFICACION.md#los-tipos-de-la-base-generados-desde-la-base-2026-09-19)
---

## 7. HIGIENE DE GIT

### La regla de oro: **una sola rama viva, y es `main`**

Decidida el 2026-08-28, después de encontrar **132 ramas** acumuladas en el
remoto. Ninguna guardaba trabajo —todas eran de PRs ya fusionados— pero cada
una era una copia vieja del código esperando a confundir a alguien. La local
del último PR, por ejemplo, conservaba el `size-10` de las dianas, la utilidad
muerta que se había retirado y el `check` sin los tests de la tienda: **una
rama abandonada no protege trabajo, resucita decisiones ya revertidas.**

**El ciclo se cierra SIEMPRE, en el mismo turno:**

```
rama → trabajo → verificación → PR → CI en verde → merge → despliegue → comprobar en producción
```

Nada de «lo dejo en un PR y mañana veo». Un trabajo que no llegó a `main` no
está hecho, y a los tres días nadie recuerda en qué estado quedó.

- **Ramas de vida corta.** Nacen del `main` de hoy y mueren al fusionarse. Si
  una rama sobrevive más de un par de días, el problema es el tamaño del
  cambio: pártelo.
- **GitHub borra la rama al fusionar** (`delete_branch_on_merge`, activado el
  2026-08-28). No hay que acordarse de nada. Al terminar, `git fetch --prune`
  y borrar también la local.
- **Cada PR se fusiona o se cierra con su motivo escrito.** Un PR cerrado sin
  explicación es trabajo perdido que nadie sabe si hacía falta. El ejemplo a
  seguir es el #231: se cerró diciendo qué se rescataba (las tres guardas del
  ejecutor, ya en #272) y qué se descartaba por obsoleto — así, un mes después,
  se pudo borrar su rama con la certeza de no perder nada.
- **Un punto histórico es una ETIQUETA, no una rama.** El respaldo de WhatsApp
  Flows vive en `respaldo-whatsapp-flows`: una etiqueta es inmutable, no se
  trabaja sobre ella por error y no ensucia la lista de ramas.

⚠️ **Lo que MIENTE al comprobar si una rama se puede borrar** (aprendido a base
de equivocarse):
- `git branch --no-merged` marca como «sin fusionar» todo lo fusionado con
  **squash**, porque el commit resultante tiene otro SHA.
- `git diff main rama` cuenta además lo que `main` cambió **después**, así que
  una rama perfectamente fusionada aparenta tener «74 archivos que main no
  tiene».
- `git fetch` **no purga**: las referencias `origin/*` locales sobreviven a
  ramas borradas hace meses. Sin `--prune`, la lista local dice 10 cuando el
  remoto tiene 132.

**Lo que sí decide**, y solo esto: el estado del PR (`gh pr list --head <rama>
--state all`) o buscar su commit de squash en main
(`git log origin/main --grep="(#NNN)"`). Si el PR está `MERGED`, el código está
en `main` y la rama sobra; GitHub conserva sus commits en la pestaña del PR.

### Lo de siempre

- **Commits pequeños y descriptivos**, en español (ej: "fix: monto mensual no se guardaba al editar cliente").
- **Punto limpio antes de un cambio grande**: confirma que el árbol está estable o haz commit de lo pendiente primero.
- **NUNCA** `git reset --hard`, `git clean -fd`, ni borrar ramas sin **confirmación explícita** del usuario.
- **NUNCA** subir `server/.env` (ya está en `.gitignore`). Si una credencial entra al diff, deténte y avisa.
- Trabaja en rama si el cambio es grande; no commitees en `main` sin pedirlo.

### `main` está protegida, y se aplica también a los admins

Exige PR, los **siete** checks del CI en verde (el séptimo, los recorridos de punta a punta), estar al día con `main`, y
prohíbe force-push y borrado. No se debilita para «salir del paso»: si el CI
molesta, es que el CI está diciendo algo.

---

## 8. IDIOMA

- **Responde al usuario en español** (mercado Ecuador/Colombia).
- **Textos del bot y de los paneles en español neutro.**
- Código, nombres de variables y claves técnicas en inglés/snake_case según el patrón existente; comentarios en español.

---

## 9. MAPA DE SKILLS

Ante cualquier pedido, identifica la situación y consulta la(s) skill(s) correspondiente(s) en `.claude/skills/`. Varias pueden aplicar a la vez.

| Situación / pedido | Skill a consultar |
|--------------------|-------------------|
| Tocar BD, RLS, auth, esquema, multi-tenancy o etiquetas/tools del bot | **arquitecto-saas** (primero) |
| Modificar algo existente, pedido amplio o ambiguo, "mejora esto/todo" | **cambios-seguros** |
| Antes de dar por terminada una feature, un modo o una rama nueva; o ante un «está construido pero no responde» | **camino-real** |
| Después de CUALQUIER cambio, verificar que nada se rompió | **tester-saas** |
| Tocar auth, secretos, encriptación, webhooks, endpoints públicos, datos sensibles | **seguridad-saas** |
| Crear/modificar migraciones, tablas, índices, columnas o políticas RLS | **base-de-datos** |
| Antes de commit o de abrir un PR: revisar el diff completo | **revisor-pr** |
| Versionar: ramas, commits, push, PRs, merges (el "cómo" de Git/GitHub) | **git-github** |
| Sacar un cambio a producción: migraciones, despliegue, humo, salud del canal | **ship** |
| Hay un error, bug o comportamiento inesperado | **debugging** |
| Crear feature/endpoint/etiqueta nueva o cambiar comportamiento que otros consumen | **documentacion** |
| Crear o modificar gráficos, dashboards, KPIs o visualizaciones en el panel | **graficos-dashboard** (usa la bundled **dataviz**) |
| Crear, migrar o revisar pantallas React y componentes del sistema visual | **shadcn-ui** |

**Combinaciones frecuentes:**
- "Agrega una tabla/campo nuevo" → base-de-datos + arquitecto-saas + tester-saas + documentacion.
- "Cambia el login / cómo se guardan las keys" → seguridad-saas + arquitecto-saas + tester-saas.
- "El bot responde mal / no detecta venta" → debugging + tester-saas.
- "Revisa esto antes de subirlo" → revisor-pr.

---

## 10. MÓDULOS FUTUROS (no construir hasta que haya demanda real)

> 📋 **La lista completa de módulos futuros —con lo que habría que definir antes de construir cada uno— está en [PENDIENTE.md](PENDIENTE.md).** No construir nada de ahí sin señal de un cliente real. Allí viven también las dos notas de estrategia: en qué fase está el producto y cuándo tocaría pensar en escalar.
