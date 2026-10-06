-- ============================================================================
-- LA CIUDAD POR LA UBICACIÓN DEL CLIENTE
--
-- Decisión del dueño (2026-10-05): Umbani sale como APP, y «según la ubicación
-- del cliente le saldrán los locales de la ciudad donde está». Como las
-- grandes: la app pide el GPS y el servidor dice en qué ciudad está.
--
--   · Cada ciudad tiene su CENTRO y su RADIO de cobertura. Chone empieza con
--     6 km —el casco urbano y sus alrededores—; se ajusta desde el superadmin.
--   · `ciudad_de_la_ubicacion`: la ciudad activa más cercana y si el punto cae
--     dentro de su radio.
--   · La entrega, DENTRO de la ciudad del local: hasta hoy nadie lo comprobaba
--     y se podía pedir a domicilio a cualquier punto del país. Lo impide un
--     disparador al crear el pedido, como el mínimo de compra, y el cliente ve
--     el motivo al confirmar.
--   · Quien abre la app FUERA de toda ciudad queda anotado —redondeado a ~1 km,
--     nunca su casa— para saber dónde abrir la siguiente: «si en Chone nos va
--     bien, seguiremos en Portoviejo».
-- ============================================================================

alter table public.cities
  add column if not exists latitude  numeric(9,6),
  add column if not exists longitude numeric(9,6),
  add column if not exists radius_km numeric(5,2) not null default 6;
alter table public.cities drop constraint if exists cities_centro_check;
alter table public.cities add constraint cities_centro_check check (
  (latitude is null) = (longitude is null)
  and (latitude is null or latitude between -90 and 90)
  and (longitude is null or longitude between -180 and 180)
  and radius_km between 0.5 and 50
);
comment on column public.cities.radius_km is
  'Radio de cobertura desde el centro (km): dentro, el cliente ve los locales de la ciudad y se le puede entregar.';

-- Los centros de hoy (latitudelongitude.org). El dueño los afina en el mapa.
update public.cities set latitude = -0.698190, longitude = -80.093610, radius_km = 6
 where lower(name) = 'chone' and latitude is null;
update public.cities set latitude = -1.054580, longitude = -80.454450, radius_km = 10
 where lower(name) = 'portoviejo' and latitude is null;


-- ── La distancia entre dos puntos (haversine, km) ───────────────────────────
-- Sin PostGIS: para saber si alguien está a 3 o a 30 km de un centro sobra.
create or replace function public.distancia_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select (6371 * 2 * asin(sqrt(
    power(sin(radians((lat2 - lat1)::double precision / 2)), 2)
    + cos(radians(lat1::double precision)) * cos(radians(lat2::double precision))
      * power(sin(radians((lng2 - lng1)::double precision / 2)), 2)
  )))::numeric
$$;

revoke all on function public.distancia_km(numeric, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.distancia_km(numeric, numeric, numeric, numeric) to service_role;


-- ── ¿En qué ciudad está este punto? ─────────────────────────────────────────
-- La activa más cercana con centro, y si cae dentro de su radio. Fuera de toda
-- ciudad devuelve igual la más cercana (`dentro = false`): la app puede decir
-- «todavía no llegamos; la más cercana es Chone, a 40 km».
create or replace function public.ciudad_de_la_ubicacion(p_lat numeric, p_lng numeric)
returns table (id uuid, name text, km numeric, dentro boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  select c.id, c.name,
         round(public.distancia_km(p_lat, p_lng, c.latitude, c.longitude), 1) as km,
         public.distancia_km(p_lat, p_lng, c.latitude, c.longitude) <= c.radius_km as dentro
  from public.cities c
  where c.active and c.latitude is not null
    and p_lat between -90 and 90 and p_lng between -180 and 180
  order by public.distancia_km(p_lat, p_lng, c.latitude, c.longitude)
  limit 1
$$;

revoke all on function public.ciudad_de_la_ubicacion(numeric, numeric) from public, anon, authenticated;
grant execute on function public.ciudad_de_la_ubicacion(numeric, numeric) to service_role;


-- ── La entrega, dentro de la ciudad del local ──────────────────────────────
-- Antes de crear el pedido, como `orders_enforce_min_amount`, y con el mismo
-- código (42501): la tienda le enseña el motivo al cliente al confirmar.
--   · Solo pedidos de la tienda a domicilio: el retiro no tiene entrega, y el
--     mostrador lo teclea el dueño con la persona delante.
--   · Falla ABIERTO sin punto de entrega o sin centro de ciudad: sin datos no
--     se puede medir, y un local sin ciudad ni siquiera aparece en el menú.
create or replace function public.orders_entrega_en_su_ciudad()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ciudad record;
  v_km numeric;
begin
  if coalesce(new.source, '') <> 'storefront'
     or coalesce(new.fulfillment, 'delivery') <> 'delivery'
     or new.delivery_latitude is null or new.delivery_longitude is null then
    return new;
  end if;

  select c.name, c.latitude, c.longitude, c.radius_km into v_ciudad
    from public.businesses b join public.cities c on c.id = b.city_id
   where b.id = new.business_id;
  if v_ciudad.latitude is null then
    return new;
  end if;

  v_km := public.distancia_km(new.delivery_latitude, new.delivery_longitude, v_ciudad.latitude, v_ciudad.longitude);
  if v_km > v_ciudad.radius_km then
    raise exception using
      errcode = '42501',
      message = format(
        'Esa dirección está fuera de la zona de reparto de %s (a %s km). Elige una dirección en %s para recibir tu pedido.',
        v_ciudad.name, to_char(round(v_km), 'FM9999990'), v_ciudad.name
      );
  end if;
  return new;
end;
$$;

revoke all on function public.orders_entrega_en_su_ciudad() from public, anon, authenticated;

drop trigger if exists orders_entrega_en_su_ciudad on public.orders;
create trigger orders_entrega_en_su_ciudad
  before insert on public.orders
  for each row execute function public.orders_entrega_en_su_ciudad();


-- ── Quién pide desde fuera de toda ciudad ──────────────────────────────────
-- ⚠️ REDONDEADO a ~1 km (dos decimales): se quiere saber DÓNDE hay demanda, no
-- la casa de nadie. Uno por día, celda y dispositivo: abrir la app diez veces
-- no son diez personas.
create table if not exists public.coverage_requests (
  id              bigint generated always as identity primary key,
  day             date not null default (now() at time zone 'America/Guayaquil')::date,
  lat_aprox       numeric(6,2) not null,
  lng_aprox       numeric(6,2) not null,
  device_hash     text not null default '',
  nearest_city_id uuid references public.cities(id) on delete set null,
  km              numeric(8,1),
  created_at      timestamptz not null default now()
);
create unique index if not exists idx_coverage_requests_unico
  on public.coverage_requests (day, lat_aprox, lng_aprox, device_hash);
create index if not exists idx_coverage_requests_dia on public.coverage_requests (day);
alter table public.coverage_requests enable row level security;
revoke all on public.coverage_requests from anon, authenticated;
comment on table public.coverage_requests is
  'Aperturas de la app fuera de toda ciudad, redondeadas a ~1 km: dónde abrir la siguiente.';

create or replace function public.registrar_sin_cobertura(p_lat numeric, p_lng numeric, p_dispositivo text)
returns void
language sql
set search_path = public, pg_temp
as $$
  insert into public.coverage_requests (lat_aprox, lng_aprox, device_hash, nearest_city_id, km)
  select round(p_lat, 2), round(p_lng, 2), coalesce(p_dispositivo, ''), u.id, u.km
  from (select 1) uno
  left join lateral (select * from public.ciudad_de_la_ubicacion(p_lat, p_lng)) u on true
  where p_lat between -90 and 90 and p_lng between -180 and 180
  on conflict (day, lat_aprox, lng_aprox, device_hash) do nothing
$$;

revoke all on function public.registrar_sin_cobertura(numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.registrar_sin_cobertura(numeric, numeric, text) to service_role;

-- Para el superadmin: dónde se pide, cuántas personas y la ciudad más cercana.
create or replace function public.cobertura_pedida(p_dias integer default 30)
returns table (lat_aprox numeric, lng_aprox numeric, ciudad_cercana text, km numeric, personas bigint, ultima date)
language sql
stable
set search_path = public, pg_temp
as $$
  -- Personas = dispositivos distintos; los que no mandan dispositivo cuentan
  -- uno por día (no se pueden distinguir entre sí).
  select r.lat_aprox, r.lng_aprox, c.name, min(r.km),
         count(distinct nullif(r.device_hash, '')) + count(distinct case when r.device_hash = '' then r.day end),
         max(r.day)
  from public.coverage_requests r
  left join public.cities c on c.id = r.nearest_city_id
  where r.day >= (now() at time zone 'America/Guayaquil')::date - greatest(coalesce(p_dias, 30), 1)
  group by r.lat_aprox, r.lng_aprox, c.name
  order by 5 desc, 6 desc
  limit 100
$$;

revoke all on function public.cobertura_pedida(integer) from public, anon, authenticated;
grant execute on function public.cobertura_pedida(integer) to service_role;
