-- ============================================================================
-- LA TARIFA DE SERVICIO (como las grandes)
--
-- Decisión del dueño (2026-09-27): una tarifa fija por pedido, IGUAL para todo
-- método de pago (en Ecuador es ilegal cobrar más por pagar con tarjeta), que
-- se ve en el carrito ANTES de confirmar y es entera de Umbani. Cubre la
-- comisión de la tarjeta y los mensajes de WhatsApp en los pedidos pequeños.
--
-- Nace en $0 (apagada): se enciende en Superadmin → Configuración
-- (`server_settings.service_fee`). La lee la BASE, que es la que cobra; la
-- app la pide aquí mismo para enseñarla, así el número que ve el cliente y el
-- que se cobra salen del mismo sitio.
-- ============================================================================

alter table public.orders
  add column if not exists service_fee numeric(10,2) not null default 0;

alter table public.orders drop constraint if exists orders_service_fee_check;
alter table public.orders add constraint orders_service_fee_check
  check (service_fee >= 0 and service_fee <= 5);

comment on column public.orders.service_fee is
  'Tarifa de servicio congelada en el pedido. Va DENTRO de platform_markup (es de Umbani); aparte solo para desglosarla.';

-- Tope de $5: una tarifa mayor es un error de tecleo, no una decisión.
create or replace function public.tarifa_de_servicio()
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select least(btrim(value)::numeric(10,2), 5)
    from public.server_settings
    where key = 'service_fee' and btrim(value) ~ '^[0-9]{1,2}([.][0-9]{1,2})?$'
  ), 0)
$$;

revoke all on function public.tarifa_de_servicio() from public, anon, authenticated;
grant execute on function public.tarifa_de_servicio() to service_role;

-- ── El sello del pedido suma la tarifa ────────────────────────────────────
-- Copiada ENTERA de la vigente (migration-2026-09-20-margen-respeta-los-frenos).
-- Cambia SOLO lo marcado: la tarifa entra en la parte de Umbani y en el total.
create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc     jsonb;
  v_base     numeric(10,2);
  v_modo     text;
  v_pct      numeric;
  v_piso     numeric;
  v_techo    numeric;
  v_markup   numeric(10,2);
  v_porlinea numeric(10,2);
  v_envio    numeric(10,2);
  -- La tarifa de servicio (2026-09-28): la paga el cliente, es de Umbani.
  v_tarifa   numeric(10,2);
begin
  -- Lo que el comercio cobra POR LOS PRODUCTOS: sin envío, sin propina.
  v_base := round(coalesce(new.subtotal, 0) - coalesce(new.discount, 0), 2);

  if v_base <= 0 then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.discount is not distinct from old.discount
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  v_calc := public.calculate_platform_markup(new.business_id, v_base, new.pricing_rule_id);
  v_markup := (v_calc ->> 'markup')::numeric;
  v_modo := coalesce(v_calc ->> 'markup_mode', 'absorbed');

  -- Con `on_top` el precio se muestra por producto, así que el margen se
  -- calcula por línea o el total no coincidiría con lo que el cliente sumó.
  -- Si el pedido aún no tiene líneas (bot y mostrador) se queda el del
  -- subtotal: en esos caminos nunca se mostró un precio unitario con margen.
  if v_modo = 'on_top' and (v_calc ->> 'strategy') = 'percentage' then
    select percentage, min_amount, max_amount
      into v_pct, v_piso, v_techo
    from public.pricing_rules
    where id = nullif(v_calc ->> 'rule_id', '')::uuid;

    -- ⚠️ SOLO por línea cuando la regla no tiene frenos de PEDIDO.
    --
    -- Un techo o un piso no son del producto, son del pedido entero: con un
    -- techo de $1 el reparto por línea cobraba $5 y se saltaba el freno. Y el
    -- cliente nunca vio ese número, porque ni el catálogo (`precioDeVitrina`)
    -- ni la cotización (`quoteCart`) pintan margen por producto cuando la
    -- regla lleva topes. Esta era la única capa que no hacía la excepción.
    --
    -- Con frenos se queda el margen del subtotal, que es el que YA viene
    -- recortado por `calculate_platform_markup` y el que la app le enseñó.
    if v_piso is null and v_techo is null then
      v_porlinea := public.order_markup_by_line(new.id, coalesce(v_pct, 0));
      if v_porlinea is not null then
        v_markup := v_porlinea;
      end if;
    end if;
  end if;

  -- ── La tarifa de servicio ─────────────────────────────────────────────
  --
  -- Solo en los pedidos de la TIENDA (el mostrador lo teclea el dueño con la
  -- persona delante). Se CONGELA en el pedido: si ya tenía una, se respeta;
  -- cambiar la tarifa mañana no reescribe lo vendido hoy.
  --
  -- ⚠️ Va DENTRO de `platform_markup` (la parte de Umbani) y además aparte en
  -- `service_fee`, solo para enseñarla desglosada. Así los reportes, el libro,
  -- las liquidaciones y la validación del comprobante ya la tratan como de
  -- Umbani sin tocarlos: el local nunca se queda con ella.
  v_tarifa := case
    when tg_op = 'UPDATE' and coalesce(old.service_fee, 0) > 0 then old.service_fee
    when coalesce(new.source, '') = 'storefront' then public.tarifa_de_servicio()
    else 0
  end;
  new.service_fee := v_tarifa;

  new.platform_markup      := v_markup + v_tarifa;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  if v_modo = 'on_top' then
    -- El comercio conserva su precio ENTERO: es la promesa del modo.
    new.merchant_subtotal := v_base;
    -- Y el margen se suma a lo que paga el cliente. El envío se respeta tal
    -- como lo dejó la función del dinero.
    v_envio := round(coalesce(new.total, 0) - v_base, 2);
    if v_envio < 0 then v_envio := 0; end if;
    new.total := round(v_base + v_markup + v_envio + v_tarifa, 2);
  else
    -- `absorbed`: el margen sale del precio del comercio y el cliente paga
    -- lo mismo. El total solo sube por la tarifa, que paga el cliente: la
    -- comisión se le quita al comercio, la tarifa NUNCA.
    new.merchant_subtotal := round(v_base - v_markup, 2);
    new.total := round(coalesce(new.total, 0) + v_tarifa, 2);
  end if;

  return new;
end;
$$;
