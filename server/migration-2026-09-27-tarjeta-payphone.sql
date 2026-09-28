-- ============================================================================
-- PAGO CON TARJETA (PAYPHONE) — EL COBRO, LA CONFIRMACIÓN Y LA DEVOLUCIÓN
--
-- Decisión del dueño (2026-09-27): la tarjeta entra en la cuenta PayPhone de
-- UMBANI, y Umbani liquida después a cada local. Es lo que hacen las grandes
-- y lo que deja cobrar la comisión en el acto, sin «Nos debe». Este archivo
-- es la PRIMERA pieza: cobrar, confirmar y devolver. La liquidación al local
-- (y el split) llega en su propio PR.
--
-- ── Lo que obliga el diseño: PayPhone NO avisa ────────────────────────────
--
-- No hay webhook. PayPhone redirige al TELÉFONO del cliente a nuestra URL de
-- respuesta, y es NUESTRO servidor quien tiene que llamar a su `Confirm`. Si
-- nadie confirma en 5 minutos, PayPhone DEVUELVE el dinero solo. Por eso:
--
--   · Cada intento se registra ANTES de mandar al cliente a pagar, con una
--     referencia nuestra (`client_transaction_id`) que PayPhone devuelve.
--   · Una tarea del servidor confirma cada intento pase lo que pase con el
--     teléfono. La redirección solo enseña el resultado antes.
--   · La base decide si se confirma: si el pedido ya no está para cobrarse
--     —lo canceló el local, ya se pagó con otro intento— NO se confirma, y
--     PayPhone lo devuelve solo. Ningún dinero se queda donde no debe.
--
-- ── Cada centavo cuadra, o no se confirma ─────────────────────────────────
--
-- Todo en CENTAVOS ENTEROS, como trabaja PayPhone. El monto del intento sale
-- de `orders.total` en la base —nunca del teléfono— y al asentar se exige que
-- lo cobrado sea IGUAL a ese monto y al total vigente del pedido. Si no, el
-- pago no marca nada y pasa a devolverse.
--
-- ── El modo PRUEBAS en producción ─────────────────────────────────────────
--
-- En pruebas PayPhone aprueba TODO sin cobrar. Si ese modo alcanzara a un
-- local real, un cliente se llevaría comida gratis. Por eso cada local lleva
-- `card_mode` y cada pago su `environment`, y la base exige que coincidan al
-- iniciar Y al asentar: un pago de prueba jamás confirma un pedido de un
-- local en producción.
-- ============================================================================


-- ── 1. Qué locales cobran con tarjeta, y en qué modo ──────────────────────
--
-- NULO = sin tarjeta (todos, hoy). Lo pone SOLO el superadmin: el dinero entra
-- en la cuenta de Umbani, así que no puede encenderlo el dueño desde su panel
-- (por eso NO vive en `business_payment_methods`, que sí edita él).
alter table public.businesses
  add column if not exists card_mode text;

alter table public.businesses
  drop constraint if exists businesses_card_mode_check;
alter table public.businesses
  add constraint businesses_card_mode_check
  check (card_mode is null or card_mode in ('pruebas', 'produccion'));

comment on column public.businesses.card_mode is
  'Cobro con tarjeta (PayPhone): NULL = no; pruebas = solo local de pruebas '
  'con PayPhone en modo pruebas; produccion = cobro real. Lo decide el superadmin.';


-- ── 2. El CHECK de método de pago admite la tarjeta ───────────────────────
--
-- ⚠️ Es ESTE el que manda (el de `migration-2026-08-07-checkout.sql`, que pisó
-- al del create table). Se reescribe entero, igual que entonces.
do $$
begin
  alter table public.orders drop constraint if exists orders_pago_check;
  alter table public.orders add constraint orders_pago_check check (
    shipping >= 0
    and (
      payment_method is null
      or payment_method in ('transferencia', 'efectivo', 'pago_al_retirar', 'tarjeta')
    )
    and (delivery_notes is null or char_length(delivery_notes) <= 300)
  );
end;
$$;


-- ── 3. Los pagos ──────────────────────────────────────────────────────────
--
-- Genérica a propósito: PayPhone hoy, Deuna mañana. Un intento de cobro por
-- fila; un pedido puede tener varios (el cliente cerró la página y volvió a
-- intentarlo), pero solo UNO aprobado.
create table if not exists public.payments (
  id                      uuid primary key default gen_random_uuid(),
  business_id             uuid not null references public.businesses(id) on delete cascade,
  order_id                uuid not null,
  provider                text not null default 'payphone',
  method                  text not null default 'tarjeta',
  environment             text not null,
  -- La referencia NUESTRA que viaja a PayPhone y vuelve en la redirección.
  client_transaction_id   text not null,
  -- El id que asigna PayPhone. Llega con la redirección o con la consulta.
  provider_transaction_id text,
  -- Lo que se pidió cobrar (el total del pedido al iniciar) y lo que PayPhone
  -- dice que cobró. Centavos enteros.
  amount_cents            integer not null,
  captured_cents          integer,
  currency                text not null default 'USD',
  status                  text not null default 'iniciado',
  status_detail           text,
  -- Lo que el dueño ve y lo que pide un reclamo. NUNCA el número de tarjeta.
  authorization_code      text,
  card_brand              text,
  card_last_digits        text,
  confirm_attempts        integer not null default 0,
  -- Cuándo vuelve a mirarlo la tarea del servidor.
  next_check_at           timestamptz not null default now(),
  approved_at             timestamptz,
  reversed_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- ⚠️ Por PAREJA (id, business_id): un pago no puede apuntar al pedido de
  -- OTRO negocio. Lo exige `verificar-fronteras.sql`.
  constraint payments_order_fk foreign key (order_id, business_id)
    references public.orders (id, business_id) on delete cascade,
  constraint payments_provider_check    check (provider in ('payphone')),
  constraint payments_method_check      check (method in ('tarjeta')),
  constraint payments_environment_check check (environment in ('pruebas', 'produccion')),
  constraint payments_currency_check    check (currency = 'USD'),
  -- Un pedido de $100.000 no existe aquí; un monto así es un error de cálculo.
  constraint payments_amount_check      check (amount_cents > 0 and amount_cents <= 10000000),
  constraint payments_captured_check    check (captured_cents is null or captured_cents >= 0),
  constraint payments_client_tx_check   check (client_transaction_id ~ '^[A-Za-z0-9-]{8,50}$'),
  constraint payments_last_digits_check check (card_last_digits is null or card_last_digits ~ '^[0-9]{2,4}$'),
  constraint payments_status_check check (status in (
    'iniciado',          -- se preparó el cobro y el cliente fue a pagar
    'confirmando',       -- la base aceptó que se confirme; falta la respuesta
    'aprobado',          -- cobrado, cuadrado y aplicado al pedido
    'rechazado',         -- PayPhone lo canceló o la tarjeta no pasó
    'caducado',          -- nadie pagó dentro del plazo de PayPhone
    'no_confirmado',     -- se pagó, pero el pedido ya no se podía cobrar:
                         -- no se confirmó y PayPhone lo devuelve solo
    'por_devolver',      -- cobrado y hay que devolverlo (pedido cancelado o descuadre)
    'devuelto',          -- devuelto por la API de PayPhone
    'devolucion_manual'  -- PayPhone no dejó revertirlo: hay que devolverlo a mano
  ))
);

alter table public.payments enable row level security;
-- ⚠️ Sin políticas y sin permisos para anon/authenticated: aquí hay códigos
-- de autorización y los últimos dígitos de tarjetas. Solo el servidor.
revoke all on table public.payments from anon, authenticated;

create unique index if not exists payments_client_tx_unico
  on public.payments (client_transaction_id);
-- El mismo cobro de PayPhone no puede aplicarse a dos intentos.
create unique index if not exists payments_provider_tx_unico
  on public.payments (provider, provider_transaction_id)
  where provider_transaction_id is not null;
-- ⚠️ LA GARANTÍA CONTRA EL DOBLE COBRO: un pedido, un pago aprobado.
create unique index if not exists payments_un_aprobado_por_pedido
  on public.payments (order_id)
  where status = 'aprobado';
create index if not exists idx_payments_biz_created
  on public.payments (business_id, created_at desc);
create index if not exists idx_payments_order
  on public.payments (order_id);
-- La cola de la tarea del servidor: solo lo que sigue vivo.
create index if not exists idx_payments_pendientes
  on public.payments (next_check_at)
  where status in ('iniciado', 'confirmando', 'por_devolver');

comment on table public.payments is
  'Intentos de cobro por pasarela (PayPhone). Centavos enteros; un solo aprobado por pedido.';


-- ── 3b. La RPC que crea el pedido admite la tarjeta ───────────────────────
--
-- Copiada ENTERA de migration-2026-09-27-pedidos-a-la-vez.sql (la vigente).
-- Cambian DOS cosas y nada más: la lista de métodos admite «tarjeta», y la
-- tarjeta nace en `esperando_pago` igual que la transferencia. Las
-- comprobaciones de dinero, stock, precio y bloqueo son las mismas.

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
  p_scheduled_for timestamptz default null
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

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;


-- ── 4. El local acepta la tarjeta si el SUPERADMIN la encendió ────────────
--
-- `orders_check_payment_method` exigía una fila en `business_payment_methods`,
-- que edita el dueño. La tarjeta se decide en `businesses.card_mode`: el resto
-- de métodos sigue exactamente igual.
create or replace function public.orders_check_payment_method()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.source, '') = 'storefront'
     and new.payment_method = 'tarjeta' then
    if not exists (
      select 1 from public.businesses
      where id = new.business_id and card_mode is not null
    ) then
      raise exception using
        errcode = '22023',
        message = 'Ese local no acepta ese método de pago.';
    end if;
    return new;
  end if;

  if coalesce(new.source, '') = 'storefront'
     and new.payment_method is not null
     and not exists (
       select 1
       from public.business_payment_methods bpm
       join public.payment_methods pm on pm.code = bpm.method_code
       where bpm.business_id = new.business_id
         and bpm.method_code = new.payment_method
         and bpm.enabled
         and pm.available
     ) then
    raise exception using
      errcode = '22023',
      message = 'Ese local no acepta ese método de pago.';
  end if;
  return new;
end;
$$;


-- ── 5. Con tarjeta NO se pide comprobante ─────────────────────────────────
--
-- Al nacer en `esperando_pago`, este disparador ponía la conversación en
-- `esperando_comprobante` y el chat le pedía al cliente una FOTO de una
-- transferencia que nunca va a hacer. Con tarjeta se conserva lo que hacía de
-- paso —borrar la pregunta pendiente, para que un «Empezar de nuevo» de antes
-- no cancele el pedido recién nacido— y NO se toca el estado.
create or replace function public.orders_mark_awaiting_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is null
     or coalesce(new.source, '') <> 'storefront'
     or new.status <> 'esperando_pago' then
    return new;
  end if;

  begin
    update public.marketplace_conversations as conv
       set current_state = case
             when new.payment_method = 'tarjeta' then conv.current_state
             else 'esperando_comprobante'
           end,
           -- ⚠️ La vista se BORRA (2026-09-27). Si el cliente tenía pendiente
           -- «¿Empezamos de nuevo o sigues?», su «Empezar de nuevo» —el botón
           -- o un «1» escrito— cancelaba este pedido recién nacido, aunque ya
           -- hubiera transferido. Esa pregunta era sobre un carrito; ahora hay
           -- un pedido y manda el candado.
           flow_state    = null,
           version       = conv.version + 1,
           updated_at    = now()
     where conv.customer_id = new.customer_id
       -- Solo si está en ESE local: si la conversación anda en otro sitio,
       -- pisarle el estado la sacaría de donde está.
       and conv.selected_business_id = new.business_id
       and case
             -- Tarjeta: solo hay algo que hacer si queda una pregunta pendiente.
             when new.payment_method = 'tarjeta' then conv.flow_state is not null
             else conv.current_state <> 'esperando_comprobante'
           end;
  exception when others then
    -- El pedido ya existe. Un fallo marcando la conversación no puede
    -- deshacerlo: lo peor que pasa es que el bot dé el mensaje de antes.
    null;
  end;

  return new;
end;
$$;

comment on function public.orders_mark_awaiting_receipt() is
  'Al crear un pedido que espera transferencia, la conversación pasa a '
  'esperando_comprobante y se borra cualquier pregunta pendiente: un «Empezar '
  'de nuevo» de antes de pedir no puede cancelar el pedido recién nacido. '
  'Con tarjeta solo se borra la pregunta: no hay comprobante que pedir.';


-- ── 6. Un pedido con tarjeta NO avanza sin el cobro confirmado ────────────
--
-- `set_order_status` permite `esperando_pago → preparacion` para quien
-- transfirió por fuera y avisó por WhatsApp. Con tarjeta eso es regalar la
-- comida: el dinero solo existe si PayPhone lo confirmó. Vive aquí, en la
-- base, porque es la única puerta que no se salta desde ningún panel.
--
-- Sin cobro solo se puede: seguir esperando, o morir (cancelar, rechazar,
-- caducar).
create or replace function public.orders_card_requires_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.payment_method = 'tarjeta'
     and new.status is distinct from old.status
     and new.payment_confirmed_at is null
     and new.status not in ('esperando_pago', 'cancelado', 'rechazado', 'expirado') then
    raise exception using
      errcode = '22023',
      message = 'Este pedido se paga con tarjeta y el cobro aún no está confirmado.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_card_requires_payment on public.orders;
create trigger orders_card_requires_payment
  before update of status on public.orders
  for each row execute function public.orders_card_requires_payment();


-- ── 7. Pedido pagado y luego cancelado → se devuelve ──────────────────────
--
-- Si el local rechaza o cancela un pedido YA cobrado, el dinero es del
-- cliente. El pago pasa a `por_devolver` y la tarea del servidor lo revierte
-- en PayPhone. Por disparador, para que ninguna puerta (panel, caducidad,
-- superadmin) pueda cancelar sin dejar la devolución en marcha.
create or replace function public.orders_card_refund_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.payment_method = 'tarjeta'
     and new.status is distinct from old.status
     and new.status in ('cancelado', 'rechazado', 'expirado') then
    update public.payments
       set status = 'por_devolver',
           status_detail = 'El pedido pasó a ' || new.status,
           next_check_at = now(),
           updated_at = now()
     where order_id = new.id
       and status = 'aprobado';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_card_refund_on_cancel on public.orders;
create trigger orders_card_refund_on_cancel
  after update of status on public.orders
  for each row execute function public.orders_card_refund_on_cancel();


-- ── 8. La caducidad no toca un cobro en curso ─────────────────────────────
--
-- Lo mismo de antes, con dos frenos más:
--   · Un pedido con un intento de tarjeta VIVO (el cliente está en la página
--     de PayPhone o se está confirmando) no caduca: caducarlo a mitad dejaría
--     el cobro sin pedido.
--   · Con tarjeta, la ventana es como mucho de 30 minutos: pagar con tarjeta
--     tarda un minuto, y quien lo abandona no tiene por qué quedarse con el
--     candado puesto dos horas.
create or replace function public.expire_unpaid_orders(
  p_limite integer default 20
)
returns table (
  order_id uuid,
  business_id uuid,
  order_number integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila record;
  v_hechos integer := 0;
begin
  for v_fila in
    select o.id, o.business_id, o.order_number
    from public.orders o
    join public.businesses b on b.id = o.business_id
    where o.status = 'esperando_pago'
      and coalesce(o.source, '') = 'storefront'
      and o.payment_proof_url is null
      and o.payment_confirmed_at is null
      and b.payment_window_minutes > 0
      and o.created_at < now() - make_interval(mins => case
            when o.payment_method = 'tarjeta' then least(b.payment_window_minutes, 30)
            else b.payment_window_minutes
          end)
      and o.created_at > now() - interval '24 hours'
      and not exists (
        select 1 from public.payments p
        where p.order_id = o.id
          and p.status in ('iniciado', 'confirmando')
      )
    order by o.created_at
    limit greatest(1, least(coalesce(p_limite, 20), 100))
  loop
    begin
      perform public.set_order_status(v_fila.business_id, v_fila.id, 'expirado');
      order_id := v_fila.id;
      business_id := v_fila.business_id;
      order_number := v_fila.order_number;
      v_hechos := v_hechos + 1;
      return next;
    exception when others then
      null;
    end;
  end loop;

  return;
end;
$$;

revoke all on function public.expire_unpaid_orders(integer) from public, anon, authenticated;
grant execute on function public.expire_unpaid_orders(integer) to service_role;


-- ── 9. Iniciar un cobro ───────────────────────────────────────────────────
--
-- La mini app pide pagar un pedido; la base comprueba que es de ESA persona
-- (negocio + pedido + teléfono de la sesión, igual que el comprobante), que
-- se paga con tarjeta, que sigue esperando el pago y que el local cobra en el
-- MISMO modo que el servidor. El monto sale del pedido, en centavos.
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

  v_centavos := round(coalesce(v_order.total, 0) * 100)::integer;
  if v_centavos <= 0 then
    return jsonb_build_object('result', 'not_payable', 'status', v_order.status);
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

revoke all on function public.start_card_payment(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.start_card_payment(uuid, uuid, text, text)
  to service_role;


-- ── 10. ¿Se confirma? — lo decide la base ANTES de llamar a PayPhone ──────
--
-- `Confirm` es lo que CAPTURA el dinero. Por eso se pregunta primero: si el
-- pedido ya no se puede cobrar, el intento pasa a `no_confirmado`, nadie
-- llama a PayPhone y PayPhone devuelve el dinero solo a los 5 minutos.
--
-- Idempotente: si el intento ya está resuelto, devuelve su estado y no toca
-- nada. La redirección y la tarea del servidor pueden llegar a la vez.
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
    when round(coalesce(v_order.total, 0) * 100)::integer <> v_pago.amount_cents then 'El total del pedido cambió'
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

revoke all on function public.claim_card_payment(text, text)
  from public, anon, authenticated;
grant execute on function public.claim_card_payment(text, text)
  to service_role;


-- ── 11. Asentar la respuesta de PayPhone ──────────────────────────────────
--
-- Aquí se decide si el dinero cuadra. Aprobado + cobrado == pedido == intento
-- (en centavos) + moneda USD → el pedido queda pagado y pasa a `pendiente`,
-- que es cuando el local lo ve como pedido nuevo y le suena la alarma. Si
-- algo no cuadra, NO se toca el pedido: el pago pasa a `por_devolver`.
--
-- ⚠️ Mueve el estado con un UPDATE propio + su fila en `order_events`, igual
-- que `attach_storefront_payment_proof`. `set_order_status` no permite
-- `esperando_pago → pendiente`, y abrir esa transición para todos dejaría
-- que un pedido por transferencia saltara el pago.
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
    when round(coalesce(v_order.total, 0) * 100)::integer <> v_pago.amount_cents
      then format('Descuadre: el pedido vale %s centavos y el cobro %s',
                  round(coalesce(v_order.total, 0) * 100)::integer, v_pago.amount_cents)
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

revoke all on function public.settle_card_payment(text, text, integer, integer, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.settle_card_payment(text, text, integer, integer, text, text, text, text, text)
  to service_role;


-- ── 12. La cola de la tarea del servidor ──────────────────────────────────
--
-- Reserva los intentos que toca mirar y los aparta un rato (`p_lease_s`) para
-- que dos instancias del servidor no trabajen el mismo. `skip locked`: lo que
-- ya está cogiendo otro, se salta.
create or replace function public.lease_card_payments(
  p_limite integer default 10,
  p_lease_s integer default 45
)
returns table (
  id uuid,
  business_id uuid,
  order_id uuid,
  environment text,
  client_transaction_id text,
  provider_transaction_id text,
  status text,
  amount_cents integer,
  confirm_attempts integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  return query
  with toca as (
    select p.id
    from public.payments p
    where p.status in ('iniciado', 'confirmando', 'por_devolver')
      and p.next_check_at <= now()
    order by p.next_check_at
    limit greatest(1, least(coalesce(p_limite, 10), 50))
    for update skip locked
  )
  update public.payments p
     set next_check_at = now() + make_interval(secs => greatest(10, least(coalesce(p_lease_s, 45), 600))),
         updated_at = now()
    from toca
   where p.id = toca.id
  returning p.id, p.business_id, p.order_id, p.environment, p.client_transaction_id,
            p.provider_transaction_id, p.status, p.amount_cents, p.confirm_attempts,
            p.created_at;
end;
$$;

revoke all on function public.lease_card_payments(integer, integer)
  from public, anon, authenticated;
grant execute on function public.lease_card_payments(integer, integer)
  to service_role;


-- ── 13. Cerrar lo que no llegó a cobrarse ─────────────────────────────────
--
-- Un intento que nadie pagó (la página de PayPhone vale 10 minutos) caduca.
-- Solo desde `iniciado`: uno en `confirmando` puede tener el dinero ya
-- capturado, y ese se resuelve preguntándole a PayPhone, no por el reloj.
create or replace function public.expire_card_payment(
  p_client_transaction_id text,
  p_detail text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_filas integer;
begin
  update public.payments
     set status = 'caducado',
         status_detail = left(coalesce(nullif(btrim(p_detail), ''), 'Nadie pagó dentro del plazo'), 300),
         updated_at = now()
   where client_transaction_id = btrim(coalesce(p_client_transaction_id, ''))
     and status = 'iniciado'
     and created_at < now() - interval '10 minutes';
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end;
$$;

revoke all on function public.expire_card_payment(text, text)
  from public, anon, authenticated;
grant execute on function public.expire_card_payment(text, text)
  to service_role;


-- ── 14. La devolución, resuelta ───────────────────────────────────────────
--
-- `devuelto` si la API de PayPhone lo revirtió; `devolucion_manual` si no se
-- pudo (PayPhone solo revierte el mismo día y antes de las 20:00): entonces
-- lo devuelve una persona y el superadmin lo ve pendiente.
create or replace function public.finish_card_refund(
  p_client_transaction_id text,
  p_reversed boolean,
  p_detail text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_filas integer;
begin
  update public.payments
     set status = case when p_reversed then 'devuelto' else 'devolucion_manual' end,
         reversed_at = case when p_reversed then now() else reversed_at end,
         status_detail = left(coalesce(
           nullif(btrim(coalesce(p_detail, '')), ''),
           status_detail
         ), 300),
         updated_at = now()
   where client_transaction_id = btrim(coalesce(p_client_transaction_id, ''))
     and status = 'por_devolver';
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end;
$$;

revoke all on function public.finish_card_refund(text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.finish_card_refund(text, boolean, text)
  to service_role;


-- ── 15. Las alertas de DINERO tienen categoría propia ─────────────────────
--
-- Un descuadre o una devolución que PayPhone no dejó hacer no puede perderse
-- entre los avisos del servidor: el superadmin los filtra por «Pagos».
-- La función se copia ENTERA de `schema.sql` (la vigente) y solo cambia la
-- lista de categorías.
alter table public.platform_errors
  drop constraint if exists platform_errors_category_check;
alter table public.platform_errors
  add constraint platform_errors_category_check
  check (category in ('canal', 'ia', 'envio', 'servidor', 'pagos'));

create or replace function public.record_platform_error(
  p_business_id uuid,
  p_category text,
  p_code text,
  p_message text,
  p_context jsonb,
  p_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_message text;
  v_context jsonb;
begin
  if p_category not in ('canal', 'ia', 'envio', 'servidor', 'pagos') then
    raise exception using errcode = '22023', message = 'Categoria de error invalida';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Huella de error invalida';
  end if;

  v_message := left(coalesce(nullif(btrim(p_message), ''), 'Error sin detalle'), 2000);
  v_context := case
    when jsonb_typeof(p_context) = 'object' and pg_column_size(p_context) <= 8192
      then p_context
    else '{}'::jsonb
  end;

  -- Upsert atómico. Se resuelve con `on conflict` sobre los índices parciales en
  -- lugar de capturar excepciones: así el registro nunca deja una transacción a
  -- medias, ni siquiera si dos errores idénticos llegan a la vez.
  if p_business_id is null then
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      null, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (fingerprint) where business_id is null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  else
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      p_business_id, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (business_id, fingerprint) where business_id is not null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

