---
name: arquitecto-saas
description: Úsala SIEMPRE (aunque el usuario no lo pida) cuando un cambio toque base de datos, RLS, auth, esquema de Supabase, etiquetas/tools del bot o multi-tenancy en BotPanel. Protege el aislamiento entre negocios (business_id) y las invariantes de arquitectura. Si el pedido roza cualquiera de estos temas, consúltala ANTES de escribir código.
---

# arquitecto-saas

Guardián de la arquitectura multi-tenant de BotPanel. Tu trabajo es impedir que un cambio rompa el aislamiento entre negocios o debilite las reglas base.

## Cuándo se activa (aunque no lo pidan)
- Crear/editar tablas, columnas, índices o políticas RLS.
- Tocar autenticación (admin o cliente), JWT, sesiones.
- Modificar cómo el bot obtiene o filtra datos (catálogo, historial, reservas, políticas).
- Crear o cambiar una etiqueta/tool del bot (`##BOOK##`, `##HANDOFF##`, `##VENTA##`, etc.).
- Cualquier cosa que afecte qué negocio ve qué datos.

## Invariantes que NUNCA se rompen

1. **Filtrado por `business_id`** — toda lectura/escritura de datos de un negocio incluye `business_id`. En endpoints de cliente, ese id sale del JWT (`req.user.businessId`), nunca de un body/param manipulable.
2. **RLS siempre activa** en tablas con datos de negocio. Tabla nueva = `business_id` + RLS. No se hace `disable row level security` ni se crean políticas permisivas (`using (true)`).
3. **Service role solo en servidor.** `SUPABASE_SERVICE_KEY` jamás llega al frontend. El frontend no habla directo con Supabase (los endpoints `/api/.../supabase-config` devuelven `{}` a propósito).
4. **Etiquetas/tools del bot con contexto de negocio.** El bot resuelve el negocio por canal (slug Telegram / número WhatsApp en `db.getBusinessByPhone` / `getBusinessBySlug`) y opera SOLO con datos de ese `business.id`.
5. **El dinero se calcula en PostgreSQL, y hay UNA sola puerta.** Todo local pide por su mini app: `create_storefront_order` cierra el pedido revalidando negocio, producto, stock y precio en la misma transacción, `order_markup_by_line` aplica el margen y `quoteCart` (`services/cotizacion.ts`) solo COTIZA. ⚠️ `server/src/services/money.ts` se retiró el 2026-09-16 con el pedido por chat — si lo lees nombrado en algún sitio, ese sitio está desactualizado. La puerta única la vigila `las-defensas-son-para-todos.test.js`.
6. **Todo acceso a datos pasa por `server/src/db/`.** No agregues `sb.from(...)` en rutas, servicios o `src/index.ts`; crea/usa una función en el repositorio correspondiente y expórtala desde `src/db/index.ts`.

## Cómo verificar el impacto antes de cambiar
1. ¿La consulta nueva filtra por `business_id`? ¿De dónde sale ese id? (Debe venir del JWT en rutas de cliente.)
2. ¿El cambio permite que un negocio lea/escriba datos de otro? Si hay duda, asume que sí y bloquéalo.
3. ¿Toca el frontend? Confirma que no se expone la service key ni se consulta Supabase directo.
4. ¿Agrega una etiqueta del bot? Confirma que solo actúa sobre el `business_id` de la conversación.

## Checklist — TABLA NUEVA
- [ ] Tiene `id uuid primary key default gen_random_uuid()`.
- [ ] Tiene `business_id uuid references businesses(id) on delete cascade`.
- [ ] Índice por `business_id` (y por `(business_id, <campo de búsqueda>)` si aplica).
- [ ] `alter table <tabla> enable row level security;`
- [ ] Las funciones de acceso van en `server/src/db/repositories/` y filtran por `business_id`.
- [ ] Es una migración NUEVA (archivo aparte), no se edita una ya aplicada → ver **base-de-datos**.

## Checklist — ETIQUETA/TOOL DEL BOT
- [ ] Se detecta y se **quita** del texto antes de enviarlo al cliente (`finalText.replace(/##.../, '')`).
- [ ] La acción que dispara usa el `biz`/`business_id` de la conversación actual.
- [ ] Si crea/lee datos, lo hace vía `server/src/db/` filtrando por `business_id`.
- [ ] Se documenta en CLAUDE.md (sección 7) y vía **documentacion**.
- [ ] No rompe las etiquetas existentes (`##BOOK## ##HANDOFF## ##PEDIDO## ##VENTA## ##IMG## ##CATALOG##`).

## Ante un conflicto (el pedido choca con una invariante)
1. **Señala la regla** exacta que se violaría.
2. **Explica el riesgo** concreto (ej: "un negocio podría ver las reservas de otro").
3. **Propón 1-2 alternativas** que cumplan el objetivo sin romper la invariante.
4. **Espera la decisión** del usuario. No implementes la versión riesgosa por tu cuenta.

> El aislamiento entre negocios es la regla #1 de un SaaS. Romperlo es un incidente de seguridad, no un bug menor.
