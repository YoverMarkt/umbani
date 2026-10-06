-- ============================================================================
-- LAS COOPERATIVAS DE REPARTO — la tercera flota
--
-- Decisión del dueño (2026-10-05, aprobado el 2026-10-06): como los «socios de
-- flota» de Uber, una cooperativa registra a SUS motorizados, ve sus carreras
-- y responde por ellos. Quedan tres flotas:
--
--   · De Umbani: los registra el superadmin, llevan los locales con «Quién
--     reparte: Umbani» de SU ciudad.
--   · De una COOPERATIVA: los registra la cooperativa en su panel, llevan los
--     locales con «Quién reparte: la cooperativa X» de SU ciudad.
--   · De un local: los registra el local, llevan solo los suyos.
--
-- ⚠️ EL DINERO NO CAMBIA, y es a propósito. Con la cooperativa, Umbani le paga
-- la carrera a cada motorizado el lunes y él liquida su efectivo con Umbani,
-- igual que los de Umbani; la comisión que le pagan a su cooperativa queda
-- entre ellos. El libro (`sales_write_ledger`) ya decide «reparte Umbani» por
-- `fleet_business_id is null`, y un motorizado de cooperativa no es de ningún
-- local: su carrera y su efectivo caen solos donde deben. Lo fija una prueba
-- de `verificar-esquema.sql` para que nadie lo «arregle».
--
-- ⚠️ LA REGLA DE QUIÉN LLEVA QUÉ, ESCRITA UNA SOLA VEZ. Vivía copiada en las
-- tres puertas del reparto (ofrecer, tomar y asignar), y una cuarta flota era
-- justo la ocasión de actualizar dos y olvidar la tercera: un motorizado de
-- cooperativa tampoco tiene local, así que la regla vieja de Umbani —«sin
-- local»— le habría enseñado los pedidos de Umbani. Ahora las tres llaman a
-- `repartidor_puede_llevar`.
-- ============================================================================


-- ── 1. La cooperativa ───────────────────────────────────────────────────────
create table if not exists public.cooperatives (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  -- Reparte en UNA ciudad: sus motorizados son de ella.
  city_id       uuid not null references public.cities(id) on delete restrict,
  contact_phone text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint cooperatives_name_check check (char_length(btrim(name)) between 2 and 80),
  constraint cooperatives_contact_phone_check check (contact_phone is null or contact_phone ~ '^\+?[0-9]{8,15}$')
);

create unique index if not exists cooperatives_nombre_unico on public.cooperatives (lower(btrim(name)));
create index if not exists idx_cooperatives_ciudad on public.cooperatives (city_id);
alter table public.cooperatives enable row level security;
revoke all on table public.cooperatives from anon, authenticated;
comment on table public.cooperatives is
  'Cooperativas de reparto: registran a sus motorizados y ven sus carreras. Umbani les paga la carrera a ellos.';


-- ── 2. Quién entra a su panel (`/cooperativa`) ──────────────────────────────
-- Como el dueño de un local: correo y contraseña con bcrypt, nunca en claro.
create table if not exists public.cooperative_users (
  id             uuid primary key default gen_random_uuid(),
  cooperative_id uuid not null references public.cooperatives(id) on delete cascade,
  email          text not null,
  password_hash  text not null,
  name           text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint cooperative_users_email_check check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint cooperative_users_name_check check (name is null or char_length(btrim(name)) between 2 and 80)
);

create unique index if not exists cooperative_users_email_unico on public.cooperative_users (email);
create index if not exists idx_cooperative_users_cooperativa on public.cooperative_users (cooperative_id);
alter table public.cooperative_users enable row level security;
revoke all on table public.cooperative_users from anon, authenticated;


-- ── 3. El motorizado: su flota y sus datos ──────────────────────────────────
alter table public.couriers
  add column if not exists cooperative_id uuid references public.cooperatives(id) on delete restrict,
  -- Cédula o pasaporte: en Chone reparten también personas de otros países.
  add column if not exists id_number text,
  add column if not exists plate text,
  add column if not exists license_number text;

alter table public.couriers drop constraint if exists couriers_una_flota_check;
alter table public.couriers add constraint couriers_una_flota_check
  check (fleet_business_id is null or cooperative_id is null);
alter table public.couriers drop constraint if exists couriers_documentos_check;
alter table public.couriers add constraint couriers_documentos_check check (
  (id_number is null or char_length(btrim(id_number)) between 5 and 20)
  and (plate is null or char_length(btrim(plate)) between 3 and 12)
  and (license_number is null or char_length(btrim(license_number)) between 3 and 30)
);
-- Lo que la cooperativa responde por cada uno (decidido 2026-10-05): nombre,
-- WhatsApp, cédula, placa y vehículo. La licencia, opcional.
alter table public.couriers drop constraint if exists couriers_de_cooperativa_check;
alter table public.couriers add constraint couriers_de_cooperativa_check check (
  cooperative_id is null
  or (id_number is not null and plate is not null and char_length(btrim(coalesce(vehicle, ''))) >= 2)
);

create index if not exists idx_couriers_cooperativa on public.couriers (cooperative_id) where cooperative_id is not null;
comment on column public.couriers.cooperative_id is
  'Cooperativa del motorizado: lleva los locales de ella en su ciudad, y Umbani le paga la carrera como a uno suyo.';

-- Su ciudad es la de su cooperativa, siempre: si pudiera ser otra, vería una
-- lista vacía sin que nadie entendiera por qué.
create or replace function public.couriers_ciudad_de_su_cooperativa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select c.city_id into new.city_id from public.cooperatives c where c.id = new.cooperative_id;
  return new;
end;
$$;

revoke all on function public.couriers_ciudad_de_su_cooperativa() from public, anon, authenticated;

drop trigger if exists couriers_ciudad_de_su_cooperativa on public.couriers;
create trigger couriers_ciudad_de_su_cooperativa
  before insert or update of cooperative_id, city_id on public.couriers
  for each row when (new.cooperative_id is not null)
  execute function public.couriers_ciudad_de_su_cooperativa();


-- ── 4. Quién reparte: el local, Umbani o UNA cooperativa ───────────────────
alter table public.businesses
  add column if not exists cooperative_id uuid references public.cooperatives(id) on delete restrict;
alter table public.businesses drop constraint if exists businesses_delivery_by_check;
alter table public.businesses add constraint businesses_delivery_by_check
  check (delivery_by in ('local', 'umbani', 'cooperativa'));
-- «La cooperativa» siempre dice CUÁL, y solo entonces.
alter table public.businesses drop constraint if exists businesses_cooperativa_check;
alter table public.businesses add constraint businesses_cooperativa_check
  check ((delivery_by = 'cooperativa') = (cooperative_id is not null));
comment on column public.businesses.delivery_by is
  'Quién lleva los pedidos: local (su gente), umbani (motorizados de la plataforma) o cooperativa (los de cooperative_id).';

create index if not exists idx_businesses_cooperativa on public.businesses (cooperative_id) where cooperative_id is not null;

-- Y de SU ciudad: con una de otra, sus motorizados nunca verían los pedidos y
-- el local se quedaría sin reparto en silencio.
create or replace function public.businesses_cooperativa_de_su_ciudad()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.cooperatives c
     where c.id = new.cooperative_id and c.city_id = new.city_id
  ) then
    raise exception using errcode = '23514',
      message = 'La cooperativa tiene que ser de la ciudad del local.';
  end if;
  return new;
end;
$$;

revoke all on function public.businesses_cooperativa_de_su_ciudad() from public, anon, authenticated;

drop trigger if exists businesses_cooperativa_de_su_ciudad on public.businesses;
create trigger businesses_cooperativa_de_su_ciudad
  before insert or update of delivery_by, cooperative_id, city_id on public.businesses
  for each row when (new.delivery_by = 'cooperativa')
  execute function public.businesses_cooperativa_de_su_ciudad();


-- ── 5. La regla de quién lleva qué, en UN solo sitio ───────────────────────
--
-- ⚠️ `coalesce(…, false)` sobre todo: con NULL en una comparación (un local
-- sin ciudad, un motorizado sin cooperativa) la rama da NULL, y un NULL que
-- llega a un `if not (…)` se lee como «no rechazar». Falla CERRADO.
create or replace function public.repartidor_puede_llevar(p_courier_id uuid, p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select c.active and (
      -- De Umbani: ni de un local ni de una cooperativa, y en SU ciudad.
      (c.fleet_business_id is null and c.cooperative_id is null
        and b.delivery_by = 'umbani' and b.city_id = c.city_id)
      -- De una cooperativa ACTIVA: los locales de ELLA, en su ciudad.
      or (c.cooperative_id is not null and coop.active
        and b.delivery_by = 'cooperativa' and b.cooperative_id = c.cooperative_id
        and b.city_id = c.city_id)
      -- De la flota de un local: solo ese local, con sus repartidores
      -- encendidos y repartiendo él mismo.
      or (c.fleet_business_id = b.id and b.own_fleet and b.delivery_by = 'local')
    )
    from public.couriers c
    join public.businesses b on b.id = p_business_id
    left join public.cooperatives coop on coop.id = c.cooperative_id
    where c.id = p_courier_id
  ), false)
$$;

revoke all on function public.repartidor_puede_llevar(uuid, uuid) from public, anon, authenticated;
grant execute on function public.repartidor_puede_llevar(uuid, uuid) to service_role;


-- ── 6. Las tres puertas, con esa regla ──────────────────────────────────────

-- Asignar (también a mano): ningún repartidor lleva el pedido de un local que
-- no le toca.
create or replace function public.orders_courier_permitido()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.courier_id is null or new.courier_id is not distinct from old.courier_id then
    return new;
  end if;
  if not public.repartidor_puede_llevar(new.courier_id, new.business_id) then
    raise exception using errcode = '42501',
      message = 'Ese repartidor no puede llevar pedidos de este local.';
  end if;
  return new;
end;
$$;

-- Tomar un pedido: el primero que llega se lo lleva.
create or replace function public.courier_take_order(p_courier_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.couriers%rowtype;
  v_o public.orders%rowtype;
  v_centavos integer;
begin
  select * into v_c from public.couriers where id = p_courier_id;
  if v_c.id is null or not v_c.active then
    return jsonb_build_object('result', 'inactivo');
  end if;

  select * into v_o from public.orders where id = p_order_id for update;
  if v_o.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v_o.courier_id is not null then
    return jsonb_build_object('result', case when v_o.courier_id = p_courier_id then 'ya_es_tuyo' else 'ya_tomado' end);
  end if;
  if coalesce(v_o.fulfillment, 'delivery') <> 'delivery'
     -- Solo lo que el local YA ACEPTÓ: como en las grandes, nadie sale a por
     -- un pedido que el local todavía puede rechazar.
     or v_o.status not in ('confirmado', 'aceptado', 'preparacion')
     or not public.repartidor_puede_llevar(p_courier_id, v_o.business_id) then
    return jsonb_build_object('result', 'no_disponible');
  end if;
  -- Con tarjeta ya pagado; sin pagar no sale (lo exige también la base).
  if v_o.payment_method = 'tarjeta' and v_o.payment_confirmed_at is null then
    return jsonb_build_object('result', 'no_disponible');
  end if;

  if coalesce(v_o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar') then
    v_centavos := round(v_o.total * 100)::integer;
    if public.courier_cash_in_hand(p_courier_id) + v_centavos > v_c.cash_limit_cents then
      return jsonb_build_object('result', 'tope_de_efectivo',
        'tope_cents', v_c.cash_limit_cents, 'en_mano_cents', public.courier_cash_in_hand(p_courier_id));
    end if;
  end if;

  update public.orders
     set courier_id = p_courier_id, courier_assigned_at = now(), updated_at = now()
   where id = p_order_id;
  return jsonb_build_object('result', 'ok', 'order_id', p_order_id, 'business_id', v_o.business_id);
end;
$$;

-- Ofrecer: los que puede tomar y los que ya lleva. Lo que ya lleva lo sigue
-- viendo aunque se apague su flota: apagar no puede dejar una comida en la
-- calle sin nadie que pueda marcarla.
create or replace function public.courier_orders(p_courier_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with yo as (select * from public.couriers where id = p_courier_id and active),
  pedidos as (
    select o.*, b.name as local_nombre, b.address as local_direccion,
           b.latitude as local_lat, b.longitude as local_lng
    from public.orders o
    join public.businesses b on b.id = o.business_id
    join yo on true
    where coalesce(o.fulfillment, 'delivery') = 'delivery'
      and (
        (o.courier_id is null and o.status in ('confirmado', 'aceptado', 'preparacion')
          and public.repartidor_puede_llevar(yo.id, o.business_id)
          and not (o.payment_method = 'tarjeta' and o.payment_confirmed_at is null))
        or (o.courier_id = yo.id and o.status not in ('completado', 'cancelado', 'rechazado', 'expirado'))
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'numero', p.order_number,
    'estado', p.status,
    'mio', p.courier_id is not null,
    'totalCents', round(p.total * 100)::integer,
    'carreraCents', round(coalesce(p.shipping, 0) * 100)::integer,
    -- Efectivo = lo cobra él en la puerta; el resto ya está pagado.
    'cobrarEnEfectivo', coalesce(p.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar'),
    'recoger', jsonb_build_object('local', p.local_nombre, 'direccion', p.local_direccion,
                                  'lat', p.local_lat, 'lng', p.local_lng),
    'entregar', jsonb_build_object('cliente', p.contact_name, 'direccion', p.delivery_address,
                                   'referencia', p.delivery_reference, 'notas', p.delivery_courier_notes,
                                   'lat', p.delivery_latitude, 'lng', p.delivery_longitude)
  ) order by p.courier_id is null, p.created_at), '[]'::jsonb)
  from pedidos p
$$;

revoke all on function public.orders_courier_permitido() from public, anon, authenticated;
revoke all on function public.courier_take_order(uuid, uuid) from public, anon, authenticated;
grant execute on function public.courier_take_order(uuid, uuid) to service_role;
revoke all on function public.courier_orders(uuid) from public, anon, authenticated;
grant execute on function public.courier_orders(uuid) to service_role;
