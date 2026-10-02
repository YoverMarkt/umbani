# VERIFICACION.md — las capas que evitan que un fallo llegue al cliente

Movido de `CLAUDE.md` **sin cambiar una frase**.

Cada capa nació después de un incidente concreto. El diagnóstico de fondo
(2026-08-02) fue que **todos los guardianes se escribieron después de un
fallo**: la red dependía de que alguien se acordara, y nadie se acuerda de lo
que aún no ha visto romperse. Varias de estas invierten esa carga.

> ⚠️ Ninguna sustituye a otra. `verify:schema` comprueba que las funciones
> FUNCIONEN, `verify:drift` que producción SEA el archivo, y `verify:smoke`
> que la app RESPONDA. Las tres miran cosas distintas.

---

> ⚖️ **Presupuesto de tamaño de la tienda (`npm run size -w @botpanel/store`, job `Mini app de la tienda` del CI):** la mini app la abre el cliente final desde WhatsApp, con datos móviles y a menudo con mala señal; cada kilobyte se paga en gente que cierra antes de que cargue, y **una venta perdida así no deja rastro en ningún log**. Mide el gzip de lo que el navegador descarga para pintar la primera pantalla (`.js` + `.css` + `.html`; fuentes e imágenes quedan fuera porque llegan después y no bloquean). Hoy **76,0 kB** con un presupuesto de **82 kB**. ⚠️ **El margen de 6 kB está calibrado por DEBAJO de la librería más pequeña que querríamos cazar** (react-router son ~10 kB gzip): un presupuesto con más holgura que eso deja pasar justo lo que dice vigilar y solo da tranquilidad falsa. Verificado de verdad, no en teoría — se instaló `react-router-dom` y se envolvió la app: subió a **89,8 kB** y el CI habría fallado; se revirtió y volvió a 76,0. El presupuesto no premia adelgazar, solo impide engordar sin darse cuenta: si un cambio lo necesita, se sube el número a propósito y queda escrito en el historial quién decidió que valía la pena.
>
> 📊 **Cobertura con umbral (`npm run test:coverage -w @botpanel/server`, dentro del job `Lint + Tipos + Tests`):** mide qué líneas del servidor no ejecuta ninguna prueba. Hoy: **71% sentencias · 61% ramas · 66% funciones · 74% líneas**, y los umbrales están **por debajo** de eso a propósito — existen para que la cobertura no RETROCEDA, no para exigir una cifra bonita; un margen de uno o dos puntos evita que un refactor inocente rompa el CI sin haber empeorado nada. Se mide sobre `dist/` porque es lo que las pruebas cargan de verdad, y los sourcemaps devuelven la medida al TypeScript original. ⚠️ **No se lee como nota del proyecto:** los repositorios de `db/` salen bajos *a propósito* — son envoltorios finos de Supabase y probarlos sería probar el cliente de Supabase; lo que de verdad los verifica es `verify:schema`, que EJECUTA sus funciones contra PostgreSQL real. **El hallazgo que sí importó:** `storefront.routes.ts` estaba al **21%** — las pruebas comprobaban el CABLEADO (qué rutas existen, qué middleware llevan) pero jamás ejecutaban un manejador, así que nadie había hecho nunca un pedido por ahí… justo el camino que usa el cliente final desde su teléfono. Se añadieron pruebas de comportamiento (el precio que manda el teléfono se descarta, el negocio sale de la SESIÓN y no del slug de la dirección, `42501` se traduce a 403 y no a 500, el horario del dueño manda también aquí) y subió a **39%**. Quedan cortos `middleware/storefront.ts` (21%) e `index.ts` (0%, composición y arranque).
>
> 📒 **Ejecutor de migraciones (`npm run migrate:status` · `migrate:baseline` · `migrate`, en `server/tests/migraciones.mjs`):** las 34 migraciones del proyecto se corrían a mano en el editor SQL de Supabase y **nadie llevaba la cuenta**; olvidar una no avisa —la app responde 500 cuando el código busca una tabla que no existe— y ya pasó con las del hostal y las de la tienda. La tabla `schema_migrations` es el libro de cuentas: nombre, huella SHA-256 y cuándo se aplicó. Cada migración va en **su propia transacción** (PostgreSQL soporta DDL transaccional, así que una a medias no existe: o entra entera o no entra) y las anteriores quedan aplicadas si una falla. **La huella no es adorno:** editar un `.sql` ya aplicado —lo que la guía prohíbe— deja de cuadrar y el comando se niega a seguir; sin ella un archivo cambiado se ve idéntico a uno intacto. ⚠️ **`migrate:baseline` es una AFIRMACIÓN, no una comprobación:** marca migraciones como aplicadas **sin ejecutarlas**, que es lo único que permite adoptar el registro en una base que ya existe, pero si una nunca se corrió de verdad queda invisible para siempre. Por eso exige `--si`, acepta `--excepto=a.sql,b.sql` y remite a `verify:drift` antes. `migrate` se niega a correr si el registro está vacío y hay muchas pendientes: sería la señal de que nadie hizo el baseline. `migration-integraciones.sql` está en una lista de **jamás ejecutar** dentro del código (tiene el esquema viejo de tablas que ya no existen; aplicarlo hoy rompería la base) y no depende de que alguien se acuerde. Necesita `DATABASE_URL` —la conexión **directa** de Postgres, no `SUPABASE_URL`—, que es credencial de herramienta: vive en el `.env` local y **no hace falta en Railway**, porque el servidor nunca aplica migraciones solo (cuatro instancias significarían cuatro procesos corriendo el mismo DDL a la vez). Verificado de punta a punta contra un PostgreSQL real en Docker: los dos frenos, el baseline con exclusión, aplicar, el rechazo por huella y el rollback de una migración rota (ni la tabla ni el registro quedaron).
>
> 🐘 **Verificación contra PostgreSQL real (`npm run verify:schema -w @botpanel/server`, job `esquema` del CI):** levanta un PostgreSQL con pgvector, emula el entorno de Supabase (`server/tests/sql/bootstrap-supabase.sql` crea el esquema `extensions` con pgcrypto dentro y los roles `anon`/`authenticated`/`service_role`), aplica `schema.sql` **en una base vacía** y **EJECUTA** las funciones críticas con datos de prueba (`server/tests/sql/verificar-esquema.sql`): cola durable + trigger de consumo, registro de errores y su agrupación, cálculo del total de un pedido y su rechazo si el precio no cuadra, y creación de reserva. El CI además reintroduce a propósito el fallo de julio de 2026 y exige que la verificación salte: una verificación que deja de detectar es peor que ninguna. ⚠️ Es una **imitación** de Supabase, no Supabase: detecta migraciones rotas, funciones que revientan y contratos que no cuadran, pero no garantiza comportamiento idéntico en producción. Como `schema.sql` se aplica de cero, **toda tabla o función nueva debe añadirse también al consolidado**, no solo a su migración.
>
> 💾 **Respaldo de producción y su prueba (`npm run backup` · `npm run backup:verify`, en `server/tests/respaldo.mjs`):** ⚠️ **En el plan gratuito Supabase NO hace respaldos automáticos** — los diarios son de Pro en adelante, y su propia documentación recomienda a los proyectos gratuitos exportar por su cuenta. Hasta que existió esto, perder la base era perderlo todo. `backup` vuelca en formato `custom` con permisos locales `0600` (comprimido, y permite recuperar UNA tabla sin tragarse el volcado entero) y **acto seguido lo restaura en un PostgreSQL limpio y cuenta las filas**: un respaldo que nunca se restauró no es un respaldo, es un archivo del que nadie sabe nada. Falla si aparecen menos de 30 tablas o falta cualquiera de las cuatro tablas base núcleo (`businesses`, `products`, `orders`, `client_users`); admite que estén vacías porque una instalación nueva puede no tener filas todavía. ⚠️ Usa `pg_dump` **dentro de un contenedor** en vez del que haya en la máquina, porque un pg_dump más viejo que el servidor se niega a trabajar — y esa es la forma más común de descubrir que el respaldo no se puede hacer justo cuando hace falta. **La imagen es `pgvector`, no el postgres normal:** `products` guarda embeddings de 1536 dimensiones y sin esa extensión la tabla ni se crea. La imagen local no incluye `supabase_vault`: la restauración solo tolera sus tres errores exactos de extensión/tabla ausente y el cierre `errors ignored on restore: 3`, con `pg_restore` terminado normalmente en estado 1 y sin ninguna línea externa; cualquier otra salida, estado o señal falla. Los errores de las herramientas se capturan y sanean antes de mostrarse para que `DATABASE_URL` y su contraseña nunca lleguen al terminal o al CI. Necesita `DATABASE_URL`, la misma de las migraciones. ⚠️ Un respaldo en la misma máquina no protege de perder la máquina: hay que copiarlo fuera.
>
> 🚧 **Guardián de fronteras entre negocios (`server/tests/sql/verificar-fronteras.sql`, job `esquema` del CI):** responde la pregunta que ninguna otra comprobación respondía — *¿hay alguna tabla desde la que se pueda apuntar al dato de OTRO negocio?*. Busca el patrón exacto del fallo: una tabla con `business_id` con una foránea hacia otra tabla que **también** tiene `business_id`, sin incluir `business_id` en la pareja. Esa foránea comprueba «esa fila existe», no «esa fila es de este negocio», y como el negocio sale del JWT mientras el otro id viaja en la petición, ahí se cruza la frontera con un uuid ajeno. **Así estuvieron `product_variants.product_id` y `products.category_id` durante meses** sin que nadie los viera: el agujero existía, pero no había ninguna ruta que escribiera esas tablas — no había puerta. En cuanto se construyó la puerta (PR #132), se volvió real. ⚠️ **Ese es el punto:** antes la protección se ponía caso por caso y NADA comprobaba el caso siguiente. Acepta **dos** formas de cerrar cada frontera: una foránea **compuesta** sobre `(id, business_id)` —lo impide la base—, o una **RPC que compruebe pertenencia y lance `42501`**, y entonces se anota en el archivo diciendo qué función lo cierra. Hoy hay 10 anotadas (pedidos, ventas, direcciones, facturación…) y 2 cerradas por la base. Verificado creando una tabla nueva con el patrón: el CI para y explica cómo cerrarla. **Este guardián vigila la FORMA; `verificar-aislamiento.sql` vigila el COMPORTAMIENTO** ejecutando el intento con dos negocios reales — hacen falta los dos.
>
> 🔒 **Aislamiento multi-tenant contra PostgreSQL real (`server/tests/sql/verificar-aislamiento.sql`, mismo job del CI):** la regla #1 del proyecto estaba probada solo con simulacros; aquí conviven **DOS negocios reales** en la misma base y cada comprobación intenta ACTIVAMENTE cruzar la frontera, exigiendo que la base lo impida: el negocio A no puede vender ni facturar un producto de B (`create_order_with_items` y `create_sale_with_items` deben rechazar con `42501`), la búsqueda semántica de A nunca devuelve catálogo de B, el mismo `message_id_hash` en dos negocios se encola por separado (deduplicar sin mirar el negocio silenciaría al cliente de otro), la misma huella de error genera dos registros, y **borrar un negocio se lleva lo suyo y solo lo suyo** (verificado sobre productos, pedidos y errores del vecino). Un fallo aquí no es un bug: es un incidente de seguridad. Verificado quitando el filtro `business_id` de la RPC de pedidos y comprobando que salta `FUGA: el negocio A pudo crear un pedido con el producto de B`.
>
> 🔎 **Cobertura obligatoria de funciones (`server/tests/rpc-cobertura.test.js`):** el CI lee el código, encuentra cada `db.rpc()` y **falla si la verificación contra PostgreSQL real no la ejecuta**. Nació del 2 de agosto de 2026, cuando se descubrió que ningún cliente nuevo se podía crear: `create_business_onboarding` llevaba meses rota y era una de las 6 (de 20) que ninguna prueba tocaba. El problema de fondo no era el disparador, era que la verificación cubría *lo que alguien se acordó de añadir*, y nadie se acuerda de lo que aún no ha visto fallar. Este guardián invierte la carga: añade una función mañana y el CI te para hasta que la pruebes. ⚠️ Al medir la cobertura por primera vez salieron 10 funciones y resultaron ser **20** — la mitad se llaman con el nombre en la línea siguiente y el patrón ingenuo no las veía; un contador que miente por la mitad es peor que no contar, así que hay un test que vigila al extractor.
>
> 🔀 **Detector de deriva (`npm run verify:drift -w @botpanel/server`):** responde la pregunta que ninguna otra comprobación responde — *¿la base REAL es lo que dice `schema.sql`?*. El CI verifica que el archivo sea correcto, no que producción se le parezca: si se corre una migración y se olvida el consolidado (ya pasó con `platform_errors`), el CI sigue en verde verificando una ficción. Aplica `schema.sql` a un PostgreSQL limpio en Docker y **le pregunta a él** qué produjo —intentar parsearlo con expresiones regulares daba una lista donde faltaban `businesses` y `products`—, y lo compara contra el catálogo que PostgREST publica en `/rest/v1/`. Solo lectura, no toca producción, no corre en el CI (que no debe tener las llaves). ⚠️ Compara **nombres** de tablas, columnas y funciones: NO ve disparadores ni el cuerpo de las funciones, así que el fallo del 2026-08-02 habría pasado por aquí sin despeinarse. Vía descartada y anotada para que nadie la reintente: sondear funciones con `rpc(x, {})` no sirve — PostgREST devuelve el mismo `PGRST202` para una función que existe con argumentos y para una que no existe, y esa versión daba 25 falsos positivos.
>
> > 🔥 **Prueba de humo contra producción (`npm run verify:smoke -w @botpanel/server -- https://…`):** la única capa que mira la aplicación DE VERDAD. Las otras verifican simulaciones — `verify:schema` ejecuta sobre un PostgreSQL en Docker (una imitación de Supabase) y `verify:drift` compara nombres sin ejecutar nada. Entre ambas queda el hueco por donde caben los fallos de configuración: una variable de entorno ausente, un despliegue que no llegó, una credencial caducada; nada de eso lo ve el CI y es justo lo que deja la app muerta con todo en verde. Comprueba salud y cola de webhooks, que se sirvan los tres frontales, que la tienda exija sesión y que el enlace corto no filtre negocio, que el panel rechace sin token, y **da de alta un cliente y lo borra** — el camino que estuvo roto meses. ⚠️ **ESCRIBE EN PRODUCCIÓN**: crea UN negocio con nombre inequívoco (`ZZZ PRUEBA DE HUMO …`) y lo borra en el `finally`; si el borrado falla lo grita con el id para limpiarlo a mano. **Nunca manda mensajes de WhatsApp** (costaría dinero y gastaría el saldo del canal). `BASE_URL` va vacío en el `.env` local a propósito —para que el servidor levante su túnel—, así que la dirección se pasa por argumento o `SMOKE_URL`. Se lanza después de cada despliegue; no corre en el CI porque el CI no debe tener las llaves de producción.
>
> > 🛡️ **Guardián de migraciones (`server/tests/migraciones-guardian.test.js`):** revisa TODOS los `.sql` del proyecto —los de hoy y los que se escriban mañana— contra cinco reglas que fallan el CI: (1) ninguna función usa **pgcrypto** (`digest`, `crypt`, `hmac`, `gen_random_bytes`) con un `search_path` que no incluya `extensions`; (2) toda tabla creada habilita **RLS** en el mismo archivo; (3) ninguna política usa `using (true)`; (4) toda FK a `businesses` lleva `on delete cascade`; (5) tablas e índices se crean con `if not exists`, porque las migraciones se aplican a mano y repetirlas no puede romper nada. Nació del apagón del 26–31 jul 2026: `record_inbound_message_usage()` llamaba a `digest()` fuera de alcance, el trigger reventaba en cada mensaje entrante y el bot estuvo cinco días mudo. **PostgreSQL no valida el cuerpo de una función plpgsql al crearla**, así que el SQL se aplicó "con éxito" y el fallo solo apareció al ejecutarse. El guardián incluye un test que reintroduce ese SQL defectuoso y comprueba que lo detecta: si la regla se rompe, se sabe. ⚠️ Sigue sin haber pruebas contra un PostgreSQL real, así que estas reglas atrapan la familia de errores conocida, no cualquier error posible.
>
> ✅ Esquema: `server/schema.sql` está **consolidado y actualizado** (refleja la base real: RLS activado, todas las columnas y tablas vivas, y la función RAG `match_products`). `server/migration-integraciones.sql` quedó **OBSOLETO** (marcado como tal, solo historial — no ejecutar). Para el estado del esquema, usa `schema.sql` o consulta la BD.

---

## Guardián de funciones de base de datos sin dueño

**De dónde sale:** una pregunta del dueño del SaaS el 2026-08-02 — «todo lo que se borra o el código viejo, ¿ya no existe en mi sistema? ¿se está verificando?». La respuesta honesta entonces era **«a mano»**. Esto lo automatiza.

`server/tests/funciones-huerfanas.test.js` cubre los dos riesgos reales de tocar funciones en PostgreSQL:

1. **Un permiso que nombra una firma inexistente.** `create or replace function` con un parámetro nuevo **no reemplaza**: crea una SEGUNDA función con el mismo nombre. Ese mismo día, cuatro `grant` se quedaron con la firma vieja y `psql` abortó al aplicar el esquema entero. El test lo caza sin necesidad de levantar PostgreSQL — comprobado reintroduciendo el fallo a propósito.
2. **Funciones que no llama nadie**: ni el servidor, ni un disparador, ni otra función. Código muerto esperando a que alguien lo invoque por error.

⚠️ Distingue `execute function X()` (un disparador **usándola**) de `create function X(` (declarándola). Confundirlas marcaba como muertas todas las funciones de trigger del proyecto.

**Y en PostgreSQL real** (`verificar-esquema.sql`, que el CI ejecuta en cada PR): **ninguna función del proyecto puede tener dos versiones vivas**. Las sobrecargas de extensiones (pgvector, pgcrypto) se excluyen mirando `pg_depend`: esas sí son legítimas.

### Dos guardianes se acotaron, y por qué

`orders-atomicity` y `sales-atomicity` prohibían `exception when` en **todo** `schema.sql` para impedir escrituras compensatorias. Al incorporar al consolidado la función que activa RLS en tablas nuevas —que **necesita** capturar para no romper donde falte un permiso de superusuario— el guardián saltaba por algo que no era su objetivo. Ahora cada uno mira **solo su función** (`create_order_with_items`, `create_sale_with_items`), que es la garantía que de verdad protegían.

El guardián de migraciones también aprendió a **ignorar los literales de cadena**: una función que filtra eventos DDL por su etiqueta (`command_tag in ('CREATE TABLE AS', …)`) se leía como si estuviera creando una tabla llamada «as».

### La deriva que encontró

Existía en producción un disparador de evento `ensure_rls` con su función `rls_auto_enable` —activa RLS automáticamente en toda tabla nueva de `public`— que **no estaba en `schema.sql`**. Una instalación nueva nacía sin esa red de seguridad. Ya está en el consolidado.

## Los E2E fallan ante un error de la página (2026-08-15)

**Daban 32/32 con el dashboard del superadmin sin renderizar.** React lanzaba
`Cannot read properties of undefined (reading 'length')` y Playwright ni se
inmutaba, porque las pruebas miraban la URL, el tema o el token — cosas que
siguen ahí aunque el contenido no aparezca.

`e2e/fixtures.ts` añade un fixture automático que escucha `pageerror` y los
`console.error` de React y pone la prueba en rojo. Se ignoran a propósito los
errores de RED: un `fetch` fallido es cosa de los mocks de cada prueba, y
hacerlas fallar por eso las volvería ruidosas hasta que alguien las apagara.

⚠️ **Y hacía falta algo más que el fixture: ninguna prueba abría el dashboard
con sesión.** Un guardián no sirve de nada en una pantalla donde nadie entra.
Por eso se añadieron dos pruebas — una que lo abre entero, y otra que le
devuelve basura a la salud del canal y exige que el resto siga en pie.

⚠️ Ese par no es redundante, y comprobarlo cuesta un minuto: **arreglado el
mock, la primera pasa aunque se quite la defensa del componente**. La que de
verdad la protege es la que manda `{}` a propósito. Es el mismo patrón que en
`client.spec.ts` con la lista de bloqueados.

## La transacción de una migración la pone el ejecutor

`tests/migraciones.mjs` abre una transacción por migración y registra dentro de
ella el `insert` en `schema_migrations`. Una migración con su propio `commit`
**cierra esa transacción antes de tiempo**: el registro queda fuera y, si
fallara, el `rollback` no desharía el DDL — esquema cambiado sin constancia,
que es el peor estado en el que se puede quedar una migración.

Lo vigila `migraciones-guardian.test.js` con una lista de indultados: las 16
que ya lo llevaban están aplicadas y **un `.sql` aplicado no se edita nunca**
—cambiaría su huella y el ejecutor las marcaría como modificadas—. La lista no
puede crecer.

⚠️ Y una lección del mismo día: **aplicar una migración por fuera del ejecutor
deja el registro desincronizado**. Se aplicó con un cliente `pg` suelto, quedó
en la base y no en `schema_migrations`. Se reconcilió reejecutándola con
`npm run migrate` —es idempotente—, que además demuestra que se puede reaplicar
sin daño.

## Detector de código muerto (knip)

Corre dentro de `npm run check`, así que el CI lo ejecuta en cada PR. Encuentra **archivos que no importa nadie**, **dependencias declaradas que ya no se usan** y **dependencias que se usan sin declarar**. Comprobado que muerde: un archivo huérfano de prueba lo hace fallar.

Su primer hallazgo real fue `express-serve-static-core`, que `middleware/async.ts` importaba **sin declararlo** — llegaba de rebote a través de `@types/express`. Si ese árbol de dependencias cambiaba, el import se rompía sin que nadie hubiera tocado nada. Ya está declarado.

### ⚠️ Lo que NO detecta, y por qué

**Exports muertos del servidor.** Está apagado a propósito (`"exports": "off"`), no por comodidad: el servidor importa con `require('...')` tipado —el patrón CommonJS deliberado del proyecto— y knip no rastrea esas importaciones. En la primera pasada marcó **71 exports como muertos**, y el primero que se comprobó, `authClient`, tenía **66 usos reales**.

Un guardián que reporta 71 falsos positivos es peor que no tenerlo: se aprende a ignorarlo y el día que acierte, nadie mirará. Por eso solo queda encendido lo que este proyecto puede verificar con certeza.

Para el riesgo grave —código viejo que **sí se ejecuta**— está el guardián de funciones de base de datos, que es donde una versión olvidada puede correr sola. Una función TypeScript que nadie importa es peso muerto, pero no se ejecuta.

**Y para los exports del servidor está `exports-huerfanos.test.js`**, que sí entiende el patrón: los módulos terminan en `export = { … }` y quien los usa escribe `modulo.laClave(...)`, así que basta con mirar si alguien nombra esa clave en el código o en las pruebas. Es deliberadamente **conservador** —solo caza lo que nadie nombra en ningún sitio— porque un guardián ruidoso se acaba ignorando.

**Lo que destapó al escribirlo:** cuatro exports muertos, y uno de ellos era un problema de verdad. `cleanupStorefrontSessions` existía desde el primer día de la mini app pero **nadie la llamaba**: la tabla de sesiones crecía sin límite, una fila por cada enlace que manda el bot. No se borró — se **conectó** al mismo ciclo diario que ya limpia el inbox de webhooks y el registro de errores. Los otros tres (`getVariantForOrder`, `getExtrasForOrder`, `revokeStorefrontSessions`) sí eran peso muerto y se retiraron.

**En los paneles la auditoría se corre aparte** (`npx knip -c knip.exports.json`), porque ahí los imports son ESM y knip sí acierta. Encontró dos restos reales: `salesApi.getOrders`, que quedó huérfano al mover Pedidos a su propia sección, y `BotForm`, la versión anterior de la pantalla del prompt que `BotPrompt.tsx` ya había reemplazado.

`ignoreDependencies` cubre las que usa `packages/ui` y las apps declaran para el hoisting de los workspaces (`clsx`, `tailwind-merge`, `radix-ui`, `class-variance-authority`), y `apps/*/public/theme-boot.js`, que lo carga el HTML y no un import.

## El guardián de fronteras ahora corre en el CI

**Encontrado el 2026-08-02, y es el fallo más instructivo de esa sesión.**
`verificar-fronteras.sql` busca claves foráneas que apuntan a otra tabla **sin
comprobar de quién es la fila**: una simple garantiza que exista, no que sea de
tu negocio. Pero solo se ejecutaba desde `npm run verify:schema`, que **necesita
Docker y corre en local**.

Resultado: el CI estuvo **verde todo el día** mientras se abrían cuatro
fronteras nuevas —`sales(order_id)`, `sales(booking_id)`,
`sales(order_id)`—, creada ese mismo
día al construir el estándar de ventas. Las funciones `crear_venta_desde_*` ya
impedían el cruce, pero eso depende de que nadie escriba nunca por otro camino,
y **la regla #1 dice que lo impida la base**.

Se cerraron con claves foráneas **compuestas** sobre `(id, business_id)` —el
mismo patrón de `product_variants`— y el guardián se añadió al CI.

**La lección, que vale más que el arreglo:** un guardián que depende de que
alguien se acuerde de correrlo no es un guardián. Si una verificación existe,
tiene que estar en el camino automático.

---
## Las plantillas REALES del alta, contra PostgreSQL (2026-09-16)

`server/tests/sql/plantillas-reales.mjs`, en el job `esquema` del CI y en
`npm run verify:schema`. Da de alta un negocio por **cada** tipo con plantilla,
le aplica la plantilla **de verdad** —la de `business-templates.ts`, no una
copia escrita a mano— y exige que la base la acepte, que el local nazca con su
producto de ejemplo, que ese ejemplo nazca **agotado** (nadie lo puede pedir)
pero **activo** (aquí inactivo es borrado, y su dueño no lo vería) y que ningún
grupo vivo quede vacío. Todo dentro de una transacción que se deshace.

**Por qué hace falta aunque `plantillas-negocio.test.js` ya replique las reglas
de la base:** este fallo es **silencioso por diseño**. El alta se traga el
error de la plantilla a propósito —el negocio ya existe y no puede devolver un
500—, así que una plantilla que la base rechace deja al local naciendo con el
catálogo **vacío** y el motivo escondido en el registro de errores. Una copia
de las reglas en JavaScript envejece; la base no.

⚠️ **Lee el TypeScript sin compilar** (Node quita los tipos desde la 22.18):
el job del esquema no instala dependencias y así sigue. Funciona porque
`business-templates.ts` solo importa **tipos**. Si algún día importa un valor,
el paso falla en voz alta, no en silencio.

**Verificado que detecta**, no solo que pasa: una lista mal escrita
(`"Sabore"`) para con «La plantilla enlaza «Sabores» a la lista «Sabore», que
no trae», y una parte del plato sin marcar como parte para con la restricción
`option_groups_parte_del_plato_check`.

## Las dos capas que vigilan lo que YA está en producción (2026-09-18)

Todo lo de arriba corre **antes** de desplegar, y por eso comparte un punto
ciego: ninguna de esas capas dice nada a las tres de la mañana de un martes.
Estas dos corren en GitHub Actions, **fuera del servidor**, que es la única
manera de cubrir el fallo que ningún detector interno puede avisar — que el
proceso haya muerto.

### Los vigías · `vigia.yml` + `vigia-atencion.yml` + `.github/scripts/vigia.mjs`

Le preguntan a producción por `/api/health` (público) y por
`/api/health/detalle` (con token). Comparten el script y se reparten el trabajo
por `VIGIA_MODO`:

| Workflow | Modo | Cada | Mira | Recordatorio |
|---|---|---|---|---|
| `vigia.yml` | `caida` | 15 min | No contesta · contesta algo que no es nuestro health · `ok:false` · cola de webhooks parada | 4 h |
| `vigia-atencion.yml` | `atencion` | 6 h | Saldo y credenciales · canario con fallos · entregas rechazadas · canal 24 h mudo | 24 h |

**No mandan correos: terminan en rojo**, y de eso se encarga GitHub. Cero
cuentas y cero credenciales de envío que mantener.

⚠️ **Están partidos por la MEMORIA, no por orden** (2026-09-19). El script
recuerda una sola cosa —la hora del último run en rojo— y esa memoria es *por
workflow*. Juntos, el saldo de YCloud en 0,50 USD, que lleva semanas sonando,
ocupaba el hueco de silencio, y una caída de verdad se habría quedado esperando
el turno de una alarma crónica. Separados, cada gravedad tiene su propio reloj.
El segundo motivo es cómo se lee el correo: un rojo de `vigia-atencion` es
«revísalo cuando puedas» y uno de `vigia.yml` es «ahora»; mezclados, los dos
acaban leyéndose igual.

⚠️ **Distingue una CAÍDA de un aviso**, y no es cosmético. El primer aviso real
que mandó decía «🔴 Producción ha caído» porque al número le quedaban 0,50 USD
—con el bot vivo y vendiendo—, y un título que exagera se deja de leer: el día
que se caiga de verdad parecerá uno más. Caída es no contestar, `ok:false` o la
cola parada; lo demás —saldo, credenciales, canario, silencio— es «🟠 necesita
atención». Y cada uno tiene su ritmo: la caída se recuerda cada **4 h**, la
atención cada **24 h**, porque un saldo bajo puede llevar semanas ahí.

⚠️ **Lo que de verdad hubo que pensar es cuándo callarse.** Corriendo cada 15
minutos, fallar siempre que algo va mal son 96 correos al día, y una alarma que
suena 96 veces se apaga el primer día. Así que solo falla cuando la noticia es
nueva: al romperse, y como recordatorio mientras siga rota. Su memoria es **la
hora del último run en rojo** de su propio workflow, consultada por la API — no
guarda estado en ningún sitio. La recuperación queda en verde y escrita en el
resumen, pero **no genera correo**: es una limitación asumida.

⚠️ **La memoria NO puede ser «¿la ejecución anterior fue un fallo?»**, y lo fue
hasta el 2026-09-19. Esa pregunta se contesta sola mal: cuando el vigía se
callaba dejaba un run **verde**, el siguiente veía verde detrás, creía que el
problema acababa de empezar y volvía a fallar. Rojo, verde, rojo, verde cada 15
minutos — **48 correos al día** del único workflow escrito para no mandar 96.
Lo destapó el dueño preguntando por qué le llegaban tantos avisos y ninguno en
verde. La hora del último rojo no tiene ese problema: no la cambia el hecho de
haberse callado. `vigia.test.js` simula 96 vueltas seguidas y exige que salga
**un** correo.

⚠️ El umbral de silencio son **24 h** y tiene que valer lo mismo que
`DEFAULT_SILENCE_HOURS` en `channel-health.ts`. `vigia.test.js` lo comprueba,
porque desincronizarlos haría que los dos digan cosas distintas del mismo canal.

### El parte diario · `parte-diario.yml` + `.github/scripts/parte-diario.mjs`

Los vigías avisan **fallando**, y GitHub solo manda correo cuando un run acaba
en rojo. Eso deja un agujero que se vio al usarlo: con todo en orden no llega
nada, y «nada» no se distingue de «el workflow dejó de ejecutarse». El dueño lo
dijo así: «me llegan muchas notificaciones, pero todas de errores y ninguna de
OK».

Cada día a las 7:30 de Ecuador publica el estado como **comentario en un
issue** etiquetado `parte-diario`. Un comentario en un issue al que estás
suscrito sí notifica, así que el OK llega por el mismo canal que las alarmas,
sin cuentas nuevas y sin Telegram, que el dueño no usa. La primera vez crea el
issue y **se lo asigna al dueño del repositorio**: sin asignado no habría nadie
suscrito y el parte no le llegaría a nadie.

⚠️ **Nunca falla por lo que encuentre.** Si el parte pudiera ponerse rojo sería
una alarma más, y el correo que existe para leerse con calma acabaría en la
misma carpeta que las urgencias. Solo termina en rojo si no pudo publicar.

⚠️ **No decide nada por su cuenta:** reutiliza `evaluarSalud` del vigía. Dos
criterios distintos para el mismo estado acabarían diciendo cosas distintas el
mismo día.

⚠️ **En un repositorio PÚBLICO el parte no da detalles.** `YoverMarkt/umbani` lo
es, y un issue diario contando que al canal le queda saldo para dos mensajes,
que lleva 31 h sin un pedido o que producción está caída es un informe
operativo del negocio —indexable y permanente— para cualquiera. Publica el
semáforo, que es para lo que existe, y remite a la pestaña Actions. El script
lo pregunta a la API en vez de fiarlo a una variable, así que el día que el
repositorio cambie de visibilidad se ajusta solo; si no puede saberlo, asume
**público**, porque equivocarse hacia el silencio no cuesta nada y hacia el
otro lado publica el saldo del canal en internet.

### El respaldo · repositorio privado `YoverMarkt/bot-respaldos`

Cada día a las 03:00 de Ecuador vuelca la base, **la restaura en un PostgreSQL
limpio para comprobar que sirve**, la cifra con AES-256 y la publica como
Release con 30 días de retención. Si la restauración no trae el esquema
completo, no se publica nada y el run queda en rojo.

⚠️ **Vive en otro repositorio a propósito**, y por dos motivos: este es público
—los artifacts de Actions de un repo público los descarga cualquiera— y así
ninguna credencial de producción tiene que existir aquí. El código sigue siendo
el de aquí: el workflow hace checkout de este repositorio y ejecuta
`server/tests/respaldo.mjs`.

⚠️ **Usa la cadena del POOLER, no la directa.** `db.<ref>.supabase.co` resuelve
solo a IPv6 y los runners de GitHub no tienen IPv6. Con la directa falla con
«Network is unreachable», que parece un problema de credenciales y no lo es.
La que funciona es `aws-0-us-east-1.pooler.supabase.com:5432` con usuario
`postgres.<ref>` desde el traslado del 2026-09-26. El prefijo (`aws-0`,
`aws-1`…) depende de CADA proyecto —el viejo de São Paulo era `aws-1` y ahí
`aws-0` contestaba «tenant not found»—: se copia del botón «Connect».

## El staging local, y el freno que lo hizo necesario (2026-09-19)

Todo lo anterior prueba piezas. Lo que faltaba era un sitio donde correr **la
aplicación entera** sin que la estuvieran usando clientes — porque hasta esta
fecha no lo había: `server/.env` apunta a la base de producción, así que
desarrollar y producción eran literalmente el mismo sitio.

### Lo que arrancar en local disparaba contra los datos de los clientes

No es una lista teórica; es lo que `src/index.ts` programa al levantarse:

| Cuándo | Qué | Contra qué |
|---|---|---|
| al instante | el worker de la cola de webhooks | mensajes de clientes reales, contestados desde un portátil |
| 3 s | la facturación del mes | filas de cobro reales |
| 5, 7 y 9 s | tres limpiezas | **borran** filas |
| 12 s | las comisiones | |
| 20 s | la revisión de credenciales | llama a los proveedores de verdad |
| **30 s** | **`expireUnpaidOrders`** | **CANCELA pedidos de clientes** |
| 60 s | el canario | recorre el catálogo real |
| — | Telegram en polling | **borra el webhook** que tenga producción |

`src/config/tareas-de-fondo.ts` corta eso: si el proceso **no** es producción y
la base **sí** es remota, las tareas no arrancan y el servidor lo grita al
levantarse. Las rutas, los paneles y el simulador siguen funcionando, que es
para lo que se abre en local. El escape explícito es
`PERMITIR_TAREAS_CONTRA_PRODUCCION=si`.

⚠️ **En producción el freno nunca puede actuar**, y esa es la única condición
que no se puede romper al tocarlo: un freno que apague las tareas en producción
deja la facturación sin generar y los pedidos sin expirar. `tareas-de-fondo.test.js`
lo comprueba desde las dos direcciones, y un guardián verifica que el `if` sigue
envolviendo las tareas en `index.ts` — de nada sirve un freno bien probado que
el arranque no consulte.

### Cómo se trabaja con él (decidido 2026-09-19)

**Nada llega a producción sin haber funcionado antes aquí.** Se decidió después
de tres arreglos seguidos de la mini app que fueron directos a producción y
que el dueño tuvo que encontrar con clientes pudiendo entrar: el `+` mudo, las
dos cuentas y los nombres cortados. Ninguno era un error que salte — los tres
solo se veían tocando la app en un teléfono.

```
cambio → staging → lo pruebo en el móvil → ¿al 100 %? → PR → CI → producción
```

⚠️ **«Tengo el staging levantado» NO significa «el staging tiene lo último»**, y
las tres razones son invisibles:

1. el repositorio local no se actualiza solo;
2. el servidor **no vigila cambios** — compila al arrancar y ya;
3. y la peor: **`npm run build` del servidor no construye los paneles**. La
   mini app se sirve desde `apps/store/dist`, así que sin reconstruirla el
   staging enseña la tienda de antes con un servidor nuevo. Esa trampa ya se
   pagó una vez en producción (ver [[feedback_deploy-local-paneles]]).

`npm run staging:actualizar` hace los cuatro pasos en el orden correcto: se
niega si hay trabajo sin guardar, trae lo último, reconstruye **todo** y
arranca. Y si lo que traes cambia el esquema, **corta en vez de arrancar** —
con la base de ayer la aplicación falla con errores de columna que parecen
bugs de la app y no lo son; ahí toca `npm run staging:reset` primero.

### El staging

`supabase/config.toml` + `server/tests/staging.mjs`. Levanta **el stack de
Supabase**, no un PostgreSQL pelado: el servidor habla con la base por HTTP
(supabase-js → PostgREST), así que un Postgres a secas no sirve para correr la
aplicación — solo para el esquema, que es lo que ya hace el job del CI.

La semilla llama a `apply_business_template`, la misma función que el alta real.
Sembrarlo por otro camino probaría un mundo que no existe.

⚠️ **Qué NO cubre:** WhatsApp de verdad. Solo hay un número y apuntarlo aquí
dejaría a los clientes sin atender. Se sigue probando en producción después de
desplegar, con `verify:smoke` y el simulador. Lo que sí queda cubierto antes es
todo lo demás, que es donde está el riesgo caro: dinero, pedidos, catálogo,
sesiones y migraciones.

### La franja

`src/lib/franja-entorno.ts`. La página dice de qué entorno es: «STAGING · datos
de mentira» en índigo, o «⚠️ LOCAL · BASE REAL» en rojo. En producción no se
pinta nada y el HTML se sirve por `sendFile`, intacto y con su ETag.

⚠️ Al conectarla apareció un fallo de la familia de siempre: salía en la tienda
y **no** en los dos paneles. `express.static` sirve él mismo el `index.html` de
la carpeta (`/app`), sin pasar por `enviarHtmlDeSpa`, y el comodín `/app/*` no
casa con `/app`. La tienda se salvaba solo porque `/t/<slug>` nunca casa con un
archivo. Hay un guardián que exige que la ruta explícita de cada panel se
declare **antes** que su `express.static`.

## Los tipos de la base, generados desde la base (2026-09-19)

Cierra la familia del incidente del 2026-08-02: había **115 `as`** en la capa de
datos que el compilador no comprobaba, porque afirmar un tipo no es
verificarlo. Destapó cuatro bugs reales.

`src/db/tipos-generados.ts` lo escribe la CLI de Supabase leyendo el esquema
real — 57 tablas y 74 funciones. Se regenera con
`npm run tipos:generar -w @botpanel/server` y se comprueba contra la base con
`tipos:verificar`.

⚠️ **Generarlos NO sirve de nada por sí solo**, y esto se descubrió aquí mismo:
los tipos se generaron, el proyecto compiló a la primera con **cero errores**…
porque 22 repositorios declaraban `const db: SupabaseClient`, que es
`SupabaseClient<any>` y convierte la base entera en un `any` con buenos
modales. El patrón «construido y desconectado» otra vez, esta vez en los tipos.

Al enchufarlos de verdad (`SupabaseClient<Database>`) salieron **71 errores en
16 repositorios**. Seis quedaron tipados; los otros dieciséis fallan por el
mismo desajuste —el código pasa `null` explícito donde los tipos generados de
una RPC con DEFAULT esperan `undefined`— y **no se han "arreglado" a la fuerza**:
meter conversiones sería volver exactamente a los `as` que causaron el
incidente. Se tipan cuando se toquen, uno a uno.

`tipos-de-la-base.test.js` vigila las tres cosas que importan: que toda tabla de
`schema.sql` tenga sus tipos, que el cliente lleve `<Database>`, y que la lista
de pendientes **solo pueda encoger** — un repositorio nuevo nace tipado.

### Dos cosas que destapó el tipado

**`sales.sold_at` era nullable.** Tenía `default now()` pero no `not null`, y
`services/reports.ts` la declara `string` y hace `new Date(v.sold_at)` en tres
sitios: con NULL eso no lanza, devuelve el epoch, así que esa venta se habría
contado en **1970** y habría desaparecido de los reportes del dueño sin un solo
error en ningún log. Había 0 de 9 ventas afectadas. Cerrado con
`migration-2026-09-19-venta-sin-fecha.sql`, que rellena con `created_at` lo que
hubiera antes de exigir el NOT NULL.

**`verify:drift` daba un falso positivo permanente.** El lado de `schema.sql`
contaba solo `BASE TABLE` mientras que el de producción lee el catálogo de
PostgREST, que **expone vistas igual que tablas**. Así, la vista
`marketplace_cajones_de_negocio` —que `schema.sql` sí crea— salía eternamente
como «producción la tiene y schema.sql no». Un detector que grita en falso se
acaba ignorando, que es justo lo que no le puede pasar al guardián del esquema.

## El respaldo, por fin automático (2026-09-23)

**El comando existía desde hacía meses y no lo corría nadie.**
`npm run backup -w @botpanel/server` funciona, se autoverifica restaurando en
un PostgreSQL limpio, y se ejecutó **seis veces en agosto**. Después, nunca más.

El 2026-09-23 el proyecto de Supabase estuvo **~39 horas sin existir** —dejó de
resolver el DNS; se arregló pagando el plan—. Producción seguía viva pero
ciega: `/api/health` daba `ok:false` y la cola llevaba desde el día 21 sin
llegar a la base. **El respaldo más reciente era del 2026-08-23: un mes.** Si en
vez de un impago hubiera sido un borrado, se perdía el mes entero.

`.github/workflows/respaldo.yml` lo corre **cada día a las 05:00 de Ecuador**.

### Qué hace, y qué NO

1. `pg_dump` de la base de producción.
2. **Comprueba el inventario** (`.github/scripts/respaldo-sano.mjs`): exige las
   seis tablas sin las que el respaldo no sirve y un mínimo de 30 con datos.
3. **Lo restaura en un PostgreSQL limpio** y comprueba que traen datos
   `businesses`, `products` y `orders`. Generar un dump no demuestra nada; que
   vuelva a entrar, sí.

   ⚠️ **La imagen es `pgvector/pgvector:pg17`, no `postgres:17`.** El esquema
   usa columnas vectoriales y con la imagen oficial **`products` no se
   restaura**: la comprobación pasaba con 53 tablas y sin catálogo, que es
   justo el tipo de verificación que no verifica. Con pgvector entran las 54 y
   los datos cuadran con producción (2 negocios, 23 productos, 71 pedidos).
   Por eso `products` está en la lista que se comprueba: si alguien cambia la
   imagen, esto lo caza.
4. Lo **cifra** y lo guarda como artefacto 90 días.
5. Si algo falla, el workflow queda en rojo — y ese rojo **es** el aviso, igual
   que en los vigías. Sin integraciones ni cuentas nuevas.

**NO cubre:** que el respaldo salga de GitHub. Si se pierde la cuenta, se
pierden los artefactos. Para eso hay que bajarse uno de vez en cuando.

### ⚠️ Las tres trampas que costaron encontrar

**1. El host directo de Supabase es IPv6 PURO.** `db.<proyecto>.supabase.co` no
tiene registro A, solo AAAA. Los runners de GitHub no tienen IPv6, así que desde
ahí es inalcanzable — por eso el script local necesita Docker con
`--network host` (ver [[feedback_respaldo-ipv6]]). **La salida es el pooler**,
que sí responde por IPv4 y en modo sesión (puerto 5432) admite `pg_dump`.

**2. El usuario del pooler NO es `postgres`, es `postgres.<proyecto>`.** Y
**cada pooler solo conoce sus propios proyectos**: apuntar a otra región
devuelve `Tenant or user not found` aunque la contraseña sea correcta, que es un
error que no dice lo que pasa. El de este proyecto es
`aws-0-us-east-1.pooler.supabase.com` — Virginia, desde el traslado del
2026-09-26. El de São Paulo era `aws-1-sa-east-1`: el prefijo cambia de un
proyecto a otro.

**3. `pg_dump` 16 se niega a volcar un servidor 17**: «aborting because of
server version mismatch». Ubuntu trae el 16, así que el workflow instala el 17
desde PGDG.

### Los dos secretos que necesita

| secreto | qué es |
|---|---|
| `BACKUP_DATABASE_URL` | la cadena del **pooler**, no la directa |
| `BACKUP_PASSPHRASE` | con la que se cifra el dump |

⚠️ **La frase va en un gestor de contraseñas.** Un secreto de GitHub no se puede
volver a leer: si se pierde, los respaldos cifrados no se abren nunca más y
entonces no son respaldos.

Para abrir uno:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in respaldo.dump.enc -out respaldo.dump
pg_restore --no-owner --no-privileges -d <destino> respaldo.dump
```

## El traslado de la base a EE. UU. Este (2026-09-26)

La base vivía en **São Paulo** y el servidor en **Virginia** (Railway us-east4):
cada consulta cruzaba el continente, ~140 ms, y un mensaje del chat hace entre
6 y 10. Se trasladó al proyecto «Umbani» en **us-east-1**. La consulta de la
salud (`base_ms`) pasó de ~140 ms a ~25 ms. El corte dejó el servidor parado
4 min 40 s.

⚠️ **Supabase da EXECUTE a `anon` en cada función que se crea** (permisos por
defecto), y `pg_dump` no lo deshace: vuelca los permisos respecto a los de
PostgreSQL, no a los del proyecto destino. En el ensayo, funciones que en
producción solo ejecuta el servidor —`create_storefront_order`,
`block_customer_temporarily`…— quedaron ejecutables con la clave pública. Por
eso **el `--no-privileges` del respaldo diario NO sirve para trasladar**: el
traslado vuelca CON permisos y después aplica un guion generado desde la base
vieja con `aclexplode` (revocar a PUBLIC/anon/authenticated/service_role y
conceder exactamente lo de producción).

**Lo que decidió que el traslado era bueno** no fue «el volcado terminó», fue
comparar una huella de las dos bases —filas y contenido de cada tabla, RLS,
permisos, código de cada función, disparadores, índices, restricciones, vista y
extensiones— y exigir cero diferencias: 786 hechos idénticos. Las restricciones
CHECK se comparan sin paréntesis: PostgreSQL los reescribe al recrearlas
(`((a AND b) AND c)` → `(a AND b AND c)`) sin cambiar lo que dicen.

Otras trampas del día:

- **Railway no deja un servicio con cero réplicas.** `railway scale us-east=0`
  lo MUDÓ a us-west2 con una réplica. Para parar de verdad: `railway down`, y
  `railway redeploy --from-source` para volver a arrancar desde `main`.
- **Las extensiones van en el MISMO esquema que en origen**: `pgcrypto`,
  `pg_trgm` y `unaccent` en `extensions`; `vector` y `btree_gist` en `public`.
- **Una contraseña con `@` rompe `pg_dump`/`psql`** aunque Node la lea bien, y
  el error imprime un trozo de ella. Tras cambiarla, el pooler tarda ~30 s en
  aceptar la nueva.
- Las fotos y los comprobantes viven en Cloudinary: el traslado es solo la base.

El proyecto de São Paulo quedó intacto como vuelta atrás: volver es devolver
las tres variables `SUPABASE_*` de Railway (lo escrito después del corte se
perdería).

---

## Los recorridos de punta a punta (2026-10-01)

`npm run test:recorridos -w @botpanel/server` · trabajo `recorridos` del CI (el
séptimo) · `server/tests/recorridos/`.

Todas las capas de arriba prueban **piezas**: Vitest prueba rutas y servicios
con la base simulada, `verify:schema` ejecuta las funciones SQL una a una, el
E2E de Playwright pinta los paneles con la API interceptada. Ninguna recorría
un pedido **entero** como lo vive la gente —el cliente pide y paga, el local
acepta, prepara y entrega, el dinero se reparte y se liquida el lunes— con el
servidor hablando con la base por HTTP, que es como corre en producción. Un
fallo en la **costura** entre dos piezas probadas no lo veía nadie.

### Qué recorre

| Archivo | El recorrido |
|---|---|
| `00-escenario` | Las cuatro puertas abren: servidor, cliente por WhatsApp, cliente por la app, local. Nada sale a internet. |
| `01-efectivo` | Lo de la carta es lo que se cobra · pedido idempotente · aceptar, preparar línea a línea, salir, entregar · UNA venta · el libro cuadra al centavo (local + envío + Umbani = total) · los tres avisos al cliente · el candado de la bolsa |
| `02-transferencia` | Por la app (la puerta de Flutter): la cuenta del local, `esperando_pago`, confirmar el pago (la segunda vez no hace nada), entregar, el dinero en manos del local |
| `03-tarjeta-y-reembolso` | Cobro preparado desde el servidor · sin pago el local no puede aceptar · paga y vuelve → captura al instante · paga y **no vuelve** → la tarea lo confirma igual · cancelado ya cobrado → **se devuelve solo** · PayPhone cobra otro monto → no se da por pagado y se devuelve · tarjeta rechazada · la comisión de PayPhone en el libro |
| `04-cancelaciones` | Rechazo con aviso · transferencia que caduca · cancelar en camino · un pedido entregado NO se cancela |
| `05-liquidacion-semanal` | Efectivo + transferencia + tarjeta en una semana → cierre del lunes al centavo · cerrar dos veces no crea nada · Pagos del superadmin y «Mis pagos» dicen lo mismo · marcar pagada deja rastro en el registro de dinero y no se paga dos veces |
| `06-precios-desde-el-panel` | Envío (dueño), margen y tarifa (superadmin) cambiados desde los paneles llegan YA a la carta, la cotización y el cobro · el pedido de antes queda congelado |

### Cómo está montado

- **La base es la del staging local** (`supabase start`), vaciada y sembrada con
  el MISMO `preparar()` de `staging.mjs` —que usa la plantilla real del alta— más
  lo que un recorrido necesita (`entorno.mjs`). ⚠️ **Vacía el staging local:**
  los datos de mentira que hubiera se pierden.
- **El servidor es el compilado de verdad**, arrancado con
  `interceptor.cjs` delante: desvía TODA llamada a internet —axios, `fetch` y
  `https.request`— al **proveedor falso** (`proveedores-falsos.mjs`), que
  contesta como PayPhone y YCloud y anota lo que recibe. Así se comprueba qué se
  le cobró a la tarjeta, qué se devolvió y qué mensaje le llegó al cliente, sin
  gastar un centavo ni escribirle a nadie.
- **Cada actor entra por su puerta real** (`actores.mjs`): el cliente por el
  chat (simulador del panel) o por la app (código por WhatsApp); el local con su
  correo y contraseña; el superadmin con su token (firmado: los dos pasos tienen
  sus propias pruebas).
- **El reloj:** la semana solo se cierra cuando terminó, así que la liquidación
  lleva sus pedidos a una semana pasada (`reloj.llevarALaSemana`) y la base de
  la prueba adelanta el corte. Es lo único que no pasa por una pantalla.
- **Los frenos son de verdad** y saltaron al correr la batería entera (8 pedidos
  por minuto por IP; 5 intentos de tarjeta por hora por cliente). No se
  apagan: cada archivo llega desde su propia red (`X-Forwarded-For`, como detrás
  de Railway) y `recogerLaMesa()` pasa los cobros anteriores a «ayer».

### Lo que encontró el primer día

Tres fallos que las otras capas no veían, los tres en la COSTURA:

1. **El candado de la bolsa daba 500.** `set_order_status` respondía
   `incompleto` / `not_pickable` desde #407, pero la ruta del panel no los
   conocía: el dueño leía «la base de datos devolvió una respuesta inválida»
   en vez de QUÉ faltaba. Ahora 409 con lo que falta.
2. **La tarjeta sin cobrar daba 500.** El disparador
   `orders_card_requires_payment` lanza `22023` y la ruta lo trataba como fallo
   del servidor. Ahora 409 con su motivo.
3. **💰 El cliente veía una tarifa y pagaba otra.** La tienda guarda la tarifa
   de servicio un minuto en memoria (`tarifa-de-servicio.ts`) y nadie la
   olvidaba al cambiarla: durante ese minuto el carrito decía $4,62 y se
   cobraban $4,77. Guardar la tarifa en el panel ahora la olvida en el acto.

### Qué NO cubre

- **WhatsApp de verdad** (YCloud y Meta son falsos) ni **PayPhone de verdad**:
  la forma de sus respuestas está copiada de su documentación y del sandbox; si
  ellos la cambian, esto no se entera. Lo vigila producción (el cuadre diario).
- **El comprobante por foto** (descarga del medio, Cloudinary, OpenAI): tiene
  sus pruebas unitarias; aquí el local confirma el pago a mano.
- **Las pantallas**: eso es el E2E de Playwright. Esto prueba la API y el dinero.

### Correrlo en local

```
npm run staging:up                              # una vez: Supabase en Docker
npm run test:recorridos -w @botpanel/server     # ~2 min, compila antes
```

El registro del servidor queda en `$TMPDIR/umbani-recorridos-servidor.log`. ⚠️
`staging.mjs` usa `psql` si está instalado y, si no, el de un contenedor (en
Linux con `--network host`: allí no existe `host.docker.internal`).

---

## El staging en internet, y el candado de la base (2026-10-01)

El staging local solo se ve en el escritorio, en el modo móvil del navegador; el
dueño tenía que revisar los cambios en SU teléfono, y los desarrolladores de las
apps Flutter necesitan un servidor de pruebas (nunca se desarrolla contra
producción). Desde el 2026-10-01 hay uno en internet:

- **Servidor:** el entorno «staging» del proyecto de Railway, el mismo código.
- **Base:** un proyecto de Supabase en una organización GRATUITA (se duerme a los
  7 días sin uso y se despierta desde su panel). ~3 USD/mes en total, aprobado.
- **Credenciales:** variables del entorno «staging» de Railway y
  `server/.env.staging-remoto` (ignorado por git). Ninguna en el repositorio.

```
npm run staging:remoto -w @botpanel/server -- preparar   # vacía y siembra SU base
npm run staging:subir                                     # despliega la rama en revisión
npm run staging:remoto -w @botpanel/server -- humo        # la prueba de humo, contra él
```

### `UMBANI_ENTORNO=staging`

Para el resto del código el staging en Railway ES un despliegue de verdad
(tareas de fondo, `BASE_URL` obligatoria). Lo que cambia por ser staging lo
decide `esStaging(env)`:

- pinta la franja «STAGING · datos de mentira» (antes se apagaba en Railway);
- **la tarjeta nunca cobra de verdad**: con `PAYPHONE_MODO=produccion` se queda
  sin tarjeta. Las credenciales de PayPhone son las mismas en pruebas y en
  producción; copiar las variables bastaría para cobrar tarjetas reales.

### 🔐 El candado de la base

Una variable mal copiada pondría un staging a procesar los pedidos de los
clientes de verdad —sus tareas de fondo expiran pedidos y cierran la semana—, o
a producción a servir locales inventados. No se le pregunta a quien despliega:
se le pregunta a la BASE. La de staging lleva `server_settings.entorno =
'staging'` (la pone su semilla, y está FUERA de `ALLOWED_KEYS`: ninguna pantalla
puede escribirla); la de producción no lleva nada. Antes de abrir el puerto
(`config/identidad-de-la-base.ts`):

| Proceso | Base | Qué pasa |
|---|---|---|
| staging | marcada | arranca |
| staging | sin marca | **NO arranca** (podría ser producción) |
| staging | no responde | **NO arranca** |
| producción | sin marca | arranca |
| producción | marcada | **NO arranca** (datos de mentira) |
| producción | no responde | arranca — una caída de red al desplegar no puede tumbarla |

Comprobado de verdad, no solo en pruebas: con la marca borrada, el servidor de
staging sale con código 1 y dice por qué.

### Los permisos de la siembra, cerrados

Al vaciar el esquema se van los `grant` de Supabase y la siembra los devolvía
**a todos los roles, también `anon`**: eso deshacía los 135 `revoke … from anon`
de `schema.sql` sobre las funciones del dinero y abría a la clave pública las
tablas sin RLS (`server_settings`, con la clave de dos pasos del superadmin). En
el Docker de una máquina daba igual; en internet, no. Ahora solo reciben
permisos `postgres` y `service_role` —el servidor no usa otro—, en el staging
local y en el de internet, y los 49 recorridos pasan igual.

### La guardia del `preparar` remoto

Vacía una base, así que se niega si: la dirección es local, la dirección es la
de producción (la de `server/.env`), o la base tiene negocios y NO lleva la
marca de staging. La última es la que de verdad protege.

### Qué NO cubre

- **WhatsApp:** el staging no tiene número. Las conversaciones se prueban con el
  simulador de su panel de superadmin (también el código de inicio de sesión de
  la app: «Mi código de Umbani: XXXXXX»).
- **La tarjeta** solo funciona si su dominio está registrado en PayPhone
  (pruebas): lo registra el dueño en su portal.
