# ARQUITECTURA.md — BotPanel: arquitectura objetivo y plan de migración

> **Qué es este documento:** la "biblia técnica" del proyecto. Define el stack
> objetivo de gran escala, la estructura del monorepo y el plan de migración
> **gradual** (patrón estrangulador — nunca big-bang). Complementa a `CLAUDE.md`
> (reglas de trabajo); este archivo define **hacia dónde** evoluciona el código.
> Decidido con el dueño el 2026-07-06. Cualquier programador que se sume al
> proyecto debe leer ambos documentos antes de tocar código.

---

## 1. PRINCIPIOS (por qué migramos así)

1. **Nunca big-bang.** Reescribir todo de golpe mata startups: meses sin vender
   y bugs nuevos en lo que ya funcionaba. Se migra por piezas, con el sistema
   viejo y el nuevo conviviendo detrás del mismo dominio (patrón estrangulador).
2. **Primero las puertas de un solo sentido.** Lo difícil de cambiar con 1000
   clientes no es el código (interno, se refactoriza igual a cualquier escala);
   es lo que los clientes usan/guardan: dominio, datos, canal de WhatsApp,
   esquema de BD. Eso se resuelve ANTES que cualquier refactor bonito.
3. **Regla de oro:** todo lo nuevo nace en React/TypeScript y `server/src/`;
   no se reintroducen paneles HTML ni módulos JavaScript operativos.
4. **La IA conversa, el código calcula** (regla inviolable #8 de CLAUDE.md) se
   mantiene intacta en la nueva arquitectura: dinero solo server-side.

---

## 2. STACK OBJETIVO

| Capa | Hoy | Objetivo | Decisión |
|---|---|---|---|
| Lenguaje | JS puro | **TypeScript** (backend y frontend) | Gradual: `@ts-check` → `.ts` |
| Backend | Node + Express (monolito) | **Node + Express + TS**, rutas delgadas / servicios gordos, validación runtime con **Zod** | ✅ Express SE QUEDA (estándar de industria); solo se ordena |
| Base de datos | Supabase (Postgres + RLS + pgvector) | **La misma** | ✅ No se toca. Multi-tenant por `business_id` intacto |
| Frontend paneles | HTML con JS inline | **React + Vite + TypeScript + Tailwind** (SPA) | 🚨 El cambio real |
| Web pública (landing) | No existe | **Next.js** (SEO) | Futuro — Next SOLO para lo público |
| Datos en el front | fetch + polling manual | **TanStack Query** | Con cada feature migrada |
| Tests | Manuales (tester-saas) | **Vitest** (+ Supertest) — dinero PRIMERO | `money`, resolución, totales |
| CI/CD | No hay | **GitHub Actions**: lint + types + tests en cada PR | Fase 0 |
| Deploy | Local + túnel Cloudflare | **Railway + dominio propio + Sentry** | Fase 0 — puerta irreversible |
| Backups | No hay (plan free) | **Supabase Pro** (backups diarios) | Fase 0 — no negociable con clientes reales |
| Escala | — | Redis/BullMQ (colas), workers, Realtime | ⏳ SOLO cuando el volumen lo pida (ver PENDIENTE.md) |

**¿Por qué Vite y no Next.js para los paneles?** Los paneles viven detrás de un
login: Google no los ve (el SSR/SEO de Next no aporta) y Next exigiría operar un
segundo servidor. Una SPA de Vite son archivos estáticos que el Express actual
sirve igual que hoy sirve los HTML: un solo servidor, un solo deploy. Next.js se
usará donde brilla: la landing pública con SEO.

**¿Por qué React?** Requisito del proyecto: "que cualquier programador sepa cómo
funciona". React tiene el mayor mercado de desarrolladores (incl. Ecuador/
Colombia): se contrata mañana y produce el día uno.

---

## 3. ESTRUCTURA OBJETIVO DEL MONOREPO

> Monorepo = todo el producto en un solo repositorio (lo que ya existe), con
> **npm workspaces** para manejar las sub-apps. Solo se agregan las "paredes
> internas".

```
bot/                                  ← monorepo (npm workspaces)
│
├── server/                           ← API + bot (el Express actual, ordenado)
│   ├── src/
│   │   ├── index.ts                  ← arranque delgado: solo levanta el server
│   │   ├── routes/                   ← UNA ruta = UN archivo
│   │   │   ├── auth.routes.ts
│   │   │   ├── products.routes.ts
│   │   │   ├── orders.routes.ts      ←   pedidos (núcleo de dinero)
│   │   │   ├── sales.routes.ts
│   │   │   ├── sessions.routes.ts
│   │   │   ├── admin.routes.ts
│   │   │   └── webhooks.routes.ts    ←   Meta/YCloud (anti-duplicados)
│   │   ├── services/                 ← la LÓGICA (rutas delgadas, servicios gordos)
│   │   │   ├── money.ts              ←   núcleo monetario tipado
│   │   │   ├── bot.service.ts        ←   processMessage, prompt, media
│   │   │   ├── ai.service.ts         ←   callAI multi-proveedor + visión + audio
│   │   │   ├── reports.service.ts    ←   7 reportes + alertas
│   │   │   └── schedule.service.ts   ←   horarios / fuera de horario
│   │   ├── db/
│   │   │   ├── client.ts             ←   conexión Supabase (ÚNICA)
│   │   │   └── repositories/         ←   ex db.js, partido por tabla
│   │   ├── middleware/               ←   authAdmin, authClient, permisos, rate-limit
│   │   └── lib/                      ←   helpers puros (fechas, key9, etc.)
│   ├── tests/                        ← Vitest — dinero primero
│   └── package.json
│
├── apps/
│   ├── client/                       ← panel del cliente — React + Vite + TS
│   │   └── src/
│   │       ├── features/             ← POR FUNCIÓN, no por tipo de archivo
│   │       │   ├── conversations/    ←   chat, etiquetas, modo manual
│   │       │   ├── catalog/          ←   productos, fotos/videos
│   │       │   ├── sales/            ←   ventas + pedidos del bot
│   │       │   ├── reports/          ←   dashboards, KPIs, alertas
│   │       │   ├── customers/        ←   directorio, reactivar, perdidos
│   │       │   └── settings/         ←   horarios, prompt, equipo
│   │       ├── components/           ←   componentes propios del panel
│   │       ├── api/                  ←   llamadas al server (TanStack Query)
│   │       └── App.tsx / main.tsx
│   ├── admin/                        ← panel superadmin — misma estructura
│   └── landing/                      ← (futuro) Next.js — web pública con SEO
│
├── packages/
│   └── ui/                           ← shadcn/ui compartido por client y admin
│       └── src/components/           ← botones, diálogos, tablas, formularios…
│
├── .github/workflows/ci.yml          ← lint + types + tests en cada PR
├── ARQUITECTURA.md                   ← este documento
├── CLAUDE.md                         ← reglas de trabajo (leer SIEMPRE)
└── package.json                      ← raíz workspaces
```

### Las 3 reglas que hacen que esto escale
1. **Rutas delgadas, servicios gordos** — la ruta solo recibe/responde HTTP; la
   lógica vive en `services/` y se testea sin levantar el servidor.
2. **Frontend por `features/`, no por tipo** — todo lo de "ventas" vive junto.
   Un programador nuevo encuentra cualquier cosa en 30 segundos.
3. **Tipos compartidos en `packages/shared`** — el contrato front↔back es UNO.
   Cambias un campo y ambos lados marcan en rojo lo que se rompió.

---

## 4. PLAN DE MIGRACIÓN (estrangulador — nadie espera nada)

| Fase | Qué se hace | El sistema viejo… |
|---|---|---|
| **0. Cimientos** | Railway + **dominio propio** + Supabase Pro (**backups**) + npm workspaces + CI (lint + `@ts-check` en dinero) + Sentry — *parte gratis ✅ HECHA (2026-07-08: CI + ESLint + @ts-check + 16 tests de dinero; 2026-07-09: npm workspaces con lockfile único y paquetes @botpanel/*); parte pagada (Railway/dominio/Supabase Pro/Sentry) agendada para agosto* | …sigue atendiendo clientes, intacto |
| **1. Server ordenado** — ✅ **HECHA 2026-07-12** (el monolito `index.js` de 1277 líneas y `bot.js` de 1071 líneas fueron reemplazados por `src/index.ts`, rutas, servicios, integraciones y repositorios TypeScript; comandos, pruebas y Railway ejecutan directamente `server/dist`; se retiraron todas las fachadas CommonJS; fuera del código compilado solo `eslint.config.js` permanece JavaScript; el núcleo monetario conserva resolución estricta, centavos, `price_sale` y RPC atómicas; las mutaciones protegen `business_id` y fallan cerrado). | Migración de backend cerrada; los siguientes cambios se realizan únicamente sobre `server/src/**/*.ts`. | …conservó endpoints y comportamiento |
| **2. Panel cliente React** — ✅ **HECHA 2026-07-09** (`apps/client`, servida en `/app`) | React + Vite + TypeScript, organizada por features | …fue reemplazado completamente |
| **3. Panel admin React** — ✅ **HECHA 2026-07-09** (`apps/admin`, servida en `/app-admin`) | React + Vite + TypeScript para el superadmin | …fue reemplazado completamente |
| **3.5 Corte y retiro del monolito visual** — ✅ **HECHA 2026-07-11**: se eliminaron `admin/`, `client/` y las rutas `/-legacy`; `/admin` y `/client` quedan como alias compatibles. Ambos paneles consumen `packages/ui`, basado en shadcn/ui | React queda como única interfaz | …ya no existe |
| **3.6 Seguridad de datos** — ✅ **HECHA 2026-07-11**: RLS de `conversation_tags` aplicado en Supabase, secretos administrativos enmascarados y webhooks con validación estricta | Sin cambios visuales | — |
| **3.7 Pruebas de navegador** — ✅ **HECHA 2026-07-11**: Playwright valida acceso sin sesión, login cliente/admin, persistencia de sesión, permisos de empleado y navegación móvil; corre en CI sin secretos ni BD | APIs simuladas y deterministas | — |
| **3.8 Endurecimiento de lanzamiento** — 🟡 **EN PROGRESO 2026-07-14**: Railway usa Railpack; Node 20.19+; entorno falla cerrado; sesiones revalidadas; CSP/HSTS; dinero y stock se revalidan en PostgreSQL; suite Vitest + Playwright en CI. El cobro se coordina manualmente fuera de la plataforma. | Validar la estabilidad de la plataforma | — |
| **4. Landing Next.js** | La hace el usuario por su cuenta (decidido 2026-07-09) | no existe hoy — todo es ganancia |
| **5. Escala real** | Redis/colas/workers/Realtime **cuando el volumen lo pida** | — |

**Orden de fases = orden de riesgo:** primero lo irreversible (dominio, backups,
canal), después las barandillas (CI/tests), y solo entonces el refactor visible.
Un panel React precioso corriendo en un Mac con túnel y sin backups NO es
"empresa grande".

### Criterios de "hecho" por fase
- **Fase 0 hecha** cuando: los paneles cargan desde el dominio propio, un push a
  `main` deploya solo, la BD tiene backup diario y el CI corre en cada PR.
- **Fase 1 hecha** cuando: el backend operativo vive en `server/src/**/*.ts`,
  producción ejecuta `server/dist/index.js` y el dinero tiene tests en CI.
- **Fase 2 hecha** cuando: el dueño de un negocio hace TODO su día en la app
  React sin tocar el HTML viejo.

---

## 5. QUÉ NO CAMBIA NUNCA (invariantes)

- Aislamiento multi-tenant por `business_id` (JWT) — reglas §4 de CLAUDE.md.
- El dinero se calcula SOLO server-side — regla #8. Desde el 2026-09-16 el núcleo es la RPC `create_storefront_order` (+ `order_markup_by_line`) y `quoteCart`; `services/money.ts` se retiró con el pedido por chat.
- Supabase/Postgres como única base; `schema.sql` como referencia del esquema.
- Migraciones de BD aditivas, jamás destructivas.
- Español en textos de cara al cliente; commits en español.
- Monolito hasta que la demanda real exija otra cosa (PENDIENTE.md).
