-- ============================================================================
-- INSULTOS EN EL CHAT: ADVERTENCIA, Y AL SEGUNDO, 15 DÍAS FUERA DE UMBANI
--
-- El dueño probó el chat de Umbani con insultos el 2026-09-27 y el bot los
-- contestaba como a cualquier otra cosa. Lo que decidió:
--
--   · la PRIMERA vez, una advertencia: «si vuelve a pasar, quedarás bloqueado»;
--   · la SEGUNDA, bloqueo AUTOMÁTICO de 15 días en toda la app —ni el bot le
--     contesta ni ningún local acepta su pedido—, que CADUCA SOLO;
--   · el superadmin lo ve junto a los demás bloqueos de plataforma, marcado
--     como «Insultos», y lo puede levantar antes;
--   · al volver —porque caducó o porque se levantó— se le dice «te hemos
--     desbloqueado, esperamos que mejores tu conducta», y a la siguiente se
--     bloquea directo, sin nueva advertencia.
--
-- Se monta sobre el bloqueo de PLATAFORMA que ya existe (`customers.blocked_at`,
-- el del superadmin), no sobre el de cada local: el insulto es al chat de
-- Umbani, que es de todos, y quien insulta puede no haber elegido local aún.
--
-- ⚠️ El aviso de desbloqueo NO se manda al desbloquear: pasados 15 días la
-- ventana de 24 h de WhatsApp está cerrada y un mensaje libre fallaría. Se le
-- da en su PRIMER mensaje después, que es cuando la ventana está abierta.
--
-- ⚠️ Antes de reescribir `set_platform_blocked` y
-- `orders_reject_platform_blocked` se comprobó que las de producción eran
-- IDÉNTICAS a las de `schema.sql`.
-- ============================================================================

-- ── 1. Hasta cuándo, por qué, y las dos marcas ─────────────────────────────
--
-- `blocked_until` sigue la convención de `business_customers` (2026-09-01):
-- nulo con `blocked_at` puesto = permanente, con fecha = caduca solo.
alter table public.customers
  add column if not exists blocked_until timestamptz,
  add column if not exists blocked_kind text,
  -- La advertencia se da UNA vez en la vida: después, directo al bloqueo.
  add column if not exists insult_warned_at timestamptz,
  -- Se levantó a mano un bloqueo por insultos: su próximo mensaje lo sabrá.
  add column if not exists unblock_notice_pending boolean not null default false;

alter table public.customers
  drop constraint if exists customers_blocked_kind_check;
alter table public.customers
  add constraint customers_blocked_kind_check
  check (blocked_kind is null or blocked_kind in ('manual', 'insultos'));

-- Los que ya existen los puso el superadmin a mano.
update public.customers
   set blocked_kind = 'manual'
 where blocked_at is not null and blocked_kind is null;

-- ── 2. Un pedido de alguien bloqueado: respetando la caducidad ─────────────
create or replace function public.orders_reject_platform_blocked()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is not null
     and exists (
       select 1 from public.customers
       where id = new.customer_id
         and blocked_at is not null
         -- Un bloqueo de 15 días que ya pasó no rechaza nada, aunque nadie
         -- haya limpiado todavía la fila.
         and (blocked_until is null or blocked_until > now())
     ) then
    raise exception using
      errcode = '42501',
      message = 'No podemos procesar este pedido.';
  end if;
  return new;
end;
$$;

-- ── 3. El superadmin bloquea y desbloquea ──────────────────────────────────
create or replace function public.set_platform_blocked(
  p_phone  text,
  p_blocked boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_digitos text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_id uuid;
begin
  if char_length(v_digitos) < 8 or char_length(v_digitos) > 15 then
    raise exception using
      errcode = '22023',
      message = 'El teléfono debe tener entre 8 y 15 dígitos';
  end if;

  insert into public.customers (phone) values (v_digitos)
  on conflict (phone) do nothing;

  -- ⚠️ En un UPDATE, las columnas de la derecha son las de ANTES: por eso
  -- `blocked_kind = 'insultos'` pregunta cómo estaba, no cómo queda.
  update public.customers
     set blocked_at = case when p_blocked then now() else null end,
         blocked_reason = case when p_blocked then nullif(btrim(coalesce(p_reason, '')), '') else null end,
         -- El del superadmin es permanente: lo levanta él.
         blocked_until = null,
         blocked_kind = case when p_blocked then 'manual' else null end,
         -- Levantar a mano un bloqueo por INSULTOS deja el aviso pendiente.
         unblock_notice_pending = case
           when p_blocked then false
           when blocked_at is not null and blocked_kind = 'insultos' then true
           else unblock_notice_pending
         end
   where phone = v_digitos
   returning id into v_id;

  return jsonb_build_object('phone', v_digitos, 'blocked', p_blocked, 'customer_id', v_id);
end;
$$;

-- ── 4. Un insulto: advertencia, o bloqueo ──────────────────────────────────
--
-- Devuelve `accion`: 'advertido' la primera vez, 'bloqueado' (con `hasta`) la
-- siguiente, 'ya_bloqueado' si ya lo estaba. Todo en la MISMA fila bloqueada
-- (`for update`): dos insultos a la vez no pueden dar dos advertencias.
create or replace function public.register_insult(
  p_customer_id uuid,
  p_dias integer default 15
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila public.customers%rowtype;
  v_hasta timestamptz;
begin
  if p_customer_id is null then
    return jsonb_build_object('accion', 'nada');
  end if;

  select * into v_fila from public.customers where id = p_customer_id for update;
  if not found then
    return jsonb_build_object('accion', 'nada');
  end if;

  if v_fila.blocked_at is not null
     and (v_fila.blocked_until is null or v_fila.blocked_until > now()) then
    return jsonb_build_object('accion', 'ya_bloqueado', 'hasta', v_fila.blocked_until);
  end if;

  if v_fila.insult_warned_at is null then
    update public.customers
       set insult_warned_at = now(), updated_at = now()
     where id = p_customer_id;
    return jsonb_build_object('accion', 'advertido');
  end if;

  v_hasta := now() + make_interval(days => greatest(1, least(coalesce(p_dias, 15), 365)));
  update public.customers
     set blocked_at = now(),
         blocked_until = v_hasta,
         blocked_kind = 'insultos',
         blocked_reason = 'Insultos en el chat',
         unblock_notice_pending = false,
         updated_at = now()
   where id = p_customer_id;
  return jsonb_build_object('accion', 'bloqueado', 'hasta', v_hasta);
end;
$$;

revoke all on function public.register_insult(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.register_insult(uuid, integer)
  to service_role;

-- ── 5. ¿Está bloqueado? Y si le toca, el aviso de vuelta ───────────────────
--
-- Lo pregunta cada mensaje del marketplace. Devuelve `bloqueado` y, cuando le
-- toca, `avisar_desbloqueo`: su bloqueo por insultos caducó (y aquí mismo se
-- limpia) o el superadmin lo levantó. El aviso se RECLAMA en la misma
-- consulta, así que sale una sola vez aunque lleguen dos mensajes seguidos.
--
-- ⚠️ Primero se mira SIN bloquear la fila: es el camino de casi todos los
-- mensajes, y la inmensa mayoría no tiene nada que cambiar.
create or replace function public.claim_platform_block_state(
  p_customer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
  v_hasta timestamptz;
  v_tipo text;
  v_pendiente boolean;
begin
  if p_customer_id is null then
    return jsonb_build_object('bloqueado', false);
  end if;

  select blocked_at, blocked_until, blocked_kind, unblock_notice_pending
    into v_at, v_hasta, v_tipo, v_pendiente
    from public.customers where id = p_customer_id;

  if v_at is null and not coalesce(v_pendiente, false) then
    return jsonb_build_object('bloqueado', false);
  end if;
  if v_at is not null and (v_hasta is null or v_hasta > now()) then
    return jsonb_build_object('bloqueado', true, 'tipo', v_tipo, 'hasta', v_hasta);
  end if;

  -- Hay algo que cambiar: ahora sí, con la fila bloqueada, y se vuelve a mirar
  -- por si otro mensaje se adelantó.
  select blocked_at, blocked_until, blocked_kind, unblock_notice_pending
    into v_at, v_hasta, v_tipo, v_pendiente
    from public.customers where id = p_customer_id for update;

  if v_at is not null and v_hasta is not null and v_hasta <= now() then
    update public.customers
       set blocked_at = null, blocked_until = null, blocked_kind = null,
           blocked_reason = null, unblock_notice_pending = false, updated_at = now()
     where id = p_customer_id;
    return jsonb_build_object('bloqueado', false, 'avisar_desbloqueo', v_tipo = 'insultos');
  end if;
  if v_at is null and v_pendiente then
    update public.customers
       set unblock_notice_pending = false, updated_at = now()
     where id = p_customer_id;
    return jsonb_build_object('bloqueado', false, 'avisar_desbloqueo', true);
  end if;
  return jsonb_build_object(
    'bloqueado', v_at is not null and (v_hasta is null or v_hasta > now()),
    'tipo', v_tipo, 'hasta', v_hasta
  );
end;
$$;

revoke all on function public.claim_platform_block_state(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_platform_block_state(uuid)
  to service_role;
