# PENDIENTE.md — módulos futuros y decisiones de NO construir

Movido de `CLAUDE.md` **sin cambiar una frase**.

> **No construir nada de aquí de forma especulativa.** Cada entrada está
> anotada con lo que haría falta definir ANTES de empezar, y varias existen
> justamente para dejar constancia de que se decidió *no* hacerlas todavía.
> Esperar la señal de un cliente o piloto real.

---

- **`max_total_quantity`: una columna que nadie mira.** Hallada el 2026-08-09 auditando el motor contra el diagrama. El dueño la configura desde `Catálogo → Personalización` —la ruta la sanea, la base la guarda y su CHECK la valida entre 1 y 100— y **nadie la comprueba al pedir**: ni `create_storefront_order`, ni `quoteCart`, ni la app. Hoy no se cuela nada por ahí: en los grupos `quantity` la RPC cuenta las PORCIONES y las compara contra `max_selectable`, así que el tope existe. Lo que **no** se puede expresar es la diferencia que dibuja el diagrama —«Salsas: selecciona entre 2 y 4 · **Total seleccionadas: 3 de 3**»—, donde hay DOS límites: cuántas salsas distintas y cuántas porciones en total. Antes de construirlo hay que **decidir qué significa cada columna**, porque hoy `max_selectable` hace de las dos cosas según el tipo de grupo; y tocarlo implica recrear `create_storefront_order`, la función que cobra. Mientras tanto el panel deja configurar algo que no hace nada, que es peor que no ofrecerlo. Va con **arquitecto-saas** + **base-de-datos**.
- **Turno partido: dos tramos de horario en un mismo día.** NO existe, y es la limitación real frente a Rappi o PedidosYa (anotada 2026-09-02, decidida con el dueño: **no construir todavía**). Hoy `business_schedule` lleva `unique (business_id, day_of_week)`: **un día admite un solo tramo**. Un restaurante que abre `12:00–15:00` y `19:00–23:00` no se puede configurar — o abre seguido de 12:00 a 23:00 (y el bot acepta pedidos a las 16:00, cuando la cocina está cerrada) o pierde uno de los dos servicios. ⚠️ **Así se llegó al horario raro que destapó tres bugs**: el dueño intentaba cubrir la madrugada, el día solo le daba un tramo, y acabó con «miércoles 00:00–03:00» — un miércoles cerrado de día entero y 30 h seguidas sin poder pedir. Los bugs se arreglaron (#319, #320); la limitación que llevó a esa configuración sigue aquí. **Qué habría que tocar**: migración para quitar el `unique` y permitir varias filas por día (con CHECK de que no se solapen entre sí); `services/schedule.ts` —`turnoVigente` ya devuelve el tramo que cierra más tarde, así que aguanta varios, pero `todaysHours` tendría que enseñar **los dos** («12:00–15:00 · 19:00–23:00») en vez de uno; el panel del dueño (hoy una fila por día); `buildScheduleMessage` y `scheduleToText`, que arman el texto del bot; y las RPC de reserva que leen el horario. ⚠️ **Antes de empezar hay que decidir qué se enseña en la portada** cuando hay dos tramos y el cliente está en el hueco: «cerrado, abre a las 19:00» es lo honesto, y hoy `todaysHours` solo sabe devolver un par. Va con **base-de-datos** + **arquitecto-saas**. **Señal para construirlo**: el primer local que cierre a mediodía — un restaurante de almuerzos, una panadería con turno de tarde.
- **Sucursales / multi-local por negocio.** Un negocio con varios locales. Enfoque **aditivo** cuando se pida: tabla `locations` + columna `location_id` (nullable) en `products`, `sales`, `conversation_sessions`. Los negocios de un solo local quedan con `location_id` nulo (sin cambios). NO construir de forma especulativa: mete "impuesto de complejidad" a todos y toca multi-tenancy (filtrar por `business_id` **y** `location_id`). Requiere definir antes: ¿cada sucursal tiene su propio número de WhatsApp?, ¿comparten catálogo?, ¿un empleado pertenece a una o varias? Va con **arquitecto-saas**.
- **Ventas por sucursal** (reporte) depende del módulo anterior.
- **Perfil de cliente ampliado (paso 2 del directorio de clientes).** Agregar al directorio: **ciudad, cédula y correo del cliente**, y permitir **buscar por cédula y correo**. Hoy NO se recopilan esos datos. Requiere definir: (a) dónde se guardan (tabla/perfil de cliente por `business_id`, hoy el cliente es solo `contact_phone` disperso en `sales`/`conversation_sessions`), y (b) **cómo se capturan** (¿el dueño los escribe a mano?, ¿el bot los pide?). ⚠️ La **cédula es PII sensible** → va con **seguridad-saas** (para qué se usa, consentimiento, almacenamiento cuidado). El directorio base (nuevos/frecuentes/inactivos, última compra, total gastado, frecuencia, búsqueda por nombre/teléfono) YA está hecho.
- **Alertas — Fase 2 (push instantáneo) y Fase 3 (resumen diario).** La Fase 1 YA está hecha: **banner de alertas en el panel** (sección Reportes, endpoint `/api/client/alerts` → `reports.computeAlerts`), que vigila con los cálculos existentes. Falta: (a) **Fase 2 — push por WhatsApp al dueño** de las críticas, con hook en `server/src/services/bot-conversation.ts`/venta, umbral configurable y anti-duplicado; (b) **Fase 3 — resumen diario**, programado desde `server/src/index.ts`. ⚠️ Toca envío y multi-tenancy → va con **arquitecto-saas**.
- **Reporte de IA — Fase 2: con IA.** La Fase 1 YA está hecha (sin IA): preguntas frecuentes por reglas y huecos persistidos en `ai_gaps`. ⚠️ Quien los escribía era `bot-actions.ts`, retirado el 2026-09-16 con el pedido por chat: hoy **nada alimenta `ai_gaps`**, así que esta fase arranca de cero y su primer paso es decidir desde dónde se detecta un hueco. Falta agrupar preguntas abiertas y sugerir automáticamente mejoras por lotes. ⚠️ Usa IA sobre conversaciones → va con **seguridad-saas** y **arquitecto-saas**.
- **Clientes perdidos — Capa 2: razón completa.** El reporte "Clientes perdidos" (Capa 1) YA está hecho: lista de quienes **escribieron pero no compraron en el período**, con badge 🔁 ya-cliente / 🆕 nuevo y razón automática **"No respondió"** (el negocio habló al final). Falta la **razón completa**: **Precio / Sin stock / Cambió de opinión** (hoy quedan como "Sin clasificar"). Requiere definir el método de captura: (a) **manual** — el dueño marca la razón por cliente desde el panel (columna nueva, ej. tabla `lost_customers` o campo en sesión, por `business_id`); (b) **IA infiere** — clasificar leyendo la conversación (costo de llamadas IA, ~aproximado); (c) **mixto**. ⚠️ Si se usa IA sobre conversaciones del cliente → va con **seguridad-saas**; en todo caso con **arquitecto-saas** (dónde persiste la razón sin romper multi-tenancy). Entregar al usuario para analizar antes de construir.
- **Campañas / difusión (mensajes salientes).** NO existe. Mandar una promo a una audiencia (todos, clientes perdidos, en riesgo). Cimientos listos: envío (`ycloud.sendText/sendImage`, Telegram) + audiencias ya calculadas (directorio, perdidos, riesgo). Falta: módulo que arme el mensaje + elija audiencia + envíe a muchos, tabla de campañas + control de envíos, y UI. ⚠️ Envío proactivo en WhatsApp fuera de la ventana de 24h exige **plantillas aprobadas por Meta** + opt-in. **Construir SOLO después de estabilizar el canal (Meta) y el deploy.** Va con **arquitecto-saas** + **seguridad-saas**.
- **Asistente de voz para el dueño ("Jarvis" — ElevenLabs).** NO existe. Que el bot responda con nota de voz al `owner_phone`. Falta key mediante `server/src/services/settings.ts`, generación TTS, envío por la integración del canal y control de costo. ⚠️ Va con **arquitecto-saas** + **seguridad-saas** después del deploy + Meta.
- **Recordatorios automáticos de citas — RETIRADO el 2026-08-16.** La agenda salió con la fase 2 de dejar Umbani solo con domicilios, así que no hay a qué poner recordatorios. La familia de mensajes salientes (campañas, avisos proactivos) sigue viva y sigue esperando a Meta + deploy.
- **Hospedaje — RETIRADO el 2026-08-16.** El módulo salió entero en la fase 1 de dejar Umbani solo con domicilios, así que sus extensiones futuras (iCal con Booking/Airbnb, calendario de ocupación, inventarios de muchos tipos) dejan de estar pendientes: no hay a qué añadirlas. La decisión y el porqué están en [DECISIONES.md](DECISIONES.md#el-cuarto-camino-hospedaje-retirado); el código, en el historial del PR de esa fase.
- **Reglas de descuento automáticas por código (promos).** NO existe (anotado 2026-07: construir SOLO cuando un cliente real lo pida). Que el dueño configure promos con condiciones desde su panel — ej. "10% en pedidos sobre $50", "2x1 los martes", "descuento por combo" — y que las aplique el núcleo de dinero en el campo `discount` que YA existe en `orders` (cimiento listo). ⚠️ Ese núcleo es hoy la RPC `create_storefront_order` en PostgreSQL, no `services/money.ts`, que se retiró el 2026-09-16 con el pedido por chat. La IA solo ANUNCIA la promo; la condición y la resta las calcula el SERVIDOR (regla inviolable #8: la IA jamás decide montos). Requiere: tabla de reglas por `business_id` + RLS, UI en el panel del dueño, y lógica de condiciones dentro de la RPC (monto mínimo, día de semana, producto/combo). Mientras tanto, el **Precio oferta** (`price_sale`) por producto ya cubre promos simples y el núcleo lo respeta. Va con **arquitecto-saas** + **base-de-datos**; diseñar con el caso real del cliente que lo pida, no especulando.
- **Blindaje anti-invención de la IA — fase 2 (anotado 2026-07-18; construir cuando haya clientes grandes o antes de pasarelas de pago).** La fase 1 YA está hecha: grounding con datos reales, núcleo de dinero determinista, etiquetas con fallo cerrado, y detector de suplantación de resúmenes oficiales (`bot-tags.impersonatesOfficialSummary`, PR #100 — la IA imitó una cotización con datos inventados y ahora se descarta y deriva). Faltan tres capas, TODAS internas (no son pantallas de paneles): (1) **Evals de comportamiento** — comando interno tipo `npm run evals` con ~20 conversaciones doradas por tipo de negocio contra el bot real, verificando automáticamente "¿inventó datos/montos? ¿emitió la etiqueta correcta? ¿derivó cuando debía?"; correr antes de demos y al cambiar prompt o modelo (costo: centavos por corrida; es la capa que más paga por esfuerzo — construir primero). (2) **Validador de precios en salida** — chequeo en vivo en `bot-conversation`: todo monto `$X` que escriba la IA se compara contra el catálogo real del negocio; si no existe → se descarta el mensaje y deriva (fallo cerrado). ⚠️ Requiere calibrar falsos positivos con los evals del punto 1; va con **arquitecto-saas** + **seguridad-saas**. (3) **Modelo fuerte por negocio** — NO es código: palanca operativa que ya existe en el panel admin (proveedor de IA por negocio); asignar OpenAI a clientes grandes/pagantes. Regla para pasarelas de pago futuras: la IA JAMÁS toca el camino del pago — monto del pedido calculado por código, enlace generado por el servidor, la IA solo lo anuncia.
- **Optimización de egress / consumo de datos de Supabase.** NO hecho (decidido con el usuario 2026-07: por ahora se paga/aguanta, no se toca el código; anotado para cuando se justifique). **Contexto:** en plan free (5 GB egress/mes = datos leídos que SALEN de la base, NO storage) el consumo llegó a ~5.47 GB **sin subir archivos pesados**. Causa: **polling del panel** — `loadConversations` cada **3s** trae hasta **100 mensajes completos** + todas las sesiones con `select('*')`; `checkForUpdates` cada 5s; `checkNewBookings` cada 12s. Se acumula solo con el panel abierto. Segundo culpable histórico: lecturas de catálogo que incluían el `embedding` vector(1536); revisar `server/src/db/repositories/products.ts` antes de optimizar. **Cloudinary NO influye** (la media va a Cloudinary, no a Supabase). **Optimizaciones pendientes (por impacto/riesgo):** (1) bajar polling de conversaciones 3s→~10s + **pausar con Page Visibility API** cuando la pestaña no está visible → corta ~70-80%, riesgo mínimo; (2) confirmar selects mínimos del catálogo; (3) traer **solo lo nuevo** en conversaciones en vez de 100 completos; (4) detectado 2026-07-16: `reports.getAllReports` lanza ~8 lecturas idénticas de `getSalesWithItems` por carga (una por cada compute) — deduplicar trayendo las ventas UNA vez y pasándolas a los cálculos. **Alternativa operativa:** Supabase Pro. **Solución de fondo:** Realtime/WebSockets + caché cuando el volumen lo justifique. Va con **arquitecto-saas** + **base-de-datos**.

> **Estado del producto (nota estratégica):** el sistema está **listo para vender/demo**. La construcción de features está **en pausa a propósito** — el siguiente paso es **operativo**, no de código: demo → cambiar número a **Meta** (hoy YCloud) → **deploy 24/7 en servidor real** (hoy corre local + túnel). Campañas y recordatorios (los dos únicos que envían mensajes salientes) van **después** de eso. No construir más módulos de forma especulativa; esperar señal de un cliente/piloto real.

> **Escalabilidad (nota de arquitectura, a futuro):** hoy es un **monolito** (un solo servidor Node + Express). Es lo **correcto para la etapa actual** (primeros clientes) — simple, barato, fácil de operar. NO refactorizar de forma especulativa. Cuando haya **demanda real de escala** (muchos negocios/mensajes concurrentes), recién ahí evaluar: **Realtime/WebSockets** (empujar cambios al panel en vez de que pregunte cada X segundos — ataca de raíz el egress del polling), **caché (Redis)** (datos muy leídos en memoria, sin golpear la base), **colas** (procesar mensajes/IA sin bloquear), **workers** separados (envíos, embeddings, reportes pesados, transcodificar media), varias instancias + balanceador, réplicas de lectura, y quizás separar el bot del panel. Antes de todo eso, el paso barato es **Supabase Pro ($25/mes)** para subir los límites. Es un "problema de éxito": se aborda cuando el volumen lo justifique, no antes.

---

## EN CURSO — Pedidos como sección propia (decidido 2026-08-02)

**No es especulativo: sale de un cliente real** (Monster Pizza, creado hoy) y del diagrama
de flujo que trajo el dueño del SaaS.

### El diagnóstico

Medido en el código, no supuesto:

- **La alarma existe pero es sorda a los pedidos.** `components/AlarmSystem.tsx` suena y
  notifica por modo manual y reservas. `orders` NO está en la lista.
  Lo alimenta `hooks/useAttention.ts`, que tampoco los trae.
- **Los pedidos viven en el sitio equivocado:** `features/sales/Sales.tsx`, pestaña
  «Pedidos del bot», con recarga cada 15 s.

Son dos momentos distintos del negocio y por eso duele: un **pedido** llega y hay que
atenderlo ya, lo inicia el cliente; una **venta** se registra cuando ya se cobró, la cierra
el negocio. Meter el pedido dentro de Ventas obliga al dueño a entrar a «registrar una
venta» para ver algo que todavía no vendió — y por eso nadie conectó nunca la alarma ahí.

### El orden acordado

1. ~~**Que la alarma oiga los pedidos.**~~ ✅ **HECHO (2026-08-02).** `useAttention.ts`
   vigila `/api/client/orders?status=pendiente` cada 12 s —filtrado en la base, no 100
   pedidos con sus ítems— y `AlarmSystem.tsx` suena, avisa por notificación del navegador
   y lleva a atenderlo. Sigue consultando **con la pestaña en segundo plano** (único
   vigilado que lo hace: un pedido no espera a que el dueño vuelva a la pestaña).
   Cubierto por un E2E de regresión: entra un pedido con el panel abierto → banner solo.
   ⚠️ **Sigue habiendo un hueco real:** con el panel CERRADO no hay aviso. Cerrarlo es
   avisar por WhatsApp/Telegram al dueño (Alertas Fase 2), que exige el canal en Meta.
2. ~~**Sección Pedidos propia**, como bandeja de entrada, fuera de Ventas.~~ ✅ **HECHO (2026-08-02).**
   `/orders` con su entrada en el menú (badge de pendientes), la máquina de estados completa
   —aceptar → preparación → en camino → entregado, y rechazar en cualquier punto—, dirección
   de entrega, método de pago y comprobante a la vista. Ventas quedó solo para lo ya cobrado.
   El botón «Atender» de la alarma ya lleva ahí.
3. **El puente a la cooperativa de reparto**, cuando el pedido pasa a «en camino».

### La decisión que NO podía esperar — ✅ HECHA (2026-08-02)

`orders.status` ya acepta **`preparacion`** y **`en_camino`**, con la tabla todavía vacía:
`migration-2026-08-02-estados-pedido.sql`. El flujo va siempre hacia adelante, se puede
saltar pasos, no se retrocede, y `en_camino` está **prohibido en la base** para los pedidos
`pickup`/`onsite`. El porqué de cada regla está en
[DECISIONES.md](DECISIONES.md#los-estados-de-un-pedido).

⚠️ **Queda pendiente aplicarla en Supabase** (`npm run migrate`). Hasta entonces, el panel
ofrece los botones nuevos pero la base rechaza los estados.

### Lo que ya está resuelto y no hay que rehacer

- Cuenta bancaria del negocio: panel + `/api/store/:slug/payment-info` (PR #132).
- Tamaños, categorías y sabores: cargados y funcionando.
- El total lo calcula el servidor y el pedido NO viaja como mensaje de WhatsApp editable.

### Lo que sigue faltando del diagrama del dueño

Van DESPUÉS de las tres piezas de arriba, y en este orden. Cada uno lleva la trampa
que hay que tener presente antes de empezar:

**4. Selector de método de pago** — `orders` no tiene columna `payment_method`. Hoy el
pedido se crea y el negocio coordina el cobro por WhatsApp sin distinguir transferencia de
efectivo. Es el más pequeño de los tres y va primero porque **decide qué pantallas ve el
cliente después**: quien paga en efectivo no debe pasar por datos bancarios ni comprobante.

**5. Coste de envío** — el diagrama muestra `Envío $2.00` y en la base solo hay `subtotal`,
`discount` y `total`. ⚠️ **Este toca el núcleo de dinero (regla inviolable #8).** El importe
lo calcula `create_storefront_order` en PostgreSQL, así que el envío tiene que sumarse AHÍ,
nunca en el teléfono ni en el prompt. Hace falta decidir antes si es fijo por negocio, por
zona, o gratis a partir de un monto — y eso es una decisión del dueño, no del código.

**6. Subir el comprobante de transferencia** — hoy `OrderDone.tsx` le dice al cliente
«envía el comprobante por WhatsApp», que es lo que de verdad ocurre. Construirlo son dos
mitades: la subida desde la mini app (ya hay Cloudinary para media de productos) y verlo
en el panel junto al pedido. Va el último porque sin el método de pago no se sabe **a quién**
pedírselo.

**Tarjeta de crédito: descartada a propósito.** El diagrama la marca «próximamente» y así
se queda — la plataforma no procesa cobros (regla inviolable #6) y meter una pasarela
cambiaría el modelo de negocio entero, no solo una pantalla.

---

## Separar el delivery del agente de IA — decidido 2026-08-16

**Dos aplicaciones distintas**, cada una con su código, su base y su despliegue:

| Producto | Para quién | Qué lleva |
|---|---|---|
| **Delivery** | Comida y supermercados | Pedidos, motorizados, comisión por pedido, mini app |
| **Agente IA** | Barberías, clínicas, hoteles, consultorios, tiendas | Bot, citas, hospedaje, cuota mensual |

Se eligió la opción más cara a conciencia: *«es mejor separar ahora los negocios
que más adelante, y más con una de domicilios»*. Un delivery arrastra
repartidores, zonas y dinero de terceros que no tienen nada que ver con un bot
de barbería.

### ⚠️ Las FAMILIAS son el requisito, no lo siguiente

✅ **Las familias ya existen** (`business_families` + `business_type_families`,
2026-08-16) y la jerarquía de reglas es `negocio > tipo > FAMILIA > toda la
plataforma`. Antes había 52 tipos sueltos y cada uno era una isla: una regla
para `restaurante` NO alcanzaba a `pizzería`.

⚠️ **Pero la separación por familia ya no se puede hacer como estaba pensada.**
La fase 5 (2026-08-20) dejó Umbani solo con comida y retail: los tipos de
hospedaje, servicios y salud/belleza se retiraron del desplegable y sus tres
familias se borraron. La tabla de arriba describe un Agente IA que hoy **no
tiene dónde vivir en este repositorio** — habría que reintroducir esos tipos en
la aplicación nueva, no recuperarlos aquí.

Familias que llegaron a existir: **Comida · Retail · Hospedaje · Servicios ·
Salud y belleza**. Hoy quedan las dos primeras.

### Antes de arrancar, definir

1. Qué se lleva cada aplicación y qué se **comparte** — hoy el catálogo, el
   motor de opciones, los pedidos, la mini app y el motor de margen los usan
   los dos.
2. Si comparten base de datos o cada una la suya (afecta a `businesses`,
   `orders`, `sales`, `billing`).
3. Qué pasa con un negocio de comida que hoy usa el bot.
4. Si el motor de margen se duplica o se extrae a un paquete común.
5. Precios y cuotas distintos por producto.

### El modelo económico, ya cerrado

No volver a abrirlo. Se descartaron dos caminos por el camino:

- **`on_top`** (el margen dentro del precio) → *«lo que está en la app no tiene
  que subir de valor»*.
- **Tarifa de servicio visible al cliente** → *«el cliente se quejaría»*.

**El modelo es `absorbed`:** el comercio paga la comisión de su precio, como
hacen todas las plataformas grandes (15–30 %; aquí mucho menos, y ese es el
argumento de venta). Si quiere compensarla, **sube su precio en la app** —
decisión suya, no de la plataforma. Restaurante: porcentaje bajo o monto fijo
por pedido. Supermercado: porcentaje **con techo**, sin el cual nadie pediría
por la app.

**Pendiente de UI (fácil):** en el campo del precio del panel del dueño,
mostrar en vivo «recibes $X · comisión $Y», para que no tenga que hacer cuentas.


## Dos asperezas de la ficha del producto — decidido ESPERAR (2026-09-19)

Salieron al cerrar «una ficha, una cuenta» (#390). **No se construye nada
hasta que molesten de verdad al usarlo**, y esa fue la decisión del dueño:
*«por ahora dejemos así… si entras y ves un plato es porque te gusta; si no,
sales y ves otro»*.

### 1. Cerrar la ficha con la X pierde los acompañamientos marcados

Marcas 3 colas en la ficha de la pizza, no te convence ningún sabor, cierras
con la X → las colas desaparecen.

Es el precio exacto de que sea reversible, y la otra cara es la buena: marcar
cuatro panes por error y cerrar no te cuesta nada. **Si algún día molesta**, el
arreglo es un aviso al cerrar («tienes 3 cosas sin agregar, ¿salir igual?»).
No se pone antes de saber si hace falta: es una ventana más en medio.

### 2. Con el plato incompleto no se puede agregar NADA, ni lo que acompaña

Marcas 2 cervezas, no eliges la masa → el botón dice «Elige masa» y está
apagado. Para salir hay que cerrar, y al cerrar se pierden (ver el punto 1).

El razonamiento del dueño para dejarlo: **si entras a una ficha es porque ese
plato te interesa**; quien solo quiere cervezas las busca en la carta. Y lo
que sí reconoció como oportunidad —*«si yo quiero puedo hacerlo para vender
más, si solo escogen cervezas y ya»*— es justo eso, una idea de venta, no un
fallo que tapar.

**Si algún día se hace**, el botón tendría que cambiar de oficio según el
estado (`Agregar 2 cervezas · $3.30` cuando la pizza está a medias). Se puede,
pero un botón que cambia de significado confunde por otro lado: hay que verlo
con el caso real delante, no imaginado.

⚠️ **Lo que NO se toca al resolver ninguna de las dos:** que el botón diga solo
lo que entra al carrito con ese toque. Ver «Una ficha, una cuenta» en
[DECISIONES.md](DECISIONES.md).

## Cobro digital: dejar de revisar comprobantes (investigado 2026-09-20)

**El problema, en palabras del dueño:** *«es muy complicado para el dueño
revisar comprobantes, y si en ese momento le salen 15 pedidos, mejor que todo
sea más dinámico»*.

⚠️ **Esto cambiaría la regla inviolable #6 del CLAUDE.md** («Cobro manual»), y
hay piezas construidas encima — la validación de comprobantes con IA está
encendida en producción. No es un impedimento; es una decisión que hay que
tomar a conciencia.

### La decisión que va ANTES de elegir pasarela

**¿El dinero pasa por Umbani o va directo a cada local?**

- **Directo al local:** sin riesgo legal y el margen se sigue cobrando aparte,
  pero **cada local** tiene que cumplir los requisitos de la pasarela.
- **Por Umbani:** una sola integración, pero Umbani pasa a mover dinero de
  terceros —con lo que eso implica legal y fiscalmente en Ecuador— y tiene que
  liquidar a cada local.

**Bloqueante sin resolver: ¿Umbani está constituida como empresa con RUC?**

### Lo medido (septiembre 2026)

| | Comisión al comercio | Ambiente de pruebas | Requisitos |
|---|---|---|---|
| **Deuna** (B. Pichincha) | **0 %** | ❌ hay que ir al banco | empresa constituida + **cuenta corriente Pichincha** + contrato |
| **PayPhone** | ~5 % + IVA (se negocia) | ✅ público | cuenta PayPhone Business |
| Kushki | ~2,95 % + $0,25 | — | tiene pagos divididos |
| Datafast | 4,5 % débito / 6,5 % crédito | — | más burocrático |

⚠️ **La Deuna que todos tienen es la PERSONAL**, y esa no tiene API: con ella
se vuelve al comprobante. La que avisa es la **de comercio**, y ahí está la
barrera — un local de almuerzos de barrio difícilmente tiene empresa
constituida y cuenta corriente en Pichincha.

⚠️ **PayPal descartado.** Funciona en Ecuador, pero el retiro tarda **hasta 7
días hábiles** y cuesta hasta $5, la comisión se come un pedido de $3.50, y
nadie pide comida a domicilio con PayPal aquí. Sus disputas favorecen al
comprador: en comida entregada el local pierde el contracargo casi siempre.

⚠️ **`docs.deuna.com` NO es la Deuna del Pichincha** — es otra empresa. La
buena es `deuna.ec`.

### ✅ 2026-09-27: EN MARCHA — tarjeta por PayPhone, en la cuenta de Umbani

El dueño lo decidió («como las grandes») y ya tiene RUC. El cobro, la
confirmación sin depender del teléfono y la devolución están construidos
(ver [DECISIONES.md](DECISIONES.md#el-pago-con-tarjeta-entra-en-la-cuenta-de-umbani)).
Quedan, en este orden: la tarifa de servicio (igual para todo método), el
split «al día siguiente» con la liquidación a cada local, el endurecimiento de
seguridad (2FA del superadmin, auditoría de acciones de dinero) y el paso a
producción con contador, contrato y split aprobados. Lo de abajo es la
investigación que llevó hasta aquí.

### ⚠️ PayPhone NO tiene webhook, y eso decide el diseño

Su **Cajita de Pagos** se incrusta en la mini app y el cliente paga sin salir
ni generar enlace (Visa, Mastercard, Diners, Discover y saldo PayPhone), y
admite un `clientTransactionId` propio que devuelve al confirmar. Pero:

1. el cliente paga;
2. PayPhone **redirige** a una URL nuestra con `id` y `clientTransactionId`;
3. **nuestro servidor** debe llamar a `POST /api/confirm`;
4. **si no se confirma en 5 MINUTOS, la transacción se revierte.**

**La confirmación no puede depender de que el móvil del cliente cargue la
página de vuelta.** Si se le va el 4G, cierra la pestaña o entra en un túnel,
nadie confirma y el cobro se deshace solo: el cliente jura que pagó, el local
no ve el dinero y el pedido queda en el aire.

**Se resuelve con lo que ya existe:** guardar el `clientTransactionId` al crear
el pedido y que una tarea de la cola reintente `/api/confirm` hasta tener
respuesta firme, pase lo que pase con el teléfono. La redirección solo enseña
el resultado antes. Es el mismo principio que ya rige el dinero aquí: la
pantalla informa, el servidor decide.

⚠️ **Probarlo rompiéndolo:** cerrar la app justo después de pagar y comprobar
que el pedido acaba en «pagado» igual.

⚠️ **Las credenciales de prueba y producción de PayPhone parecen ser LAS
MISMAS** (el ambiente se cambia por configuración). Hace falta un aviso bien
visible de en qué modo corre, como la franja «STAGING · datos de mentira», o
se cobra de verdad creyendo que se prueba.

### Plan acordado

Las dos cosas en paralelo: montar contra el **sandbox de PayPhone** (se puede
empezar ya) y llamar a Banca Empresas de Pichincha preguntando (1) si una
plataforma puede cobrar por varios locales o cada uno necesita su contrato,
(2) si hay webhook y referencia propia, y (3) si hay ambiente de pruebas.

El trabajo no se tira si gana Deuna: la parte difícil —marcar el pedido como
pagado sin tocar comprobantes— es la misma para las dos.

## El pedido trazable — encargo anunciado, prompt pendiente

El dueño avisó (2026-09-20) de un módulo nuevo alrededor del pedido y quedó en
pasar un prompt. Sus palabras: **ir marcando lo que lleva el pedido** para que
no salga incompleto, **el sellado del pedido**, y **qué pasa si al repartidor
se le cae**. Pidió ver «cómo lo hacen las grandes empresas».

**No empezar sin ese prompt.** Y la decisión de fondo que hay que resolver
antes de diseñar nada: **quién responde de qué en cada punto del camino** — de
ahí sale qué se registra, quién paga un pedido perdido y si el cliente ve algo.

⚠️ Aquí el reparto **lo hace el propio local**, no una flota de Umbani. Las
respuestas de Rappi o Uber no se copian tal cual: ellos responden del
repartidor porque es suyo.

## Estrategia — dos notas que vivían en CLAUDE.md

_Movidas aquí el 2026-09-08: orientan el «¿y si añadimos…?», que es justo
lo que se consulta en este archivo, y no hacían falta en cada sesión._

> **Estado del producto (nota estratégica):** el sistema está **listo para vender/demo**. La construcción de features está **en pausa a propósito** — el siguiente paso es **operativo**, no de código: demo → cambiar número a **Meta** (hoy YCloud) → **deploy 24/7 en servidor real** (hoy corre local + túnel). Campañas y recordatorios (los dos únicos que envían mensajes salientes) van **después** de eso. No construir más módulos de forma especulativa; esperar señal de un cliente/piloto real.

> **Escalabilidad (nota de arquitectura, a futuro):** hoy es un **monolito** (un solo servidor Node + Express). Es lo **correcto para la etapa actual** (primeros clientes) — simple, barato, fácil de operar. NO refactorizar de forma especulativa. Cuando haya **demanda real de escala** (muchos negocios/mensajes concurrentes), recién ahí evaluar: **Realtime/WebSockets** (empujar cambios al panel en vez de que pregunte cada X segundos — ataca de raíz el egress del polling), **caché (Redis)** (datos muy leídos en memoria, sin golpear la base), **colas** (procesar mensajes/IA sin bloquear), **workers** separados (envíos, embeddings, reportes pesados, transcodificar media), varias instancias + balanceador, réplicas de lectura, y quizás separar el bot del panel. Antes de todo eso, el paso barato es **Supabase Pro ($25/mes)** para subir los límites. Es un "problema de éxito": se aborda cuando el volumen lo justifique, no antes.
