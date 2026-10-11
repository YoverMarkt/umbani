-- ============================================================================
-- USAR EL SALDO UMBANI AL PEDIR — fase 2 de las incidencias, parte 2 (2026-10-10)
--
-- Reglas del dueño (2026-10-10, aprobadas con el plan):
--
--   · El saldo se DESCUENTA SOLO, como Uber Cash, y se combina con CUALQUIER
--     pago, también el efectivo: con $1,10 de saldo y un pedido de $8,00, el
--     cliente paga $6,90 con lo que eligió.
--   · El TOTAL del pedido no cambia: es su precio, y de él cuelgan los
--     reportes, la comisión, el margen y el libro. Lo que cambia es lo que
--     FALTA por cobrar (total − saldo): eso cobra la tarjeta, eso se coteja
--     en el comprobante y eso recibe el repartidor en la puerta.
--   · El LOCAL NO PIERDE NADA: la parte pagada con saldo la pone Umbani, y el
--     cierre del lunes se la reconoce (se resta de la comisión que debe o se
--     le deposita). Estaba previsto para la parte 3, pero sin esto el local
--     perdería el lunes lo que el cliente pagó con saldo.
--   · Si el saldo cubre TODO, el pedido entra ya pagado (método `saldo`).
--   · Si el pedido se cancela, se rechaza o caduca, el saldo vuelve. Como con
--     la tarjeta, anular una venta YA entregada no lo devuelve.
--   · Se gasta primero el saldo que vence antes.
--   · ESCALÓN 3 de la escalera (dos reclamos rechazados): solo paga por
--     adelantado, con tarjeta o transferencia. En todas las puertas.
--   · Solo cuando la app lo pide (`p_use_credit`): la tienda web, congelada,
--     no pinta el saldo y no lo manda; el saldo se le guarda para la app.
--
-- Dar el saldo fue la parte 1 (`migration-2026-10-10-saldo-umbani.sql`);
-- cobrárselo al responsable en la liquidación del lunes es la parte 3.
--
-- ⚠️ Se copian ENTERAS las funciones vigentes que cobran «el total»; cambia
-- solo lo marcado con (2026-10-10).
-- ============================================================================


-- ── 1. El pedido guarda lo que pagó con saldo ──────────────────────────────
alter table public.orders
  add column if not exists credit_cents integer not null default 0;

comment on column public.orders.credit_cents is
  'Lo que el cliente pagó con su saldo Umbani (centavos). El total NO cambia: lo que falta por cobrar es total − esto.';

-- ⚠️ Nunca más que el total, y el método `saldo` solo si lo cubrió ENTERO: un
-- pedido «pagado con saldo» que dejara algo por cobrar no tendría quién lo
-- cobre.
alter table public.orders drop constraint if exists orders_saldo_check;
alter table public.orders add constraint orders_saldo_check check (
  credit_cents >= 0
  and credit_cents <= round(total * 100)
  and (payment_method is distinct from 'saldo'
       or (credit_cents > 0 and credit_cents = round(total * 100)))
);

-- El método `saldo`: lo pone la base cuando el saldo cubre el pedido entero.
-- El cliente no lo elige (la ruta y la RPC solo aceptan los otros cuatro).
-- ⚠️ Es ESTE el que manda (el de `migration-2026-09-27-tarjeta-payphone.sql`
-- se reescribe entero, igual que entonces).
do $$
begin
  alter table public.orders drop constraint if exists orders_pago_check;
  alter table public.orders add constraint orders_pago_check check (
    shipping >= 0
    and (
      payment_method is null
      or payment_method in ('transferencia', 'efectivo', 'pago_al_retirar', 'tarjeta', 'saldo')
    )
    and (delivery_notes is null or char_length(delivery_notes) <= 300)
  );
end;
$$;


-- ── 2. El libro: la parte que pone Umbani ──────────────────────────────────
-- `en_mano` dice QUIÉN tiene el dinero; `en_mano_cents`, CUÁNTO: el total
-- menos lo pagado con saldo, que lo pone Umbani. El invariante de siempre
-- (local + reparto + Umbani = total) no cambia.
alter table public.order_ledger
  add column if not exists credit_cents integer not null default 0;
alter table public.order_ledger
  add column if not exists en_mano_cents integer generated always as (total_cents - credit_cents) stored;

alter table public.order_ledger drop constraint if exists order_ledger_saldo_check;
alter table public.order_ledger add constraint order_ledger_saldo_check check (
  (kind = 'venta' and credit_cents between 0 and total_cents)
  or (kind = 'reverso' and credit_cents between total_cents and 0)
);

comment on column public.order_ledger.credit_cents is
  'Lo que el cliente pagó con saldo Umbani: lo pone Umbani, no quien tiene el dinero en la mano.';
comment on column public.order_ledger.en_mano_cents is
  'Lo que tiene en la mano `en_mano`: el total menos lo pagado con saldo.';


-- ── 2b. La escalera, en cada pedido en efectivo ────────────────────────────
-- El escalón 3 se pregunta ahora en cada pedido que no se paga por adelantado,
-- y la escalera busca las cuentas que compraron desde el MISMO dispositivo.
-- Sin estos índices, esa búsqueda recorría la tabla entera de sesiones: el
-- índice por cliente que había solo cubre las no revocadas, y por dispositivo
-- no había ninguno.
create index if not exists idx_storefront_sessions_cliente
  on public.storefront_sessions (customer_id);
create index if not exists idx_storefront_sessions_dispositivo
  on public.storefront_sessions (device_hash) where device_hash is not null;


-- ── 3. Gastar el saldo en un pedido ────────────────────────────────────────
-- Lo llama SOLO `create_storefront_order`, dentro de su transacción y con el
-- total ya sellado. Gasta primero lo que vence antes y nunca más de lo que
-- falta.
-- ⚠️ El candado es por PERSONA, el mismo de reportar: dos pedidos a la vez no
-- pueden gastar el mismo saldo.
create or replace function public.usar_saldo_en_pedido(p_order_id uuid, p_customer_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o public.orders%rowtype;
  v_falta integer;
  v_usado integer := 0;
  v_toma integer;
  v_lote record;
begin
  if p_customer_id is null then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('saldo:' || p_customer_id::text, 0));

  select * into v_o from public.orders
   where id = p_order_id and customer_id = p_customer_id
  for update;
  if v_o.id is null then
    return 0;
  end if;

  v_falta := round(coalesce(v_o.total, 0) * 100)::integer - coalesce(v_o.credit_cents, 0);
  for v_lote in
    select l.id,
           l.cents - coalesce((
             select sum(u.cents) from public.customer_credit_uses u
              where u.lot_id = l.id and u.reversed_at is null
           ), 0) as restante
      from public.customer_credit_lots l
     where l.customer_id = p_customer_id and l.expires_at > now()
     order by l.expires_at, l.created_at, l.id
  loop
    exit when v_falta <= 0;
    continue when v_lote.restante <= 0;
    v_toma := least(v_lote.restante, v_falta);
    insert into public.customer_credit_uses (lot_id, order_id, business_id, cents)
    values (v_lote.id, v_o.id, v_o.business_id, v_toma);
    v_usado := v_usado + v_toma;
    v_falta := v_falta - v_toma;
  end loop;

  if v_usado > 0 then
    update public.orders
       set credit_cents = credit_cents + v_usado, updated_at = now()
     where id = v_o.id;
  end if;
  return v_usado;
end;
$$;

revoke all on function public.usar_saldo_en_pedido(uuid, uuid) from public, anon, authenticated;


-- ── 4. La puerta única del pedido, con el saldo ────────────────────────────
-- Copiada ENTERA de la vigente (migration-2026-09-27-tarjeta-payphone.sql).
-- Cambian cuatro cosas y nada más: el parámetro `p_use_credit`, el bloque del
-- saldo al final (cubre todo → pagado; «elige cómo pagar el resto»; escalón
-- 3 = solo por adelantado) y lo que devuelve. Las comprobaciones de dinero,
-- stock, precio y bloqueo son las mismas.
-- ⚠️ La firma cambia: se borra la vieja para que PostgREST no vea dos.
drop function if exists public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text, text, timestamptz
);

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null,
  -- El saldo Umbani (2026-10-10): SOLO cuando la app lo pide. La tienda web no
  -- lo pinta, así que no lo manda, y el saldo se le guarda para la app.
  p_use_credit boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
  -- La dirección se copia al pedido, no se apunta. Van en variables sueltas y
  -- no en un record porque en PL/pgSQL un record sin asignar no se puede ni
  -- consultar, y sin dirección —retiro en local— no se asigna ninguna.
  v_dir_label text;
  v_dir_address text;
  v_dir_reference text;
  v_dir_latitude numeric(10,7);
  v_dir_longitude numeric(10,7);
  v_dir_accuracy numeric(7,1);
  v_dir_building_type text;
  v_dir_courier_notes text;
  -- El plato por partes: cada línea que devuelve, qué platos ya salieron en
  -- este pedido y si la nota del cliente ya se puso.
  v_linea jsonb;
  v_platos_por_partes uuid[] := '{}';
  v_nota_puesta boolean;
  -- El saldo Umbani: cuánto se pagó con él y cuánto vale el pedido sellado.
  v_saldo integer := 0;
  v_total_cents integer;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  -- ⚠️ FOR NO KEY UPDATE, no FOR SHARE (2026-09-27). El disparador que
  -- numera el pedido (`assign_order_number`) ESCRIBE en esta misma fila
  -- (`last_order_number + 1`). Con FOR SHARE, dos pedidos a la vez en el
  -- mismo local tomaban los dos el bloqueo compartido, luego cada uno
  -- esperaba al otro para escribir, y PostgreSQL mataba uno con «deadlock
  -- detected»: el cliente veía fallar su pedido. Tomando desde el principio
  -- el bloqueo que igual se iba a necesitar, el segundo ESPERA unos
  -- milisegundos a que el primero termine, en vez de chocar. No choca con
  -- las foráneas (FOR KEY SHARE), así que nada más se frena.
  for no key update;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        -- El mismo pedido devuelve el MISMO número: un doble toque no puede
        -- dejar al cliente con dos números para una sola comanda.
        'order_number', v_existente.order_number,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'credit_cents', coalesce(v_existente.credit_cents, 0),
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  -- «pago_al_retirar» es el tercer método del diagrama: no es cómo paga, es
  -- CUÁNDO — al pasar por el local. La ruta ya impide ofrecerlo a domicilio;
  -- aquí solo se comprueba que sea un valor válido, igual que el CHECK.
  if p_payment_method is not null
     and p_payment_method not in ('transferencia', 'efectivo', 'pago_al_retirar', 'tarjeta') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  --
  -- Antes esto solo COMPROBABA; ahora además trae los datos, porque el pedido
  -- se los queda. Es la misma consulta y las mismas cuatro condiciones: no se
  -- relaja nada, se aprovecha lo que ya se estaba leyendo.
  --
  -- `for share` bloquea la fila hasta que la transacción termine: sin él, el
  -- cliente podría borrar su dirección entre la comprobación y la copia.
  if p_address_id is not null then
    select label, address, reference, latitude, longitude, accuracy_m,
           building_type, courier_notes
    into v_dir_label, v_dir_address, v_dir_reference, v_dir_latitude,
         v_dir_longitude, v_dir_accuracy, v_dir_building_type,
         v_dir_courier_notes
    from public.customer_addresses
    where id = p_address_id
      and business_id = p_business_id
      and customer_id = p_customer_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  -- ⚠️ La dirección se CONGELA, igual que `order_items` congela el nombre y el
  -- precio del producto. `address_id` se queda como puntero —sirve para saber
  -- a qué casa pide más un cliente— pero ya no es de donde se lee para
  -- repartir: si el cliente corrige su dirección el martes, el pedido del lunes
  -- tiene que seguir diciendo a dónde se llevó.
  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for, delivery_notes,
    delivery_label, delivery_address, delivery_reference,
    delivery_latitude, delivery_longitude, delivery_accuracy_m,
    delivery_building_type, delivery_courier_notes
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0,
    -- ⚠️ Quien va a TRANSFERIR nace esperando el pago, no «pendiente».
    --
    -- El estado existía desde hace tiempo y no lo usaba nadie: todo pedido
    -- nacía igual, pagara como pagara. Eso hacía que el dueño viera lo mismo
    -- en dos situaciones distintas —uno que le va a pagar en la puerta y otro
    -- del que aún no ha visto un centavo— y que el cliente leyera «pedido
    -- confirmado» cuando su negocio ni lo había mirado.
    -- La tarjeta también nace DEBIENDO: el pedido existe, pero el local no lo
    -- ve como nuevo hasta que PayPhone confirma el cobro (`settle_card_payment`).
    case when p_payment_method in ('transferencia', 'tarjeta') then 'esperando_pago' else 'pendiente' end,
    'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for,
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_dir_label, v_dir_address, v_dir_reference,
    v_dir_latitude, v_dir_longitude, v_dir_accuracy,
    v_dir_building_type, v_dir_courier_notes
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id,
           available_days, available_from, available_until
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;
    -- Menús con reloj (2026-09-17): fuera de su franja no se vende, lo pinte
    -- como lo pinte el teléfono.
    if not public.producto_en_horario(
         v_product.available_days, v_product.available_from, v_product.available_until
       ) then
      raise exception using errcode = '22023',
        message = format('%s no se puede pedir a esta hora', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type,
               og.sort as group_sort
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          -- El ORDEN que el dueño le dio a este grupo, congelado como el
          -- nombre y el precio. Se copia al crear el pedido y no se consulta al
          -- leer: el panel del dueño pregunta por sus pedidos cada 12 segundos,
          -- y una unión más ahí correría sin parar durante todo el servicio.
          'option_group_sort', coalesce(v_option_row.group_sort, 0),
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── El plato POR PARTES: la mesa entera, partida en sus líneas ────────
    --
    -- Va DESPUÉS de validar cada opción —pertenencia, stock y cantidades— y
    -- ANTES de las comprobaciones de grupos, que en este plato no aplican: aquí
    -- las porciones son de toda la mesa, no de una unidad. Un producto sin
    -- partes no entra y sigue exactamente el camino de siempre.
    if exists (
      select 1 from public.option_groups og
      where og.business_id = p_business_id
        and og.product_id = v_product_id
        and og.active = true
        and og.is_meal_part = true
    ) then
      if v_quantity <> 1 or v_has_variant or coalesce(cardinality(v_extras_names), 0) > 0 then
        raise exception using errcode = '22023',
          message = format('%s se arma en una sola línea', v_product.name);
      end if;
      -- Dos líneas del mismo plato no se juntarían: la sopa en una y el segundo
      -- en otra saldrían sueltos, por menos que el precio del dueño.
      if v_product_id = any(v_platos_por_partes) then
        raise exception using errcode = '22023',
          message = format('%s va una sola vez en el pedido', v_product.name);
      end if;
      v_platos_por_partes := v_platos_por_partes || v_product_id;

      v_nota_puesta := false;
      for v_linea in
        select value from jsonb_array_elements(
          public.lineas_del_plato_por_partes(
            p_business_id, v_product_id, v_product.name, v_unit_price, v_chosen
          )
        )
      loop
        v_line_total := round(
          (v_linea ->> 'unit_price')::numeric * (v_linea ->> 'quantity')::integer, 2
        );
        v_subtotal := v_subtotal + v_line_total;

        -- Lo elegido entra también en `extras_names`, igual que en cualquier
        -- plato: es lo que el dueño lee en su panel de pedidos.
        insert into public.order_items (
          order_id, business_id, product_id, product_name,
          variant_id, variant_name, extras_names, item_note,
          quantity, unit_price, line_total
        ) values (
          v_order_id, p_business_id, v_product.id, v_linea ->> 'name',
          null, null,
          coalesce((
            select array_agg(
              case when (t.o ->> 'quantity')::integer > 1
                then format('%s x%s', t.o ->> 'option_name', t.o ->> 'quantity')
                else t.o ->> 'option_name'
              end
              order by t.orden
            )
            from jsonb_array_elements(v_linea -> 'options') with ordinality as t(o, orden)
          ), '{}'),
          -- La nota del cliente va en la PRIMERA línea, no repetida en todas.
          case when v_nota_puesta then null else v_note end,
          (v_linea ->> 'quantity')::integer,
          (v_linea ->> 'unit_price')::numeric,
          v_line_total
        )
        returning id into v_order_item_id;
        v_nota_puesta := true;

        insert into public.order_item_options (
          business_id, order_item_id, option_group_id, option_id,
          option_group_name, group_sort, option_name, quantity,
          unit_price_adjustment, total_price_adjustment
        )
        select p_business_id, v_order_item_id,
               (o ->> 'option_group_id')::uuid, (o ->> 'option_id')::uuid,
               o ->> 'option_group_name',
               coalesce((o ->> 'option_group_sort')::integer, 0),
               o ->> 'option_name',
               (o ->> 'quantity')::integer,
               (o ->> 'unit_price_adjustment')::numeric,
               round((o ->> 'unit_price_adjustment')::numeric * (o ->> 'quantity')::integer, 2)
        from jsonb_array_elements(v_linea -> 'options') o;
      end loop;
      continue;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, group_sort, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name',
           coalesce((e ->> 'option_group_sort')::integer, 0),
           e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  -- ── El saldo Umbani (2026-10-10, fase 2 de las incidencias, parte 2) ────
  --
  -- Va AL FINAL, con el total ya sellado: `orders_stamp_pricing` le sumó el
  -- margen y la tarifa en el UPDATE de arriba. El saldo paga el pedido como
  -- cualquier otro pago —productos, envío, comisión y tarifa—.
  --
  -- ⚠️ El TOTAL no cambia: es el precio del pedido, y de él cuelgan los
  -- reportes, la comisión y el libro. Lo que cambia es lo que FALTA por
  -- cobrar (total − saldo): eso es lo que cobra la tarjeta, lo que se coteja
  -- en el comprobante y lo que el repartidor recibe en la puerta.
  if coalesce(p_use_credit, false) and p_customer_id is not null then
    v_saldo := public.usar_saldo_en_pedido(v_order_id, p_customer_id);
  end if;

  select round(total * 100)::integer into v_total_cents
    from public.orders where id = v_order_id;

  if v_saldo > 0 and v_saldo >= v_total_cents then
    -- Lo cubre ENTERO: el pedido entra ya pagado. Es el mismo paso que da un
    -- cobro con tarjeta al confirmarse (`settle_card_payment`): esperando
    -- pago → pendiente, y el local lo ve como pedido nuevo al instante.
    update public.orders
       set payment_method = 'saldo',
           payment_confirmed_at = now(),
           status = case when status = 'esperando_pago' then 'pendiente' else status end,
           updated_at = now()
     where id = v_order_id;
    if p_payment_method in ('transferencia', 'tarjeta') then
      insert into public.order_events (business_id, order_id, from_status, to_status, note)
      values (p_business_id, v_order_id, 'esperando_pago', 'pendiente', 'Pagado con saldo Umbani');
    end if;
  elsif v_saldo > 0 and p_payment_method is null then
    -- Quien usa su saldo dice cómo paga lo que falta: un pedido «por
    -- coordinar» con saldo dentro no sabe quién cobra qué. Sin saldo
    -- usado, el pedido sin método sigue como siempre.
    raise exception using errcode = '22023', message = 'Elige cómo pagar el resto';
  elsif not coalesce((select pm.is_prepaid from public.payment_methods pm
                       where pm.code = p_payment_method), false) then
    -- ⚠️ ESCALÓN 3 de la escalera (dos reclamos rechazados): solo paga POR
    -- ADELANTADO (`payment_methods.is_prepaid`: tarjeta o transferencia; sin
    -- método tampoco). Vale para todas las puertas —la app y la tienda web—,
    -- y el mensaje no le explica la regla. La escalera se mira SOLO aquí, en
    -- un `if` aparte: con tarjeta o transferencia no hace falta preguntarla.
    if (public.escalera_del_cliente(p_customer_id) ->> 'escalon')::integer >= 3 then
      raise exception using errcode = '22023', message = 'Para este pedido elige tarjeta o transferencia.';
    end if;
  end if;

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'credit_cents', v_saldo,
    'items', v_count
  );
end;
$$;

revoke all on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text, text, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text, text, timestamptz, boolean
) to service_role;


-- ── 5. Si el pedido no sigue, el saldo vuelve ──────────────────────────────
-- Por disparador, como la devolución de la tarjeta: ninguna puerta (panel,
-- caducidad, superadmin, repartidor) puede cancelar sin devolverlo. Vuelve a
-- su lote; si ese lote ya venció, vence con él.
create or replace function public.orders_return_credit_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('cancelado', 'rechazado', 'expirado') then
    update public.customer_credit_uses
       set reversed_at = now()
     where order_id = new.id
       and reversed_at is null;
  end if;
  return new;
end;
$$;

revoke all on function public.orders_return_credit_on_cancel() from public, anon, authenticated;

drop trigger if exists orders_return_credit_on_cancel on public.orders;
create trigger orders_return_credit_on_cancel
  after update of status on public.orders
  for each row when (new.credit_cents > 0)
  execute function public.orders_return_credit_on_cancel();


-- ── 6. La tarjeta cobra lo que FALTA ───────────────────────────────────────
-- Copiadas ENTERAS de migration-2026-09-29-frenos-de-tarjeta.sql /
-- migration-2026-09-27-tarjeta-payphone.sql (las vigentes). Cambia solo el
-- monto: total − saldo, al iniciar, al reclamar y al cuadrar al centavo.

create or replace function public.start_card_payment(
  p_business_id uuid,
  p_order_id uuid,
  p_contact_phone text,
  p_environment text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     public.orders%rowtype;
  v_modo      text;
  v_centavos  integer;
  v_intentos  integer;
  v_referencia text;
  v_pago_id   uuid;
  v_frenos    jsonb := public.frenos_de_tarjeta();
begin
  if p_environment is null or p_environment not in ('pruebas', 'produccion') then
    raise exception using errcode = '22023', message = 'Modo de cobro inválido';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and business_id = p_business_id
    and contact_phone = btrim(coalesce(p_contact_phone, ''))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if coalesce(v_order.payment_method, '') <> 'tarjeta' then
    return jsonb_build_object('result', 'not_card');
  end if;

  if v_order.payment_confirmed_at is not null
     or exists (select 1 from public.payments where order_id = p_order_id and status = 'aprobado') then
    return jsonb_build_object('result', 'already_paid');
  end if;

  if v_order.status <> 'esperando_pago' then
    return jsonb_build_object('result', 'not_payable', 'status', v_order.status);
  end if;

  select card_mode into v_modo from public.businesses where id = p_business_id;
  if v_modo is distinct from p_environment then
    return jsonb_build_object('result', 'card_unavailable');
  end if;

  -- Freno contra quien prueba tarjetas robadas: 5 intentos por pedido y hora.
  select count(*) into v_intentos
  from public.payments
  where order_id = p_order_id
    and created_at > now() - interval '1 hour';
  if v_intentos >= 5 then
    return jsonb_build_object('result', 'too_many_attempts');
  end if;

  -- ⚠️ Y POR CLIENTE, entre todos sus pedidos (2026-09-29): el freno por pedido
  -- se esquivaba creando pedidos nuevos, que es justo lo que hace quien prueba
  -- tarjetas robadas.
  if v_order.customer_id is not null then
    select count(*) into v_intentos
    from public.payments p
    join public.orders o on o.id = p.order_id and o.business_id = p.business_id
    where o.customer_id = v_order.customer_id
      and p.created_at > now() - interval '1 hour';
    if v_intentos >= (v_frenos ->> 'intentos_por_hora')::integer then
      return jsonb_build_object('result', 'too_many_attempts');
    end if;
  end if;

  -- Tarjeta apagada para este cliente por rechazos recientes.
  if public.tarjeta_apagada_para(v_order.customer_id) then
    return jsonb_build_object('result', 'card_blocked');
  end if;

  -- Lo que FALTA: lo que el cliente pagó con saldo Umbani no se cobra dos
  -- veces (2026-10-10).
  v_centavos := round(coalesce(v_order.total, 0) * 100)::integer - coalesce(v_order.credit_cents, 0);
  if v_centavos <= 0 then
    return jsonb_build_object('result', 'not_payable', 'status', v_order.status);
  end if;

  -- El tope por pedido, otra vez aquí: el disparador lo impide al crear el
  -- pedido, y esto es el cinturón para uno que llegara por otro camino.
  if v_centavos > (v_frenos ->> 'tope_por_pedido_cents')::integer then
    return jsonb_build_object('result', 'over_card_limit');
  end if;

  v_referencia := replace(gen_random_uuid()::text, '-', '');

  insert into public.payments (
    business_id, order_id, provider, method, environment,
    client_transaction_id, amount_cents, currency, status,
    -- La primera consulta de la tarea llega en un minuto: si el teléfono no
    -- vuelve con la redirección, el cobro se busca igual.
    next_check_at
  ) values (
    p_business_id, p_order_id, 'payphone', 'tarjeta', p_environment,
    v_referencia, v_centavos, 'USD', 'iniciado',
    now() + interval '60 seconds'
  )
  returning id into v_pago_id;

  return jsonb_build_object(
    'result', 'ok',
    'payment_id', v_pago_id,
    'client_transaction_id', v_referencia,
    'amount_cents', v_centavos,
    'currency', 'USD',
    'order_number', v_order.order_number
  );
end;
$$;

create or replace function public.claim_card_payment(
  p_client_transaction_id text,
  p_provider_transaction_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pago  public.payments%rowtype;
  v_order public.orders%rowtype;
  v_modo  text;
  v_id    text := nullif(btrim(coalesce(p_provider_transaction_id, '')), '');
  v_motivo text;
begin
  select * into v_pago
  from public.payments
  where client_transaction_id = btrim(coalesce(p_client_transaction_id, ''))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_pago.status not in ('iniciado', 'confirmando') then
    return jsonb_build_object('result', 'final', 'status', v_pago.status,
                              'order_id', v_pago.order_id, 'business_id', v_pago.business_id);
  end if;

  -- Un id de PayPhone que no es el que ya teníamos: alguien armó la URL a
  -- mano. No se confirma nada con él.
  if v_id is not null and v_pago.provider_transaction_id is not null
     and v_pago.provider_transaction_id <> v_id then
    return jsonb_build_object('result', 'mismatch', 'order_id', v_pago.order_id,
                              'business_id', v_pago.business_id);
  end if;

  select * into v_order from public.orders where id = v_pago.order_id for update;
  select card_mode into v_modo from public.businesses where id = v_pago.business_id;

  v_motivo := case
    when v_order.id is null then 'El pedido ya no existe'
    when v_order.status <> 'esperando_pago' then 'El pedido pasó a ' || v_order.status
    when v_order.payment_confirmed_at is not null then 'El pedido ya estaba pagado'
    when exists (select 1 from public.payments
                 where order_id = v_pago.order_id and status = 'aprobado') then 'Ya se pagó con otro intento'
    when v_modo is distinct from v_pago.environment then 'El local cambió de modo de cobro'
    when round(coalesce(v_order.total, 0) * 100)::integer - coalesce(v_order.credit_cents, 0)
         <> v_pago.amount_cents then 'El total del pedido cambió'
    else null
  end;

  if v_motivo is not null then
    update public.payments
       set status = 'no_confirmado',
           status_detail = v_motivo,
           provider_transaction_id = coalesce(provider_transaction_id, v_id),
           updated_at = now()
     where id = v_pago.id;
    return jsonb_build_object('result', 'dont_confirm', 'reason', v_motivo,
                              'order_id', v_pago.order_id, 'business_id', v_pago.business_id);
  end if;

  update public.payments
     set status = 'confirmando',
         provider_transaction_id = coalesce(provider_transaction_id, v_id),
         confirm_attempts = confirm_attempts + 1,
         -- Si la respuesta no llega (se cayó el proceso), la tarea lo retoma.
         next_check_at = now() + interval '30 seconds',
         updated_at = now()
   where id = v_pago.id
  returning * into v_pago;

  return jsonb_build_object(
    'result', 'confirm',
    'order_id', v_pago.order_id,
    'business_id', v_pago.business_id,
    'environment', v_pago.environment,
    'client_transaction_id', v_pago.client_transaction_id,
    'provider_transaction_id', v_pago.provider_transaction_id,
    'amount_cents', v_pago.amount_cents
  );
end;
$$;

create or replace function public.settle_card_payment(
  p_client_transaction_id text,
  p_provider_transaction_id text,
  p_status_code integer,
  p_captured_cents integer,
  p_currency text,
  p_authorization_code text default null,
  p_card_brand text default null,
  p_last_digits text default null,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pago    public.payments%rowtype;
  v_order   public.orders%rowtype;
  v_modo    text;
  v_id      text := nullif(btrim(coalesce(p_provider_transaction_id, '')), '');
  v_ultimos text := nullif(regexp_replace(coalesce(p_last_digits, ''), '[^0-9]', '', 'g'), '');
  v_marca   text := left(nullif(btrim(coalesce(p_card_brand, '')), ''), 30);
  v_detalle text := left(nullif(btrim(coalesce(p_detail, '')), ''), 300);
  v_motivo  text;
begin
  select * into v_pago
  from public.payments
  where client_transaction_id = btrim(coalesce(p_client_transaction_id, ''))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Ya resuelto: se contesta lo que hay, sin tocar nada.
  if v_pago.status not in ('iniciado', 'confirmando') then
    return jsonb_build_object('result', 'final', 'status', v_pago.status,
                              'order_id', v_pago.order_id, 'business_id', v_pago.business_id);
  end if;

  if v_id is not null and v_pago.provider_transaction_id is not null
     and v_pago.provider_transaction_id <> v_id then
    return jsonb_build_object('result', 'mismatch', 'order_id', v_pago.order_id,
                              'business_id', v_pago.business_id);
  end if;

  if v_ultimos is not null then
    v_ultimos := right(v_ultimos, 4);
  end if;

  -- ── Sin respuesta firme (1 = pendiente en PayPhone): no se toca nada ────
  -- La tarea del servidor volverá a preguntar. Marcarlo rechazado dejaría
  -- reintentar al cliente con el primer cobro todavía vivo.
  if coalesce(p_status_code, 0) not in (2, 3) then
    return jsonb_build_object('result', 'pending', 'order_id', v_pago.order_id,
                              'business_id', v_pago.business_id);
  end if;

  -- ── No aprobado: el pedido sigue esperando, el cliente puede reintentar ──
  if p_status_code = 2 then
    update public.payments
       set status = 'rechazado',
           status_detail = coalesce(v_detalle, 'PayPhone no aprobó el cobro'),
           provider_transaction_id = coalesce(provider_transaction_id, v_id),
           card_brand = coalesce(v_marca, card_brand),
           card_last_digits = coalesce(v_ultimos, card_last_digits),
           updated_at = now()
     where id = v_pago.id;
    return jsonb_build_object('result', 'rejected', 'order_id', v_pago.order_id,
                              'business_id', v_pago.business_id);
  end if;

  -- ── Aprobado: ¿cuadra al centavo y el pedido sigue para cobrarse? ────────
  select * into v_order from public.orders where id = v_pago.order_id for update;
  select card_mode into v_modo from public.businesses where id = v_pago.business_id;

  v_motivo := case
    when p_captured_cents is null or p_captured_cents <> v_pago.amount_cents
      then format('Descuadre: PayPhone cobró %s centavos y se esperaban %s',
                  coalesce(p_captured_cents::text, '?'), v_pago.amount_cents)
    when upper(coalesce(p_currency, '')) <> v_pago.currency
      then 'Descuadre: moneda ' || coalesce(p_currency, '?')
    when v_order.id is null then 'El pedido ya no existe'
    -- Lo que FALTA por cobrar: el total menos lo pagado con saldo (2026-10-10).
    when round(coalesce(v_order.total, 0) * 100)::integer - coalesce(v_order.credit_cents, 0)
         <> v_pago.amount_cents
      then format('Descuadre: faltaban %s centavos por cobrar y el cobro es de %s',
                  round(coalesce(v_order.total, 0) * 100)::integer - coalesce(v_order.credit_cents, 0),
                  v_pago.amount_cents)
    when v_order.status <> 'esperando_pago' then 'El pedido pasó a ' || v_order.status
    when v_order.payment_confirmed_at is not null then 'El pedido ya estaba pagado'
    when exists (select 1 from public.payments
                 where order_id = v_pago.order_id and status = 'aprobado') then 'Ya se pagó con otro intento'
    when v_modo is distinct from v_pago.environment then 'El local cambió de modo de cobro'
    else null
  end;

  if v_motivo is not null then
    update public.payments
       set status = 'por_devolver',
           status_detail = v_motivo,
           provider_transaction_id = coalesce(provider_transaction_id, v_id),
           captured_cents = p_captured_cents,
           authorization_code = left(nullif(btrim(coalesce(p_authorization_code, '')), ''), 60),
           card_brand = v_marca,
           card_last_digits = v_ultimos,
           next_check_at = now(),
           updated_at = now()
     where id = v_pago.id;
    return jsonb_build_object('result', 'refund', 'reason', v_motivo,
                              'order_id', v_pago.order_id, 'business_id', v_pago.business_id);
  end if;

  update public.payments
     set status = 'aprobado',
         status_detail = null,
         provider_transaction_id = coalesce(provider_transaction_id, v_id),
         captured_cents = p_captured_cents,
         authorization_code = left(nullif(btrim(coalesce(p_authorization_code, '')), ''), 60),
         card_brand = v_marca,
         card_last_digits = v_ultimos,
         approved_at = now(),
         updated_at = now()
   where id = v_pago.id;

  update public.orders
     set payment_confirmed_at = now(),
         status = 'pendiente',
         updated_at = now()
   where id = v_order.id;

  insert into public.order_events (business_id, order_id, from_status, to_status, note)
  values (v_order.business_id, v_order.id, 'esperando_pago', 'pendiente',
          left('Pagado con tarjeta' || coalesce(' · ' || v_marca, '')
               || coalesce(' ···' || v_ultimos, ''), 200));

  return jsonb_build_object(
    'result', 'approved',
    'order_id', v_order.id,
    'business_id', v_order.business_id,
    'order_number', v_order.order_number
  );
end;
$$;


-- ── 7. El libro y el cierre del lunes ──────────────────────────────────────
-- La venta anota lo pagado con saldo; el cierre cuenta en la mano solo el
-- resto. Copiadas ENTERAS de las vigentes.

create or replace function public.sales_write_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_metodo  text;
  v_courier uuid;
  v_umbani_reparte boolean := false;
  v_total   integer;
  v_umbani  integer;
  v_reparto integer;
  -- Lo que el cliente pagó con saldo Umbani: lo pone Umbani (2026-10-10).
  v_saldo   integer := 0;
begin
  if new.order_id is null
     or new.status <> 'completada'
     or new.sold_at < (public.liquidacion_semanal_desde()::timestamp at time zone 'America/Guayaquil') then
    return new;
  end if;

  select o.payment_method, o.courier_id, (c.id is not null and c.fleet_business_id is null),
         coalesce(o.credit_cents, 0)
    into v_metodo, v_courier, v_umbani_reparte, v_saldo
  from public.orders o
  left join public.couriers c on c.id = o.courier_id
  where o.id = new.order_id and o.business_id = new.business_id;

  v_total   := round(coalesce(new.total, 0) * 100)::integer;
  v_umbani  := round(coalesce(new.platform_markup, 0) * 100)::integer;
  v_reparto := round(coalesce(new.shipping, 0) * 100)::integer;
  v_saldo   := least(greatest(v_saldo, 0), v_total);

  insert into public.order_ledger (
    business_id, order_id, sale_id, kind, sold_at, payment_method,
    total_cents, local_cents, reparto_cents, umbani_cents, provider_fee_cents,
    reparto_para, courier_id, en_mano, credit_cents
  ) values (
    new.business_id, new.order_id, new.id, 'venta', new.sold_at, v_metodo,
    v_total, v_total - v_umbani - v_reparto, v_reparto, v_umbani,
    -- PayPhone cobra su comisión sobre lo que pasó por la tarjeta, no sobre
    -- lo pagado con saldo.
    case when v_metodo = 'tarjeta'
      then round((v_total - v_saldo) * public.comision_payphone_bps() / 10000.0)::integer
      else 0 end,
    case when v_umbani_reparte then 'motorizado' else 'local' end,
    case when v_umbani_reparte then v_courier end,
    case
      -- Pagado entero con saldo: nadie cobró nada; todo lo pone Umbani.
      when v_metodo in ('tarjeta', 'saldo') then 'umbani'
      when v_metodo = 'transferencia' then 'local'
      when v_umbani_reparte then 'motorizado'
      else 'local'
    end,
    -- ⚠️ La parte pagada con saldo la pone UMBANI: quien tiene el dinero en la
    -- mano solo tiene el resto (`en_mano_cents` = total − saldo).
    v_saldo
  )
  on conflict (order_id, kind) do nothing;

  return new;
end;
$$;

create or replace function public.sales_void_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.order_id is null
     or old.status is not distinct from new.status
     or old.status <> 'completada' or new.status <> 'anulada' then
    return new;
  end if;

  delete from public.order_ledger
  where order_id = new.order_id and kind = 'venta' and settlement_id is null;

  if not found then
    insert into public.order_ledger (
      business_id, order_id, sale_id, kind, sold_at, payment_method,
      total_cents, local_cents, reparto_cents, umbani_cents, provider_fee_cents,
      reparto_para, courier_id, en_mano, credit_cents
    )
    select business_id, order_id, sale_id, 'reverso', now(), payment_method,
           -total_cents, -local_cents, -reparto_cents, -umbani_cents, -provider_fee_cents,
           reparto_para, courier_id, en_mano, -credit_cents
    from public.order_ledger
    where order_id = new.order_id and kind = 'venta'
    on conflict (order_id, kind) do nothing;
  end if;

  return new;
end;
$$;

create or replace function public.close_weekly_settlements(
  p_week_start date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fin    date;
  v_hoy    date := (now() at time zone 'America/Guayaquil')::date;
  v_hasta  timestamptz;
  v_creadas integer;
begin
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception using errcode = '22023', message = 'La semana empieza en lunes.';
  end if;
  v_fin := p_week_start + 7;
  if v_fin > v_hoy then
    raise exception using errcode = '22023', message = 'Esa semana todavía no terminó.';
  end if;
  if p_week_start < public.liquidacion_semanal_desde() then
    return jsonb_build_object('semana', p_week_start, 'creadas', 0, 'motivo', 'antes_del_corte');
  end if;

  perform pg_advisory_xact_lock(hashtext('close_weekly_settlements'));
  v_hasta := v_fin::timestamp at time zone 'America/Guayaquil';

  create temp table if not exists tmp_cierre (
    business_id uuid primary key,
    pedidos integer, derecho integer, en_mano integer,
    arrastre integer, cuota integer, billing_id uuid
  ) on commit drop;
  truncate pg_temp.tmp_cierre;

  insert into pg_temp.tmp_cierre (business_id, pedidos, derecho, en_mano, arrastre, cuota, billing_id)
  with libro as (
    select l.business_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           coalesce(sum(l.local_cents
             + case when l.reparto_para = 'local' then l.reparto_cents else 0 end), 0)::integer as derecho,
           -- Lo que el local tiene en la mano: sin lo pagado con saldo, que lo pone Umbani.
           coalesce(sum(case when l.en_mano = 'local' then l.en_mano_cents else 0 end), 0)::integer as en_mano
    from public.order_ledger l
    where l.settlement_id is null and l.sold_at < v_hasta
    group by l.business_id
  ),
  deuda as (
    select s.business_id, sum(s.neto_cents)::integer as arrastre
    from public.settlements s
    where s.party = 'local' and s.courier_id is null
      and s.status = 'por_cobrar' and s.period_start < p_week_start
    group by s.business_id
  ),
  base as (
    select coalesce(l.business_id, d.business_id) as business_id,
           coalesce(l.pedidos, 0) as pedidos, coalesce(l.derecho, 0) as derecho,
           coalesce(l.en_mano, 0) as en_mano, coalesce(d.arrastre, 0) as arrastre
    from libro l
    full join deuda d on d.business_id = l.business_id
  ),
  -- La factura más vieja pendiente de cada local (cuota + la comisión de los
  -- meses anteriores al corte). Solo se descuenta si el saldo la cubre ENTERA.
  factura as (
    select distinct on (b.business_id)
           b.business_id, b.id as billing_id,
           round((coalesce(b.amount, 0) + coalesce(b.commission_amount, 0)) * 100)::integer as cents
    from public.billing b
    where b.status in ('pending', 'overdue') and b.period_start <= p_week_start
    order by b.business_id, b.period_start
  )
  select x.business_id, x.pedidos, x.derecho, x.en_mano, x.arrastre,
         case when f.cents > 0 and x.derecho - x.en_mano + x.arrastre >= f.cents
              then f.cents else 0 end,
         case when f.cents > 0 and x.derecho - x.en_mano + x.arrastre >= f.cents
              then f.billing_id end
  from base x
  left join factura f on f.business_id = x.business_id
  -- Ya liquidado esa semana: no se toca (idempotencia).
  where not exists (
    select 1 from public.settlements s
    where s.business_id = x.business_id and s.party = 'local'
      and s.courier_id is null and s.period_start = p_week_start
  );

  insert into public.settlements (
    business_id, party, period_start, period_end, orders_count,
    derecho_cents, en_mano_cents, arrastre_cents, cuota_cents, billing_id,
    neto_cents, status
  )
  select t.business_id, 'local', p_week_start, p_week_start + 6, t.pedidos,
         t.derecho, t.en_mano, t.arrastre, t.cuota, t.billing_id,
         t.derecho - t.en_mano + t.arrastre - t.cuota,
         case
           when t.derecho - t.en_mano + t.arrastre - t.cuota > 0 then 'por_pagar'
           when t.derecho - t.en_mano + t.arrastre - t.cuota < 0 then 'por_cobrar'
           else 'en_cero'
         end
  from pg_temp.tmp_cierre t
  on conflict do nothing;
  get diagnostics v_creadas = row_count;

  -- Cada pedido se liquida UNA vez.
  update public.order_ledger l
     set settlement_id = s.id
    from public.settlements s
   where s.business_id = l.business_id and s.party = 'local' and s.courier_id is null
     and s.period_start = p_week_start
     and l.settlement_id is null and l.sold_at < v_hasta
     and exists (select 1 from pg_temp.tmp_cierre t where t.business_id = l.business_id);

  -- La deuda anterior ya viaja en el arrastre de esta semana.
  update public.settlements s
     set status = 'compensada', updated_at = now()
   where s.party = 'local' and s.courier_id is null
     and s.status = 'por_cobrar' and s.period_start < p_week_start
     and exists (select 1 from pg_temp.tmp_cierre t where t.business_id = s.business_id);

  -- La factura descontada queda pagada, con su rastro.
  update public.billing b
     set status = 'paid', paid_at = now(),
         notes = left(coalesce(nullif(btrim(b.notes), '') || ' · ', '')
           || 'Descontada de la liquidación de la semana del ' || to_char(p_week_start, 'DD/MM/YYYY'), 500)
   where b.id in (select billing_id from pg_temp.tmp_cierre where billing_id is not null);

  return jsonb_build_object('semana', p_week_start, 'creadas', v_creadas);
end;
$$;

create or replace function public.settlement_balances(
  p_business_id uuid default null
)
returns table (
  business_id      uuid,
  business_name    text,
  pedidos          integer,
  pedidos_tarjeta  integer,
  derecho_cents    integer,
  en_mano_cents    integer,
  arrastre_cents   integer,
  neto_cents       integer,
  umbani_cents     integer,
  payphone_cents   integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with libro as (
    select l.business_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           count(*) filter (where l.kind = 'venta' and l.payment_method = 'tarjeta')::integer as pedidos_tarjeta,
           coalesce(sum(l.local_cents
             + case when l.reparto_para = 'local' then l.reparto_cents else 0 end), 0)::integer as derecho,
           -- Sin lo pagado con saldo Umbani: eso lo pone Umbani (2026-10-10).
           coalesce(sum(case when l.en_mano = 'local' then l.en_mano_cents else 0 end), 0)::integer as en_mano,
           coalesce(sum(l.umbani_cents), 0)::integer as umbani,
           coalesce(sum(l.provider_fee_cents), 0)::integer as payphone
    from public.order_ledger l
    where l.settlement_id is null
      and (p_business_id is null or l.business_id = p_business_id)
    group by l.business_id
  ),
  deuda as (
    select s.business_id, sum(s.neto_cents)::integer as arrastre
    from public.settlements s
    where s.party = 'local' and s.courier_id is null and s.status = 'por_cobrar'
      and (p_business_id is null or s.business_id = p_business_id)
    group by s.business_id
  )
  select coalesce(l.business_id, d.business_id), b.name,
         coalesce(l.pedidos, 0), coalesce(l.pedidos_tarjeta, 0),
         coalesce(l.derecho, 0), coalesce(l.en_mano, 0), coalesce(d.arrastre, 0),
         coalesce(l.derecho, 0) - coalesce(l.en_mano, 0) + coalesce(d.arrastre, 0),
         coalesce(l.umbani, 0), coalesce(l.payphone, 0)
  from libro l
  full join deuda d on d.business_id = l.business_id
  join public.businesses b on b.id = coalesce(l.business_id, d.business_id)
  order by 8 desc;
$$;


-- ── 8. El repartidor cobra lo que FALTA ────────────────────────────────────
-- En la puerta, en su tope de efectivo y en su liquidación. Copiadas ENTERAS
-- de las vigentes (migration-2026-09-28-motorizados.sql y cooperativas).

create or replace function public.courier_cash_in_hand(p_courier_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
    coalesce((
      select sum(en_mano_cents) from public.order_ledger
      where courier_id = p_courier_id and en_mano = 'motorizado' and courier_settlement_id is null
    ), 0)
    + coalesce((
      -- Lo que va a cobrar: sin lo pagado con saldo Umbani (2026-10-10).
      select sum(round(o.total * 100) - coalesce(o.credit_cents, 0)) from public.orders o
      where o.courier_id = p_courier_id
        and coalesce(o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar')
        and o.status not in ('completado', 'cancelado', 'rechazado', 'expirado')
    ), 0)
  )::integer
$$;

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
    -- Lo que va a cobrar en la puerta: sin lo pagado con saldo (2026-10-10).
    v_centavos := round(v_o.total * 100)::integer - coalesce(v_o.credit_cents, 0);
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
    -- ⚠️ Lo que COBRA en la puerta (2026-10-10): el total menos lo que el
    -- cliente pagó con saldo Umbani. Cobrar `totalCents` sería cobrar de más.
    'cobrarCents', case when coalesce(p.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar')
                        then round(p.total * 100)::integer - coalesce(p.credit_cents, 0) else 0 end,
    'recoger', jsonb_build_object('local', p.local_nombre, 'direccion', p.local_direccion,
                                  'lat', p.local_lat, 'lng', p.local_lng),
    'entregar', jsonb_build_object('cliente', p.contact_name, 'direccion', p.delivery_address,
                                   'referencia', p.delivery_reference, 'notas', p.delivery_courier_notes,
                                   'lat', p.delivery_latitude, 'lng', p.delivery_longitude)
  ) order by p.courier_id is null, p.created_at), '[]'::jsonb)
  from pedidos p
$$;

create or replace function public.courier_balance(p_courier_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'pedidos', count(*) filter (where l.kind = 'venta'),
    'carrerasCents', coalesce(sum(case when l.reparto_para = 'motorizado' and not l.retenido then l.reparto_cents else 0 end), 0),
    'retenidasCents', coalesce(sum(case when l.retenido then l.reparto_cents else 0 end), 0),
    'efectivoCobradoCents', coalesce(sum(case when l.en_mano = 'motorizado' then l.en_mano_cents else 0 end), 0),
    'deAntesCents', coalesce((select sum(neto_cents) from public.courier_settlements
                              where courier_id = p_courier_id and status = 'por_cobrar'), 0),
    'efectivoEncimaCents', public.courier_cash_in_hand(p_courier_id)
  )
  from public.order_ledger l
  where l.courier_id = p_courier_id and l.courier_settlement_id is null
$$;

create or replace function public.close_weekly_courier_settlements(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fin    date;
  v_hoy    date := (now() at time zone 'America/Guayaquil')::date;
  v_hasta  timestamptz;
  v_creadas integer;
begin
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception using errcode = '22023', message = 'La semana empieza en lunes.';
  end if;
  v_fin := p_week_start + 7;
  if v_fin > v_hoy then
    raise exception using errcode = '22023', message = 'Esa semana todavía no terminó.';
  end if;
  if p_week_start < public.liquidacion_semanal_desde() then
    return jsonb_build_object('semana', p_week_start, 'creadas', 0, 'motivo', 'antes_del_corte');
  end if;

  perform pg_advisory_xact_lock(hashtext('close_weekly_courier_settlements'));
  v_hasta := v_fin::timestamp at time zone 'America/Guayaquil';

  with libro as (
    select l.courier_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           coalesce(sum(case when l.reparto_para = 'motorizado' and not l.retenido then l.reparto_cents else 0 end), 0)::integer as derecho,
           -- El efectivo que cobró: sin lo pagado con saldo Umbani (2026-10-10).
           coalesce(sum(case when l.en_mano = 'motorizado' then l.en_mano_cents else 0 end), 0)::integer as en_mano
    from public.order_ledger l
    where l.courier_id is not null and l.courier_settlement_id is null and l.sold_at < v_hasta
    group by l.courier_id
  ),
  deuda as (
    select courier_id, sum(neto_cents)::integer as arrastre
    from public.courier_settlements
    where status = 'por_cobrar' and period_start < p_week_start
    group by courier_id
  ),
  base as (
    select coalesce(l.courier_id, d.courier_id) as courier_id,
           coalesce(l.pedidos, 0) as pedidos, coalesce(l.derecho, 0) as derecho,
           coalesce(l.en_mano, 0) as en_mano, coalesce(d.arrastre, 0) as arrastre
    from libro l full join deuda d on d.courier_id = l.courier_id
  )
  insert into public.courier_settlements (
    courier_id, period_start, period_end, orders_count,
    derecho_cents, en_mano_cents, arrastre_cents, neto_cents, status
  )
  select b.courier_id, p_week_start, p_week_start + 6, b.pedidos,
         b.derecho, b.en_mano, b.arrastre, b.derecho - b.en_mano + b.arrastre,
         case when b.derecho - b.en_mano + b.arrastre > 0 then 'por_pagar'
              when b.derecho - b.en_mano + b.arrastre < 0 then 'por_cobrar'
              else 'en_cero' end
  from base b
  on conflict (courier_id, period_start) do nothing;
  get diagnostics v_creadas = row_count;

  update public.order_ledger l
     set courier_settlement_id = s.id
    from public.courier_settlements s
   where s.courier_id = l.courier_id and s.period_start = p_week_start
     and l.courier_settlement_id is null and l.sold_at < v_hasta;

  update public.courier_settlements s
     set status = 'compensada', updated_at = now()
   where s.status = 'por_cobrar' and s.period_start < p_week_start
     and exists (select 1 from public.courier_settlements n
                 where n.courier_id = s.courier_id and n.period_start = p_week_start);

  return jsonb_build_object('semana', p_week_start, 'creadas', v_creadas);
end;
$$;


-- ── 9. «No llegó» en efectivo: se devuelve lo que pagó con saldo ───────────
-- Copiada ENTERA de migration-2026-10-10-saldo-umbani.sql.

create or replace function public.customer_report_order(
  p_order_id uuid, p_phone text, p_kind text, p_lines jsonb, p_note text, p_photo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
  v_o public.orders%rowtype;
  v_base numeric;
  v_factor numeric;
  v_fila record;
  v_lineas jsonb := '[]'::jsonb;
  v_sugerido bigint := 0;
  v_local bigint := 0;
  v_umbani integer := 0;
  v_reparto integer := 0;
  v_unidad integer;
  v_unidad_local integer;
  v_total integer;
  v_id uuid;
  v_foto text := nullif(btrim(coalesce(p_photo, '')), '');
  v_cliente uuid;
  v_escalera jsonb;
  v_motivos text[] := '{}';
  v_tope integer := public.parametro_entero('reclamo_al_instante_tope_cents', 500, 0, 100000);
  v_foto_obligatoria boolean := public.parametro_entero('reclamo_foto_obligatoria', 1, 0, 1) = 1;
  v_lote jsonb;
begin
  if p_kind is null or p_kind not in ('falta_producto', 'vino_mal', 'no_llego') then
    return jsonb_build_object('result', 'tipo_invalido');
  end if;
  if p_note is not null and char_length(btrim(p_note)) > 500 then
    return jsonb_build_object('result', 'nota_larga');
  end if;
  -- La foto la sube el servidor en la carpeta de ESTE pedido: otra no vale.
  if v_foto is not null
     and (char_length(v_foto) > 300 or position(('/reclamos/' || p_order_id::text || '/') in v_foto) = 0) then
    return jsonb_build_object('result', 'foto_invalida');
  end if;

  select * into v from public.pedido_entregado_de(p_order_id, p_phone);
  if v.order_id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v.status <> 'completado' then return jsonb_build_object('result', 'no_entregado'); end if;
  if exists (select 1 from public.order_incidents i where i.order_id = v.order_id and i.origin = 'cliente') then
    return jsonb_build_object('result', 'ya_reclamado');
  end if;
  if v.entregado_en < now() - interval '48 hours' then
    return jsonb_build_object('result', 'fuera_de_plazo');
  end if;

  select * into v_o from public.orders where id = v.order_id;
  v_total := round(coalesce(v_o.total, 0) * 100)::integer;

  if p_kind = 'no_llego' then
    -- No llegó nada: el pedido entero, repartido como lo reparte el libro.
    v_umbani := least(round(coalesce(v_o.platform_markup, 0) * 100)::integer, v_total);
    v_reparto := least(round(coalesce(v_o.shipping, 0) * 100)::integer, v_total - v_umbani);
    v_local := v_total - v_umbani - v_reparto;
    -- ⚠️ Iba a pagar al recibir y no recibió nada: NO pagó. No hay nada que
    -- devolverle en saldo (el reparto de arriba queda para cobrar la comida)…
    -- salvo lo que SÍ pagó con su saldo Umbani al pedir (2026-10-10).
    v_sugerido := case when coalesce(v_o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar')
                       then least(coalesce(v_o.credit_cents, 0), v_total) else v_total end;
  else
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
      return jsonb_build_object('result', 'sin_lineas');
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_lines) x
       where jsonb_typeof(x) <> 'object'
          or coalesce(x ->> 'item', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          or coalesce(x ->> 'cantidad', '') !~ '^[0-9]{1,3}$'
    ) then
      return jsonb_build_object('result', 'linea_invalida');
    end if;

    select coalesce(sum(oi.line_total), 0) into v_base from public.order_items oi where oi.order_id = v_o.id;
    v_factor := case when v_base > 0
      then 1 + greatest(coalesce(v_o.platform_markup, 0) - coalesce(v_o.service_fee, 0), 0) / v_base
      else 1 end;

    -- La misma línea dos veces cuenta como una, sumando la cantidad.
    for v_fila in
      select (x ->> 'item')::uuid as item, sum((x ->> 'cantidad')::integer) as cantidad
        from jsonb_array_elements(p_lines) x
       group by 1
    loop
      declare
        v_item public.order_items%rowtype;
      begin
        select * into v_item from public.order_items oi where oi.id = v_fila.item and oi.order_id = v_o.id;
        if v_item.id is null or v_fila.cantidad < 1 or v_fila.cantidad > v_item.quantity then
          return jsonb_build_object('result', 'linea_invalida');
        end if;
        v_unidad_local := round(round(v_item.line_total / v_item.quantity, 2) * 100)::integer;
        v_unidad := round(round(v_item.line_total / v_item.quantity, 2) * v_factor * 100)::integer;
        v_sugerido := v_sugerido + v_unidad::bigint * v_fila.cantidad;
        v_local := v_local + v_unidad_local::bigint * v_fila.cantidad;
        v_lineas := v_lineas || jsonb_build_object(
          'item', v_item.id, 'nombre', v_item.product_name, 'cantidad', v_fila.cantidad,
          'centavos', v_unidad * v_fila.cantidad);
      end;
    end loop;
    v_sugerido := least(v_sugerido, v_total);
    -- Del sugerido, lo del local; el resto es la comisión de Umbani.
    v_local := least(v_local, v_sugerido);
    v_umbani := (v_sugerido - v_local)::integer;
  end if;

  -- La escalera, con un candado por persona: dos reportes a la vez no pueden
  -- llevarse los dos el «uno cada 30 días».
  v_cliente := public.cliente_del_telefono(p_phone);
  if v_cliente is null then
    v_motivos := array['sin_cuenta'];
  else
    perform pg_advisory_xact_lock(hashtextextended('saldo:' || v_cliente::text, 0));
    v_escalera := public.escalera_del_cliente(v_cliente, true);
    select coalesce(array_agg(m), '{}') into v_motivos from jsonb_array_elements_text(v_escalera -> 'motivos') m;
  end if;
  if p_kind = 'no_llego' then v_motivos := v_motivos || 'no_llego'::text; end if;
  if v_sugerido = 0 then v_motivos := v_motivos || 'sin_monto'::text; end if;
  if v_sugerido > v_tope then v_motivos := v_motivos || 'tope'::text; end if;
  if coalesce((v_escalera ->> 'alInstante')::integer, 0) >= 1 then v_motivos := v_motivos || 'al_instante_reciente'::text; end if;
  if p_kind = 'vino_mal' and v_foto_obligatoria and v_foto is null then v_motivos := v_motivos || 'sin_foto'::text; end if;

  insert into public.order_incidents (
    business_id, order_id, courier_id, kind, origin, lines, note, suggested_cents,
    customer_id, local_cents, umbani_cents, reparto_cents, photo_public_id, escalon, review_reasons
  )
  values (
    v_o.business_id, v_o.id, v_o.courier_id, p_kind, 'cliente', v_lineas,
    nullif(btrim(coalesce(p_note, '')), ''), v_sugerido::integer,
    v_cliente, v_local::integer, v_umbani, v_reparto, v_foto,
    (v_escalera ->> 'escalon')::smallint, v_motivos
  )
  returning id into v_id;

  if cardinality(v_motivos) = 0 then
    -- AL INSTANTE: el saldo ya. Quién responde lo confirma después el superadmin.
    v_lote := public.abonar_saldo(v_id, v_cliente, v_sugerido::integer);
    update public.order_incidents
       set status = 'compensada', compensation_cents = v_sugerido::integer,
           compensated_at = now(), auto_approved = true
     where id = v_id;
    return jsonb_build_object('result', 'ok', 'id', v_id, 'sugeridoCents', v_sugerido::integer,
      'estado', 'compensada', 'saldoCents', v_sugerido::integer, 'venceEl', v_lote ->> 'venceEl');
  end if;

  return jsonb_build_object('result', 'ok', 'id', v_id, 'sugeridoCents', v_sugerido::integer,
    'estado', 'abierta', 'saldoCents', 0);
exception
  -- Dos toques a la vez: el índice único deja entrar uno solo.
  when unique_violation then
    return jsonb_build_object('result', 'ya_reclamado');
end;
$$;


-- ── 10. El registro de dinero dice cuánto fue con saldo ────────────────────
-- Copiada ENTERA de migration-2026-09-29-registro-de-dinero.sql.

create or replace function public.orders_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_base jsonb := jsonb_build_object('numero', new.order_number,
    'metodo', new.payment_method, 'total', new.total,
    -- Lo pagado con saldo Umbani (2026-10-10): sin esto, un pedido de $8 con
    -- tarjeta y $1,10 de saldo diría que la tarjeta cobró $8.
    'saldoCents', new.credit_cents);
begin
  if old.payment_confirmed_at is null and new.payment_confirmed_at is not null then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'pago_confirmado', 'orders',
      new.id::text, v_base);
  end if;
  if new.status = 'cancelado' and old.status is distinct from 'cancelado'
     and old.payment_confirmed_at is not null then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'pedido_pagado_cancelado', 'orders',
      new.id::text, v_base || jsonb_build_object('estaba', old.status));
  end if;
  return null;
end;
$$;
