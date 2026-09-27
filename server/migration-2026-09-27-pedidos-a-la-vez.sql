-- ============================================================================
-- DOS PEDIDOS A LA VEZ EN EL MISMO LOCAL YA NO CHOCAN
--
-- Lo destapó la batería de recorridos de clientes en staging (2026-09-27):
-- cuatro clientes pidiendo a la vez, y a uno la base le devolvió
-- «deadlock detected». Su pedido falló.
--
-- La causa es el patrón clásico de bloqueo mutuo:
--
--   1. `create_storefront_order` lee el local con FOR SHARE, un bloqueo
--      COMPARTIDO que los dos pedidos obtienen a la vez.
--   2. Al insertar el pedido, el disparador `assign_order_number` hace
--      `update businesses set last_order_number = last_order_number + 1` sobre
--      ESA MISMA fila, y para escribir necesita un bloqueo EXCLUSIVO.
--   3. Cada uno espera a que el otro suelte su bloqueo compartido; ninguno lo
--      suelta. PostgreSQL lo detecta y aborta uno de los dos.
--
-- En producción no se había visto porque casi no hay tráfico, pero bastaba la
-- primera hora punta de un local con dos clientes pidiendo en el mismo
-- segundo.
--
-- El arreglo: tomar desde el principio el bloqueo que igual se iba a necesitar
-- (FOR NO KEY UPDATE). El segundo pedido espera unos milisegundos a que el
-- primero termine, en vez de chocar. FOR NO KEY UPDATE no choca con las
-- foráneas (FOR KEY SHARE), así que nada más se frena.
--
-- La función se reescribe ENTERA porque es así como se cambia una función,
-- pero lo único distinto es ese bloqueo. Las comprobaciones de dinero, stock
-- y precio son exactamente las de antes.
-- ============================================================================

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
     and p_payment_method not in ('transferencia', 'efectivo', 'pago_al_retirar') then
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
    case when p_payment_method = 'transferencia' then 'esperando_pago' else 'pendiente' end,
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
