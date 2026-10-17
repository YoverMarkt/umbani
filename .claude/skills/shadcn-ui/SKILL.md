---
name: shadcn-ui
description: Migra, crea o revisa interfaces de BotPanel en React + TypeScript usando shadcn/ui, Tailwind v4 y Lucide. Usar al tocar pantallas, layouts, formularios, tablas, modales, navegación, estados visuales, tema o componentes compartidos de apps/client y apps/admin.
---

# shadcn-ui

Mantener una sola experiencia visual para cliente y admin sin alterar contratos API ni reglas de negocio.

## Fuente y arquitectura

- Tratar shadcn/ui como código propio versionado, no como una caja negra.
- Conservar `style: radix-nova`, Tailwind v4, variables CSS, Lucide y la marca Indigo existente.
- Preferir un paquete workspace `packages/ui` compartido por ambas apps. Mantener el mismo `style`, `baseColor` e `iconLibrary` en todos los `components.json`.
- Usar el CLI para componentes faltantes; revisar el diff y no sobrescribir personalizaciones silenciosamente.

## Flujo por pantalla

1. Inventariar comportamiento, permisos, loading, error, empty, responsive y tema oscuro antes de editar.
2. Identificar controles manuales y estilos duplicados.
3. Sustituirlos por componentes del sistema compartido.
4. Mantener la lógica de datos en el feature; el paquete UI no llama APIs ni conoce `business_id`.
5. Verificar accesibilidad, compilación y paridad funcional antes de pasar a otra pantalla.

## Mapeo obligatorio

- Acciones → `Button`; icon-only requiere `aria-label` o `Tooltip`.
- Campos → `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `Label`.
- Formularios → estructura consistente de label, ayuda y error; Zod/Form solo cuando aporte validación real.
- Modales → `Dialog`; acciones destructivas → `AlertDialog`.
- Datos → `Table`, `Badge`, `Pagination`, `ScrollArea` según volumen.
- Navegación → `Tabs`, `DropdownMenu`, `Sheet`, `Breadcrumb` según contexto.
- Feedback → `Sonner`, `Alert`, `Skeleton`, estados vacíos reutilizables.
- Gráficos → wrapper shadcn `Chart` + Recharts; conservar cálculos fuera del componente visual.

## Criterios de aceptación

- No dejar `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>` o modal manual en features; solo dentro de primitivas UI justificadas.
- No repetir cadenas como `const input = ...` para imitar componentes existentes.
- No duplicar una primitiva entre admin y cliente.
- Cubrir claro/oscuro, móvil/escritorio, teclado, foco visible, disabled, loading, empty y error.
- No ocultar permisos solo en UI: el servidor continúa autorizando.
- Ejecutar `npm run build`, `npm run check` y `git diff --check`.

## Límites

- No convertir cada `div` en componente; layouts y grids siguen en Tailwind.
- No agregar una dependencia visual si shadcn/Radix/Lucide ya cubren el caso.
- No rediseñar la identidad ni cambiar comportamiento de negocio durante una migración visual.
- No declarar paridad por compilación solamente: revisar la pantalla y sus estados.

## Rendimiento (esencial, adaptado de ECC react-performance a los paneles Vite)

En orden de impacto — revisa esto antes de optimizar nada más:

1. **Awaits en cascada:** dos `await` independientes se lanzan juntos con `Promise.all` (los paneles ya lo hacen en cargas de pantalla; no lo rompas al editar).
2. **Imports directos, no barriles:** importa `@botpanel/ui/components/button`, no un índice que arrastre toda la librería al bundle.
3. **Pantallas pesadas con `lazy()`:** las rutas ya se cargan con dynamic import (se ve en los chunks del build); una pantalla nueva pesada sigue ese patrón.
4. **Re-renders:** estado lo más local posible; no subas un `useState` al layout si solo lo usa una card. TanStack Query ya deduplica y cachea las llamadas — no agregues estados espejo de sus datos.
5. **Listas largas:** el patrón actual es paginar/filtrar server-side (los repos ya lo soportan); no renderices cientos de filas de golpe ni agregues virtualización sin medir antes.
6. **Polling:** cualquier `refetchInterval` nuevo se justifica; el egress de Supabase ya fue un problema real (ver «Optimización de egress» en PENDIENTE.md).
