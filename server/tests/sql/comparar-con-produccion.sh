#!/usr/bin/env bash
# ============================================================================
# DETECTOR DE DERIVA: ¿la base real es lo que dice schema.sql?
#
# El CI verifica que `schema.sql` sea correcto aplicándolo a un PostgreSQL
# limpio. Pero eso no dice nada de la base REAL: si alguien corre una migración
# y olvida actualizar el consolidado —o al revés— el CI sigue en verde
# verificando una ficción. Ya pasó con `platform_errors`.
#
#   bash server/tests/sql/comparar-con-produccion.sh
#
# Cómo funciona, y por qué así: NO se parsea schema.sql. Se aplica a un
# PostgreSQL de verdad en Docker y se le pregunta a ÉL qué salió. Intentarlo
# con expresiones regulares daba una lista donde faltaban `businesses` y
# `products`, que evidentemente están en el archivo — parsear SQL a mano miente.
#
# Solo lee. No toca la base real ni un byte.
#
# ⚠️ LÍMITE: compara nombres de tablas, columnas y funciones. La API de Supabase
# no expone disparadores, así que un BEFORE que debiera ser AFTER —el fallo del
# 2026-08-02— no se ve aquí. Para eso está `npm run verify:schema`.
# ============================================================================
set -euo pipefail

CONTENEDOR=botpanel-comparar-produccion
IMAGEN=pgvector/pgvector:pg16
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$(cd "$AQUI/../.." && pwd)"
RAIZ="$(cd "$SERVER/.." && pwd)"

limpiar() { docker rm -f "$CONTENEDOR" >/dev/null 2>&1 || true; }
trap limpiar EXIT

if [ ! -f "$SERVER/.env" ]; then
  echo "❌ Falta server/.env con SUPABASE_URL y SUPABASE_SERVICE_KEY"
  exit 1
fi

echo "🐘 Aplicando schema.sql a un PostgreSQL limpio…"
limpiar
docker run -d --name "$CONTENEDOR" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=botpanel "$IMAGEN" >/dev/null
until docker exec "$CONTENEDOR" pg_isready -U postgres -d botpanel >/dev/null 2>&1; do
  sleep 1
done

psql_() { docker exec -i "$CONTENEDOR" psql -U postgres -d botpanel -q -v ON_ERROR_STOP=1 "$@"; }
psql_ < "$SERVER/tests/sql/bootstrap-supabase.sql" > /dev/null 2>&1
psql_ < "$SERVER/schema.sql" > /dev/null 2>&1

echo "📋 Leyendo lo que schema.sql produjo…"
ESPERADO=$(docker exec -i "$CONTENEDOR" psql -U postgres -d botpanel -t -A -c "
  select jsonb_build_object(
    'tablas', (
      select coalesce(jsonb_object_agg(tabla, columnas), '{}'::jsonb) from (
        select c.table_name as tabla,
               jsonb_agg(c.column_name order by c.column_name) as columnas
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name
        -- ⚠️ VISTAS TAMBIÉN, y no es un detalle (2026-09-19). El otro lado de
        -- la comparación lee el catálogo de PostgREST, que expone vistas igual
        -- que tablas. Contando aquí solo «BASE TABLE» se comparaban peras con
        -- manzanas: «marketplace_cajones_de_negocio» —una vista que schema.sql
        -- SÍ crea— salía eternamente como «producción la tiene y schema.sql
        -- no». Un detector que grita en falso se acaba ignorando, que es
        -- justo lo que no puede pasarle al guardián del esquema.
        where c.table_schema = 'public' and t.table_type in ('BASE TABLE', 'VIEW')
        group by c.table_name
      ) x
    ),
    'funciones', (
      select coalesce(jsonb_agg(distinct p.proname), '[]'::jsonb)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
    ),
    'disparadores', (
      select coalesce(jsonb_agg(
        t.tgname || ' ' ||
        case when (t.tgtype::integer & 2) <> 0 then 'BEFORE' else 'AFTER' end
        order by t.tgname
      ), '[]'::jsonb)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
    )
  )
")

echo "$ESPERADO" > /tmp/botpanel-esquema-esperado.json
node --env-file="$SERVER/.env" "$AQUI/comparar-con-produccion.mjs" /tmp/botpanel-esquema-esperado.json
