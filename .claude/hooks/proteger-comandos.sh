#!/bin/bash
# Hook PreToolUse (Bash): aplica CLAUDE.md §7 de forma mecánica.
# - Comandos git destructivos → pedir confirmación explícita al usuario.
# - Forzar .env dentro de git → denegar siempre.
# Lee el JSON del tool call por stdin y responde con permissionDecision.

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}
ask() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

# Nunca meter un .env al índice de git (ni con -f saltando el .gitignore).
if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+add[^|;&]*\.env($|[^.a-zA-Z])' \
  && ! printf '%s' "$CMD" | grep -qE '\.env\.example'; then
  deny "CLAUDE.md §7: los archivos .env jamás entran a git. Revisa el comando."
fi

# Acciones destructivas de git: requieren confirmación explícita del usuario.
if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+reset[^|;&]*--hard'; then
  ask "git reset --hard descarta trabajo. CLAUDE.md §7 exige confirmación explícita del usuario."
fi
if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+clean[^|;&]*-[a-zA-Z]*f'; then
  ask "git clean -f borra archivos sin trackear. CLAUDE.md §7 exige confirmación explícita."
fi
if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+push[^|;&]*([[:space:]]-f([[:space:]]|$)|--force)'; then
  ask "git push --force reescribe historia remota. CLAUDE.md §7 exige confirmación explícita."
fi
if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+branch[^|;&]*[[:space:]]-D([[:space:]]|$)'; then
  ask "Borrar una rama con -D pierde commits no fusionados. Confirmación explícita requerida."
fi

# rm -rf fuera de zonas temporales: que el usuario lo confirme.
if printf '%s' "$CMD" | grep -qE 'rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)' \
  && ! printf '%s' "$CMD" | grep -qE 'rm[[:space:]]+-[a-zA-Z]+[[:space:]]+("?/(private/)?tmp/|.*scratchpad|.*node_modules|.*dist/)'; then
  ask "rm -rf fuera de tmp/scratchpad/node_modules/dist. Confirma que el destino es correcto."
fi

exit 0
