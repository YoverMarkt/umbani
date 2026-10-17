---
name: git-github
description: Úsala SIEMPRE (aunque no lo pidan) al versionar en BotPanel — ramas, commits, push, PRs, merges o cualquier operación de Git/GitHub. Garantiza un historial limpio y seguro, sin romper `main`, sin subir secretos y sin acciones destructivas. Trabaja de la mano con revisor-pr (revisar) — esta skill maneja el cómo del versionado.
---

# git-github

Llevar el repositorio de forma profesional: historial limpio, commits atómicos y descriptivos, y **cero incidentes** (secretos subidos, `main` roto, trabajo perdido). Complementa a **revisor-pr** (que revisa el diff); esta skill maneja ramas, commits, push y PRs.

## Regla de oro (antes de tocar Git)
1. **Punto limpio primero.** Corre `git status` y `git diff --stat`. Entiende qué hay sin commitear antes de cambiar de rama o commitear.
2. **Nunca subas `server/.env`.** Verifica con `git check-ignore server/.env` y revisa el stage con `git diff --staged --name-only` antes de cada commit. Si una credencial entra al diff → **detente y avisa**.
3. **Acciones destructivas requieren confirmación EXPLÍCITA del usuario:** `git reset --hard`, `git clean -fd`, `git push --force`, borrar ramas, `git checkout .` que descarte trabajo. Ante la duda, no lo hagas.

## El ciclo se cierra SIEMPRE, en el mismo turno

```
rama → trabajo → verificación → PR → CI en verde → merge → despliegue → comprobar en producción
```

**Un trabajo que no llegó a `main` no está hecho.** Nada de dejarlo en un PR
«para mañana»: a los tres días nadie recuerda en qué estado quedó, y el
repositorio acumula copias viejas del código. Ver CLAUDE.md §7.

⚠️ **Al terminar, la rama muere.** GitHub la borra sola al fusionar
(`delete_branch_on_merge`, activado el 2026-08-28); la local se borra a mano
con `git fetch --prune` + `git branch -d`.

⚠️ **Un PR que se cierra sin fusionar necesita su motivo ESCRITO**: qué se
rescata, qué se descarta y dónde vive lo rescatado. Sin eso, un mes después
nadie sabe si esa rama guarda algo que hace falta.

⚠️ **Un punto histórico es una ETIQUETA, no una rama** (`respaldo-whatsapp-flows`).
Inmutable, no se trabaja sobre ella y no ensucia la lista.

### ⚠️ Antes de borrar una rama: qué miente y qué decide

| Herramienta | Qué dice | Por qué MIENTE |
|---|---|---|
| `git branch --no-merged` | «sin fusionar» | El **squash** crea otro SHA: marca como pendiente todo lo fusionado así |
| `git diff main rama` | «74 archivos que main no tiene» | Cuenta también lo que `main` cambió **después** de fusionarla |
| `git branch -r` | la lista de ramas | `git fetch` **no purga**: sobreviven referencias de ramas borradas hace meses. Hace falta `--prune` |

**Lo que decide, y solo esto:**
```bash
gh pr list --head <rama> --state all --json number,state   # ¿MERGED?
git log origin/main --oneline --grep="(#NNN)"              # ¿su commit está en main?
```
Si el PR está `MERGED`, el código está en `main` y la rama sobra. GitHub
conserva sus commits en la pestaña del PR aunque la rama se borre.

## Estrategia de ramas
- **No commitees directo en `main`** para features o cambios grandes (CLAUDE.md §7). Crea una rama:
  ```bash
  git checkout -b <tipo>/<tema-corto>     # feat/ventas-reportes, fix/correo-cruzado
  ```
- Prefijos: `feat/` (nuevo), `fix/` (bug), `refactor/`, `docs/`, `chore/`.
- Fixes menores muy puntuales pueden ir en `main` **solo si el usuario lo pide**.
- Una rama = un objetivo. No mezcles features no relacionados en la misma rama.

## Commits
- **Mensajes en español**, estilo conventional: `tipo: resumen corto en imperativo`.
  - `feat: registro manual de ventas + 7 reportes para el dueño`
  - `fix: el correo del cliente se mezclaba entre negocios`
- Cuerpo cuando el cambio lo amerite: qué y **por qué** (no el cómo, que se ve en el diff).
- **Atómicos y proporcionales:** un fix pequeño no toca 10 archivos. Si un commit hace muchas cosas no relacionadas, sepáralo — salvo que los archivos ya mezclen features (entonces un commit bien redactado es más seguro que un split artificial).
- Cierra SIEMPRE el mensaje con:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Flujo típico:
  ```bash
  git add -A
  git diff --staged --name-only          # confirmar alcance y que .env NO está
  git commit -F - <<'EOF'
  feat: ...
  EOF
  ```
- **Antes de commitear, pasa revisor-pr** (alcance, secretos, aislamiento multi-tenant, reglas §4).

## Push y PRs
- Push de la rama, nunca directo a `main` sin pedirlo:
  ```bash
  git push -u origin <rama>
  ```
- Confirma **a qué remoto/repo** vas antes de subir (`git remote -v`) y díselo al usuario.
- **PR con `gh`** si está disponible (`gh auth status`):
  ```bash
  gh pr create --base main --head <rama> --title "..." --body "..."
  ```
  Body en Markdown: qué cambió, por qué, cómo se verificó, y qué NO se tocó. Termina el body con:
  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```
- **Si `gh` no está instalado:** entrega el enlace `https://github.com/<owner>/<repo>/pull/new/<rama>` + título y descripción listos para pegar. Ofrece instalar `gh` (`brew install gh`) solo si el usuario quiere que se automatice a futuro.
- El push es una acción de cara al exterior: confírmalo si el usuario no lo pidió explícitamente.

## Higiene y seguridad
- `.gitignore` debe cubrir `server/.env`, `node_modules/`. Nunca lo debilites.
- Si un secreto ya se subió: avisa de inmediato, trátalo como incidente (rotar la credencial > reescribir historia). No basta con borrarlo en un commit nuevo.
- No hagas `git add` a ciegas de archivos raros (dumps, `.env.*`, binarios grandes). Revisa `git status` primero.

## Al terminar
- Reporta: rama, hash del commit, archivos, a qué remoto se subió, y que `.env` quedó fuera.
- Recuerda al usuario en qué rama quedó parado y cómo volver a `main` (`git checkout main`).

> Un commit mal hecho se arregla; un secreto subido a un repo público es un incidente. Prioriza no filtrar credenciales y no romper `main` por encima de la elegancia del historial.
