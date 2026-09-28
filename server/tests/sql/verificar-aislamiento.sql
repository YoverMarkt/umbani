-- ============================================================================
-- AISLAMIENTO MULTI-TENANT CONTRA UN POSTGRESQL REAL
--
-- La regla #1 del proyecto: un negocio JAMÁS puede ver ni tocar los datos de
-- otro. Hasta ahora solo estaba probada con simulacros; aquí se comprueba con
-- DOS negocios reales conviviendo en la misma base.
--
-- Un fallo aquí no es un bug: es un incidente de seguridad. Por eso cada
-- comprobación intenta ACTIVAMENTE cruzar la frontera y exige que la base lo
-- impida, en vez de limitarse a mirar que los datos propios estén bien.
--
-- Se corre sobre una base recién creada con bootstrap-supabase.sql + schema.sql.
-- ============================================================================

\set ON_ERROR_STOP on

do $$
declare
  v_rol text;
  v_a uuid;              -- negocio A
  v_b uuid;              -- negocio B
  v_producto_a uuid;
  v_producto_b uuid;
  v_categoria_a uuid;
  v_categoria_b uuid;
  v_producto_tmp uuid;
  v_pedidos_b integer;
  v_encolado boolean;
  v_ok boolean;
begin
  -- ── Dos negocios distintos, cada uno con lo suyo ─────────────────────────
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders
  ) values (
    'aislamiento-a', 'Negocio A', 'tienda',
    'ycloud', '+593900001111', '+593900001111', true
  ) returning id into v_a;

  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders
  ) values (
    'aislamiento-b', 'Negocio B', 'tienda',
    'ycloud', '+593900002222', '+593900002222', true
  ) returning id into v_b;

  insert into products (business_id, name, price, stock, active)
  values (v_a, 'Producto de A', 10.00, 'disponible', true)
  returning id into v_producto_a;

  insert into products (business_id, name, price, stock, active)
  values (v_b, 'Producto de B', 99.00, 'disponible', true)
  returning id into v_producto_b;

  -- ── 1. DINERO: A no puede vender el producto de B ────────────────────────
  -- Si esto pasara, un negocio podría cobrar por el catálogo del vecino.
  begin
    perform public.create_order_with_items(
      v_a, '+593900009999', 'Cliente', 'pendiente', 0, 'USD',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto_b, 'quantity', 1, 'unit_price', 99.00
      ))
    );
    raise exception 'FUGA: el negocio A pudo crear un pedido con el producto de B';
  exception when sqlstate '42501' then
    null;  -- rechazado como debe
  end;

  -- Lo mismo por el camino de las ventas. El alta manual se retiró el
  -- 2026-08-02, así que la frontera se comprueba donde ahora nace el dinero:
  -- nadie puede cobrarse el pedido de otro negocio.
  declare
    v_pedido_a uuid;
  begin
    insert into orders (business_id, contact_phone, status, total)
    values (v_a, '+593900009999', 'completado', 50.00)
    returning id into v_pedido_a;

    if public.crear_venta_desde_pedido(v_b, v_pedido_a) is not null then
      raise exception 'FUGA: el negocio B se cobró un pedido del negocio A';
    end if;

  end;

  -- Con su propio producto sí funciona: la barrera no rompe el uso legítimo.
  perform public.create_order_with_items(
    v_a, '+593900009999', 'Cliente', 'pendiente', 0, 'USD',
    jsonb_build_array(jsonb_build_object(
      'product_id', v_producto_a, 'quantity', 1, 'unit_price', 10.00
    ))
  );

  -- ── 2. CATÁLOGO: la búsqueda semántica no cruza negocios ─────────────────
  if exists (
    select 1
    from public.match_products(
      array_fill(0.01::real, array[1536])::vector, v_a, 50
    ) as encontrado
    where encontrado.id = v_producto_b
  ) then
    raise exception 'FUGA: la búsqueda del negocio A devolvió un producto de B';
  end if;

  -- ── 3. COLA DE WEBHOOKS: el mismo mensaje en dos negocios no se pisa ──────
  -- Deduplicar por hash sin mirar el negocio haría que el mensaje de un cliente
  -- silenciara el de otro.
  v_encolado := public.enqueue_webhook_event(
    v_a, 'ycloud', repeat('a', 64), repeat('b', 64), '{"content":{"kind":"text"}}'::jsonb
  );
  if v_encolado is not true then
    raise exception 'El negocio A no pudo encolar su mensaje';
  end if;

  v_encolado := public.enqueue_webhook_event(
    v_b, 'ycloud', repeat('a', 64), repeat('b', 64), '{"content":{"kind":"text"}}'::jsonb
  );
  if v_encolado is not true then
    raise exception 'FUGA: el mensaje del negocio A bloqueó el del negocio B';
  end if;

  -- ── 4. ERRORES: la misma huella en dos negocios son dos registros ────────
  perform public.record_platform_error(
    v_a, 'canal', '503', 'Mismo error', '{}'::jsonb, repeat('c', 64)
  );
  perform public.record_platform_error(
    v_b, 'canal', '503', 'Mismo error', '{}'::jsonb, repeat('c', 64)
  );
  if (select count(*) from platform_errors where fingerprint = repeat('c', 64)) <> 2 then
    raise exception 'FUGA: el error de un negocio se mezcló con el de otro';
  end if;

  -- ── 6. CATÁLOGO: el de A no se engancha al de B ──────────────────────────
  --
  -- `product_variants` lleva business_id Y product_id; `products` lleva
  -- business_id Y category_id. Con una foránea de una sola columna el negocio
  -- salía del JWT pero el otro id viajaba en la petición, así que la frontera
  -- se cruzaba mandando un uuid ajeno. Las rutas lo comprueban, pero eso
  -- dependía de que quien escriba la próxima ruta se acordara. Aquí se exige
  -- que lo impida la BASE.
  insert into product_categories (business_id, name)
  values (v_b, 'Categoría de B')
  returning id into v_categoria_b;

  begin
    insert into product_variants (business_id, product_id, name, price)
    values (v_a, v_producto_b, 'Familiar', 1.00);
    raise exception 'FUGA: el negocio A pudo colgar una variante del producto de B';
  exception when foreign_key_violation then
    null;  -- correcto: la base rechaza la pareja (producto, negocio)
  end;

  begin
    update products set category_id = v_categoria_b where id = v_producto_a;
    raise exception 'FUGA: el negocio A pudo meter su producto en la categoría de B';
  exception when foreign_key_violation then
    null;
  end;

  -- Y el uso legítimo sigue funcionando: una cerradura que también deja fuera
  -- al dueño no sirve de nada.
  insert into product_categories (business_id, name)
  values (v_a, 'Pizzas de A')
  returning id into v_categoria_a;

  update products set category_id = v_categoria_a where id = v_producto_a;

  insert into product_variants (business_id, product_id, name, price)
  values (v_a, v_producto_a, 'Familiar', 14.00);

  -- Borrar la categoría deja el producto suelto y NO revienta. Importa porque
  -- la foránea compuesta anula solo `category_id`: sin nombrar la columna,
  -- PostgreSQL intentaría anular también `business_id`, que es NOT NULL.
  delete from product_categories where id = v_categoria_a;
  select category_id is null into v_ok from products where id = v_producto_a;
  if v_ok is not true then
    raise exception 'Borrar una categoría dejó el producto apuntando a la nada';
  end if;

  -- Borrar un producto se lleva sus variantes. Se usa uno DESECHABLE: el de A
  -- tiene que seguir vivo para la comprobación de cascada que viene ahora.
  insert into products (business_id, name, price, stock, active)
  values (v_a, 'Producto desechable de A', 5.00, 'disponible', true)
  returning id into v_producto_tmp;

  insert into product_variants (business_id, product_id, name, price)
  values (v_a, v_producto_tmp, 'Único', 5.00);

  delete from products where id = v_producto_tmp;
  if exists (select 1 from product_variants where product_id = v_producto_tmp) then
    raise exception 'Las variantes sobrevivieron al producto que las contenía';
  end if;

  -- ── 7. BORRAR EL ORIGEN DE UNA VENTA NO PUEDE REVENTAR ───────────────────
  --
  -- La foránea de `sales` hacia el pedido es compuesta sobre
  -- (id, business_id) para que nadie se cobre lo del vecino. Pero una foránea
  -- compuesta CORRECTA puede tener una acción de borrado ROTA: con
  -- `on delete set null` a secas PostgreSQL anula todas las columnas de la
  -- pareja, incluida `business_id`, que es NOT NULL. Así estuvieron hasta el
  -- 2026-08-02, y borrar un pedido entregado fallaba con 23502.
  --
  -- `verificar-fronteras.sql` no lo veía: mira la FORMA de la foránea, y la
  -- forma era correcta. Por eso aquí se BORRA de verdad.
  declare
    v_pedido_venta uuid;
    v_estadia uuid;
    v_venta uuid;
    v_negocio_venta uuid;
  begin
    -- Pedido entregado → venta → borrar el pedido.
    --
    -- ⚠️ El estado NO es decorativo: `crear_venta_desde_pedido` solo cobra lo
    -- que está 'completado', y su hermana solo lo 'attended'. Con otro estado
    -- devuelven null, no habría venta que borrar, y esta comprobación pasaría
    -- sin comprobar nada. Por eso abajo se exige que la venta exista ANTES de
    -- borrar: si un día cambia la guardia de estado, salta aquí y se ve el
    -- porqué, en vez de fallar más adelante con un `business_id` nulo que no
    -- explica nada.
    insert into orders (business_id, contact_phone, status, total)
    values (v_b, '+593900007777', 'completado', 40.00)
    returning id into v_pedido_venta;
    v_venta := public.crear_venta_desde_pedido(v_b, v_pedido_venta);
    if v_venta is null then
      raise exception 'El pedido completado no generó venta: no hay nada que borrar';
    end if;

    delete from orders where id = v_pedido_venta;

    select business_id into v_negocio_venta from sales where id = v_venta;
    if v_negocio_venta is distinct from v_b then
      raise exception
        'Borrar el pedido dejó la venta sin negocio (business_id = %)', v_negocio_venta;
    end if;

  end;

  -- ── 7 bis. MOTOR DE OPCIONES: los grupos y combos no cruzan negocios ─────
  --
  -- Un grupo cuelga de un producto y una opción puede APUNTAR a otro producto
  -- (así se arman los combos). Son dos sitios más donde un uuid ajeno viajando
  -- en la petición cruzaría la frontera, y la base tiene que impedirlo sin
  -- depender de que la ruta se acuerde.
  declare
    v_grupo_a uuid;
  begin
    begin
      insert into option_groups (business_id, product_id, name)
      values (v_a, v_producto_b, 'Tamaño');
      raise exception 'FUGA: el negocio A colgó un grupo del producto de B';
    exception when foreign_key_violation then null;
    end;

    insert into option_groups (
      business_id, product_id, name, selection_type, required, min_selectable, max_selectable
    ) values (v_a, v_producto_a, 'Tamaño', 'single', true, 1, 1)
    returning id into v_grupo_a;

    begin
      insert into options (business_id, option_group_id, name, references_product_id)
      values (v_a, v_grupo_a, 'La pizza del vecino', v_producto_b);
      raise exception 'FUGA: un combo de A incluyó un producto de B';
    exception when foreign_key_violation then null;
    end;

    -- Y un grupo de B no se puede colgar de un grupo de A.
    begin
      insert into options (business_id, option_group_id, name)
      values (v_b, v_grupo_a, 'Opción ajena');
      raise exception 'FUGA: el negocio B metió una opción en el grupo de A';
    exception when foreign_key_violation then null;
    end;

    -- El uso legítimo sigue funcionando.
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_a, v_grupo_a, 'Familiar', 9.00);

    -- ── El grupo también puede colgar de una CATEGORÍA ────────────────────
    -- Es como 19 sabores los comparten todas las pizzas sin repetirlos, y como
    -- una plantilla deja grupos cargados antes de que exista un producto. Son
    -- dos destinos, así que son dos fronteras que cerrar, no una.
    declare
      v_categoria_propia uuid;
      v_grupo_categoria uuid;
    begin
      begin
        insert into option_groups (business_id, category_id, name)
        values (v_a, v_categoria_b, 'Sabor');
        raise exception 'FUGA: el negocio A colgó un grupo de la categoría de B';
      exception when foreign_key_violation then null;
      end;

      -- Y el destino es exactamente uno: ni ninguno…
      begin
        insert into option_groups (business_id, name) values (v_a, 'Huérfano');
        raise exception 'Se admitió un grupo que no cuelga de nada';
      exception when check_violation then null;
      end;

      insert into product_categories (business_id, name)
      values (v_a, 'Sabores de A')
      returning id into v_categoria_propia;

      -- …ni los dos a la vez.
      begin
        insert into option_groups (business_id, category_id, product_id, name)
        values (v_a, v_categoria_propia, v_producto_a, 'Ambos');
        raise exception 'Se admitió un grupo colgado de producto Y categoría';
      exception when check_violation then null;
      end;

      insert into option_groups (business_id, category_id, name)
      values (v_a, v_categoria_propia, 'Sabor')
      returning id into v_grupo_categoria;
      insert into options (business_id, option_group_id, name)
      values (v_a, v_grupo_categoria, 'Hawaiana');

      -- Borrar la categoría se lleva su grupo y las opciones de dentro. Va en
      -- cascade y no en `set null` porque anular el destino dejaría el grupo
      -- violando el check, y borrar una categoría reventaría.
      delete from product_categories where id = v_categoria_propia;
      if exists (select 1 from option_groups where id = v_grupo_categoria) then
        raise exception 'Borrar la categoría dejó su grupo de opciones huérfano';
      end if;
      if exists (select 1 from options where option_group_id = v_grupo_categoria) then
        raise exception 'Borrar la categoría dejó opciones huérfanas';
      end if;
      -- Y no se llevó por delante el grupo del producto, que no era suyo.
      if not exists (select 1 from option_groups where id = v_grupo_a) then
        raise exception 'Borrar una categoría se llevó el grupo de un producto';
      end if;
    end;

    -- ── Plantillas de opciones: tres puertas más ──────────────────────────
    -- Una plantilla se referencia desde varios grupos a la vez, así que un
    -- descuido aquí no filtra una opción: filtra la lista entera de otro
    -- negocio a todos los productos que la usen.
    declare
      v_plantilla_a uuid;
      v_plantilla_b uuid;
    begin
      insert into option_templates (business_id, name)
      values (v_a, 'Sabores de A') returning id into v_plantilla_a;
      insert into option_templates (business_id, name)
      values (v_b, 'Sabores de B') returning id into v_plantilla_b;

      -- A no puede meter opciones en la plantilla de B.
      begin
        insert into option_template_items (business_id, option_template_id, name)
        values (v_a, v_plantilla_b, 'Hawaiana');
        raise exception 'FUGA: el negocio A metió una opción en la plantilla de B';
      exception when foreign_key_violation then null;
      end;

      -- Ni apuntar desde su plantilla a un producto de B.
      begin
        insert into option_template_items (
          business_id, option_template_id, name, references_product_id
        ) values (v_a, v_plantilla_a, 'La pizza del vecino', v_producto_b);
        raise exception 'FUGA: la plantilla de A referenció un producto de B';
      exception when foreign_key_violation then null;
      end;

      -- Ni servir uno de sus grupos con la plantilla de B.
      begin
        insert into option_groups (business_id, product_id, name, option_template_id)
        values (v_a, v_producto_a, 'Sabor prestado', v_plantilla_b);
        raise exception 'FUGA: el grupo de A se sirvió de la plantilla de B';
      exception when foreign_key_violation then null;
      end;

      -- El uso legítimo funciona, y borrar la plantilla no revienta el grupo:
      -- se queda sin ella y el producto se sigue pudiendo pedir.
      insert into option_template_items (
        business_id, option_template_id, name, references_product_id
      ) values (v_a, v_plantilla_a, 'La pizza propia', v_producto_a);
      insert into option_groups (business_id, product_id, name, option_template_id)
      values (v_a, v_producto_a, 'Sabor', v_plantilla_a);

      delete from option_templates where id = v_plantilla_a;
      if not exists (
        select 1 from option_groups
        where business_id = v_a and name = 'Sabor' and option_template_id is null
      ) then
        raise exception 'Borrar una plantilla dejó su grupo en mal estado';
      end if;
    end;
  end;

  -- ── 7 ter. ADICIONALES: lo que se ofrece «además» ────────────────────────
  --
  -- Un adicional acaba en el carrito como LÍNEA propia, no como opción dentro
  -- de un plato. Por eso una fuga aquí es más grave que en las opciones: el
  -- cliente pediría —y pagaría— el producto de otro negocio.
  declare
    v_reco_categoria uuid;
    v_pan uuid;
  begin
    insert into products (business_id, name, price, stock, active)
    values (v_a, 'Pan de ajo', 3, 'disponible', true)
    returning id into v_pan;
    insert into product_categories (business_id, name)
    values (v_a, 'Para acompañar')
    returning id into v_reco_categoria;

    -- No se puede recomendar DESDE el producto de B…
    begin
      insert into product_recommendations (
        business_id, source_product_id, recommended_product_id
      ) values (v_a, v_producto_b, v_pan);
      raise exception 'FUGA: A colgó una recomendación del producto de B';
    exception when foreign_key_violation then null;
    end;

    -- …ni OFRECER el producto de B, que es la fuga que llegaría al carrito.
    begin
      insert into product_recommendations (
        business_id, source_product_id, recommended_product_id
      ) values (v_a, v_producto_a, v_producto_b);
      raise exception 'FUGA GRAVE: A ofreció el producto de B como adicional';
    exception when foreign_key_violation then null;
    end;

    -- …ni desde la categoría de B.
    begin
      insert into product_recommendations (
        business_id, source_category_id, recommended_product_id
      ) values (v_a, v_categoria_b, v_pan);
      raise exception 'FUGA: A recomendó desde la categoría de B';
    exception when foreign_key_violation then null;
    end;

    -- El uso legítimo funciona en sus tres formas.
    insert into product_recommendations (
      business_id, source_product_id, recommended_product_id, section
    ) values (v_a, v_producto_a, v_pan, 'Agrega algo más');
    insert into product_recommendations (
      business_id, source_category_id, recommended_product_id, section
    ) values (v_a, v_reco_categoria, v_pan, 'Con tu pedido');
    insert into product_recommendations (
      business_id, recommended_product_id, section
    ) values (v_a, v_pan, 'También te puede gustar');

    -- Y si el producto ofrecido desaparece, la recomendación se va con él: no
    -- puede quedar ofreciéndose algo que ya no se sirve.
    delete from products where id = v_pan;
    if exists (select 1 from product_recommendations where business_id = v_a) then
      raise exception 'Borrar el producto dejó recomendaciones vivas';
    end if;
  end;

  -- ── 8. BORRADO EN CASCADA: se lleva lo suyo y solo lo suyo ───────────────
  select count(*) into v_pedidos_b from orders where business_id = v_b;
  delete from businesses where id = v_a;

  if exists (select 1 from products where business_id = v_a) then
    raise exception 'Borrar el negocio A dejó sus productos huérfanos';
  end if;
  if exists (select 1 from orders where business_id = v_a) then
    raise exception 'Borrar el negocio A dejó sus pedidos huérfanos';
  end if;
  if exists (select 1 from platform_errors where business_id = v_a) then
    raise exception 'Borrar el negocio A dejó sus errores huérfanos';
  end if;

  -- Y lo más importante: no se llevó nada del vecino.
  if not exists (select 1 from products where id = v_producto_b) then
    raise exception 'FUGA GRAVE: borrar el negocio A eliminó el producto de B';
  end if;
  if (select count(*) from orders where business_id = v_b) <> v_pedidos_b then
    raise exception 'FUGA GRAVE: borrar el negocio A alteró los pedidos de B';
  end if;

  -- ── 9. RLS activa en todas las tablas de negocio ─────────────────────────
  select bool_and(c.relrowsecurity) into v_ok
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r';
  if v_ok is not true then
    raise exception 'Hay tablas sin RLS habilitada';
  end if;

  -- ── 10. La conversación del marketplace no la ve ningún negocio ─────────
  --
  -- Es la única tabla sin `business_id`, porque la conversación ABARCA varios
  -- negocios. Lo que no puede pasar es que una pizzería llegue a saber que su
  -- cliente está pidiendo en la competencia: se cierra quitando el acceso, no
  -- partiendo la tabla. Sin esto, el día que alguien añada una política
  -- permisiva nadie se enteraría.
  for v_rol in select unnest(array['anon', 'authenticated']) loop
    if has_table_privilege(v_rol, 'public.marketplace_conversations', 'select') then
      raise exception
        'FUGA GRAVE: el rol % puede leer marketplace_conversations, y ahí se ve en qué local está comprando cada cliente',
        v_rol;
    end if;
  end loop;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'marketplace_conversations'
  ) then
    raise exception
      'marketplace_conversations no debería tener políticas RLS: su protección es no dar acceso a nadie salvo service_role';
  end if;

  -- ── 11. Los pagos con tarjeta no los lee nadie salvo el servidor ────────
  --
  -- Guardan códigos de autorización y los últimos dígitos de tarjetas. RLS
  -- sin políticas ya lo cierra; esto vigila además que nadie les devuelva el
  -- permiso de tabla por descuido.
  -- Y lo mismo el libro de cada pedido y las liquidaciones: son el dinero
  -- de cada local.
  for v_rol in select unnest(array['anon', 'authenticated']) loop
    if has_table_privilege(v_rol, 'public.payments', 'select')
       or has_table_privilege(v_rol, 'public.order_ledger', 'select')
       or has_table_privilege(v_rol, 'public.settlements', 'select')
       or has_table_privilege(v_rol, 'public.app_login_codes', 'select') then
      raise exception 'FUGA GRAVE: el rol % puede leer pagos, el libro o las liquidaciones', v_rol;
    end if;
  end loop;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payments') then
    raise exception 'payments no debería tener políticas RLS: solo la lee el servidor';
  end if;

  -- Y borrar un negocio no puede llevarse la conversación del cliente con la
  -- plataforma: la reinicia, que es distinto.
  if exists (
    select 1 from marketplace_conversations where selected_business_id = v_a
  ) then
    raise exception 'Borrar el negocio A dejó conversaciones apuntándolo';
  end if;

  -- ── Limpieza ─────────────────────────────────────────────────────────────
  delete from businesses where id = v_b;

  raise notice 'AISLAMIENTO MULTI-TENANT: ninguna frontera se pudo cruzar';
end;
$$;
