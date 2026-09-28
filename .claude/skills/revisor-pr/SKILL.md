---
name: revisor-pr
description: Úsala SIEMPRE antes de hacer commit o abrir un PR en BotPanel, aunque no lo pidan. Revisa el diff completo para detectar cambios fuera de alcance, fugas de secretos, roturas del aislamiento multi-tenant y violaciones de las reglas inviolables del CLAUDE.md.
---

# revisor-pr

Última línea de defensa antes de que un cambio quede registrado. Revisa el conjunto completo, no solo lo que recuerdas haber tocado.

## Cuándo se activa
- Antes de `git commit` o `git push`.
- Antes de abrir/actualizar un PR.
- Cuando el usuario dice "revisa esto antes de subirlo".

## Cómo revisar
```bash
git status            # ¿qué archivos cambiaron?
git diff              # cambios sin stage
git diff --staged     # cambios en stage
git diff --stat       # tamaño del cambio por archivo
```

## Checklist de revisión

### Alcance
- [ ] El diff coincide con lo que se pidió. ¿Hay archivos tocados que no debían cambiar?
- [ ] No hay reescrituras masivas ni reformateos "de paso".
- [ ] No se borraron funciones, campos, endpoints ni validaciones ajenos al pedido.
- [ ] El tamaño del cambio es proporcional al pedido (un fix pequeño no debería tocar 10 archivos).

### Reglas inviolables (CLAUDE.md §4)
- [ ] Toda consulta nueva de datos filtra por `business_id` (id desde el JWT en rutas de cliente).
- [ ] Ninguna política RLS se desactivó ni se volvió permisiva.
- [ ] La service key no se expone al frontend; no se consulta Supabase directo desde los paneles.
- [ ] Las etiquetas/tools del bot operan sobre el `business_id` de la conversación.
- [ ] Ninguna pasarela de pago NUEVA. La única es PayPhone para tarjeta (decidido por el dueño el 2026-09-27): sus credenciales solo en variables de entorno, el monto sale de la base y lo que se da por pagado lo decide `settle_card_payment` al centavo.

### Seguridad (ver seguridad-saas)
- [ ] **No hay secretos ni API keys en el diff** (`git diff | grep -iE "sk-|gsk_|eyJ|api.?key|password|secret"`).
- [ ] `server/.env` NO está en el diff.
- [ ] Las rutas nuevas tienen su middleware de auth.
- [ ] Contenido del cliente se renderiza con `esc(...)`.

### Datos
- [ ] Si hay cambio de esquema, viene como migración nueva (no editando una aplicada) → **base-de-datos**.
- [ ] No hay `drop`/`delete` masivo sin confirmación.

### Verificación
- [ ] Pasó **tester-saas** (módulos cargan, server arranca, smoke test OK).

## Salida del revisor (resumen claro)
Produce un resumen con:
1. **Qué cambió** — lista de archivos y propósito de cada uno.
2. **Riesgos** — qué podría romperse y qué se verificó al respecto.
3. **Reglas** — confirma explícitamente que las inviolables se respetan (o señala cuál no).
4. **Veredicto** — listo para commit, o qué falta corregir antes.

## Comando útil para cazar secretos
```bash
git diff --staged | grep -inE "sk-[a-z0-9]|gsk_[a-z0-9]|eyJ[a-z0-9]|AIza[a-z0-9]|password\s*=|secret\s*=" && echo "⚠️ POSIBLE SECRETO EN EL DIFF"
```

> Si algo del diff no lo pediste tú ni el usuario, no debería estar ahí. Quítalo o explícalo antes de commitear.
