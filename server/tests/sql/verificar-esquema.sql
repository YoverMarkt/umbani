-- ============================================================================
-- VERIFICACIÓN DEL ESQUEMA CONTRA UN POSTGRESQL REAL
--
-- Los demás tests LEEN el SQL. Este lo EJECUTA, que es la única forma de
-- detectar la familia de fallos que tumbó el canal cinco días en julio de 2026:
-- PostgreSQL no valida el cuerpo de una función plpgsql al crearla, así que una
-- migración puede aplicarse "con éxito" y reventar en el primer uso real.
--
-- Se corre sobre una base recién creada con bootstrap-supabase.sql + schema.sql.
-- Cualquier `raise exception` aquí hace fallar el CI.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 0. Dar de alta un cliente: la función que hace ganar dinero ────────────
--
-- Va PRIMERO y aparte porque es la más importante del sistema: sin ella no
-- entra ningún cliente nuevo. No estaba verificada, y el 2 de agosto de 2026
-- se descubrió que llevaba rota desde la migración de planes — el disparador
-- de la cuota mensual era BEFORE y su clave foránea apuntaba a una fila de
-- `billing` que aún no existía. El panel decía «No se pudo crear el cliente»
-- y el registro de errores no mostraba nada.
do $$
declare
  v_alta jsonb;
  v_nuevo uuid;
  v_cuotas integer;
begin
  v_alta := public.create_business_onboarding(
    jsonb_build_object(
      'name', 'Alta de verificación',
      'slug', 'alta-verificacion',
      'whatsapp_number', '+593900000900',
      'whatsapp_provider', 'ycloud',
      'ycloud_number', '+593900000900',
      'takes_orders', true,
      'storefront_enabled', true,
      'chat_mode', 'miniapp',
      'plan', 'micro',
      'monthly_contact_limit', 50,
      'monthly_outbound_message_limit', 250
    ),
    'verificacion@ejemplo.com',
    '$2a$10$hashdepruebaquenoesunaclavereal00000000',
    25
  );

  v_nuevo := (v_alta ->> 'id')::uuid;
  if v_nuevo is null then
    raise exception 'create_business_onboarding no devolvió el negocio creado';
  end if;

  if v_alta ->> 'chat_mode' is distinct from 'miniapp'
     or (v_alta ->> 'storefront_enabled')::boolean is distinct from true then
    raise exception 'El alta no devolvió miniapp con la tienda encendida';
  end if;
  if not exists (
    select 1
    from businesses
    where id = v_nuevo
      and chat_mode = 'miniapp'
      and storefront_enabled is true
  ) then
    raise exception 'El alta no guardó miniapp con storefront_enabled=true';
  end if;

  -- El alta es atómica: negocio, dueño y primera cuota, o nada.
  --
  -- ⚠️ Aquí se exigía además una fila en `bot_policies`. La tabla se retiró el
  -- 2026-09-20 —el saludo y las políticas que guardaba no los leía nadie— y
  -- con ella el insert del alta. Esta comprobación fue la que lo cazó al
  -- borrar la tabla sin tocarla, que es justo para lo que está.
  if (select count(*) from client_users where business_id = v_nuevo) <> 1 then
    raise exception 'El alta no creó el usuario dueño';
  end if;
  select count(*) into v_cuotas from billing where business_id = v_nuevo;
  if v_cuotas <> 1 then
    raise exception 'El alta debía dejar exactamente una cuota, dejó %', v_cuotas;
  end if;

  -- La cuota queda reclamada para su mes, y apuntando a la factura real: es
  -- justo la clave foránea que estaba rota.
  if not exists (
    select 1 from billing_month_claims c
    join billing b on b.id = c.billing_id
    where c.business_id = v_nuevo
  ) then
    raise exception 'La cuota del mes no quedó enlazada con su factura';
  end if;

  -- Un negocio no puede tener dos cuotas del mismo mes.
  --
  -- ⚠️ El mes se calcula en la zona del NEGOCIO, igual que `create_business_onboarding`
  -- (`timezone('America/Guayaquil', now())`), y NO con `current_date`, que en
  -- el contenedor es UTC.
  --
  -- Con `current_date` esta comprobación falla las primeras 5 horas UTC del
  -- día 1 de cada mes: en Ecuador todavía es el último día del mes anterior,
  -- así que el alta reclama —correctamente— el mes que se va, y la prueba
  -- intentaba insertar el que entra. No colisionan, y el verificador acusaba
  -- al esquema de un fallo que era suyo. Encontrado el 2026-09-01 auditando,
  -- y habría bloqueado TODOS los PRs durante esa ventana.
  begin
    insert into billing (business_id, amount, currency, status, period_start, period_end)
    values (
      v_nuevo, 25, 'USD', 'pending',
      date_trunc('month', timezone('America/Guayaquil', now()))::date,
      (date_trunc('month', timezone('America/Guayaquil', now()))
        + interval '1 month - 1 day')::date
    );
    raise exception 'La base aceptó dos cuotas del mismo mes para el mismo negocio';
  exception when sqlstate '23505' then
    null;
  end;

  delete from businesses where id = v_nuevo;
  raise notice 'ALTA DE CLIENTES: verificada';
end;
$$;

do $$
declare
  v_business uuid;
  v_encolado boolean;
  v_producto uuid;
  v_dias_horario integer;
begin
  -- ── Preparación ───────────────────────────────────────────────────────────
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders
  ) values (
    'verificacion-esquema', 'Negocio de verificación', 'pizzería',
    'ycloud', '+593900000001', '+593900000001',
    true
  )
  returning id into v_business;

  -- ── 1. Cola durable + trigger de consumo ─────────────────────────────────
  -- Este es EXACTAMENTE el camino que falló: enqueue_webhook_event inserta y el
  -- trigger record_inbound_message_usage llama a digest() de pgcrypto. Si el
  -- search_path de esa función no alcanza el esquema `extensions`, aquí revienta.
  v_encolado := public.enqueue_webhook_event(
    v_business,
    'ycloud',
    repeat('a', 64),
    repeat('b', 64),
    '{"content":{"kind":"text"},"inboundId":"verificacion-1"}'::jsonb
  );
  if v_encolado is not true then
    raise exception 'enqueue_webhook_event no encoló el evento';
  end if;

  if (select count(*) from webhook_inbound_events where business_id = v_business) <> 1 then
    raise exception 'El evento no quedó en la cola durable';
  end if;

  -- El trigger de consumo debe haber copiado la unidad en la misma transacción.
  if (select count(*) from message_usage_events where business_id = v_business) < 1 then
    raise exception 'El trigger de consumo no registró el mensaje entrante';
  end if;

  -- Reencolar el mismo mensaje no puede duplicarlo.
  if public.enqueue_webhook_event(
    v_business, 'ycloud', repeat('a', 64), repeat('b', 64),
    '{"content":{"kind":"text"},"inboundId":"verificacion-1"}'::jsonb
  ) is not false then
    raise exception 'La deduplicación de la cola no está funcionando';
  end if;

  -- ── 1b. EL MENÚ RESPONDE AL INSTANTE ──────────────────────────────────────
  --
  -- Pedido del dueño el 2026-09-23: «el tiempo de respuesta en WhatsApp lo más
  -- rápido posible, antes parecía lento, como de 3 segundos».
  --
  -- Era literal. `webhooks.routes.ts` convierte las respuestas interactivas en
  -- `kind: 'text'` —a propósito, para no duplicar el emparejamiento del menú—,
  -- y la cola abría su ventana de silencio de 3 s para TODO lo que fuera texto.
  -- Resultado: **cada toque de un botón esperaba tres segundos** por una
  -- ventana que existe para juntar mensajes escritos a trozos.
  --
  -- Una elección no se puede fragmentar. Aquí se comprueba el comportamiento,
  -- no el texto del SQL: lo elegido entra YA y lo escrito sigue esperando.
  declare
    v_elegido timestamptz;
    v_escrito timestamptz;
  begin
    -- (a) Lo que el cliente ELIGIÓ: disponible de inmediato.
    perform public.enqueue_webhook_event(
      v_business, 'ycloud', repeat('c', 64), repeat('d', 64),
      '{"content":{"kind":"text","text":"2","interactivo":true},"inboundId":"eleccion-1"}'::jsonb
    );
    select available_at into v_elegido
    from webhook_inbound_events where message_id_hash = repeat('c', 64);

    if v_elegido > now() + interval '250 milliseconds' then
      raise exception 'Tocar un botón esperó % — el menú tiene que responder al instante',
        v_elegido - now();
    end if;

    -- (b) Lo que el cliente ESCRIBIÓ: sigue esperando su ventana. Esto NO
    -- cambia, y es la mitad que hay que proteger: sin ella, tres mensajes
    -- seguidos se contestan tres veces.
    perform public.enqueue_webhook_event(
      v_business, 'ycloud', repeat('e', 64), repeat('f', 64),
      '{"content":{"kind":"text","text":"hola"},"inboundId":"escrito-1"}'::jsonb
    );
    select available_at into v_escrito
    from webhook_inbound_events where message_id_hash = repeat('e', 64);

    -- ⚠️ La ventana bajó a 300 ms el 2026-09-23 (medido: el hueco más corto
    -- entre dos mensajes de un cliente es 5,67 s, así que 3 s no agrupaban
    -- nada). Se comprueba que SIGUE EXISTIENDO, no su duración exacta: lo que
    -- no puede desaparecer es el agrupado — sin él, tres mensajes seguidos se
    -- contestan tres veces y cada saliente se paga.
    if v_escrito <= now() then
      raise exception 'El texto escrito dejó de agruparse: disponible ya, sin ventana';
    end if;

    -- (c) Un texto posterior NO puede retrasar una elección ya encolada: ella
    -- ya entró con `now()` y su respuesta no depende de lo que se escriba
    -- después.
    if (select available_at from webhook_inbound_events
        where message_id_hash = repeat('c', 64)) <> v_elegido then
      raise exception 'Un texto posterior retrasó una elección ya encolada';
    end if;
  end;

  -- ── 1c. EL CHAT ENTIENDE LAS ERRATAS, Y NO CONFUNDE LA BASURA ────────────
  --
  -- El dueño probando su app (2026-09-23): «"pizzza", "seviche"… ¿mandamos un
  -- mensaje educando al cliente? Una cosa es "sdadskads" y otra "pissa"».
  --
  -- Se decidió NO pedirle que escriba mejor —las apps grandes no lo hacen— y
  -- entender la errata. El umbral 0.40 se MIDIÓ contra el diccionario real: la
  -- peor basura da 0.14 y la peor errata de verdad 0.44.
  --
  -- Esto comprueba el COMPORTAMIENTO, que es lo único que importa: que las
  -- erratas se entiendan y que la basura NO se cuele. Una red que deja pasar
  -- «asdfghjkl» como si fuera comida es peor que no tenerla.
  declare
    v_cat text;
  begin
    -- (a) Las erratas de verdad se entienden.
    foreach v_cat in array array['pizzza', 'hanburguesa', 'almuerso', 'parriyada']
    loop
      if not exists (select 1 from public.marketplace_alias_parecido(array[v_cat])) then
        raise exception 'La errata «%» debía entenderse y no se entendió', v_cat;
      end if;
    end loop;

    -- (b) La basura NO se cuela. Esto es lo que hace útil a la red.
    foreach v_cat in array array['asdfghjkl', 'sdadskads', 'qwerty', 'gracias']
    loop
      if exists (select 1 from public.marketplace_alias_parecido(array[v_cat])) then
        raise exception 'La basura «%» se coló como si fuera comida', v_cat;
      end if;
    end loop;

    -- (c) Una palabra de menos de 4 letras no entra: ahí los trigramas fallan
    -- («pisa» contra «pizza» da lo mismo que la basura).
    if exists (select 1 from public.marketplace_alias_parecido(array['pan'])) then
      raise exception 'Una palabra de 3 letras entró al parecido';
    end if;

    -- (d) Y «pizzza» cae en pizzerías, no en cualquier sitio.
    select category_code into v_cat
    from public.marketplace_alias_parecido(array['pizzza']) limit 1;
    if v_cat is distinct from 'pizzerias' then
      raise exception '«pizzza» debía caer en pizzerias y cayó en %', v_cat;
    end if;
  end;

  -- ── 2. Registro de errores ────────────────────────────────────────────────
  perform public.record_platform_error(
    v_business, 'canal', '503', 'Error de verificación', '{}'::jsonb, repeat('e', 64)
  );
  perform public.record_platform_error(
    v_business, 'canal', '503', 'Error de verificación', '{}'::jsonb, repeat('e', 64)
  );
  -- Dos veces el mismo error = UNA fila con dos ocurrencias.
  if (select count(*) from platform_errors where business_id = v_business) <> 1 then
    raise exception 'El registro de errores no agrupó por huella';
  end if;
  if (select occurrences from platform_errors where business_id = v_business) <> 2 then
    raise exception 'El registro de errores no sumó la ocurrencia repetida';
  end if;

  -- La categoría inválida debe rechazarse.
  begin
    perform public.record_platform_error(
      v_business, 'inventada', null, 'x', '{}'::jsonb, repeat('f', 64)
    );
    raise exception 'record_platform_error aceptó una categoría inválida';
  exception when sqlstate '22023' then
    null;
  end;

  -- ── 3. Núcleo de dinero: el pedido lo calcula el CÓDIGO ───────────────────
  insert into products (business_id, name, price, stock, active)
  values (v_business, 'Producto de prueba', 10.50, 'disponible', true)
  returning id into v_producto;

  perform public.create_order_with_items(
    v_business,
    '+593900000002',
    'Cliente de prueba',
    'pendiente',
    0,
    'USD',
    jsonb_build_array(jsonb_build_object(
      'product_id', v_producto, 'quantity', 2, 'unit_price', 10.50
    ))
  );
  -- 2 × 10.50 = 21.00. Si el total no cuadra, el núcleo de dinero está roto.
  if (select total from orders where business_id = v_business limit 1) <> 21.00 then
    raise exception 'create_order_with_items calculó un total incorrecto';
  end if;

  -- ── El payload EXACTO del pedido de mostrador ────────────────────────────
  --
  -- El panel manda solo ids y cantidades a propósito («el precio NO viaja»),
  -- y eso hacía saltar el control de precio: `null is distinct from 10.50` es
  -- cierto, así que el mostrador fallaba SIEMPRE con 40001. Un camino del
  -- dinero entero que nunca funcionó desde que se publicó, y que ninguna
  -- prueba veía porque todas mandaban `unit_price`.
  --
  -- Por eso este bloque manda lo que manda la ruta, no lo que es cómodo.
  declare
    v_sin_precio jsonb;
  begin
    v_sin_precio := public.create_order_with_items(
      v_business, 'mostrador', 'Cliente en local', 'completado', 0, 'USD',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'quantity', 3
      )),
      'manual'
    );
    if (v_sin_precio ->> 'total')::numeric <> 31.50 then
      raise exception 'sin unit_price el total salió %, esperaba 31.50',
        v_sin_precio ->> 'total';
    end if;

    -- Y mandar un precio EQUIVOCADO se sigue rechazando: lo que se relaja es
    -- la ausencia, no el control.
    begin
      perform public.create_order_with_items(
        v_business, '+593900000002', 'Listillo', 'pendiente', 0, 'USD',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto, 'quantity', 1, 'unit_price', 0.01
        ))
      );
      raise exception 'create_order_with_items aceptó un precio falso';
    exception when sqlstate '40001' then
      null;  -- rechazado como debe
    end;
  end;

  -- Cambiar el estado de un pedido: lo pulsa el dueño en su panel cada día.
  declare
    v_pedido uuid;
    v_cambio jsonb;
  begin
    select id into v_pedido from orders where business_id = v_business limit 1;

    -- El estado sigue una máquina: pendiente → confirmado → completado. Saltarse
    -- un paso se rechaza en vez de dar por entregado algo que nadie confirmó.
    v_cambio := public.set_order_status(v_business, v_pedido, 'completado');
    if v_cambio ->> 'result' <> 'invalid_transition' then
      raise exception 'set_order_status aceptó completar un pedido sin confirmar: %', v_cambio;
    end if;

    perform public.set_order_status(v_business, v_pedido, 'confirmado');
    v_cambio := public.set_order_status(v_business, v_pedido, 'completado');
    if (select status from orders where id = v_pedido) <> 'completado' then
      raise exception 'set_order_status no cambió el estado: %', v_cambio;
    end if;
    -- Otro negocio no puede tocar este pedido.
    v_cambio := public.set_order_status(gen_random_uuid(), v_pedido, 'cancelado');
    if (select status from orders where id = v_pedido) <> 'completado' then
      raise exception 'FUGA: otro negocio cambió el estado de este pedido';
    end if;
  end;

  -- ── 3 bis. La segunda oportunidad del comprobante ────────────────────────
  --
  -- Rechazar CIERRA el pedido —`rechazado` es final y al cliente le llega «tu
  -- pedido fue cancelado»—, así que una foto borrosa costaba una venta entera.
  -- Esto la devuelve a esperar pago y BORRA el comprobante anterior: sin eso,
  -- el buzón de WhatsApp rechazaría la foto siguiente, porque solo adjunta
  -- cuando no hay una ya puesta.
  declare
    v_revision uuid;
    v_vuelta jsonb;
  begin
    insert into public.orders (
      business_id, contact_phone, contact_name, status, total, source,
      payment_method, payment_proof_url, payment_proof_public_id,
      payment_confirmed_at
    ) values (
      v_business, '593900000801', 'Con comprobante', 'pago_en_revision', 12.50,
      'storefront', 'transferencia', 'https://res.cloudinary.com/x/borrosa.jpg',
      'botpanel/x/borrosa', now()
    ) returning id into v_revision;

    v_vuelta := public.request_new_payment_proof(v_business, v_revision);
    if v_vuelta ->> 'result' <> 'updated' then
      raise exception 'no se pudo pedir otro comprobante: %', v_vuelta;
    end if;

    if (select status from orders where id = v_revision) <> 'esperando_pago' then
      raise exception 'el pedido debía volver a esperar el pago';
    end if;

    -- Las tres marcas del pago anterior se sueltan, o el cliente seguiría
    -- viendo «Pago confirmado» mientras se le pide otro comprobante.
    if (select payment_proof_url is not null
          or payment_proof_public_id is not null
          or payment_confirmed_at is not null
        from orders where id = v_revision) then
      raise exception 'quedó rastro del comprobante anterior';
    end if;

    -- Queda escrito en el historial, como cualquier cambio de estado.
    if not exists (
      select 1 from order_events
      where order_id = v_revision
        and from_status = 'pago_en_revision' and to_status = 'esperando_pago'
    ) then
      raise exception 'la vuelta atrás no quedó en order_events';
    end if;

    -- Y desde cualquier otro estado no significa nada: un pedido ya aceptado
    -- no vuelve a esperar un comprobante.
    v_vuelta := public.request_new_payment_proof(v_business, v_revision);
    if v_vuelta ->> 'result' <> 'invalid_transition' then
      raise exception 'se pidió otro comprobante desde un estado que no toca: %', v_vuelta;
    end if;

    -- Otro negocio no puede tocarlo.
    v_vuelta := public.request_new_payment_proof(gen_random_uuid(), v_revision);
    if v_vuelta ->> 'result' <> 'not_found' then
      raise exception 'FUGA: otro negocio pidió otro comprobante de este pedido';
    end if;
  end;

  -- ── 3a. El camino del reparto: preparación → en camino → entregado ────────
  -- Es el flujo diario de una pizzería, y donde engancha la cooperativa.
  declare
    v_reparto uuid;
    v_cambio jsonb;
  begin
    insert into orders (business_id, contact_phone, status, total, fulfillment)
    values (v_business, '+593900000003', 'pendiente', 21.00, 'delivery')
    returning id into v_reparto;

    -- Aceptar y poner a preparar es un solo gesto: se permite saltar
    -- «confirmado» hacia adelante.
    perform public.set_order_status(v_business, v_reparto, 'preparacion');
    perform public.set_order_status(v_business, v_reparto, 'en_camino');
    if (select status from orders where id = v_reparto) <> 'en_camino' then
      raise exception 'set_order_status no dejó salir a reparto un pedido a domicilio';
    end if;

    -- Hacia atrás NUNCA: un pedido que ya salió no vuelve a la cocina.
    v_cambio := public.set_order_status(v_business, v_reparto, 'preparacion');
    if v_cambio ->> 'result' <> 'invalid_transition' then
      raise exception 'set_order_status permitió retroceder un pedido: %', v_cambio;
    end if;

    perform public.set_order_status(v_business, v_reparto, 'completado');
    if (select status from orders where id = v_reparto) <> 'completado' then
      raise exception 'set_order_status no pudo cerrar el pedido entregado';
    end if;

    -- ENTREGADO = VENDIDO. Los reportes leen `sales`: sin esto el negocio
    -- vendía y sus números decían que no.
    if not exists (select 1 from sales where order_id = v_reparto) then
      raise exception 'un pedido entregado no generó su venta';
    end if;
    if (select total from sales where order_id = v_reparto) <> 21.00 then
      raise exception 'la venta no heredó el total del pedido';
    end if;

    -- Reintentar no puede duplicar el dinero del reporte.
    perform public.set_order_status(v_business, v_reparto, 'completado');
    if (select count(*) from sales where order_id = v_reparto) <> 1 then
      raise exception 'marcar entregado dos veces duplicó la venta';
    end if;

    -- Otro negocio no puede convertir en venta un pedido ajeno.
    if public.crear_venta_desde_pedido(gen_random_uuid(), v_reparto) is not null then
      raise exception 'FUGA: otro negocio convirtió en venta un pedido ajeno';
    end if;
  end;

  -- Lo que el cliente RETIRA en el local no puede salir a la calle. Lo impide
  -- la base, no la pantalla: una pantalla se equivoca, un CHECK no.
  declare
    v_retiro uuid;
    v_cambio jsonb;
  begin
    insert into orders (business_id, contact_phone, status, total, fulfillment)
    values (v_business, '+593900000004', 'pendiente', 21.00, 'pickup')
    returning id into v_retiro;

    perform public.set_order_status(v_business, v_retiro, 'preparacion');
    v_cambio := public.set_order_status(v_business, v_retiro, 'en_camino');
    if v_cambio ->> 'result' <> 'not_deliverable' then
      raise exception 'set_order_status mandó a reparto un pedido de retiro: %', v_cambio;
    end if;

    -- Pero sí se entrega en mano, sin pasar por «en camino».
    perform public.set_order_status(v_business, v_retiro, 'completado');
    if (select status from orders where id = v_retiro) <> 'completado' then
      raise exception 'set_order_status no pudo entregar un pedido de retiro';
    end if;
  end;

  -- ── 3d. Pedido de mostrador: nace entregado y ya es venta ────────────────
  declare
    v_mostrador jsonb;
    v_id uuid;
  begin
    v_mostrador := public.create_order_with_items(
      v_business, 'mostrador', 'Cliente de paso', 'completado', 0, 'USD',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'quantity', 1, 'unit_price', 10.50
      )),
      'manual'
    );
    v_id := (v_mostrador ->> 'id')::uuid;

    if not exists (select 1 from sales where order_id = v_id) then
      raise exception 'el pedido de mostrador no generó su venta';
    end if;
    -- 'mostrador' no es el teléfono de nadie: la venta va sin contacto, o el
    -- directorio de clientes acabaría con un cliente fantasma.
    if (select contact_phone from sales where order_id = v_id) is not null then
      raise exception 'la venta de mostrador guardó el teléfono postizo';
    end if;
    if (select source from sales where order_id = v_id) <> 'mostrador' then
      raise exception 'la venta de mostrador no registró su origen';
    end if;
  end;

  -- Regla inviolable #8: el precio lo manda el catálogo, no quien pide. Si el
  -- cliente envía otro, la RPC debe rechazarlo en vez de cobrarlo.
  begin
    perform public.create_order_with_items(
      v_business, '+593900000002', 'Cliente', 'pendiente', 0, 'USD',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'quantity', 1, 'unit_price', 0.01
      ))
    );
    raise exception 'create_order_with_items aceptó un precio inventado';
  exception when sqlstate '40001' then
    null;
  end;

  -- ── 3b. Pedido de la tienda: el precio lo pone la BASE, no el cliente ─────
  -- La app manda ids y cantidades. Si acepta un importe del cliente, cualquiera
  -- se lleva una pizza por un céntimo.
  update businesses set storefront_enabled = true where id = v_business;
  insert into product_variants (business_id, product_id, name, price)
  values (v_business, v_producto, 'Personal', 5.25);

  declare
    v_pedido jsonb;
  begin
    v_pedido := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'delivery',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto,
        'variant_id', (select id from product_variants where business_id = v_business limit 1),
        'quantity', 2,
        -- Precio inventado: debe ignorarse por completo.
        'unit_price', 0.01, 'total', 0.01
      ))
    );
    -- 2 × 5.25 de la variante = 10.50, nunca 0.02.
    if (v_pedido ->> 'total')::numeric <> 10.50 then
      raise exception 'create_storefront_order no calculó el total desde la base: %', v_pedido ->> 'total';
    end if;
  end;

  -- ── 3b-bis. Todo pedido nace NUMERADO ────────────────────────────────────
  -- La pantalla de confirmación lee `order_number`, y un pedido sin número deja
  -- al cliente sin nada que reclamar y al dueño con un UUID que no se dicta por
  -- teléfono. Lo pone un trigger para que valga por TODOS los caminos —bot,
  -- mostrador, mini app y el Marketplace del futuro—, no solo por el que se
  -- acordó de hacerlo.
  declare
    v_uno jsonb;
    v_dos jsonb;
    v_otro_negocio uuid;
    v_numero_otro integer;
  begin
    v_uno := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
    );
    v_dos := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
    );

    if (v_uno ->> 'order_number') is null then
      raise exception 'un pedido nació sin número: %', v_uno;
    end if;
    -- Correlativo: el siguiente es exactamente el siguiente, sin huecos.
    if (v_dos ->> 'order_number')::int <> (v_uno ->> 'order_number')::int + 1 then
      raise exception 'los números no son correlativos: % y %',
        v_uno ->> 'order_number', v_dos ->> 'order_number';
    end if;

    -- Y la cuenta es POR NEGOCIO: el primer pedido de otro local empieza en 1,
    -- no continúa la numeración del vecino.
    insert into businesses (slug, name, whatsapp_number)
    values ('numeracion-aparte', 'Otro local', '+593900000777')
    returning id into v_otro_negocio;
    insert into products (business_id, name, price)
    values (v_otro_negocio, 'Algo', 3.00);

    insert into orders (business_id, contact_phone, subtotal, total)
    values (v_otro_negocio, '+593900000888', 3.00, 3.00)
    returning order_number into v_numero_otro;

    if v_numero_otro <> 1 then
      raise exception 'la numeración no es por negocio: el otro local empezó en %', v_numero_otro;
    end if;
  end;

  -- ── 3b-ter. El flujo del pedido, contado como es ─────────────────────────
  -- Quien va a TRANSFERIR nace esperando el pago, no «pendiente»: el dueño
  -- tiene que poder distinguir a quien le pagará en la puerta de aquel del que
  -- aún no ha visto un centavo.
  declare
    v_transfer jsonb;
    v_efectivo jsonb;
    v_estado text;
    v_paso jsonb;
  begin
    v_transfer := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
      null, 'transferencia'
    );
    select status into v_estado from public.orders where id = (v_transfer ->> 'id')::uuid;
    if v_estado is distinct from 'esperando_pago' then
      raise exception 'una transferencia debía nacer esperando el pago, nació en %', v_estado;
    end if;

    -- Un negocio nuevo nace SOLO con transferencia encendida, así que para
    -- probar el flujo en efectivo hay que aceptarlo primero. Esto no es
    -- andamiaje del test: es exactamente lo que hace el dueño en su panel.
    update public.business_payment_methods set enabled = true
    where business_id = v_business and method_code in ('efectivo', 'pago_al_retirar');

    v_efectivo := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
      null, 'efectivo'
    );
    select status into v_estado from public.orders where id = (v_efectivo ->> 'id')::uuid;
    if v_estado is distinct from 'pendiente' then
      raise exception 'un pedido en efectivo debía nacer pendiente, nació en %', v_estado;
    end if;

    -- «Aceptar y preparar» es UN paso: desde el comprobante en revisión se
    -- puede ir directo a la cocina. Antes estaba prohibido a propósito.
    v_paso := public.set_order_status(
      v_business, (v_transfer ->> 'id')::uuid, 'pago_en_revision');
    v_paso := public.set_order_status(
      v_business, (v_transfer ->> 'id')::uuid, 'preparacion');
    if v_paso ->> 'result' is distinct from 'updated' then
      raise exception '«aceptar y preparar» desde pago_en_revision falló: %', v_paso ->> 'result';
    end if;

    -- Y lo que sigue prohibido, sigue prohibido: nada retrocede.
    v_paso := public.set_order_status(
      v_business, (v_transfer ->> 'id')::uuid, 'pendiente');
    if v_paso ->> 'result' is distinct from 'invalid_transition' then
      raise exception 'un pedido en preparación pudo volver a pendiente: %', v_paso ->> 'result';
    end if;
  end;

  -- ── 3b-quater. El pedido se QUEDA con la dirección ───────────────────────
  --
  -- `address_id` es una foránea `on delete set null`, y el panel leía la
  -- dirección a través de ella. O sea que el pedido no guardaba a dónde iba:
  -- preguntaba a dónde va HOY esa dirección. El cliente la corregía a media
  -- entrega y la pantalla del repartidor cambiaba debajo de él; la borraba y el
  -- pedido se quedaba sin dirección para siempre.
  --
  -- Es la misma regla que ya cumplían los productos: `order_items` congela
  -- `product_name` y `unit_price` para que el pedido de ayer siga diciendo lo
  -- que el cliente compró.
  declare
    v_cliente uuid;
    v_direccion uuid;
    v_pedido jsonb;
    v_congelada text;
    v_lat numeric;
    v_apunta uuid;
  begin
    insert into public.customers (phone, name)
    values ('593900000123', 'Cliente con casa')
    returning id into v_cliente;

    insert into public.customer_addresses (
      business_id, customer_id, label, address, reference,
      latitude, longitude, accuracy_m, building_type, courier_notes
    ) values (
      v_business, v_cliente, 'Casa', 'Calle 4 de Mayo 37', 'junto a la farmacia',
      -1.0546210, -80.4544720, 12.5, 'casa', 'el timbre no sirve, toca la puerta'
    ) returning id into v_direccion;

    v_pedido := public.create_storefront_order(
      v_business, v_cliente, '593900000123', 'Cliente con casa',
      v_direccion, 'delivery',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
    );

    -- Nace con la fotografía puesta, no con un puntero.
    select delivery_address, delivery_latitude
      into v_congelada, v_lat
      from public.orders where id = (v_pedido ->> 'id')::uuid;
    if v_congelada is distinct from 'Calle 4 de Mayo 37' then
      raise exception 'el pedido no copió la dirección: %', coalesce(v_congelada, '(nula)');
    end if;
    if v_lat is distinct from -1.0546210 then
      raise exception 'el pedido no copió el pin: %', coalesce(v_lat::text, '(nulo)');
    end if;

    -- El cliente se muda. El pedido de antes sigue yendo a donde iba.
    update public.customer_addresses
       set address = 'Otra casa, otro barrio', latitude = 0, longitude = 0
     where id = v_direccion;

    select delivery_address into v_congelada
      from public.orders where id = (v_pedido ->> 'id')::uuid;
    if v_congelada is distinct from 'Calle 4 de Mayo 37' then
      raise exception 'editar la dirección cambió un pedido ya hecho: %', v_congelada;
    end if;

    -- Y la borra. `address_id` se queda en nulo —así está declarada la
    -- foránea— pero la dirección del pedido no se va con ella.
    delete from public.customer_addresses where id = v_direccion;

    select delivery_address, address_id into v_congelada, v_apunta
      from public.orders where id = (v_pedido ->> 'id')::uuid;
    if v_apunta is not null then
      raise exception 'la foránea dejó de ser «set null», el borrado no la limpió';
    end if;
    if v_congelada is distinct from 'Calle 4 de Mayo 37' then
      raise exception 'borrar la dirección dejó el pedido sin destino: %',
        coalesce(v_congelada, '(nula)');
    end if;
  end;

  -- ── 3b-quinquies. El pedido se lee en el orden que puso el dueño ─────────
  --
  -- Una pizza se piensa en un orden: sabor, masa, borde, y al final lo que se
  -- agrega y cuesta aparte. El pedido se contaba en orden alfabético, que es el
  -- de un listado y no el de una cocina.
  --
  -- El orden se COPIA al crear el pedido en vez de consultarse al leerlo: el
  -- panel del dueño pide sus pedidos cada 12 segundos, y una unión más ahí
  -- correría sin parar durante todo el servicio.
  declare
    v_pizza uuid;
    v_grupo_sabor uuid;
    v_grupo_borde uuid;
    v_opcion_sabor uuid;
    v_opcion_borde uuid;
    v_pedido jsonb;
    v_orden integer[];
    v_movidos integer;
  begin
    -- Producto PROPIO: colgarle un grupo obligatorio al de las demás pruebas
    -- las rompería a todas, porque sus pedidos no lo mandarían.
    insert into public.products (business_id, name, price)
    values (v_business, 'Pizza del orden', 9.00)
    returning id into v_pizza;

    -- Dos grupos del mismo producto, con el orden que el dueño querría: el
    -- sabor manda, el borde es un añadido. Alfabéticamente saldrían al revés.
    -- Obligatorio exige mínimo 1: un «obligatorio» sin mínimo no obliga a nada.
    insert into public.option_groups (
      business_id, product_id, name, selection_type, required, min_selectable, sort)
    values (v_business, v_pizza, 'Sabor', 'single', true, 1, 0)
    returning id into v_grupo_sabor;
    insert into public.option_groups (business_id, product_id, name, selection_type, required, sort)
    values (v_business, v_pizza, 'Borde', 'single', false, 1)
    returning id into v_grupo_borde;

    insert into public.options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_sabor, 'Criolla', 0) returning id into v_opcion_sabor;
    insert into public.options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_borde, 'Sin borde', 0) returning id into v_opcion_borde;

    v_pedido := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_pizza, 'quantity', 1,
        'options', jsonb_build_array(
          -- Se mandan al revés a propósito: el orden lo decide el dueño, no
          -- en qué orden tocó el cliente.
          jsonb_build_object('option_id', v_opcion_borde, 'quantity', 1),
          jsonb_build_object('option_id', v_opcion_sabor, 'quantity', 1)
        )
      ))
    );

    select array_agg(oio.group_sort order by oio.option_group_name)
      into v_orden
      from public.order_item_options oio
      join public.order_items oi on oi.id = oio.order_item_id
     where oi.order_id = (v_pedido ->> 'id')::uuid;

    -- Por nombre alfabético: Borde primero (sort 1), Sabor después (sort 0).
    if v_orden is distinct from array[1, 0] then
      raise exception 'el pedido no copió el orden de los grupos: %', v_orden;
    end if;

    -- Y el orden es una FOTOGRAFÍA: reordenar mañana no reescribe la comanda
    -- de hoy, igual que cambiar un precio no reescribe lo que se cobró.
    v_movidos := public.reorder_option_groups(
      v_business, array[v_grupo_borde, v_grupo_sabor]);
    if v_movidos <> 2 then
      raise exception 'reorder_option_groups movió % grupos, se esperaban 2', v_movidos;
    end if;

    select array_agg(oio.group_sort order by oio.option_group_name)
      into v_orden
      from public.order_item_options oio
      join public.order_items oi on oi.id = oio.order_item_id
     where oi.order_id = (v_pedido ->> 'id')::uuid;
    if v_orden is distinct from array[1, 0] then
      raise exception 'reordenar cambió un pedido ya hecho: %', v_orden;
    end if;

    -- Y el nuevo orden sí manda para lo que venga.
    if (select sort from public.option_groups where id = v_grupo_borde) <> 0 then
      raise exception 'reorder_option_groups no aplicó el orden nuevo';
    end if;

    -- ⚠️ REGLA #1: los grupos de OTRO negocio no se mueven ni sabiendo su id.
    declare
      v_vecino uuid;
      v_grupo_ajeno uuid;
    begin
      insert into businesses (slug, name, whatsapp_number)
      values ('orden-vecino', 'Local vecino', '+593900000998')
      returning id into v_vecino;
      insert into public.products (business_id, name, price)
      values (v_vecino, 'Algo', 5.00);
      insert into public.option_groups (business_id, product_id, name, selection_type, sort)
      values (v_vecino, (select id from public.products where business_id = v_vecino limit 1),
              'Suyo', 'single', 7)
      returning id into v_grupo_ajeno;

      v_movidos := public.reorder_option_groups(v_business, array[v_grupo_ajeno]);
      if v_movidos <> 0 then
        raise exception 'se reordenó un grupo de otro negocio';
      end if;
      if (select sort from public.option_groups where id = v_grupo_ajeno) <> 7 then
        raise exception 'el grupo del vecino cambió de orden';
      end if;

      -- Y una opción de otro GRUPO del mismo negocio tampoco se cuela.
      v_movidos := public.reorder_options(v_business, v_grupo_sabor, array[v_opcion_borde]);
      if v_movidos <> 0 then
        raise exception 'se reordenó una opción de otro grupo';
      end if;
    end;
  end;

  -- ── 3c. El envío lo pone la BASE, no el teléfono ─────────────────────────
  -- Si el costo de envío se calculara en la app, cualquiera pediría con envío
  -- $0 tocando el JavaScript. Aquí sale de la ficha del negocio.
  update businesses set delivery_fee = 2.00 where id = v_business;

  declare
    v_pedido jsonb;
    v_variante uuid;
  begin
    select id into v_variante from product_variants where business_id = v_business limit 1;

    v_pedido := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'delivery',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'variant_id', v_variante, 'quantity', 2
      )),
      null, 'transferencia'
    );
    -- 10.50 de producto + 2.00 de envío.
    if (v_pedido ->> 'total')::numeric <> 12.50 or (v_pedido ->> 'shipping')::numeric <> 2.00 then
      raise exception 'create_storefront_order no sumó el envío: %', v_pedido;
    end if;

    -- Quien retira en el local NO paga envío.
    update public.business_payment_methods set enabled = true
    where business_id = v_business and method_code in ('efectivo', 'pago_al_retirar');

    v_pedido := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto, 'variant_id', v_variante, 'quantity', 2
      )),
      null, 'efectivo'
    );
    if (v_pedido ->> 'total')::numeric <> 10.50 or (v_pedido ->> 'shipping')::numeric <> 0 then
      raise exception 'create_storefront_order cobró envío a un retiro en local: %', v_pedido;
    end if;

    -- Un método de pago que no existe se rechaza (la plataforma no cobra con
    -- tarjeta: regla inviolable #6).
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
        null, 'tarjeta'
      );
      raise exception 'create_storefront_order aceptó un metodo de pago inventado';
    exception when sqlstate '22023' then
      null;
    end;

    -- ── El comprobante: solo el dueño del pedido puede adjuntarlo ───────────
    declare
      v_ultimo uuid;
      v_resultado jsonb;
    begin
      select id into v_ultimo from orders
      where business_id = v_business order by created_at desc limit 1;

      v_resultado := public.attach_storefront_payment_proof(
        v_business, v_ultimo, '+593900000002', 'https://res.cloudinary.com/demo/comprobante.jpg'
      );
      if v_resultado ->> 'result' <> 'updated' then
        raise exception 'attach_storefront_payment_proof no guardó el comprobante: %', v_resultado;
      end if;

      -- Otro teléfono con el id del pedido no puede colgarle nada.
      v_resultado := public.attach_storefront_payment_proof(
        v_business, v_ultimo, '+593900000099', 'https://res.cloudinary.com/demo/ajeno.jpg'
      );
      if v_resultado ->> 'result' <> 'not_found' then
        raise exception 'FUGA: otro cliente adjuntó un comprobante a este pedido';
      end if;

      -- Y otro negocio, tampoco.
      v_resultado := public.attach_storefront_payment_proof(
        gen_random_uuid(), v_ultimo, '+593900000002', 'https://res.cloudinary.com/demo/ajeno.jpg'
      );
      if v_resultado ->> 'result' <> 'not_found' then
        raise exception 'FUGA: otro negocio adjuntó un comprobante a este pedido';
      end if;
    end;
  end;

  -- Se deja como estaba para no contaminar las comprobaciones siguientes.
  update businesses set delivery_fee = 0 where id = v_business;

  -- Un producto de otro negocio no se puede pedir aquí.
  begin
    perform public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'delivery',
      jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'quantity', 1))
    );
    raise exception 'create_storefront_order aceptó un producto ajeno';
  exception when sqlstate '42501' then
    null;
  end;

  -- ── 3d bis. Las opciones entran al pedido ────────────────────────────────
  --
  -- El motor de opciones estuvo tres migraciones en la base sin que nadie lo
  -- leyera. Esto ejercita lo que decide el DINERO: que el recargo salga de la
  -- base, que los obligatorios se exijan aquí y no en el navegador, y que
  -- `order_item_options` quede escrita.
  declare
    v_categoria_op uuid;
    v_producto_op uuid;
    v_grupo_obligatorio uuid;
    v_grupo_contador uuid;
    v_op_normal uuid;
    v_op_negativa uuid;
    v_op_contador uuid;
    v_grupo_ajeno uuid;
    v_op_ajena uuid;
    v_producto_ajeno uuid;
    v_pedido_op jsonb;
    v_item_op uuid;
  begin
    insert into product_categories (business_id, name)
    values (v_business, 'Almuerzos') returning id into v_categoria_op;
    insert into products (business_id, name, price, stock, active, category_id)
    values (v_business, 'Almuerzo del día', 3.00, 'disponible', true, v_categoria_op)
    returning id into v_producto_op;
    insert into products (business_id, name, price, stock, active)
    values (v_business, 'Producto sin grupos', 5.00, 'disponible', true)
    returning id into v_producto_ajeno;

    -- Un grupo OBLIGATORIO que cuelga de la categoría.
    insert into option_groups (
      business_id, category_id, name, selection_type, required, min_selectable, max_selectable
    ) values (v_business, v_categoria_op, 'Sopa', 'single', true, 1, 1)
    returning id into v_grupo_obligatorio;
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_obligatorio, 'Sopa del día', 0)
    returning id into v_op_normal;
    -- El recargo NEGATIVO, que es la razón de que la columna lo admita.
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_obligatorio, 'Sin sopa', -0.50)
    returning id into v_op_negativa;

    -- Un contador: 3 porciones repartidas entre cortes.
    insert into option_groups (
      business_id, product_id, name, selection_type, required, min_selectable, max_selectable
    ) values (v_business, v_producto_op, 'Cortes', 'quantity', false, 0, 3)
    returning id into v_grupo_contador;
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_contador, 'Lomo', 1.00)
    returning id into v_op_contador;

    -- Y un grupo que NO aplica a este producto, para probar la frontera.
    insert into option_groups (business_id, product_id, name)
    values (v_business, v_producto_ajeno, 'Ajeno') returning id into v_grupo_ajeno;
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_grupo_ajeno, 'Opción de otro plato', -2.00)
    returning id into v_op_ajena;

    -- OBLIGATORIO: sin elegir sopa, el pedido no se crea.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object('product_id', v_producto_op, 'quantity', 1))
      );
      raise exception 'create_storefront_order aceptó un pedido sin el grupo obligatorio';
    exception when sqlstate '22023' then null;
    end;

    -- FRONTERA: una opción de otro producto no puede abaratar este.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto_op, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_op_normal, 'quantity', 1),
            jsonb_build_object('option_id', v_op_ajena, 'quantity', 1)
          )
        ))
      );
      raise exception 'FUGA: una opción de otro producto entró al pedido';
    exception when sqlstate '42501' then null;
    end;

    -- Repetir la misma opción multiplicaría su recargo por la puerta de atrás.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto_op, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_op_negativa, 'quantity', 1),
            jsonb_build_object('option_id', v_op_negativa, 'quantity', 1)
          )
        ))
      );
      raise exception 'create_storefront_order aceptó la misma opción repetida';
    exception when sqlstate '22023' then null;
    end;

    -- Y pedir por cantidad en un grupo que no es contador, tampoco.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto_op, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_op_negativa, 'quantity', 6)
          )
        ))
      );
      raise exception 'create_storefront_order multiplicó una opción que no es contador';
    exception when sqlstate '22023' then null;
    end;

    -- El caso legítimo: 3.00 − 0.50 de «sin sopa» + 2 porciones de lomo a 1.00.
    v_pedido_op := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto_op, 'quantity', 1,
        'options', jsonb_build_array(
          jsonb_build_object('option_id', v_op_negativa, 'quantity', 1),
          jsonb_build_object('option_id', v_op_contador, 'quantity', 2)
        )
      ))
    );
    if (v_pedido_op ->> 'total')::numeric <> 4.50 then
      raise exception 'el recargo de las opciones no se calculó en la base: %', v_pedido_op;
    end if;

    select oi.id into v_item_op
    from order_items oi
    where oi.order_id = (v_pedido_op ->> 'id')::uuid;

    -- La fotografía de lo elegido, congelada con su precio.
    if (select count(*) from order_item_options where order_item_id = v_item_op) <> 2 then
      raise exception 'order_item_options no guardó lo que eligió el cliente';
    end if;
    if not exists (
      select 1 from order_item_options
      where order_item_id = v_item_op and option_name = 'Lomo'
        and quantity = 2 and unit_price_adjustment = 1.00
        and total_price_adjustment = 2.00
    ) then
      raise exception 'order_item_options no congeló bien la cantidad y su importe';
    end if;
    if not exists (
      select 1 from order_item_options
      where order_item_id = v_item_op and option_name = 'Sin sopa'
        and total_price_adjustment = -0.50
    ) then
      raise exception 'order_item_options perdió el signo de un recargo negativo';
    end if;

    -- Y lo que el DUEÑO ve en su panel sigue diciendo qué se pidió: si las
    -- opciones solo fueran a la tabla nueva, el pedido se vería vacío.
    if not exists (
      select 1 from order_items
      where id = v_item_op
        and 'Sin sopa' = any(extras_names)
        and 'Lomo x2' = any(extras_names)
    ) then
      raise exception 'las opciones no llegaron a extras_names: el dueño no vería qué pidieron';
    end if;

    -- ── Las ocho estrategias de precio ─────────────────────────────────────
    --
    -- El caso que las justifica: media Suprema ($10) y media Hawaiana ($9) con
    -- `sum` costarían $19 —el doble de una pizza—. Aquí se comprueba que cada
    -- estrategia cobre lo que dice, con el MISMO grupo y las MISMAS opciones.
    declare
      v_grupo_precio uuid;
      v_barata uuid;
      v_cara uuid;
      v_media uuid;
      v_estrategia text;
      v_esperado numeric;
      v_pedido_e jsonb;
    begin
      -- Grupo de tres opciones: 1.00, 2.00 y 4.00 sobre un plato de 3.00.
      insert into option_groups (
        business_id, product_id, name, selection_type, max_selectable, pricing_strategy
      ) values (v_business, v_producto_op, 'Precios', 'multiple', 3, 'sum')
      returning id into v_grupo_precio;
      insert into options (business_id, option_group_id, name, price_adjustment)
      values (v_business, v_grupo_precio, 'Barata', 1.00) returning id into v_barata;
      insert into options (business_id, option_group_id, name, price_adjustment)
      values (v_business, v_grupo_precio, 'Media', 2.00) returning id into v_media;
      insert into options (business_id, option_group_id, name, price_adjustment)
      values (v_business, v_grupo_precio, 'Cara', 4.00) returning id into v_cara;

      foreach v_estrategia in array array[
        'sum', 'fixed', 'included', 'highest_selected', 'lowest_selected',
        'average', 'included_up_to_limit', 'extra_after_limit'
      ]
      loop
        update option_groups
        set pricing_strategy = v_estrategia, free_selections =
          case when v_estrategia in ('included_up_to_limit', 'extra_after_limit')
            then 1 else 0 end
        where id = v_grupo_precio;

        -- Base 3.00 + las tres opciones (1, 2 y 4), y el grupo obligatorio.
        v_pedido_e := public.create_storefront_order(
          v_business, null, '+593900000002', 'Cliente', null, 'pickup',
          jsonb_build_array(jsonb_build_object(
            'product_id', v_producto_op, 'quantity', 1,
            'options', jsonb_build_array(
              jsonb_build_object('option_id', v_op_normal, 'quantity', 1),
              jsonb_build_object('option_id', v_barata, 'quantity', 1),
              jsonb_build_object('option_id', v_media, 'quantity', 1),
              jsonb_build_object('option_id', v_cara, 'quantity', 1)
            )
          ))
        );

        v_esperado := 3.00 + case v_estrategia
          when 'sum' then 7.00                  -- 1 + 2 + 4
          when 'fixed' then 0.00                -- no altera el precio
          when 'included' then 0.00
          when 'highest_selected' then 4.00     -- la mitad y mitad
          when 'lowest_selected' then 1.00
          when 'average' then 2.33              -- (1+2+4)/3, redondeado
          when 'included_up_to_limit' then 3.00 -- la de 4.00 va incluida
          when 'extra_after_limit' then 3.00    -- una porción incluida, la cara
        end;

        if (v_pedido_e ->> 'total')::numeric <> v_esperado then
          raise exception 'La estrategia % cobró % y debía cobrar %',
            v_estrategia, v_pedido_e ->> 'total', v_esperado;
        end if;
        delete from orders where id = (v_pedido_e ->> 'id')::uuid;
      end loop;

      -- Y el caso del contador: `extra_after_limit` gasta el cupo en PORCIONES,
      -- así que una misma opción puede quedar a medias.
      update option_groups
      set selection_type = 'quantity', pricing_strategy = 'extra_after_limit',
          free_selections = 2, max_selectable = 5
      where id = v_grupo_precio;

      v_pedido_e := public.create_storefront_order(
        v_business, null, '+593900000002', 'Cliente', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_producto_op, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_op_normal, 'quantity', 1),
            jsonb_build_object('option_id', v_cara, 'quantity', 3)
          )
        ))
      );
      -- 3 porciones a 4.00, dos incluidas: se cobra una → 3.00 + 4.00
      if (v_pedido_e ->> 'total')::numeric <> 7.00 then
        raise exception 'El cupo por porciones cobró %, y debía cobrar 7.00',
          v_pedido_e ->> 'total';
      end if;
      delete from orders where id = (v_pedido_e ->> 'id')::uuid;

      delete from option_groups where id = v_grupo_precio;
    end;

    -- Limpieza para no contaminar lo que viene después.
    delete from orders where id = (v_pedido_op ->> 'id')::uuid;
    delete from option_groups where business_id = v_business;
    delete from products where id in (v_producto_op, v_producto_ajeno);
    delete from product_categories where id = v_categoria_op;
  end;

  -- ── 3d bis. El plato POR PARTES: el almuerzo de una familia ─────────────
  --
  -- El dueño pone UN precio al almuerzo completo y un precio suelto a cada
  -- parte. La familia marca cuántas sopas y segundos quiere, y la BASE arma
  -- los almuerzos: una porción de cada parte es un almuerzo; lo que sobra se
  -- cobra suelto; un adicional con precio va aparte; lo gratis no suma.
  --
  -- Los MISMOS casos que `tests/plato-por-partes.test.js` pasa por el motor de
  -- TypeScript: si los dos lados divergen, el cliente lee un número y paga otro.
  declare
    v_almuerzo uuid;
    v_g_sopa uuid;
    v_g_segundo uuid;
    v_g_acompanar uuid;
    v_caldo uuid;
    v_pollo uuid;
    v_ceviche uuid;
    v_jugo uuid;
    v_carne uuid;
    v_mesa jsonb;
    v_completo uuid;
  begin
    insert into products (business_id, name, price, stock, active)
    values (v_business, 'Almuerzo por partes', 3.00, 'disponible', true)
    returning id into v_almuerzo;

    insert into option_groups (
      business_id, product_id, name, selection_type, min_selectable,
      max_selectable, sort, is_meal_part, loose_price
    ) values (v_business, v_almuerzo, 'Sopa', 'quantity', 0, 100, 0, true, 1.50)
    returning id into v_g_sopa;
    insert into option_groups (
      business_id, product_id, name, selection_type, min_selectable,
      max_selectable, sort, is_meal_part, loose_price
    ) values (v_business, v_almuerzo, 'Segundo', 'quantity', 0, 100, 1, true, 2.50)
    returning id into v_g_segundo;
    insert into option_groups (
      business_id, product_id, name, selection_type, min_selectable,
      max_selectable, sort
    ) values (v_business, v_almuerzo, 'Para acompañar', 'quantity', 0, 100, 2)
    returning id into v_g_acompanar;

    insert into options (business_id, option_group_id, name, price_adjustment, sort)
    values (v_business, v_g_sopa, 'Caldo de res', 0, 0) returning id into v_caldo;
    insert into options (business_id, option_group_id, name, price_adjustment, sort)
    values (v_business, v_g_segundo, 'Pollo', 0, 0) returning id into v_pollo;
    insert into options (business_id, option_group_id, name, price_adjustment, sort)
    values (v_business, v_g_segundo, 'Ceviche', 0, 1) returning id into v_ceviche;
    insert into options (business_id, option_group_id, name, price_adjustment, sort)
    values (v_business, v_g_acompanar, 'Jugo', 0, 0) returning id into v_jugo;
    insert into options (business_id, option_group_id, name, price_adjustment, sort)
    values (v_business, v_g_acompanar, 'Porción de carne', 0.50, 1) returning id into v_carne;

    -- Una parte solo puede ser un CONTADOR colgado de un producto: un radio no
    -- deja pedir tres sopas, y en una categoría no hay un precio de almuerzo.
    begin
      insert into option_groups (business_id, product_id, name, selection_type, is_meal_part)
      values (v_business, v_almuerzo, 'Parte que no cuenta', 'single', true);
      raise exception 'option_groups aceptó una parte del plato que no es contador';
    exception when sqlstate '23514' then null;
    end;
    -- Y un precio suelto sin ser parte no significaría nada.
    begin
      insert into option_groups (
        business_id, product_id, name, selection_type, max_selectable, loose_price
      ) values (v_business, v_almuerzo, 'Suelto sin parte', 'quantity', 5, 1.00);
      raise exception 'option_groups aceptó un precio suelto en un grupo que no es parte';
    exception when sqlstate '23514' then null;
    end;

    -- La familia: 2 sopas, 3 segundos, 3 jugos gratis y una porción de carne.
    v_mesa := public.create_storefront_order(
      v_business, null, '+593900000007', 'Familia', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_almuerzo, 'quantity', 1,
        'options', jsonb_build_array(
          jsonb_build_object('option_id', v_ceviche, 'quantity', 1),
          jsonb_build_object('option_id', v_caldo, 'quantity', 2),
          jsonb_build_object('option_id', v_pollo, 'quantity', 2),
          jsonb_build_object('option_id', v_jugo, 'quantity', 3),
          jsonb_build_object('option_id', v_carne, 'quantity', 1)
        )
      ))
    );
    -- 2 almuerzos a 3.00 + 1 segundo suelto a 2.50 + la carne a 0.50.
    if (v_mesa ->> 'total')::numeric <> 9.00 then
      raise exception 'el plato por partes cobró %, y debía cobrar 9.00', v_mesa ->> 'total';
    end if;
    if (select count(*) from order_items where order_id = (v_mesa ->> 'id')::uuid) <> 3 then
      raise exception 'el plato por partes no se partió en sus tres líneas';
    end if;

    select id into v_completo
    from order_items
    where order_id = (v_mesa ->> 'id')::uuid
      and product_name = 'Almuerzo por partes'
      and quantity = 2 and unit_price = 3.00 and line_total = 6.00;
    if v_completo is null then
      raise exception 'los almuerzos completos no salieron como 2 × 3.00';
    end if;
    if not exists (
      select 1 from order_items
      where order_id = (v_mesa ->> 'id')::uuid
        and product_name = 'Solo segundo' and quantity = 1 and unit_price = 2.50
    ) then
      raise exception 'el segundo que sobraba no se cobró a su precio suelto';
    end if;
    if not exists (
      select 1 from order_items
      where order_id = (v_mesa ->> 'id')::uuid
        and product_name = 'Porción de carne' and quantity = 1 and unit_price = 0.50
    ) then
      raise exception 'el adicional con precio no salió en su propia línea';
    end if;

    -- La cocina lee el almuerzo contado, y lo gratis va con él sin sumar.
    if not exists (
      select 1 from order_item_options
      where order_item_id = v_completo and option_name = 'Caldo de res'
        and quantity = 2 and total_price_adjustment = 0
    ) or not exists (
      select 1 from order_item_options
      where order_item_id = v_completo and option_name = 'Pollo' and quantity = 2
    ) or not exists (
      select 1 from order_item_options
      where order_item_id = v_completo and option_name = 'Jugo'
        and quantity = 3 and total_price_adjustment = 0
    ) then
      raise exception 'el almuerzo no guardó sus partes contadas';
    end if;
    -- El pollo va primero en la carta del dueño, así que el suelto es el ceviche.
    if not exists (
      select 1
      from order_item_options oio
      join order_items oi on oi.id = oio.order_item_id
      where oi.order_id = (v_mesa ->> 'id')::uuid
        and oi.product_name = 'Solo segundo'
        and oio.option_name = 'Ceviche' and oio.quantity = 1
    ) then
      raise exception 'la línea suelta no dice qué segundo se pidió';
    end if;
    delete from orders where id = (v_mesa ->> 'id')::uuid;

    -- ── LO GRATIS VA POR PLATO, NO A DISCRECIÓN ──────────────────────────
    --
    -- Lo encontró el dueño mirando su propio local (2026-09-16): «el jugo que
    -- va gratis es por el número de almuerzos que lleva el cliente, pero ahora
    -- pueden elegir muchos jugos gratis».
    --
    -- Y era cierto en las TRES capas: ni la app, ni `pricing.ts`, ni esta
    -- función contaban cuántos platos había. El único tope era
    -- `max_selectable`, que en La Abuelita valía 100: un almuerzo de $3.50 se
    -- podía llevar cien jugos.
    --
    -- El tope es `platos` = completos + partes sueltas, que es justo lo que ya
    -- se calcula aquí arriba para partir las líneas.
    begin
      v_mesa := public.create_storefront_order(
        v_business, null, '+593900000007', 'Aprovechado', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_almuerzo, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_caldo, 'quantity', 1),
            jsonb_build_object('option_id', v_pollo, 'quantity', 1),
            -- UN plato, CINCO jugos gratis.
            jsonb_build_object('option_id', v_jugo, 'quantity', 5)
          )
        ))
      );
      raise exception 'se aceptaron 5 jugos gratis para 1 solo plato';
    exception when sqlstate '22023' then null;
    end;

    -- Y lo que SÍ cuadra sigue pasando: 2 completos + 1 suelto = 3 platos, y
    -- caben 3 jugos. Es el ejemplo literal del dueño.
    v_mesa := public.create_storefront_order(
      v_business, null, '+593900000007', 'Familia', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_almuerzo, 'quantity', 1,
        'options', jsonb_build_array(
          jsonb_build_object('option_id', v_caldo, 'quantity', 2),
          jsonb_build_object('option_id', v_pollo, 'quantity', 3),
          jsonb_build_object('option_id', v_jugo, 'quantity', 3)
        )
      ))
    );
    if (select count(*) from order_items where order_id = (v_mesa ->> 'id')::uuid) <> 2 then
      raise exception 'los 3 jugos por 3 platos no se aceptaron como antes';
    end if;
    delete from orders where id = (v_mesa ->> 'id')::uuid;

    -- ⚠️ Lo que se COBRA no tiene tope, y es deliberado: quien quiera cinco
    -- porciones de carne las paga. El tope es solo para lo que va GRATIS.
    v_mesa := public.create_storefront_order(
      v_business, null, '+593900000007', 'Con extras', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_almuerzo, 'quantity', 1,
        'options', jsonb_build_array(
          jsonb_build_object('option_id', v_caldo, 'quantity', 1),
          jsonb_build_object('option_id', v_pollo, 'quantity', 1),
          jsonb_build_object('option_id', v_carne, 'quantity', 5)
        )
      ))
    );
    if (v_mesa ->> 'total')::numeric <> 5.50 then
      raise exception 'el adicional de pago no se cobró entero: %', v_mesa ->> 'total';
    end if;
    delete from orders where id = (v_mesa ->> 'id')::uuid;

    -- El almuerzo vale lo que dice el dueño, aunque las partes sueltas sumen menos.
    update option_groups set loose_price = 0.50 where id in (v_g_sopa, v_g_segundo);
    v_mesa := public.create_storefront_order(
      v_business, null, '+593900000007', 'Familia', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_almuerzo, 'quantity', 1,
        'options', jsonb_build_array(
          jsonb_build_object('option_id', v_caldo, 'quantity', 1),
          jsonb_build_object('option_id', v_pollo, 'quantity', 1)
        )
      ))
    );
    if (v_mesa ->> 'total')::numeric <> 3.00 then
      raise exception 'el almuerzo completo cobró % en vez del precio del dueño', v_mesa ->> 'total';
    end if;
    delete from orders where id = (v_mesa ->> 'id')::uuid;

    -- Sin precio suelto, la sopa que sobra NO se vende.
    update option_groups set loose_price = null where id = v_g_sopa;
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000007', 'Familia', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_almuerzo, 'quantity', 1,
          'options', jsonb_build_array(
            jsonb_build_object('option_id', v_caldo, 'quantity', 2),
            jsonb_build_object('option_id', v_pollo, 'quantity', 1)
          )
        ))
      );
      raise exception 'se vendió una sopa suelta que no tiene precio suelto';
    exception when sqlstate '22023' then null;
    end;

    -- Solo lo gratis no es un plato.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000007', 'Familia', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_almuerzo, 'quantity', 1,
          'options', jsonb_build_array(jsonb_build_object('option_id', v_jugo, 'quantity', 2))
        ))
      );
      raise exception 'se aceptó un plato por partes sin ninguna parte';
    exception when sqlstate '22023' then null;
    end;

    -- En DOS líneas la sopa y el segundo no se juntarían: el almuerzo saldría
    -- por lo que suman sueltos. La mesa va en una sola.
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000007', 'Familia', null, 'pickup',
        jsonb_build_array(
          jsonb_build_object(
            'product_id', v_almuerzo, 'quantity', 1,
            'options', jsonb_build_array(jsonb_build_object('option_id', v_pollo, 'quantity', 1))
          ),
          jsonb_build_object(
            'product_id', v_almuerzo, 'quantity', 1,
            'options', jsonb_build_array(jsonb_build_object('option_id', v_ceviche, 'quantity', 1))
          )
        )
      );
      raise exception 'se aceptó el plato por partes repartido en dos líneas';
    exception when sqlstate '22023' then null;
    end;
    begin
      perform public.create_storefront_order(
        v_business, null, '+593900000007', 'Familia', null, 'pickup',
        jsonb_build_array(jsonb_build_object(
          'product_id', v_almuerzo, 'quantity', 2,
          'options', jsonb_build_array(jsonb_build_object('option_id', v_pollo, 'quantity', 1))
        ))
      );
      raise exception 'se aceptó el plato por partes con cantidad 2';
    exception when sqlstate '22023' then null;
    end;

    delete from option_groups where product_id = v_almuerzo;
    delete from products where id = v_almuerzo;
  end;

  -- ── 3d bis. LAS PLANTILLAS DE OPCIONES FUNCIONAN (2026-09-16) ───────────
  --
  -- El panel dejaba crear una plantilla y enganchar un grupo a ella, pero ni la
  -- tienda ni esta RPC la leían: el grupo se quedaba sin opciones propias, la
  -- tienda lo descartaba por vacío y el cliente NO VEÍA NADA. Construida y
  -- desconectada, décima vez del patrón.
  --
  -- ⚠️ Se arregla COPIANDO, no enseñando a la RPC a leer plantillas. Leerlas
  -- aquí rompía algo concreto: la RPC identifica cada elección por el id de la
  -- opción y rechaza un id repetido, así que «2 pizzas hawaianas» —el mismo
  -- sabor de la plantilla en dos pasos— se habría rechazado. Con una copia por
  -- grupo, cada paso tiene sus propios ids y la RPC no cambia una línea.
  declare
    v_pizza   uuid;
    v_plant   uuid;
    v_i_haw   uuid;
    v_i_mon   uuid;
    v_i_rom   uuid;
    v_g1      uuid;
    v_g2      uuid;
    v_manual  uuid;
    v_c1_haw  uuid;
    v_c2_haw  uuid;
    v_cuantas integer;
    v_precio  numeric;
    v_mesa    jsonb;
  begin
    insert into products (business_id, name, price, stock, active)
    values (v_business, 'Combo de dos pizzas', 12.00, 'disponible', true)
    returning id into v_pizza;

    insert into option_templates (business_id, name)
    values (v_business, 'Sabores de prueba') returning id into v_plant;
    insert into option_template_items (business_id, option_template_id, name, price_adjustment, sort)
    values (v_business, v_plant, 'Hawaiana', 0, 0) returning id into v_i_haw;
    insert into option_template_items (business_id, option_template_id, name, price_adjustment, sort)
    values (v_business, v_plant, 'Monster', 2.50, 1) returning id into v_i_mon;
    insert into option_template_items (business_id, option_template_id, name, price_adjustment, sort)
    values (v_business, v_plant, 'Romana', 0, 2) returning id into v_i_rom;

    insert into option_groups (business_id, product_id, name, selection_type, required, min_selectable, sort)
    values (v_business, v_pizza, 'Sabor de la 1.ª pizza', 'single', true, 1, 0) returning id into v_g1;
    insert into option_groups (business_id, product_id, name, selection_type, required, min_selectable, sort)
    values (v_business, v_pizza, 'Sabor de la 2.ª pizza', 'single', true, 1, 1) returning id into v_g2;

    -- Una opción MANUAL en el grupo 1, antes de enganchar: no se puede perder.
    insert into options (business_id, option_group_id, name, price_adjustment)
    values (v_business, v_g1, 'Mitad y mitad', 1.00) returning id into v_manual;

    -- ── Enganchar copia los ítems ───────────────────────────────────────
    update option_groups set option_template_id = v_plant where id in (v_g1, v_g2);

    select count(*) into v_cuantas from options
     where option_group_id = v_g2 and option_template_item_id is not null;
    if v_cuantas <> 3 then
      raise exception 'enganchar la plantilla no copió sus 3 sabores al grupo: %', v_cuantas;
    end if;
    if not exists (select 1 from options where id = v_manual) then
      raise exception 'enganchar la plantilla BORRÓ una opción manual del dueño';
    end if;

    -- Cada grupo tiene SUS copias: ids distintos para el mismo sabor.
    select id into v_c1_haw from options where option_group_id = v_g1 and option_template_item_id = v_i_haw;
    select id into v_c2_haw from options where option_group_id = v_g2 and option_template_item_id = v_i_haw;
    if v_c1_haw is null or v_c2_haw is null or v_c1_haw = v_c2_haw then
      raise exception 'los dos pasos no tienen copias propias de Hawaiana';
    end if;

    -- ── EL CASO QUE ROMPÍA LA OTRA SOLUCIÓN: dos hawaianas ──────────────
    v_mesa := public.create_storefront_order(
      v_business, null, '+593900000008', 'Dos hawaianas', null, 'pickup',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_pizza, 'quantity', 1,
        'options', jsonb_build_array(
          jsonb_build_object('option_id', v_c1_haw, 'quantity', 1),
          jsonb_build_object('option_id', v_c2_haw, 'quantity', 1)
        )
      ))
    );
    if (v_mesa ->> 'total')::numeric <> 12.00 then
      raise exception 'dos hawaianas cobró %, y debía cobrar 12.00', v_mesa ->> 'total';
    end if;
    delete from orders where id = (v_mesa ->> 'id')::uuid;

    -- ── Un sabor nuevo en la plantilla aparece en TODOS los pasos ───────
    insert into option_template_items (business_id, option_template_id, name, price_adjustment, sort)
    values (v_business, v_plant, 'Pepperoni', 0, 3);
    select count(*) into v_cuantas from options
     where option_group_id in (v_g1, v_g2) and name = 'Pepperoni';
    if v_cuantas <> 2 then
      raise exception 'un sabor nuevo de la plantilla no llegó a los dos pasos: %', v_cuantas;
    end if;

    -- ── Cambiar un precio en la plantilla lo cambia en todos ────────────
    update option_template_items set price_adjustment = 3.00 where id = v_i_mon;
    select max(price_adjustment) into v_precio from options
     where option_group_id in (v_g1, v_g2) and option_template_item_id = v_i_mon;
    if v_precio <> 3.00 or exists (
      select 1 from options where option_template_item_id = v_i_mon and price_adjustment <> 3.00
    ) then
      raise exception 'el precio nuevo de Monster no llegó a todas sus copias';
    end if;

    -- ── Agotar en la plantilla agota en todos ───────────────────────────
    update option_template_items set stock = 'agotado' where id = v_i_rom;
    if exists (
      select 1 from options where option_template_item_id = v_i_rom and stock <> 'agotado'
    ) then
      raise exception 'agotar Romana en la plantilla no la agotó en los pasos';
    end if;

    -- ── Borrar un sabor de la plantilla lo quita de todos ───────────────
    delete from option_template_items where id = v_i_rom;
    if exists (select 1 from options where name = 'Romana' and option_group_id in (v_g1, v_g2)) then
      raise exception 'borrar Romana de la plantilla la dejó viva en un paso';
    end if;

    -- ── Desenganchar quita SOLO las copias ──────────────────────────────
    update option_groups set option_template_id = null where id = v_g1;
    if exists (select 1 from options where option_group_id = v_g1 and option_template_item_id is not null) then
      raise exception 'desenganchar dejó copias de la plantilla en el grupo';
    end if;
    if not exists (select 1 from options where id = v_manual) then
      raise exception 'desenganchar BORRÓ la opción manual del dueño';
    end if;
    -- …y el otro grupo, que sigue enganchado, conserva las suyas.
    if not exists (select 1 from options where option_group_id = v_g2 and option_template_item_id = v_i_haw) then
      raise exception 'desenganchar un grupo dejó sin sabores al OTRO';
    end if;

    delete from option_groups where product_id = v_pizza;
    delete from option_templates where id = v_plant;
    delete from products where id = v_pizza;
  end;

  -- ── 3d ter. Un doble toque NO crea dos pedidos ───────────────────────────
  --
  -- Es el fallo más caro de una tienda: dos comandas en la cocina y un cliente
  -- que paga dos veces. La app manda una clave por intento de compra.
  declare
    v_uno jsonb;
    v_dos jsonb;
    v_sin_clave jsonb;
    v_pedido_idem uuid;
  begin
    v_uno := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
      null, null, 'clave-del-cliente'
    );
    v_dos := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1)),
      null, null, 'clave-del-cliente'
    );

    if (v_uno ->> 'id') <> (v_dos ->> 'id') then
      raise exception 'La misma clave creó DOS pedidos';
    end if;
    if (v_dos ->> 'repetido')::boolean is not true then
      raise exception 'El segundo intento no se avisó como repetido';
    end if;

    -- Sin clave se siguen creando pedidos distintos: el bot no la manda, y
    -- dos personas pidiendo lo mismo son dos pedidos.
    v_sin_clave := public.create_storefront_order(
      v_business, null, '+593900000002', 'Cliente', null, 'pickup',
      jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
    );
    if (v_sin_clave ->> 'id') = (v_uno ->> 'id') then
      raise exception 'Sin clave se reutilizó un pedido anterior';
    end if;

    -- ── El historial de estados ────────────────────────────────────────────
    v_pedido_idem := (v_uno ->> 'id')::uuid;
    perform public.set_order_status(v_business, v_pedido_idem, 'confirmado');
    perform public.set_order_status(v_business, v_pedido_idem, 'preparacion');

    if (select count(*) from order_events where order_id = v_pedido_idem) <> 2 then
      raise exception 'El historial no registró los dos cambios de estado';
    end if;
    -- De dónde venía, no solo a dónde fue: sin el origen no se puede auditar.
    if not exists (
      select 1 from order_events
      where order_id = v_pedido_idem
        and from_status = 'confirmado' and to_status = 'preparacion'
    ) then
      raise exception 'El historial no guardó de qué estado venía el pedido';
    end if;

    -- ── Los estados nuevos y sus límites ───────────────────────────────────
    -- Un pedido de retiro no sale a reparto…
    if (public.set_order_status(v_business, v_pedido_idem, 'en_camino') ->> 'result')
       <> 'not_deliverable' then
      raise exception 'Un pedido de retiro salió a reparto';
    end if;
    -- ── EL CANDADO: NINGÚN PEDIDO SALE INCOMPLETO (2026-09-24) ───────────
    --
    -- Antes de preparar sus líneas, NO puede quedar listo. Es la protección
    -- que pidió el dueño: «que en el pedido se vaya marcando lo que tiene,
    -- para que no salga incompleto».
    --
    -- ⚠️ Va en las DOS salidas —`en_camino` y `listo_para_retiro`— porque el
    -- 96 % de los pedidos son a domicilio y salen por la primera. Bloquear
    -- solo el retiro habría dejado sin proteger justo el caso del encargo.
    if (public.set_order_status(v_business, v_pedido_idem, 'listo_para_retiro') ->> 'result')
       <> 'incompleto' then
      raise exception 'Un pedido con líneas sin preparar pudo salir';
    end if;
    -- Y dice QUÉ falta, no solo que no puede: el empleado tiene que saberlo.
    if (public.set_order_status(v_business, v_pedido_idem, 'listo_para_retiro') ->> 'faltan')
       is null then
      raise exception 'El bloqueo no dijo qué producto faltaba';
    end if;

    -- ── LA CHECKLIST, A FONDO (2026-09-24) ───────────────────────────────
    --
    -- El caso del dueño: «el cliente pide hamburguesa, papas y gaseosa; el
    -- empleado mete las dos primeras, olvida la gaseosa y el pedido sale
    -- incompleto».
    declare
      v_l1 uuid;
      v_r  jsonb;
      v_n  integer;
    begin
      select id into v_l1 from order_items where order_id = v_pedido_idem limit 1;

      -- (a) Marcar una línea deja su huella: cuándo, y un evento en la línea
      -- de tiempo.
      v_r := public.marcar_linea_preparada(v_business, v_pedido_idem, v_l1, null);
      if (v_r ->> 'result') <> 'ok' then
        raise exception 'no se pudo marcar la línea: %', v_r;
      end if;
      if (select prepared_at from order_items where id = v_l1) is null then
        raise exception 'la línea quedó sin fecha de preparación';
      end if;
      if not exists (
        select 1 from order_events
        where order_item_id = v_l1 and to_status = 'producto_agregado'
      ) then
        raise exception 'marcar una línea no dejó evento en la línea de tiempo';
      end if;

      -- (b) ⚠️ IDEMPOTENTE: en una cocina se toca dos veces por nervio. Un
      -- doble toque no puede dejar dos eventos.
      perform public.marcar_linea_preparada(v_business, v_pedido_idem, v_l1, null);
      select count(*) into v_n from order_events
       where order_item_id = v_l1 and to_status = 'producto_agregado';
      if v_n <> 1 then
        raise exception 'un doble toque dejó % eventos, y debía dejar 1', v_n;
      end if;

      -- (c) ⚠️ EL AISLAMIENTO: la línea de OTRO negocio no se puede marcar.
      begin
        perform public.marcar_linea_preparada(
          gen_random_uuid(), v_pedido_idem, v_l1, null
        );
        raise exception 'se marcó una línea desde otro negocio';
      exception when sqlstate '42501' then
        null;
      end;
    end;


    -- El empleado mete todo en la bolsa…
    declare
      v_linea uuid;
    begin
      for v_linea in select id from order_items where order_id = v_pedido_idem
      loop
        perform public.marcar_linea_preparada(v_business, v_pedido_idem, v_linea, null);
      end loop;
    end;

    -- …y AHORA sí puede quedar listo para retirar.
    if (public.set_order_status(v_business, v_pedido_idem, 'listo_para_retiro') ->> 'result')
       <> 'updated' then
      raise exception 'Un pedido de retiro no pudo quedar listo para retirar';
    end if;

    -- Y de un estado FINAL no se vuelve atrás.
    perform public.set_order_status(v_business, v_pedido_idem, 'cancelado');
    if (public.set_order_status(v_business, v_pedido_idem, 'preparacion') ->> 'result')
       <> 'invalid_transition' then
      raise exception 'Un pedido cancelado volvió a preparación';
    end if;

    delete from orders where id in (v_pedido_idem, (v_sin_clave ->> 'id')::uuid);
  end;

  -- ── 4. El horario por defecto del negocio ─────────────────────────────────
  -- `business_schedule` sobrevivió a la retirada de la agenda porque decide si
  -- la tienda acepta pedidos y si el bot atiende. Su trigger llena los 7 días
  -- al crear el negocio, y sin esa comprobación un alta sin horario pasaría
  -- desapercibida hasta que un cliente no pudiera pedir.
  select count(*) into v_dias_horario
  from business_schedule where business_id = v_business;
  if v_dias_horario <> 7 then
    raise exception
      'El alta del negocio generó % días de horario, esperaba 7', v_dias_horario;
  end if;

  update business_schedule
  set is_active = true, open_time = '08:00', close_time = '20:00'
  where business_id = v_business
    and day_of_week = extract(dow from current_date + 1)::int;
  if not found then
    raise exception 'El alta del negocio no generó su horario por defecto';
  end if;

  -- ── 5. Facturación del SaaS ───────────────────────────────────────────────
  -- Corren solas desde el arranque del servidor y desde el panel. Si revientan,
  -- se descubre el día que toca cobrar, no antes.
  -- Solo se factura a negocios activos con tarifa: se le pone una.
  update businesses set monthly_rate = 25, plan = 'micro' where id = v_business;
  perform public.ensure_current_month_billing();
  if (select count(*) from billing where business_id = v_business) < 1 then
    raise exception 'ensure_current_month_billing no generó la cuota del mes';
  end if;
  -- Correrla dos veces no puede duplicar el cobro del mismo mes.
  perform public.ensure_current_month_billing();
  if (select count(*) from billing where business_id = v_business) <> 1 then
    raise exception 'ensure_current_month_billing duplicó la cuota del mes';
  end if;

  perform public.update_business_plan_billing(v_business, 'pro', 99, 400, 2000);
  if (select plan from businesses where id = v_business) <> 'pro' then
    raise exception 'update_business_plan_billing no cambió el plan';
  end if;

  update businesses set suspended = true where id = v_business;
  perform public.reactivate_business_with_billing(v_business);
  if (select suspended from businesses where id = v_business) is not false then
    raise exception 'reactivate_business_with_billing no reactivó el negocio';
  end if;

  perform public.get_admin_monthly_usage(current_date);

  -- ── 7. El dinero solo nace en el estado correcto ──────────────────────────
  --
  -- Las funciones que crean ventas comprobaban el negocio y la idempotencia,
  -- pero no el ESTADO del origen. Medido contra PostgreSQL real el 2026-08-02:
  --
  --   ⚠️ crear_venta_desde_pedido cobró un pedido en estado "cancelado"
  --
  -- Estaba protegida solo por su llamador (`set_order_status`), y eso basta
  -- hasta que alguien la llame directo: es SECURITY DEFINER y está concedida a
  -- `service_role`, que es el rol con el que el servidor habla con Supabase.
  declare
    v_pedido_cancelado uuid;
  begin
    insert into orders (business_id, contact_phone, status, total)
    values (v_business, '+593900000404', 'cancelado', 20.00)
    returning id into v_pedido_cancelado;
    if public.crear_venta_desde_pedido(v_business, v_pedido_cancelado) is not null then
      raise exception 'un pedido cancelado generó venta';
    end if;

    -- Y el camino legítimo sigue funcionando: una cerradura que también deja
    -- fuera al dueño no sirve de nada.
    update orders set status = 'completado' where id = v_pedido_cancelado;
    if public.crear_venta_desde_pedido(v_business, v_pedido_cancelado) is null then
      raise exception 'un pedido completado no generó su venta';
    end if;
  end;

  -- ── 7 bis. Modo mini app: el enlace se manda una vez cada 24 h ───────────
  --
  -- Es lo que decide si el bot manda el enlace o solo recuerda que lo usen.
  -- Vivía en un `Map` del proceso, que se perdía al reiniciar y no servía con
  -- dos instancias; ahora lo reclama la base, de forma atómica, porque tres
  -- «hola» seguidos son lo normal y no pueden mandar tres enlaces.
  declare
    v_cliente uuid;
    v_toca boolean;
  begin
    insert into public.customers (phone) values ('593900000707')
    returning id into v_cliente;

    v_toca := public.claim_storefront_link_send(v_business, v_cliente, 24);
    if v_toca is not true then
      raise exception 'la primera vez debía reclamar el envío del enlace';
    end if;

    v_toca := public.claim_storefront_link_send(v_business, v_cliente, 24);
    if v_toca is not false then
      raise exception 'dentro de la ventana de 24 h NO debía reenviar';
    end if;

    update public.business_customers
    set storefront_link_sent_at = now() - interval '25 hours'
    where business_id = v_business and customer_id = v_cliente;

    v_toca := public.claim_storefront_link_send(v_business, v_cliente, 24);
    if v_toca is not true then
      raise exception 'pasadas 24 h debía volver a mandar el enlace';
    end if;

    -- El mismo cliente en OTRO negocio lleva su propia cuenta: que un local le
    -- haya mandado su enlace no puede dejar sin enlace al de al lado.
    declare
      v_otro uuid;
    begin
      insert into businesses (
        slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
        takes_orders
      ) values (
        'verificacion-enlace-b', 'Vecino', 'tienda', 'ycloud',
        '+593900000708', '+593900000708', true
      ) returning id into v_otro;

      if public.claim_storefront_link_send(v_otro, v_cliente, 24) is not true then
        raise exception 'el envío de un negocio bloqueó el de otro';
      end if;

      delete from businesses where id = v_otro;
    end;

    delete from public.customers where id = v_cliente;
  end;

  -- ── 7 ter. Quien escribe por molestar: techo y bloqueo ──────────────────
  --
  -- El modo mini app contesta a CADA mensaje desde el 2026-08-12, así que
  -- quien escribe por molestar recibe una respuesta por mensaje — y desde
  -- octubre cada una se paga. Esto es lo que decide cuándo se ofrece el
  -- teléfono del local y cuándo se deja de contestar.
  declare
    v_molesto uuid;
    v_r jsonb;
    v_i integer;
  begin
    insert into public.customers (phone) values ('593900000709')
    returning id into v_molesto;

    -- Las cuatro primeras son normales.
    for v_i in 1..4 loop
      v_r := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24);
      if (v_r->>'permitido')::boolean is not true or v_r->>'motivo' <> 'ok' then
        raise exception 'la respuesta % debía ser normal, y fue %', v_i, v_r;
      end if;
      if (v_r->>'respuestas')::integer <> v_i then
        raise exception 'la cuenta debía ir por % y va por %', v_i, v_r->>'respuestas';
      end if;
    end loop;

    -- La quinta sigue contestando, pero ofreciendo el teléfono. No cuesta un
    -- mensaje más: es el mismo con una línea de ayuda.
    v_r := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24);
    if (v_r->>'permitido')::boolean is not true or v_r->>'motivo' <> 'con_telefono' then
      raise exception 'la quinta debía llevar el teléfono, y fue %', v_r;
    end if;

    -- De la sexta a la décima se sigue contestando.
    for v_i in 6..10 loop
      v_r := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24);
      if (v_r->>'permitido')::boolean is not true then
        raise exception 'la respuesta % no debía callarse todavía: %', v_i, v_r;
      end if;
    end loop;

    -- La undécima calla. Y el silencio dura 24 h: con una ventana que se
    -- reinicia sola, quien molesta con paciencia pagaría el techo cada hora.
    v_r := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24);
    if (v_r->>'permitido')::boolean is not false or v_r->>'motivo' <> 'silenciado' then
      raise exception 'pasado el tope debía callar, y fue %', v_r;
    end if;

    -- Aunque la hora se acabe, el silencio sigue en pie.
    update public.business_customers
    set reply_window_start = now() - interval '2 hours', reply_count = 0
    where business_id = v_business and customer_id = v_molesto;

    v_r := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24);
    if (v_r->>'permitido')::boolean is not false then
      raise exception 'el silencio de 24 h no puede levantarse al cambiar de hora: %', v_r;
    end if;

    -- Con el silencio vencido vuelve a contestar desde cero.
    update public.business_customers
    set muted_until = now() - interval '1 minute'
    where business_id = v_business and customer_id = v_molesto;

    v_r := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24);
    if (v_r->>'permitido')::boolean is not true or (v_r->>'respuestas')::integer <> 1 then
      raise exception 'pasado el silencio debía empezar de cero: %', v_r;
    end if;

    -- ⚠️ UN BLOQUEADO NO CREA PEDIDOS, y lo impide la BASE.
    --
    -- La ruta ya lo comprueba, pero falla abierto a propósito y deja una
    -- carrera de milisegundos con el botón del dueño. El trigger va dentro de
    -- la misma transacción que la inserción, así que no hay hueco.
    declare
      v_bloqueado_pedido jsonb;
      v_rechazado boolean := false;
    begin
      update public.business_customers set blocked_at = now()
      where business_id = v_business and customer_id = v_molesto;

      begin
        v_bloqueado_pedido := public.create_storefront_order(
          v_business, v_molesto, '593900000709', 'Molesto', null, 'pickup',
          jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
        );
      exception when insufficient_privilege then
        v_rechazado := true;
      end;

      if not v_rechazado then
        raise exception 'un cliente bloqueado consiguió crear un pedido: %', v_bloqueado_pedido;
      end if;

      -- Y desbloqueado vuelve a poder pedir: el cinturón no se queda puesto.
      update public.business_customers set blocked_at = null
      where business_id = v_business and customer_id = v_molesto;

      v_bloqueado_pedido := public.create_storefront_order(
        v_business, v_molesto, '593900000709', 'Molesto', null, 'pickup',
        jsonb_build_array(jsonb_build_object('product_id', v_producto, 'quantity', 1))
      );
      if (v_bloqueado_pedido ->> 'order_number') is null then
        raise exception 'tras desbloquear debía poder pedir: %', v_bloqueado_pedido;
      end if;
    end;

    -- ⚠️ EL MISMO MENSAJE NO SE CUENTA DOS VECES. La entrada es at-least-once:
    -- si la confirmación no llega, el worker reintenta y el mensaje vuelve a
    -- pasar por aquí. Sin esto, cinco reintentos de un cliente legítimo lo
    -- dejaban silenciado 24 h sin haber escrito de más.
    declare
      v_antes integer;
      v_r2 jsonb;
    begin
      v_r := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24, 'wamid.ABC');
      v_antes := (v_r->>'respuestas')::integer;

      v_r2 := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24, 'wamid.ABC');
      if (v_r2->>'respuestas')::integer <> v_antes then
        raise exception 'el mismo mensaje contó dos veces: % vs %', v_antes, v_r2;
      end if;
      if (v_r2->>'permitido')::boolean is not true then
        raise exception 'un reintento no puede callar al bot: %', v_r2;
      end if;

      -- Y un mensaje DISTINTO sí suma: la defensa no puede congelar la cuenta.
      v_r2 := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24, 'wamid.OTRO');
      if (v_r2->>'respuestas')::integer <> v_antes + 1 then
        raise exception 'un mensaje nuevo debía sumar: % vs %', v_antes, v_r2;
      end if;

      -- Sin id se cuenta como siempre: más vale contar de más que no contar.
      v_r2 := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24, null);
      if (v_r2->>'respuestas')::integer <> v_antes + 2 then
        raise exception 'sin id debía contar igualmente: %', v_r2;
      end if;
    end;

    -- El bloqueo del dueño manda sobre todo lo demás y no caduca.
    update public.business_customers
    set blocked_at = now()
    where business_id = v_business and customer_id = v_molesto;

    v_r := public.claim_miniapp_reply(v_business, v_molesto, 5, 10, 24);
    if (v_r->>'permitido')::boolean is not false or v_r->>'motivo' <> 'bloqueado' then
      raise exception 'un contacto bloqueado no puede recibir respuesta: %', v_r;
    end if;

    delete from public.customers where id = v_molesto;
  end;

  -- ── 8. Limpiezas programadas ──────────────────────────────────────────────
  perform public.cleanup_webhook_events();
  perform public.cleanup_platform_errors(30);
  perform public.cleanup_storefront_sessions(2);

  -- ── Limpieza ──────────────────────────────────────────────────────────────
  delete from businesses where id = v_business;

  -- ── La conversación del marketplace ──────────────────────────────────────
  --
  -- PostgreSQL no valida el cuerpo de una función plpgsql al crearla: un error
  -- ahí dentro solo aparece al EJECUTARLA. Por eso se ejecuta, y con los casos
  -- que de verdad pueden romperla.
  declare
    v_cliente uuid;
    v_local   uuid;
    v_conv    jsonb;
  begin
    insert into public.customers (phone, name)
    values ('593999000123', 'Cliente de verificación')
    returning id into v_cliente;

    insert into public.businesses (
      slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number
    ) values (
      'verificacion-marketplace', 'Local de verificación', 'pizzería',
      'ycloud', '+593900000123', '+593900000123'
    )
    returning id into v_local;

    -- 1. El primer mensaje crea la conversación.
    v_conv := public.advance_marketplace_conversation(v_cliente);
    if (v_conv ->> 'conflicto')::boolean is not false
       or (v_conv ->> 'current_state') <> 'inicio' then
      raise exception 'La conversación no nace en «inicio»: %', v_conv;
    end if;

    -- 2. Elige local y empieza a pedir.
    v_conv := public.advance_marketplace_conversation(
      v_cliente, (v_conv ->> 'version')::integer, 'en_negocio', v_local, false, true
    );
    if (v_conv ->> 'shopping_locked')::boolean is not true then
      raise exception 'El bloqueo de compra no se aplicó: %', v_conv;
    end if;

    -- 3. Bloqueo optimista: una versión vieja NO pisa lo que hay.
    if (public.advance_marketplace_conversation(v_cliente, 1, 'otro_estado')
         ->> 'conflicto')::boolean is not true then
      raise exception 'El bloqueo optimista dejó pisar con una versión vieja';
    end if;
    if (select current_state from public.marketplace_conversations
        where customer_id = v_cliente) <> 'en_negocio' then
      raise exception 'FUGA: un conflicto llegó a modificar la conversación';
    end if;

    -- 4. Estar bloqueado sin local es imposible.
    begin
      update public.marketplace_conversations
         set selected_business_id = null
       where customer_id = v_cliente;
      raise exception 'Se pudo dejar a un cliente bloqueado en ningún negocio';
    exception when check_violation then null;
    end;

    -- 5. Borrar el local reinicia la conversación, no la rompe ni la borra.
    delete from public.businesses where id = v_local;
    if not exists (
      select 1 from public.marketplace_conversations
      where customer_id = v_cliente
        and selected_business_id is null
        and shopping_locked = false
        and current_state = 'inicio'
    ) then
      raise exception 'Borrar el local no reinició la conversación del cliente';
    end if;

    delete from public.customers where id = v_cliente;
    raise notice 'CONVERSACIÓN DEL MARKETPLACE: verificada';
  end;

  -- ── El menú del marketplace ──────────────────────────────────────────────
  declare
    v_local_menu uuid;
    v_categorias integer;
  begin
    -- Sin locales disponibles, el menú está vacío. No es un error: es lo que
    -- ve un marketplace recién montado.
    select count(*) into v_categorias from public.marketplace_categories_disponibles();

    insert into public.businesses (
      slug, name, type, whatsapp_provider, takes_orders, storefront_enabled
    ) values (
      'verificacion-menu', 'Pizzería de verificación', 'pizzería',
      'marketplace', true, true
    )
    returning id into v_local_menu;

    -- Ahora Pizzerías tiene algo detrás y DEBE aparecer.
    if not exists (
      select 1 from public.marketplace_categories_disponibles() where code = 'pizzerias'
    ) then
      raise exception 'El menú no ofrece una categoría que sí tiene locales';
    end if;
    if not exists (
      select 1 from public.marketplace_negocios_de_categoria('pizzerias')
      where id = v_local_menu
    ) then
      raise exception 'El local no aparece dentro de su categoría';
    end if;

    -- Suspenderlo lo saca del menú: ofrecerlo sería una calle sin salida.
    update public.businesses set suspended = true where id = v_local_menu;
    if exists (
      select 1 from public.marketplace_negocios_de_categoria('pizzerias')
      where id = v_local_menu
    ) then
      raise exception 'Un local suspendido sigue saliendo en el menú';
    end if;

    -- Y apagarle la tienda también: el menú termina mandando su enlace.
    update public.businesses set suspended = false, storefront_enabled = false
     where id = v_local_menu;
    if exists (
      select 1 from public.marketplace_negocios_de_categoria('pizzerias')
      where id = v_local_menu
    ) then
      raise exception 'Un local sin tienda sigue saliendo en el menú';
    end if;

    delete from public.businesses where id = v_local_menu;
    raise notice 'MENÚ DEL MARKETPLACE: verificado';
  end;

  -- ── La búsqueda del marketplace ──────────────────────────────────────────
  declare
    v_local_busq uuid;
  begin
    -- El normalizador es lo que hace que «quiero ceviche» encuentre algo.
    if public.marketplace_normalizar_consulta('hola, quisiera un ceviche') <> 'ceviche' then
      raise exception 'El normalizador no extrae el plato: %',
        public.marketplace_normalizar_consulta('hola, quisiera un ceviche');
    end if;
    if public.marketplace_normalizar_consulta('quiero') <> '' then
      raise exception 'Una frase sin plato debería quedar vacía';
    end if;

    insert into public.businesses (
      slug, name, type, whatsapp_provider, takes_orders, storefront_enabled
    ) values (
      'verificacion-busqueda', 'Cevichería de verificación', 'marisquería',
      'marketplace', true, true
    )
    returning id into v_local_busq;

    insert into public.products (business_id, name, description, price, active)
    values (v_local_busq, 'Ceviche mixto', 'Camarón y concha', 8.50, true);

    -- Por alias: «cebiche» no casa por texto con «ceviche», y aun así encuentra.
    if not exists (
      select 1 from public.marketplace_buscar_negocios('quiero cebiche')
      where id = v_local_busq
    ) then
      raise exception 'La búsqueda no encuentra el local por alias';
    end if;

    -- Dentro del local: solo sus productos.
    if not exists (
      select 1 from public.marketplace_buscar_productos(v_local_busq, 'ceviche')
    ) then
      raise exception 'La búsqueda dentro del local no encuentra su producto';
    end if;

    -- Suspendido desaparece: encontrar un local que no puede atender es peor
    -- que no encontrar ninguno, porque el cliente ya eligió.
    update public.businesses set suspended = true where id = v_local_busq;
    if exists (
      select 1 from public.marketplace_buscar_negocios('ceviche')
      where id = v_local_busq
    ) then
      raise exception 'Un local suspendido sigue saliendo en la búsqueda';
    end if;

    delete from public.businesses where id = v_local_busq;
    raise notice 'BÚSQUEDA DEL MARKETPLACE: verificada';
  end;

  -- ── La búsqueda recorta por RELEVANCIA, no por identificador ─────────────
  --
  -- 2026-09-26: el `limit` iba pegado a un `distinct on` ordenado por `id`, y
  -- se quedaban los locales de uuid más bajo. El más parecido lleva aquí el
  -- uuid MÁS ALTO a propósito: con el código viejo queda fuera siempre, no
  -- una de cada tantas.
  declare
    v_mejor  uuid := 'ffffffff-ffff-4fff-bfff-fffffffffff1';
    v_primero uuid;
  begin
    insert into public.businesses (
      id, slug, name, type, whatsapp_provider, takes_orders, storefront_enabled
    ) values
      ('00000000-0000-4000-8000-0000000000a1', 'verificacion-relevancia-1',
       'Relevancia verificada sucursal norte', 'pizzería', 'marketplace', true, true),
      ('00000000-0000-4000-8000-0000000000a2', 'verificacion-relevancia-2',
       'Relevancia verificada sucursal sur', 'pizzería', 'marketplace', true, true),
      (v_mejor, 'verificacion-relevancia-3',
       'Relevancia verificada', 'pizzería', 'marketplace', true, true);

    select id into v_primero
    from public.marketplace_buscar_negocios('relevancia verificada', 1);
    if v_primero is distinct from v_mejor then
      raise exception 'La búsqueda recorta por identificador: el local más parecido se quedó fuera';
    end if;

    -- Y lo que sale llega de más a menos parecido, que es como lo pinta el chat.
    if exists (
      select 1
      from (
        select r.orden, lag(r.orden) over (order by r.n) as anterior
        from public.marketplace_buscar_negocios('relevancia verificada', 3)
          with ordinality as r(id, slug, name, type, motivo, orden, n)
      ) s
      where s.anterior < s.orden
    ) then
      raise exception 'La búsqueda devuelve los locales sin ordenar por relevancia';
    end if;

    delete from public.businesses where slug like 'verificacion-relevancia-%';
    raise notice 'BÚSQUEDA POR RELEVANCIA: verificada';
  end;

  -- ── La cola de avisos ────────────────────────────────────────────────────
  declare
    v_neg_out uuid;
    v_ped_out uuid := gen_random_uuid();
    v_ev      uuid;
    v_tok     uuid;
  begin
    insert into public.businesses (slug, name, type, whatsapp_provider)
    values ('verificacion-outbox', 'Local outbox', 'pizzería', 'marketplace')
    returning id into v_neg_out;

    -- Encolar el mismo hito dos veces crea UNO. Cada mensaje se paga.
    v_ev := public.enqueue_outbox_event(
      v_neg_out, 'order_status_notice', v_ped_out, '{"status":"preparacion"}'::jsonb
    );
    if v_ev is null then raise exception 'No se pudo encolar el aviso'; end if;
    if public.enqueue_outbox_event(
      v_neg_out, 'order_status_notice', v_ped_out, '{"status":"preparacion"}'::jsonb
    ) is not null then
      raise exception 'El mismo hito se encoló dos veces: el cliente recibiría dos mensajes';
    end if;

    -- Dentro de su ventana, el worker NO lo toma: el envío inmediato va en
    -- vuelo y tomarlo ahora costaría un segundo mensaje.
    if exists (select 1 from public.lease_outbox_events('verificacion', 10)) then
      raise exception 'El worker tomó un aviso dentro de su ventana de gracia';
    end if;

    -- El envío inmediato cierra su propio evento, sin lease.
    if public.complete_outbox_event(v_ev, null) is not true then
      raise exception 'El envío inmediato no pudo cerrar su evento';
    end if;

    -- Uno que falla: vuelve a la cola con espera, NO se pierde.
    v_ev := public.enqueue_outbox_event(
      v_neg_out, 'order_status_notice', v_ped_out, '{"status":"en_camino"}'::jsonb, 'order', 0
    );
    select lease_token into v_tok
    from public.lease_outbox_events('verificacion', 10) limit 1;
    if v_tok is null then raise exception 'El worker no pudo tomar el aviso vencido'; end if;
    if public.fail_outbox_event(v_ev, v_tok, 'canal caido') <> 'reintentar' then
      raise exception 'Un aviso fallido no volvió a la cola';
    end if;
    if not exists (
      select 1 from public.outbox_events
      where id = v_ev and status = 'pending' and available_at > now()
    ) then
      raise exception 'El reintento no espera antes de volver a intentarlo';
    end if;

    delete from public.businesses where id = v_neg_out;
    raise notice 'COLA DE AVISOS: verificada';
  end;

  -- ═══════════════════════════════════════════════════════════════════════
  -- EL CANAL DE LA PLATAFORMA: encolar un mensaje SIN local
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- ⚠️ Estas comprobaciones necesitan DATOS. Con la tabla vacía todas pasan
  -- solas y esconderían justo lo que vienen a cazar: en SQL dos NULL no son
  -- iguales, así que los índices únicos que empiezan por `business_id` no
  -- deduplican nada cuando el negocio es nulo, y el FIFO por conversación
  -- desaparece. Los dos fallos solo aparecen con más de una fila.
  declare
    v_neg_plat uuid;
    v_hash_a text := repeat('a', 64);
    v_hash_b text := repeat('b', 64);
    v_stream text := repeat('c', 64);
    v_leased integer;
  begin
    -- 1. Se puede encolar sin negocio: el cliente aún no eligió local.
    --    Se usa MEDIA y no texto porque un texto entra con la ventana de
    --    debounce de 3 s del agrupado, y entonces el punto 4 no mediría el
    --    FIFO sino la espera.
    if public.enqueue_webhook_event(
      null, 'ycloud', v_hash_a, v_stream,
      '{"version":1,"content":{"kind":"image","media":{"url":"a"}}}'::jsonb
    ) is not true then
      raise exception 'No se pudo encolar un mensaje del marketplace';
    end if;

    -- 2. El MISMO mensaje reentregado no crea otra fila. La entrada es
    --    at-least-once: sin esto el cliente recibiría la respuesta dos veces.
    --    ⚠️ Es lo que el índice único de siempre NO puede hacer con NULL.
    if public.enqueue_webhook_event(
      null, 'ycloud', v_hash_a, v_stream,
      '{"version":1,"content":{"kind":"image","media":{"url":"a"}}}'::jsonb
    ) is not false then
      raise exception 'Un mensaje del marketplace se encoló dos veces';
    end if;

    -- 3. Un segundo mensaje del MISMO cliente sí entra…
    if public.enqueue_webhook_event(
      null, 'ycloud', v_hash_b, v_stream,
      '{"version":1,"content":{"kind":"image","media":{"url":"b"}}}'::jsonb
    ) is not true then
      raise exception 'El segundo mensaje del marketplace no se encoló';
    end if;

    -- 4. …pero el worker toma UNO SOLO: el FIFO por conversación. Con la
    --    comparación `=` en vez de `is not distinct from`, aquí salían los
    --    dos y el cliente que escribe «1» y luego «2» recibía las respuestas
    --    al revés.
    select count(*) into v_leased
    from public.lease_webhook_events('verificacion-plataforma', 10, 60);
    if v_leased <> 1 then
      raise exception 'El FIFO del marketplace dejó salir % mensajes a la vez', v_leased;
    end if;

    -- 4b. El agrupado de textos SIGUE VIVO sin negocio: un texto entra con
    --     su ventana de gracia, así que el worker no lo toma de inmediato.
    --     Sin las comparaciones `is not distinct from` del agrupado, el
    --     debounce no vería dos mensajes del mismo cliente como del mismo
    --     stream y cada palabra suelta sería una respuesta pagada.
    if public.enqueue_webhook_event(
      null, 'ycloud', repeat('d', 64), repeat('e', 64),
      '{"version":1,"content":{"kind":"text","text":"hola"}}'::jsonb
    ) is not true then
      raise exception 'No se pudo encolar un texto del marketplace';
    end if;
    if exists (
      select 1 from public.webhook_inbound_events
      where business_id is null and message_id_hash = repeat('d', 64)
        and available_at <= now()
    ) then
      raise exception 'El texto del marketplace no esperó su ventana de agrupado';
    end if;

    -- 5. Y un negocio CON número propio sigue encolando como siempre, sin
    --    que el camino nuevo le haya cambiado nada.
    insert into public.businesses (slug, name, type, whatsapp_provider, whatsapp_number)
    values ('verificacion-plataforma', 'Local con número', 'pizzería', 'ycloud', '593200000123')
    returning id into v_neg_plat;

    if public.enqueue_webhook_event(
      v_neg_plat, 'ycloud', v_hash_a, v_stream,
      '{"version":1,"content":{"kind":"text","text":"hola"}}'::jsonb
    ) is not true then
      raise exception 'El mismo hash de otro negocio debería ser un mensaje distinto';
    end if;

    delete from public.businesses where id = v_neg_plat;
    delete from public.webhook_inbound_events where business_id is null;
    raise notice 'CANAL DE LA PLATAFORMA: encolado, deduplicación y FIFO verificados';
  end;

  -- ═══════════════════════════════════════════════════════════════════════
  -- LA HUELLA DEL COMPROBANTE
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- ⚠️ Necesita DOS negocios y varios pedidos: el caso que de verdad importa
  -- —un comprobante reutilizado en otro local— no se puede ver con una sola
  -- fila, y sobre una tabla vacía todo esto pasa solo.
  declare
    v_loc_a uuid; v_loc_b uuid;
    v_pa uuid; v_pa2 uuid; v_pb uuid;
    v_rec jsonb;
    v_huella text := repeat('a', 64);
    v_visual text := 'phash-de-prueba';
  begin
    insert into public.businesses (slug, name, type, whatsapp_provider)
    values ('verificacion-huella-a', 'Local A', 'pizzería', 'marketplace')
    returning id into v_loc_a;
    insert into public.businesses (slug, name, type, whatsapp_provider)
    values ('verificacion-huella-b', 'Local B', 'pizzería', 'marketplace')
    returning id into v_loc_b;

    insert into public.orders (business_id, contact_phone, status, subtotal, total)
    values (v_loc_a, '593990000001', 'esperando_pago', 10, 10) returning id into v_pa;
    insert into public.orders (business_id, contact_phone, status, subtotal, total)
    values (v_loc_a, '593990000001', 'esperando_pago', 20, 20) returning id into v_pa2;
    insert into public.orders (business_id, contact_phone, status, subtotal, total)
    values (v_loc_b, '593990000002', 'esperando_pago', 30, 30) returning id into v_pb;

    -- 1. El primero está limpio.
    v_rec := public.register_payment_receipt(v_loc_a, v_pa, 'https://x/1', 'p1', v_huella, v_visual);
    if (v_rec->>'duplicado')::boolean then
      raise exception 'El primer comprobante no puede salir como duplicado';
    end if;

    -- 2. El MISMO archivo en otro pedido del mismo local: se caza, y se dice
    --    en cuál se usó.
    v_rec := public.register_payment_receipt(v_loc_a, v_pa2, 'https://x/2', 'p2', v_huella, v_visual);
    if not (v_rec->>'duplicado')::boolean then
      raise exception 'No cazó el mismo archivo reutilizado en el mismo negocio';
    end if;
    if v_rec->>'pedido_previo' is null then
      raise exception 'Debería nombrar el pedido de ESTE negocio donde ya se usó';
    end if;

    -- 3. ⚠️ EL CASO QUE IMPORTA: el mismo comprobante en OTRO local. Se caza
    --    igual —es el fraude que más pesa— pero sin revelar nada del otro
    --    negocio: que exista basta para desconfiar, y el pedido ajeno no es
    --    asunto de este dueño.
    v_rec := public.register_payment_receipt(v_loc_b, v_pb, 'https://x/3', 'p3', v_huella, v_visual);
    if not (v_rec->>'duplicado')::boolean then
      raise exception 'No cazó el comprobante reutilizado en OTRO local';
    end if;
    if v_rec->>'pedido_previo' is not null then
      raise exception 'FUGA: le reveló al local B un pedido del local A';
    end if;

    -- 4. La señal queda escrita en la base, no solo en el código: si el
    --    análisis posterior falla o está apagado, el duplicado ya está marcado.
    if not exists (
      select 1 from public.payment_receipt_risk_flags
      where business_id = v_loc_b and severity = 'critica' and points > 0
    ) then
      raise exception 'No se registró la señal de duplicado';
    end if;

    -- 5. Un pedido de otro negocio no se puede colgar aquí.
    if (public.register_payment_receipt(
          v_loc_a, v_pb, 'https://x/4', 'p4', repeat('b', 64)
        )->>'result') <> 'not_found' then
      raise exception 'FUGA: aceptó colgar un comprobante de un pedido ajeno';
    end if;

    -- 6. Y la auditoría no se sobrescribe: una fila por comprobante.
    if (select count(*) from public.payment_receipt_audit_logs) <> 3 then
      raise exception 'La auditoría debería llevar una fila por comprobante';
    end if;

    -- ═════════════════════════════════════════════════════════════════════
    -- Y AHORA EL ANÁLISIS, sobre estos mismos comprobantes
    -- ═════════════════════════════════════════════════════════════════════
    --
    -- Va DENTRO de este bloque a propósito: necesita comprobantes ya
    -- registrados y, sobre todo, el del local A que salió DUPLICADO. Ese es
    -- el caso que no se puede ver de otra forma.
    declare
      v_r_limpio uuid;
      v_r_dup uuid;
      v_ana jsonb;
      v_lee jsonb;
      v_estado text;
      v_confirmado timestamptz;
    begin
      select id into v_r_limpio from public.payment_receipts
      where business_id = v_loc_a and order_id = v_pa;
      select id into v_r_dup from public.payment_receipts
      where business_id = v_loc_a and order_id = v_pa2;

      -- 7. Un comprobante que cuadra: las señales que RESTAN lo dejan en cero,
      --    nunca en negativo.
      v_ana := public.save_receipt_analysis(
        v_loc_a, v_r_limpio, 'analizado',
        jsonb_build_object(
          'bank_name', 'Banco Pichincha', 'sender_name', 'Ana Perez',
          'destination_account', '2100123456', 'amount', '10.00',
          'currency', 'USD', 'transaction_date', '2026-08-22',
          'reference_number', 'REF-1', 'ocr_raw_text', 'Transferencia exitosa'
        ),
        jsonb_build_array(
          jsonb_build_object('flag_type','monto_coincide','severity','baja','points',-10),
          jsonb_build_object('flag_type','cuenta_coincide','severity','baja','points',-10)
        ),
        jsonb_build_object('modelo', 'gpt-4o-mini')
      );
      if (v_ana->>'risk_score')::int <> 0 or v_ana->>'risk_level' <> 'bajo' then
        raise exception 'Un comprobante limpio no puede salir en % (%)',
          v_ana->>'risk_level', v_ana->>'risk_score';
      end if;

      -- 8. ⚠️ EL CASO QUE JUSTIFICA QUE EL SCORE SE SUME EN LA BASE: el
      --    duplicado ya traía 70 puntos escritos por `register_payment_receipt`
      --    ANTES de que el análisis existiera. Si el servidor mandara su propio
      --    total, esos puntos se perderían y un comprobante reutilizado podría
      --    salir «bajo» solo porque el monto cuadra —que es justo lo que hace
      --    quien reenvía el comprobante de otro pedido del mismo importe.
      v_ana := public.save_receipt_analysis(
        v_loc_a, v_r_dup, 'analizado',
        jsonb_build_object('bank_name', 'Banco Pichincha', 'amount', '20.00'),
        jsonb_build_array(
          jsonb_build_object('flag_type','monto_coincide','severity','baja','points',-10)
        ),
        null
      );
      if (v_ana->>'risk_score')::int <> 60 then
        raise exception 'El duplicado del registro debe contar en el score: salió %',
          v_ana->>'risk_score';
      end if;
      if v_ana->>'risk_level' <> 'alto' then
        raise exception 'Un comprobante reutilizado no puede quedar en nivel %',
          v_ana->>'risk_level';
      end if;

      -- 9. ⚠️ LO MÁS IMPORTANTE DE TODO EL MÓDULO: analizar NO confirma un
      --    pago. Ni mueve el pedido, ni marca `payment_confirmed_at`. Eso lo
      --    decide el dueño mirando su banco, nunca un modelo mirando una foto.
      select status, payment_confirmed_at into v_estado, v_confirmado
      from public.orders where id = v_pa;
      if v_estado <> 'esperando_pago' or v_confirmado is not null then
        raise exception 'FALLO GRAVE: el análisis tocó el pedido (estado %, pago %)',
          v_estado, v_confirmado;
      end if;

      -- 10. La basura de un modelo no puede tumbar el análisis. Una foto
      --     ruidosa devuelve cualquier cosa, y perder el análisis entero por
      --     un campo mal leído sería perder también las señales de riesgo.
      v_ana := public.save_receipt_analysis(
        v_loc_b, (select id from public.payment_receipts where business_id = v_loc_b),
        'analizado',
        jsonb_build_object(
          'bank_name', repeat('B', 300), 'transaction_date', '32/13/2026',
          'transaction_time', 'ayer', 'amount', 'un millón'
        ),
        jsonb_build_array(
          jsonb_build_object('flag_type','sin_referencia','severity','media','points',15),
          jsonb_build_object('flag_type','','points',99),
          '"no soy un objeto"'::jsonb
        ),
        null
      );
      if v_ana->>'result' <> 'saved' then
        raise exception 'La basura de un modelo tumbó el análisis: %', v_ana;
      end if;
      if (select transaction_date from public.payment_receipts where business_id = v_loc_b) is not null then
        raise exception 'Una fecha imposible tiene que quedar nula, no colarse';
      end if;

      -- 11. Un estado que diera un pago por bueno no se admite siquiera.
      begin
        perform public.save_receipt_analysis(v_loc_a, v_r_limpio, 'pagado', null, null, null);
        raise exception 'Aceptó dejar el comprobante en un estado que no existe';
      exception when sqlstate '22023' then null;
      end;

      -- 12. Un comprobante de otro negocio no se escribe ni se lee.
      if (public.save_receipt_analysis(v_loc_b, v_r_limpio, 'analizado', null, null, null)->>'result')
         <> 'not_found' then
        raise exception 'FUGA: el local B escribió sobre un comprobante del local A';
      end if;
      if (public.get_receipt_analysis(v_loc_b, v_pa)->>'result') <> 'sin_analisis' then
        raise exception 'FUGA: el local B leyó el comprobante del local A';
      end if;

      -- 13. Y lo que el dueño SÍ ve: su comprobante con sus señales.
      v_lee := public.get_receipt_analysis(v_loc_a, v_pa2);
      if v_lee->>'risk_score' <> '60' then
        raise exception 'La lectura del panel no trae el score';
      end if;
      if jsonb_array_length(v_lee->'flags') < 2 then
        raise exception 'La lectura del panel no trae las señales que explican el score';
      end if;

      -- 14. La referencia repetida: el duplicado que la HUELLA no puede ver.
      --     Quien reenvía el mismo pago recortado cambia el SHA y hasta el
      --     perceptual, pero el número del banco sigue siendo el mismo.
      --     ⚠️ Se busca en toda la plataforma, y la señal no nombra al otro
      --     negocio — el mismo criterio que la huella.
      v_ana := public.save_receipt_analysis(
        v_loc_a, v_r_limpio, 'analizado',
        jsonb_build_object('reference_number', 'REF-REPETIDA-1'),
        null, null, 60
      );
      if exists (
        select 1 from public.payment_receipt_risk_flags
        where receipt_id = v_r_limpio and flag_type = 'referencia_duplicada'
      ) then
        raise exception 'La primera vez que se ve una referencia no es un duplicado';
      end if;

      v_ana := public.save_receipt_analysis(
        v_loc_a, v_r_dup, 'analizado',
        jsonb_build_object('reference_number', 'REF-REPETIDA-1'),
        null, null, 60
      );
      if not exists (
        select 1 from public.payment_receipt_risk_flags
        where receipt_id = v_r_dup and flag_type = 'referencia_duplicada'
      ) then
        raise exception 'No cazó la misma referencia bancaria en otro pedido';
      end if;

      -- 15. Y con los puntos a cero la señal se APAGA: el dueño puede
      --     desactivar una regla desde Ajustes sin que aparezca como ruido.
      perform public.save_receipt_analysis(
        v_loc_b, (select id from public.payment_receipts where business_id = v_loc_b),
        'analizado', jsonb_build_object('reference_number', 'REF-REPETIDA-1'),
        null, null, 0
      );
      if exists (
        select 1 from public.payment_receipt_risk_flags f
        join public.payment_receipts r on r.id = f.receipt_id
        where r.business_id = v_loc_b and f.flag_type = 'referencia_duplicada'
      ) then
        raise exception 'Con la regla en cero no debería escribirse la señal';
      end if;

      raise notice 'ANÁLISIS DEL COMPROBANTE: score, aislamiento y «no confirma pagos» verificados';
    end;

    delete from public.businesses where id in (v_loc_a, v_loc_b);
    raise notice 'HUELLA DEL COMPROBANTE: duplicados, aislamiento y auditoría verificados';
  end;

  -- ═══════════════════════════════════════════════════════════════════════
  -- EL NÚMERO DE LA PLATAFORMA NO SE LO PUEDE QUEDAR UN LOCAL
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- ⚠️ Nace de un fallo REAL del 2026-08-22: escribir al número de Umbani
  -- contestaba con la mini app de Monster Pizza en vez de las categorías,
  -- porque ese local tenía el MISMO número. `resolveBusinessChannel` corre
  -- antes que la rama del marketplace, así que el local ganaba y todo lo
  -- construido para el número único era inalcanzable.
  --
  -- Ninguna prueba lo cazó porque no había nada roto que cazar: el código
  -- hacía lo que se le pidió y era la CONFIGURACIÓN la que había quedado de
  -- la etapa anterior. Por eso la defensa está en la base.
  declare
    v_neg uuid;
  begin
    insert into public.server_settings (key, value)
    values ('platform_ycloud_number', '+593991716574')
    on conflict (key) do update set value = excluded.value;

    insert into public.businesses (slug, name, type, whatsapp_provider)
    values ('verificacion-plataforma-numero', 'Local', 'pizzería', 'marketplace')
    returning id into v_neg;

    -- 1. El caso exacto que ocurrió.
    begin
      update public.businesses set whatsapp_provider = 'ycloud',
             ycloud_number = '+593991716574' where id = v_neg;
      raise exception 'Un local se quedó con el número del marketplace';
    exception when sqlstate '23514' then null;
    end;

    -- 2. Y escrito sin el «+», que es como lo guarda la tabla de
    --    identificadores: comparar en crudo dejaría pasar justo este.
    begin
      update public.businesses set whatsapp_provider = 'ycloud',
             whatsapp_number = '593991716574' where id = v_neg;
      raise exception 'Se coló el número del marketplace escrito sin el «+»';
    exception when sqlstate '23514' then null;
    end;

    -- 3. Un local NUEVO tampoco puede nacer con él.
    begin
      insert into public.businesses (slug, name, type, whatsapp_provider, whatsapp_number)
      values ('verificacion-plataforma-2', 'Otro', 'pizzería', 'ycloud', '+593 99 171 6574');
      raise exception 'Un local nuevo nació con el número del marketplace';
    exception when sqlstate '23514' then null;
    end;

    -- 4. ⚠️ Y NO estorba a un número distinto: una guarda que impidiera
    --    configurar cualquier canal sería peor que el fallo que evita.
    update public.businesses set whatsapp_provider = 'ycloud',
           whatsapp_number = '+593999888777', ycloud_number = '+593999888777'
     where id = v_neg;

    delete from public.businesses where id = v_neg;
    delete from public.server_settings where key = 'platform_ycloud_number';
    raise notice 'NÚMERO DE LA PLATAFORMA: ningún local se lo puede quedar';
  end;

  -- ═══════════════════════════════════════════════════════════════════════
  -- EL LOTE DE UN MENSAJE SIN LOCAL SE PUEDE CERRAR
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- ⚠️ Fallo REAL del 2026-08-23 que dejó al marketplace mudo. El `update`
  -- final de `complete_webhook_event` y `fail_webhook_event` comparaba
  -- `event.business_id = v_head.business_id`, y en un mensaje al número de la
  -- plataforma los dos lados son NULL: **`NULL = NULL` no es verdadero**. El
  -- `where` no casaba ninguna fila y la función LANZABA «El lote del webhook
  -- cambió durante su finalización».
  --
  -- Un evento del marketplace con lote no podía completarse NI marcarse
  -- fallido: se reintentaba —reprocesando, así que el cliente recibía la misma
  -- respuesta cada tres minutos— hasta morir. Y la cola es FIFO por
  -- conversación, así que sus mensajes siguientes esperaban detrás.
  declare
    v_lote_id uuid;
    v_lote_token uuid;
    v_ok boolean;
  begin
    delete from public.webhook_inbound_events where message_id_hash = repeat('9', 64);

    if public.enqueue_webhook_event(
      null, 'ycloud', repeat('9', 64), repeat('8', 64),
      -- ⚠️ El payload lleva `inboundId` a propósito: `lease_webhook_events`
      -- arma el suyo con `jsonb_set(..., to_jsonb(v_latest_inbound_id))`, y
      -- `jsonb_set` es ESTRICTA — con un nulo devuelve NULL y anularía el
      -- payload entero. Los payloads reales siempre lo traen (lo exige
      -- `parseInboundWebhookPayload`), así que esto solo reproduce el caso
      -- real en vez de uno imposible.
      '{"version":1,"from":"+593990978367","provider":"ycloud","inboundId":"lote-1","businessId":null,"content":{"kind":"text","text":"hola"}}'::jsonb
    ) is not true then
      raise exception 'No se pudo encolar el mensaje sin local';
    end if;

    update public.webhook_inbound_events
       set available_at = now() - interval '1 minute'
     where message_id_hash = repeat('9', 64);

    select id, lease_token into v_lote_id, v_lote_token
    from public.lease_webhook_events('verificacion-lote', 1, 180);
    if v_lote_id is null then
      raise exception 'No se pudo reservar el mensaje sin local';
    end if;

    -- ⚠️ EL CASO: con lote y sin local, esto lanzaba «El lote del webhook
    -- cambió durante su finalización» en vez de completar.
    v_ok := public.complete_webhook_event(v_lote_id, v_lote_token);
    if v_ok is not true then
      raise exception 'Un mensaje SIN LOCAL no se pudo completar (devolvió %)', v_ok;
    end if;
    if (select status from public.webhook_inbound_events where id = v_lote_id)
       <> 'completed' then
      raise exception 'El evento sin local no quedó completado';
    end if;

    -- Y lo mismo con el camino del FALLO, que tenía el mismo predicado.
    delete from public.webhook_inbound_events where message_id_hash = repeat('7', 64);
    perform public.enqueue_webhook_event(
      null, 'ycloud', repeat('7', 64), repeat('6', 64),
      '{"version":1,"from":"+593990978367","provider":"ycloud","inboundId":"lote-2","businessId":null,"content":{"kind":"text","text":"hola"}}'::jsonb
    );
    update public.webhook_inbound_events
       set available_at = now() - interval '1 minute'
     where message_id_hash = repeat('7', 64);
    select id, lease_token into v_lote_id, v_lote_token
    from public.lease_webhook_events('verificacion-lote-fallo', 1, 180);
    if public.fail_webhook_event(v_lote_id, v_lote_token, 'prueba', 10) is null then
      raise exception 'Un mensaje SIN LOCAL no pudo marcarse como fallido';
    end if;

    delete from public.webhook_inbound_events
     where message_id_hash in (repeat('9', 64), repeat('7', 64));
    raise notice 'LOTE SIN LOCAL: se completa y se puede marcar fallido';
  end;

  raise notice 'VERIFICACIÓN DEL ESQUEMA: todas las comprobaciones pasaron';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- LA PLANTILLA DEL TIPO DE NEGOCIO
-- ═══════════════════════════════════════════════════════════════════════════
-- Va en su propio bloque porque necesita negocios RECIÉN creados: el de arriba
-- ya tiene catálogo, y el portón de la función —que es justo lo que hay que
-- comprobar— lo rechazaría por el motivo correcto, dando un falso verde.
do $plantillas$
declare
  v_limpio uuid; v_ocupado uuid;
  v_resultado jsonb;
  v_plantilla jsonb := jsonb_build_object('categorias', jsonb_build_array(
    jsonb_build_object(
      'nombre', 'Hamburguesas', 'orden', 0,
      'grupos', jsonb_build_array(
        jsonb_build_object(
          'nombre', 'Término de la carne', 'tipo', 'single',
          'obligatorio', true, 'min', 1, 'max', 1,
          'opciones', jsonb_build_array(
            jsonb_build_object('nombre', 'Tres cuartos'),
            jsonb_build_object('nombre', 'Bien cocida')
          )
        ),
        jsonb_build_object(
          'nombre', 'Extras', 'tipo', 'multiple', 'max', 6,
          'opciones', jsonb_build_array(
            jsonb_build_object('nombre', 'Tocino', 'recargo', 1)
          )
        )
      )
    ),
    jsonb_build_object('nombre', 'Bebidas', 'orden', 1)
  ));
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('verif-plantilla-limpio', 'Limpio', 'hamburguesería', 'ycloud',
    '+593900888001', '+593900888001', true)
  returning id into v_limpio;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('verif-plantilla-ocupado', 'Ocupado', 'hamburguesería', 'ycloud',
    '+593900888002', '+593900888002', true)
  returning id into v_ocupado;

  v_resultado := public.apply_business_template(v_limpio, v_plantilla);
  if (v_resultado->>'aplicada')::boolean is not true
     or (v_resultado->>'categorias')::integer <> 2
     or (v_resultado->>'grupos')::integer <> 2
     or (v_resultado->>'opciones')::integer <> 3 then
    raise exception 'apply_business_template no cargó la plantilla: %', v_resultado;
  end if;

  -- Lo que hace útil a la plantilla: el grupo existe SIN productos todavía, y
  -- conserva su obligatoriedad y su recargo.
  if not exists (
    select 1 from option_groups
    where business_id = v_limpio and product_id is null and category_id is not null
      and name = 'Término de la carne' and required and min_selectable = 1
  ) then
    raise exception 'el grupo obligatorio de la plantilla no quedó bien colgado';
  end if;
  if not exists (
    select 1 from options o
    join option_groups og on og.id = o.option_group_id
    where og.business_id = v_limpio and o.name = 'Tocino' and o.price_adjustment = 1
  ) then
    raise exception 'la plantilla perdió el recargo de una opción';
  end if;

  -- El portón: sobre un negocio con catálogo no toca nada.
  insert into product_categories (business_id, name) values (v_ocupado, 'Ya existía');
  v_resultado := public.apply_business_template(v_ocupado, v_plantilla);
  if (v_resultado->>'aplicada')::boolean is not false
     or (select count(*) from product_categories where business_id = v_ocupado) <> 1 then
    raise exception 'apply_business_template pisó un negocio con catálogo: %', v_resultado;
  end if;

  -- Y un negocio inexistente se rechaza en vez de sembrar filas sueltas.
  begin
    perform public.apply_business_template(gen_random_uuid(), v_plantilla);
    raise exception 'apply_business_template aceptó un negocio inexistente';
  exception when insufficient_privilege then null;
  end;

  delete from businesses where id in (v_limpio, v_ocupado);
  raise notice 'PLANTILLAS DE NEGOCIO: carga, portón y negocio inexistente comprobados';
end;
$plantillas$;

-- ═══════════════════════════════════════════════════════════════════════════
-- LA CARTA DEL LOCAL: precios de verdad, tamaños en SU producto y el portón
-- ═══════════════════════════════════════════════════════════════════════════
-- La IA lee la carta en el superadmin, una persona la revisa y el alta la
-- carga con `apply_business_menu` en vez de los productos de ejemplo. Lo que
-- no puede fallar: que nazca a la venta (la plantilla deja todo agotado), que
-- cada tamaño cuelgue del producto correcto, y que nunca pise un catálogo.
do $carta$
declare
  v_limpio uuid; v_ocupado uuid;
  v_resultado jsonb;
  v_carta jsonb := jsonb_build_object('categorias', jsonb_build_array(
    jsonb_build_object(
      'nombre', 'Pizzas', 'orden', 0,
      'productos', jsonb_build_array(
        jsonb_build_object('nombre', 'Hawaiana', 'precio', 5.99, 'tipo', 'simple',
          'variantes', jsonb_build_array(
            jsonb_build_object('nombre', 'Personal', 'precio', 5.99, 'orden', 0),
            jsonb_build_object('nombre', 'Mediana', 'precio', 11.99, 'orden', 1)
          )),
        jsonb_build_object('nombre', 'Pepperoni', 'precio', 6.50, 'tipo', 'simple')
      )
    ),
    jsonb_build_object(
      'nombre', 'Almuerzos', 'orden', 1,
      'productos', jsonb_build_array(
        jsonb_build_object('nombre', 'Almuerzo', 'precio', 3, 'tipo', 'configurable',
          'grupos', jsonb_build_array(jsonb_build_object(
            'nombre', 'Sopas', 'tipo', 'single', 'obligatorio', true, 'min', 1, 'max', 1,
            'opciones', jsonb_build_array(
              jsonb_build_object('nombre', 'Caldo de hueso de res'),
              jsonb_build_object('nombre', 'Crema de zapallo')
            )
          )))
      )
    )
  ));
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('verif-carta-limpio', 'Carta limpia', 'pizzería', 'ycloud',
    '+593900777001', '+593900777001', true)
  returning id into v_limpio;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('verif-carta-ocupado', 'Carta ocupada', 'pizzería', 'ycloud',
    '+593900777002', '+593900777002', true)
  returning id into v_ocupado;

  v_resultado := public.apply_business_menu(v_limpio, v_carta);
  if (v_resultado->>'aplicada')::boolean is not true
     or (v_resultado->>'productos')::integer <> 3
     or (v_resultado->>'variantes')::integer <> 2
     or (v_resultado->>'opciones')::integer <> 2 then
    raise exception 'apply_business_menu no cargó la carta: %', v_resultado;
  end if;

  -- Precios de verdad: a la venta, no agotados como los de ejemplo.
  if exists (select 1 from products where business_id = v_limpio and stock <> 'disponible') then
    raise exception 'la carta dejó productos agotados como si fueran de ejemplo';
  end if;

  -- Cada tamaño en SU producto, con su precio.
  if (select count(*) from product_variants pv
      join products p on p.id = pv.product_id
      where pv.business_id = v_limpio and p.name = 'Hawaiana'
        and ((pv.name = 'Personal' and pv.price = 5.99)
          or (pv.name = 'Mediana' and pv.price = 11.99))) <> 2
     or exists (select 1 from product_variants pv join products p on p.id = pv.product_id
                where pv.business_id = v_limpio and p.name <> 'Hawaiana') then
    raise exception 'los tamaños de la carta no quedaron en su producto';
  end if;

  -- El portón: sobre un negocio con catálogo no toca nada, tampoco el stock.
  insert into product_categories (business_id, name) values (v_ocupado, 'Ya existía');
  insert into products (business_id, name, price, stock)
  values (v_ocupado, 'De antes', 1, 'agotado');
  v_resultado := public.apply_business_menu(v_ocupado, v_carta);
  if (v_resultado->>'aplicada')::boolean is not false
     or (select count(*) from products where business_id = v_ocupado) <> 1
     or (select stock from products where business_id = v_ocupado) <> 'agotado'
     or exists (select 1 from product_variants where business_id = v_ocupado) then
    raise exception 'apply_business_menu pisó un negocio con catálogo: %', v_resultado;
  end if;

  -- Nombres repetidos: un tamaño no puede acabar en el producto equivocado.
  begin
    perform public.apply_business_menu(v_ocupado, jsonb_build_object('categorias',
      jsonb_build_array(jsonb_build_object('nombre', 'Pizzas'),
                        jsonb_build_object('nombre', ' pizzas '))));
    raise exception 'apply_business_menu aceptó una categoría repetida';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.apply_business_menu(v_ocupado, jsonb_build_object('categorias',
      jsonb_build_array(jsonb_build_object('nombre', 'Pizzas', 'productos', jsonb_build_array(
        jsonb_build_object('nombre', 'Hawaiana', 'precio', 1),
        jsonb_build_object('nombre', 'hawaiana', 'precio', 2))))));
    raise exception 'apply_business_menu aceptó un producto repetido';
  exception when invalid_parameter_value then null;
  end;

  -- Y un negocio inexistente se rechaza, como en la plantilla.
  begin
    perform public.apply_business_menu(gen_random_uuid(), v_carta);
    raise exception 'apply_business_menu aceptó un negocio inexistente';
  exception when insufficient_privilege then null;
  end;

  delete from businesses where id in (v_limpio, v_ocupado);
  raise notice 'CARTA DEL LOCAL: carga a la venta, tamaños, portón y repetidos comprobados';
end;
$carta$;

-- ═══════════════════════════════════════════════════════════════════════════
-- CADA LOCAL NACE ARMADO: producto de ejemplo, parte del plato y listas
-- ═══════════════════════════════════════════════════════════════════════════
-- La plantilla vieja solo sabía colgar grupos de la CATEGORÍA, y una parte del
-- plato no puede vivir ahí (`option_groups_parte_del_plato_check`). Un local de
-- almuerzos nacía, así, sin forma de tener el plato por partes que usa La
-- Abuelita, y acababa con dos juegos de grupos.
do $armado$
declare
  v_armado uuid; v_roto uuid; v_con_lista uuid;
  v_resultado jsonb;
  v_plantilla jsonb := jsonb_build_object(
    'listas', jsonb_build_array(jsonb_build_object(
      'nombre', 'Sabores',
      'opciones', jsonb_build_array(
        jsonb_build_object('nombre', 'Hawaiana', 'orden', 0),
        jsonb_build_object('nombre', 'Mexicana', 'recargo', 1, 'orden', 1)
      )
    )),
    'categorias', jsonb_build_array(
      jsonb_build_object(
        'nombre', 'Almuerzos', 'orden', 0,
        'productos', jsonb_build_array(jsonb_build_object(
          'nombre', 'Almuerzo del día', 'precio', 3.5, 'tipo', 'daily_menu',
          'descripcion', 'Ejemplo', 'orden', 0,
          'grupos', jsonb_build_array(
            jsonb_build_object(
              'nombre', 'Sopa', 'tipo', 'quantity', 'obligatorio', true,
              'min', 1, 'max', 100, 'cobro', 'included', 'parte', true,
              'precioSuelto', 1.5, 'orden', 0,
              'opciones', jsonb_build_array(jsonb_build_object('nombre', 'Caldo'))
            ),
            jsonb_build_object(
              'nombre', 'Bebida', 'tipo', 'quantity', 'obligatorio', true,
              'min', 1, 'max', 100, 'cobro', 'included', 'orden', 1,
              'opciones', jsonb_build_array(jsonb_build_object('nombre', 'Jugo'))
            )
          )
        ))
      ),
      jsonb_build_object(
        'nombre', 'Combos', 'orden', 1,
        'productos', jsonb_build_array(jsonb_build_object(
          'nombre', 'Combo pareja', 'precio', 12, 'tipo', 'combo', 'orden', 0,
          'grupos', jsonb_build_array(
            jsonb_build_object(
              'nombre', 'Sabor de la 1.ª pizza', 'tipo', 'single',
              'obligatorio', true, 'min', 1, 'max', 1, 'lista', 'Sabores', 'orden', 0,
              'descripcion', 'Elige de la lista'
            ),
            jsonb_build_object(
              'nombre', 'Sabor de la 2.ª pizza', 'tipo', 'single',
              'obligatorio', true, 'min', 1, 'max', 1, 'lista', 'Sabores', 'orden', 1
            )
          )
        ))
      )
    )
  );
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('verif-armado', 'Armado', 'pizzería', 'ycloud',
    '+593900888011', '+593900888011', true)
  returning id into v_armado;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('verif-armado-roto', 'Roto', 'pizzería', 'ycloud',
    '+593900888012', '+593900888012', true)
  returning id into v_roto;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('verif-armado-lista', 'Con lista', 'pizzería', 'ycloud',
    '+593900888013', '+593900888013', true)
  returning id into v_con_lista;

  v_resultado := public.apply_business_template(v_armado, v_plantilla);
  -- 2 categorías, 1 lista, 2 productos, 4 grupos; opciones = Caldo + Jugo +
  -- dos copias de la lista en cada paso del combo.
  if (v_resultado->>'aplicada')::boolean is not true
     or (v_resultado->>'categorias')::integer <> 2
     or (v_resultado->>'listas')::integer <> 1
     or (v_resultado->>'productos')::integer <> 2
     or (v_resultado->>'grupos')::integer <> 4
     or (v_resultado->>'opciones')::integer <> 6 then
    raise exception 'la plantilla armada no cargó lo que trae: %', v_resultado;
  end if;

  -- ⚠️ Un producto de ejemplo NACE AGOTADO, lo diga o no la plantilla: su
  -- precio es inventado, y un local recién abierto no puede venderlo.
  if exists (
    select 1 from products where business_id = v_armado and stock <> 'agotado'
  ) then
    raise exception 'un producto de ejemplo nació a la venta';
  end if;
  -- Y ACTIVO: aquí inactivo es BORRADO, y el panel no se lo enseñaría al dueño.
  if exists (select 1 from products where business_id = v_armado and not active) then
    raise exception 'un producto de ejemplo nació borrado: su dueño no lo vería';
  end if;
  if not exists (
    select 1 from products
    where business_id = v_armado and name = 'Almuerzo del día'
      and price = 3.5 and product_type = 'daily_menu' and description = 'Ejemplo'
  ) then
    raise exception 'el producto de ejemplo perdió su precio, tipo o descripción';
  end if;

  -- La parte del plato cuelga del PRODUCTO, con su precio suelto y gratis.
  if not exists (
    select 1 from option_groups g
    join products p on p.id = g.product_id
    where g.business_id = v_armado and p.name = 'Almuerzo del día'
      and g.name = 'Sopa' and g.category_id is null and g.is_meal_part
      and g.loose_price = 1.5 and g.pricing_strategy = 'included'
      and g.selection_type = 'quantity' and g.required and g.max_selectable = 100
  ) then
    raise exception 'la parte del plato no quedó colgada del producto';
  end if;
  if exists (
    select 1 from option_groups
    where business_id = v_armado and name = 'Bebida' and is_meal_part
  ) then
    raise exception 'la bebida gratis quedó como parte del plato';
  end if;

  -- Cada paso del combo enlazado a la MISMA lista, con sus copias y su recargo.
  if (
    select count(*) from options o
    join option_groups g on g.id = o.option_group_id
    join option_templates t on t.id = g.option_template_id
    where g.business_id = v_armado and t.name = 'Sabores'
      and o.option_template_item_id is not null
  ) <> 4 then
    raise exception 'los pasos del combo no heredaron la lista de sabores';
  end if;
  if not exists (
    select 1 from options o
    join option_groups g on g.id = o.option_group_id
    where g.business_id = v_armado and g.name = 'Sabor de la 2.ª pizza'
      and o.name = 'Mexicana' and o.price_adjustment = 1
  ) then
    raise exception 'la copia de la lista perdió el recargo';
  end if;
  if not exists (
    select 1 from option_groups
    where business_id = v_armado and name = 'Sabor de la 1.ª pizza'
      and description = 'Elige de la lista' and sort = 0
  ) then
    raise exception 'el grupo perdió su descripción o su orden';
  end if;

  -- Una lista que la plantilla no trae es un error de la plantilla: se rechaza
  -- ENTERA en vez de dejar un combo con un paso vacío.
  begin
    perform public.apply_business_template(v_roto, jsonb_build_object(
      'categorias', jsonb_build_array(jsonb_build_object(
        'nombre', 'Combos',
        'productos', jsonb_build_array(jsonb_build_object(
          'nombre', 'Combo', 'precio', 10,
          'grupos', jsonb_build_array(jsonb_build_object(
            'nombre', 'Sabor', 'tipo', 'single', 'obligatorio', true,
            'min', 1, 'max', 1, 'lista', 'No existe'
          ))
        ))
      ))
    ));
    raise exception 'la plantilla aceptó enlazar una lista que no trae';
  exception when invalid_parameter_value then null;
  end;
  if exists (select 1 from product_categories where business_id = v_roto)
     or exists (select 1 from products where business_id = v_roto) then
    raise exception 'la plantilla rota dejó filas a medias';
  end if;

  -- El portón también mira las listas: quien ya armó una tomó decisiones.
  insert into option_templates (business_id, name) values (v_con_lista, 'Mía');
  v_resultado := public.apply_business_template(v_con_lista, v_plantilla);
  if (v_resultado->>'aplicada')::boolean is not false
     or exists (select 1 from product_categories where business_id = v_con_lista) then
    raise exception 'la plantilla pisó un negocio que ya tenía listas: %', v_resultado;
  end if;

  delete from businesses where id in (v_armado, v_roto, v_con_lista);
  raise notice 'LOCAL ARMADO: ejemplo agotado y visible, parte del plato, listas y portón comprobados';
end;
$armado$;

-- ═══════════════════════════════════════════════════════════════════════════
-- UN LOCAL VIVE EN VARIOS CAJONES DEL MENÚ
-- ═══════════════════════════════════════════════════════════════════════════
-- Hasta el 2026-09-17 el cajón salía del TIPO, y el tipo es uno: un local de
-- comida típica que sirve almuerzo al mediodía y carta de noche solo aparecía
-- bajo «Almuerzos». A las 7 de la noche el cliente leía ese botón y se iba
-- creyendo que no había nada para él.
do $cajones$
declare
  v_tipica uuid; v_solo_tipo uuid;
  v_almuerzos uuid; v_restaurantes uuid;
  v_codigos text[];
begin
  select id into v_almuerzos from marketplace_categories where code = 'almuerzos';
  select id into v_restaurantes from marketplace_categories where code = 'restaurantes';
  if v_restaurantes is null then
    raise exception 'falta el cajón «restaurantes»: el de noche no tiene dónde entrar';
  end if;

  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders, storefront_enabled)
  values ('verif-cajones-tipica', 'Doña Rosa', 'comida típica', 'ycloud',
    '+593900999001', '+593900999001', true, true)
  returning id into v_tipica;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders, storefront_enabled)
  values ('verif-cajones-solo-tipo', 'Sin elegir', 'pizzería', 'ycloud',
    '+593900999002', '+593900999002', true, true)
  returning id into v_solo_tipo;

  -- ── 1. Sin filas propias manda el TIPO, como siempre ──────────────────────
  -- Es lo que mantiene vivos a los locales de antes: nadie tuvo que elegir.
  select array_agg(code order by code) into v_codigos
  from marketplace_negocios_de_categoria('pizzerias') n
  join marketplace_categories c on c.code = 'pizzerias'
  where n.id = v_solo_tipo;
  if v_codigos is null then
    raise exception 'un local sin cajones elegidos desapareció del menú';
  end if;

  -- ── 2. Con filas propias, el local vive en TODOS sus cajones ──────────────
  insert into business_marketplace_categories (business_id, category_id, principal)
  values (v_tipica, v_restaurantes, true), (v_tipica, v_almuerzos, false);

  if not exists (select 1 from marketplace_negocios_de_categoria('restaurantes') where id = v_tipica) then
    raise exception 'el local no salió en su cajón principal';
  end if;
  if not exists (select 1 from marketplace_negocios_de_categoria('almuerzos') where id = v_tipica) then
    raise exception 'el local no salió en su cajón secundario';
  end if;

  -- ⚠️ Y los cajones elegidos GANAN al tipo: si además apareciera por su tipo
  -- saldría en un cajón que su dueño no eligió.
  select array_agg(code order by code) into v_codigos
  from marketplace_categories_disponibles() where locales > 0;
  if not (v_codigos @> array['almuerzos', 'restaurantes']) then
    raise exception 'el menú no ofrece los dos cajones: %', v_codigos;
  end if;

  -- ── 3. Cada cajón cuenta al local UNA vez ─────────────────────────────────
  if (select locales from marketplace_categories_disponibles() where code = 'restaurantes') <> 1 then
    raise exception 'el local se contó más de una vez en su cajón';
  end if;

  -- ── 4. Tres cajones como mucho ────────────────────────────────────────────
  -- Un local en ocho cajones es ruido: el cliente deja de fiarse del menú.
  begin
    insert into business_marketplace_categories (business_id, category_id)
    select v_tipica, id from marketplace_categories
    where code in ('desayunos', 'asados') order by code;
    raise exception 'la base aceptó más de tres cajones para un local';
  exception when check_violation or raise_exception then null;
  end;

  -- ── 5. Un solo principal ──────────────────────────────────────────────────
  begin
    insert into business_marketplace_categories (business_id, category_id, principal)
    values (v_tipica, (select id from marketplace_categories where code = 'desayunos'), true);
    raise exception 'la base aceptó dos cajones principales';
  exception when unique_violation then null;
  end;

  -- ── 6. El panel los guarda de una vez, y valida ───────────────────────────
  if public.set_business_marketplace_categories(
       v_tipica, array['almuerzos', 'desayunos'], 'desayunos') <> 2 then
    raise exception 'la RPC no guardó los dos cajones';
  end if;
  if not exists (
    select 1 from business_marketplace_categories bc
    join marketplace_categories c on c.id = bc.category_id
    where bc.business_id = v_tipica and c.code = 'desayunos' and bc.principal
  ) then
    raise exception 'la RPC no dejó el principal donde se pidió';
  end if;
  -- Reemplaza, no suma: el cajón anterior se fue.
  if exists (
    select 1 from business_marketplace_categories bc
    join marketplace_categories c on c.id = bc.category_id
    where bc.business_id = v_tipica and c.code = 'restaurantes'
  ) then
    raise exception 'la RPC dejó un cajón viejo dentro';
  end if;

  begin
    perform public.set_business_marketplace_categories(
      v_tipica, array['almuerzos', 'desayunos', 'asados', 'pizzerias']);
    raise exception 'la RPC aceptó cuatro cajones';
  exception when check_violation then null;
  end;
  begin
    perform public.set_business_marketplace_categories(v_tipica, array['inventado']);
    raise exception 'la RPC aceptó un cajón que no existe';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.set_business_marketplace_categories(
      v_tipica, array['almuerzos'], 'pizzerias');
    raise exception 'la RPC aceptó un principal fuera de la lista';
  exception when invalid_parameter_value then null;
  end;

  -- Vaciar es una decisión válida: vuelve a mandar el tipo.
  perform public.set_business_marketplace_categories(v_tipica, array[]::text[]);
  if not exists (select 1 from marketplace_negocios_de_categoria('restaurantes') where id = v_tipica) then
    raise exception 'al vaciar sus cajones, el local no volvió al de su tipo';
  end if;

  -- ── 7. Lo que lee el PANEL: la base resuelve la regla entera ──────────────
  perform public.set_business_marketplace_categories(
    v_tipica, array['restaurantes', 'almuerzos'], 'restaurantes');
  if (select array_agg(code order by principal desc, code)
        from public.marketplace_cajones_del_negocio(v_tipica))
     <> array['restaurantes', 'almuerzos'] then
    raise exception 'el panel no leería los cajones elegidos, ni en ese orden';
  end if;
  -- Y para quien no eligió, los de su tipo: es lo que el panel tiene que
  -- enseñar en vez de «sin elegir» a un local que sí aparece en el menú.
  if (select count(*) from public.marketplace_cajones_del_negocio(v_solo_tipo)) <> 1 then
    raise exception 'el panel no leería el cajón que da el tipo';
  end if;

  -- ── 8. Borrar el local se lleva sus cajones ───────────────────────────────
  delete from businesses where id in (v_tipica, v_solo_tipo);
  if exists (select 1 from business_marketplace_categories where business_id = v_tipica) then
    raise exception 'los cajones sobrevivieron al local';
  end if;

  raise notice 'CAJONES DEL MENÚ: tipo por defecto, varios cajones, tope de 3 y un solo principal';
end;
$cajones$;

-- ═══════════════════════════════════════════════════════════════════════════
-- MENÚS CON RELOJ: UN PRODUCTO SE PIDE EN SU FRANJA
-- ═══════════════════════════════════════════════════════════════════════════
-- El local no cambia con la hora: cambia su carta. Un restaurante que sirve
-- desayuno, almuerzo y cena es UN local con tres franjas, que es como lo
-- resuelven las apps grandes. Las tres columnas existían desde hacía meses
-- (`available_days`, `available_from`, `available_until`) y NO LAS LEÍA NADIE.
do $reloj$
declare
  v_business uuid;
  v_ahora    uuid;
  v_luego    uuid;
  -- Un lunes a las 08:00, ese lunes a la 01:00 de la tarde y la 01:00 de la
  -- madrugada del martes, todo en hora de Ecuador.
  v_lunes_8  timestamptz := '2026-09-14 13:00:00+00';
  v_lunes_13 timestamptz := '2026-09-14 18:00:00+00';
  v_martes_1 timestamptz := '2026-09-15 06:00:00+00';
  -- Y la hora local de AHORA, para las franjas del pedido: `now()` no se puede
  -- congelar dentro de una transacción, así que las franjas se calculan desde
  -- ella. ⚠️ La RPC del pedido NO recibe la hora por parámetro a propósito:
  -- añadirle uno crearía una segunda versión viva de la función.
  v_local    time := (timezone('America/Guayaquil', now()))::time;
begin
  -- ── La regla, caso por caso, con fechas fijas ─────────────────────────────
  -- Sin franja no hay límite: es como vivieron todos los productos hasta hoy.
  if not public.producto_en_horario(null, null, null, v_lunes_8) then
    raise exception 'un producto sin franja dejó de poder pedirse';
  end if;
  if not public.producto_en_horario(null, '07:00', '11:00', v_lunes_8) then
    raise exception 'el desayuno no se podía pedir a las 08:00';
  end if;
  if public.producto_en_horario(null, '07:00', '11:00', v_lunes_13) then
    raise exception 'el desayuno se pudo pedir a la 1 de la tarde';
  end if;
  -- El día también cuenta (0 = domingo, como en la app).
  if public.producto_en_horario(array[2,3]::smallint[], '07:00', '11:00', v_lunes_8) then
    raise exception 'un producto de martes y miércoles se pudo pedir un lunes';
  end if;
  if not public.producto_en_horario(array[1,2]::smallint[], '07:00', '11:00', v_lunes_8) then
    raise exception 'un producto de lunes no se pudo pedir el lunes';
  end if;

  -- ⚠️ La franja que CRUZA MEDIANOCHE es la que se hace mal sola: una carta de
  -- noche de 18:00 a 02:00 sigue viva a la 01:00, y ese momento pertenece al
  -- día que EMPEZÓ, no al que amaneció. Es la misma regla que el horario del
  -- local, y por eso se contesta igual.
  if not public.producto_en_horario(null, '18:00', '02:00', v_martes_1) then
    raise exception 'la carta de noche murió al pasar la medianoche';
  end if;
  if not public.producto_en_horario(array[1]::smallint[], '18:00', '02:00', v_martes_1) then
    raise exception 'la carta del LUNES por la noche no llegó a la 1 del martes';
  end if;
  if public.producto_en_horario(array[2]::smallint[], '18:00', '02:00', v_martes_1) then
    raise exception 'la carta del martes se pudo pedir a la 1 del martes, antes de abrir';
  end if;

  -- ── Y el PEDIDO lo rechaza, que es lo único que de verdad manda ───────────
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders, storefront_enabled)
  values ('verif-reloj', 'Doña Rosa', 'comida típica', 'ycloud',
    '+593900666001', '+593900666001', true, true)
  returning id into v_business;
  -- Uno en su franja ahora mismo, y otro que abre dentro de dos horas.
  insert into products (business_id, name, price, available_from, available_until)
  values (v_business, 'Lo de ahora', 3.50, v_local - interval '1 hour', v_local + interval '1 hour')
  returning id into v_ahora;
  insert into products (business_id, name, price, available_from, available_until)
  values (v_business, 'Lo de luego', 12.00, v_local + interval '2 hours', v_local + interval '3 hours')
  returning id into v_luego;

  begin
    perform public.create_storefront_order(
      v_business, null, '+593900666002', 'Cliente', null, 'delivery',
      jsonb_build_array(jsonb_build_object('product_id', v_luego, 'quantity', 1))
    );
    raise exception 'se pudo pedir un producto fuera de su franja';
  exception when invalid_parameter_value then null;
  end;

  if (public.create_storefront_order(
        v_business, null, '+593900666002', 'Cliente', null, 'delivery',
        jsonb_build_array(jsonb_build_object('product_id', v_ahora, 'quantity', 1))
      ) ->> 'total')::numeric <> 3.50 then
    raise exception 'un producto EN su franja no se pudo pedir';
  end if;

  -- Y el día: hoy no, mañana sí.
  update products set available_from = null, available_until = null,
         available_days = array[(extract(dow from timezone('America/Guayaquil', now()))::int + 1) % 7]::smallint[]
   where id = v_ahora;
  begin
    perform public.create_storefront_order(
      v_business, null, '+593900666002', 'Cliente', null, 'delivery',
      jsonb_build_array(jsonb_build_object('product_id', v_ahora, 'quantity', 1))
    );
    raise exception 'se pudo pedir un producto de otro día de la semana';
  exception when invalid_parameter_value then null;
  end;

  -- ── Abierto, pero SIN CARTA a esta hora ──────────────────────────────────
  -- Lo que el menú del chat necesita saber para no mandar a nadie a una tienda
  -- donde no puede pedir nada.
  update businesses set type = 'pizzería' where id = v_business;
  update products set available_from = v_local + interval '2 hours',
         available_until = v_local + interval '3 hours', available_days = null
   where business_id = v_business;
  if (select con_carta from marketplace_negocios_de_categoria('pizzerias') where id = v_business) then
    raise exception 'un local con toda su carta fuera de hora se ofreció como si se pudiera pedir';
  end if;
  if (select carta_desde from marketplace_negocios_de_categoria('pizzerias') where id = v_business)
     is null then
    raise exception 'no se dijo desde qué hora vuelve su carta';
  end if;
  -- Con una sola cosa pedible ya hay carta.
  update products set available_from = null, available_until = null where id = v_ahora;
  if not (select con_carta from marketplace_negocios_de_categoria('pizzerias') where id = v_business) then
    raise exception 'un local con algo pedible se marcó como sin carta';
  end if;
  -- Y un local SIN catálogo no tiene un problema de hora: no se marca.
  delete from products where business_id = v_business;
  if not (select con_carta from marketplace_negocios_de_categoria('pizzerias') where id = v_business) then
    raise exception 'un local sin catálogo se marcó como «sin carta a esta hora»';
  end if;

  delete from businesses where id = v_business;
  raise notice 'MENÚS CON RELOJ: franjas, día, medianoche, rechazo del pedido y «sin carta a esta hora»';
end;
$reloj$;

-- ═══════════════════════════════════════════════════════════════════════════
-- CÓMO USA LA GENTE EL MENÚ DE UMBANI
-- ═══════════════════════════════════════════════════════════════════════════
-- El embudo, los cajones que se abandonan y las búsquedas que no encuentran
-- nada. Lo pidió el dueño para afinar los nombres de los cajones con datos.
do $umbani$
declare
  v_business uuid;
  v_ana uuid;
  v_luis uuid;
  v_pizzerias text := 'pizzerias';
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders, storefront_enabled)
  values ('verif-umbani', 'Pizza Uno', 'pizzería', 'ycloud',
    '+593900444001', '+593900444001', true, true)
  returning id into v_business;
  insert into customers (phone, name) values ('593900444101', 'Ana') returning id into v_ana;
  insert into customers (phone, name) values ('593900444102', 'Luis') returning id into v_luis;

  -- Ana recorre el menú entero y elige; Luis entra al cajón y se va.
  insert into marketplace_events (customer_id, tipo, category_code, business_id, consulta, resultados)
  values
    (v_ana, 'menu', null, null, null, null),
    (v_ana, 'cajon', v_pizzerias, null, null, null),
    (v_ana, 'local', v_pizzerias, v_business, null, null),
    (v_luis, 'menu', null, null, null, null),
    (v_luis, 'cajon', v_pizzerias, null, null, null),
    (v_luis, 'busqueda', null, null, 'seco de chivo', 0),
    (v_luis, 'busqueda', 'internacional', null, 'sushi de cangrejo', 0),
    (v_luis, 'busqueda', null, null, 'pizza', 3);

  -- ── Lo que no se puede perder: el rastro ─────────────────────────────────
  if (select count(*) from marketplace_events where tipo = 'cajon') <> 2 then
    raise exception 'no quedaron los dos toques al cajón';
  end if;

  -- ── El embudo cuenta CLIENTES, no toques ─────────────────────────────────
  if (select clientes from marketplace_embudo(7) where paso = 'entraron a un cajón') <> 2 then
    raise exception 'el embudo no contó los dos clientes que entraron a un cajón';
  end if;
  if (select clientes from marketplace_embudo(7) where paso = 'eligieron un local') <> 1 then
    raise exception 'el embudo no contó al que eligió local';
  end if;

  -- ── El cajón abandonado, que es el dato que se pidió ──────────────────────
  declare v_cajon record;
  begin
    select * into v_cajon from marketplace_cajones_tocados(7) where code = v_pizzerias;
    if v_cajon.entradas <> 2 or v_cajon.eligieron <> 1 or v_cajon.abandonaron <> 1 then
      raise exception 'los cajones tocados no cuadran: % entradas, % eligieron, % abandonaron',
        v_cajon.entradas, v_cajon.eligieron, v_cajon.abandonaron;
    end if;
  end;

  -- ── Las búsquedas: primero las que no encontraron nada ───────────────────
  declare v_busqueda record;
  begin
    select * into v_busqueda from marketplace_busquedas(7) limit 1;
    if v_busqueda.consulta <> 'seco de chivo' or v_busqueda.sin_nada <> 1 then
      raise exception 'la búsqueda sin resultado no salió primero: %', v_busqueda;
    end if;
    -- ⚠️ «te entiendo y NO lo tengo» es demanda, y se distingue de «no sé de
    -- qué me hablas»: solo la primera trae categoría.
    select * into v_busqueda from marketplace_busquedas(7) where consulta = 'sushi de cangrejo';
    if v_busqueda.entendido is null then
      raise exception 'una búsqueda entendida sin oferta no dijo qué se entendió';
    end if;
  end;
  begin
    insert into marketplace_events (customer_id, tipo) values (v_ana, 'inventado');
    raise exception 'se aceptó un tipo de evento que no existe';
  exception when check_violation then null;
  end;

  -- ── Borrar un cliente NO borra su rastro del embudo ───────────────────────
  -- El embudo de esta semana no puede cambiar porque alguien se dé de baja.
  delete from customers where id = v_luis;
  if (select count(*) from marketplace_events where tipo = 'cajon') <> 2 then
    raise exception 'al borrar un cliente se perdieron sus eventos';
  end if;

  -- ── El embudo DEL LOCAL, que es el reporte de su dueño ───────────────────
  -- Ana recibió su enlace, lo abrió y pidió; el reporte tiene que contarlo.
  declare v_sesion uuid; v_paso record;
  begin
    insert into storefront_sessions (business_id, customer_id, contact_phone, token_hash, last_seen_at)
    values (v_business, v_ana, '593900444101', repeat('a1', 32), now())
    returning id into v_sesion;
    insert into orders (business_id, customer_id, contact_phone, total, status)
    values (v_business, v_ana, '593900444101', 10.00, 'completado');

    select * into v_paso from local_embudo(v_business, 30) where orden = 1;
    if v_paso.clientes <> 1 then
      raise exception 'el embudo del local no contó su enlace';
    end if;
    select * into v_paso from local_embudo(v_business, 30) where orden = 2;
    if v_paso.clientes <> 1 then
      raise exception 'el embudo del local no vio que abrió la tienda';
    end if;
    select * into v_paso from local_embudo(v_business, 30) where orden = 4;
    if v_paso.clientes <> 1 then
      raise exception 'el embudo del local no contó el pedido entregado';
    end if;

    -- ⚠️ Y solo lo SUYO: el embudo de un local no puede ver a los clientes de
    -- otro. Es la regla #1 del proyecto, aquí también.
    if (select clientes from local_embudo(gen_random_uuid(), 30) where orden = 1) <> 0 then
      raise exception 'FUGA: el embudo de un local contó clientes de otro';
    end if;

    -- Por dónde llegó: el cajón desde el que lo eligieron.
    if (select veces from local_llegadas(v_business, 30) where code = 'pizzerias') <> 1 then
      raise exception 'no se supo por qué cajón llegó el cliente';
    end if;
  end;

  delete from businesses where id = v_business;
  delete from customers where id = v_ana;
  delete from marketplace_events;
  raise notice 'MENÚ DE UMBANI: rastro, embudos (plataforma y local), cajones abandonados y búsquedas sin oferta';
end;
$umbani$;

-- ═══════════════════════════════════════════════════════════════════════════
-- NINGUNA FUNCIÓN PROPIA PUEDE TENER DOS VERSIONES VIVAS
-- ═══════════════════════════════════════════════════════════════════════════
-- `create or replace function` con un parámetro nuevo NO reemplaza: crea una
-- SEGUNDA función con el mismo nombre. Las dos quedan vivas y cualquier
-- llamada se vuelve ambigua — el código viejo sigue ahí, invisible.
--
-- Las sobrecargas de las extensiones (pgvector, pgcrypto, btree_gist) son
-- legítimas y se excluyen: solo se miran las funciones del proyecto, que son
-- las que están declaradas en schema.sql.
do $$
declare
  v_duplicadas text;
begin
  select string_agg(format('%s (%s versiones)', proname, veces), ', ')
  into v_duplicadas
  from (
    select p.proname, count(*) as veces
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d
      on d.objid = p.oid and d.deptype = 'e'   -- pertenece a una extensión
    where n.nspname = 'public'
      and p.prokind = 'f'
      and d.objid is null
    group by p.proname
    having count(*) > 1
  ) as repetidas;

  if v_duplicadas is not null then
    raise exception 'Funciones del proyecto con más de una versión viva: %', v_duplicadas;
  end if;
end;
$$;

select '✅ sin funciones duplicadas' as resultado;

-- ── Motor de margen de la plataforma ───────────────────────────────────────
--
-- PostgreSQL acepta una función plpgsql rota sin avisar: solo revienta en el
-- primer uso real. Aquí se EJECUTA, que es lo único que lo demuestra.
--
-- Los mismos casos que `tests/motor-de-margen.test.js` ejercita sobre el
-- espejo en TypeScript. Si los dos motores se separan, uno de los dos falla.
do $$
declare
  v_biz    uuid;
  v_otro   uuid;
  v_regla  uuid;
  v_nueva  uuid;
  v_calc   jsonb;
  v_markup numeric;
  v_ped    record;
  v_pedido uuid;
  v_suma   numeric;
  v_cierre jsonb;
begin
  -- Cada bloque de este archivo trae su propio negocio y lo borra al terminar.
  -- Reutilizar el de otro bloque no funciona: ese ya se borró en su limpieza.
  insert into public.businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number, takes_orders
  ) values (
    'verificacion-margen', 'Negocio de margen', 'pizzería',
    'ycloud', '+593900000920', '+593900000920', true
  )
  returning id into v_biz;

  -- 1. FALLA ABIERTO: sin regla, margen 0 y el pedido sigue.
  v_calc := public.calculate_platform_markup(v_biz, 50);
  if (v_calc ->> 'markup')::numeric <> 0 then
    raise exception 'sin regla el margen debería ser 0, fue %', v_calc ->> 'markup';
  end if;

  -- 2. RESTAURANTE: porcentaje simple.
  insert into public.pricing_rules (scope, business_id, strategy, percentage)
  values ('business', v_biz, 'percentage', 10) returning id into v_regla;

  v_markup := (public.calculate_platform_markup(v_biz, 15) ->> 'markup')::numeric;
  if v_markup <> 1.50 then
    raise exception '10%% de 15 debería ser 1.50, fue %', v_markup;
  end if;

  -- 3. EL DISPARADOR sella el margen y la trazabilidad al crear el pedido.
  insert into public.orders (business_id, contact_phone, status, subtotal, discount, total, currency, source)
  values (v_biz, '593900000001', 'pendiente', 20, 0, 20, 'USD', 'manual')
  returning merchant_subtotal, platform_markup, pricing_rule_id, pricing_rule_version into v_ped;

  if v_ped.platform_markup <> 2.00 then
    raise exception 'el disparador debería sellar 2.00 de margen, selló %', v_ped.platform_markup;
  end if;
  if v_ped.merchant_subtotal <> 18.00 then
    raise exception 'al comercio deberían quedarle 18.00, le quedaron %', v_ped.merchant_subtotal;
  end if;
  if v_ped.pricing_rule_id is distinct from v_regla then
    raise exception 'el pedido no registró qué regla se le aplicó';
  end if;
  if v_ped.pricing_rule_version is null then
    raise exception 'el pedido no registró la versión de la regla';
  end if;

  -- 4. SUPERMERCADO: el techo protege al comercio de volumen.
  update public.pricing_rules set status = 'archived' where id = v_regla;
  insert into public.pricing_rules (scope, business_id, strategy, percentage, max_amount)
  values ('business', v_biz, 'percentage', 4, 3) returning id into v_nueva;

  v_markup := (public.calculate_platform_markup(v_biz, 150) ->> 'markup')::numeric;
  if v_markup <> 3.00 then
    raise exception 'el techo debería dejarlo en 3.00, fue %', v_markup;
  end if;

  -- 5. EL PISO nos protege: un pedido de $2 no puede dejar $0.08.
  update public.pricing_rules set status = 'archived' where id = v_nueva;
  insert into public.pricing_rules (scope, business_id, strategy, percentage, min_amount)
  values ('business', v_biz, 'percentage', 4, 0.50) returning id into v_nueva;

  v_markup := (public.calculate_platform_markup(v_biz, 2) ->> 'markup')::numeric;
  if v_markup <> 0.50 then
    raise exception 'el piso debería subirlo a 0.50, fue %', v_markup;
  end if;

  -- 6. RAÍL: el margen nunca supera el subtotal.
  update public.pricing_rules set status = 'archived' where id = v_nueva;
  insert into public.pricing_rules (scope, business_id, strategy, fixed_amount)
  values ('business', v_biz, 'fixed', 5) returning id into v_nueva;

  v_markup := (public.calculate_platform_markup(v_biz, 2) ->> 'markup')::numeric;
  if v_markup <> 2.00 then
    raise exception 'el margen no puede superar el subtotal: fue % sobre 2', v_markup;
  end if;

  -- 7. TRAMOS: se ordenan por `up_to`, no por el orden del array.
  update public.pricing_rules set status = 'archived' where id = v_nueva;
  insert into public.pricing_rules (scope, business_id, strategy, tiers)
  values ('business', v_biz, 'tiered',
          '[{"up_to":30,"amount":1.5},{"amount":3},{"up_to":10,"amount":0.5}]'::jsonb)
  returning id into v_nueva;

  if (public.calculate_platform_markup(v_biz,   8) ->> 'markup')::numeric <> 0.50
     or (public.calculate_platform_markup(v_biz,  25) ->> 'markup')::numeric <> 1.50
     or (public.calculate_platform_markup(v_biz, 500) ->> 'markup')::numeric <> 3.00 then
    raise exception 'los tramos no se resolvieron por up_to';
  end if;

  -- 8. CONGELADO: la regla sellada manda aunque hoy esté archivada.
  v_markup := (public.calculate_platform_markup(v_biz, 15, v_regla) ->> 'markup')::numeric;
  if v_markup <> 1.50 then
    raise exception 'la regla congelada debería seguir dando 1.50, dio %', v_markup;
  end if;

  -- 9. AISLAMIENTO: la regla de un negocio no alcanza a otro.
  v_otro := gen_random_uuid();
  if (public.calculate_platform_markup(v_otro, 100) ->> 'markup')::numeric <> 0 then
    raise exception 'la regla de un negocio alcanzó a otro';
  end if;

  -- 10. Los CHECK que impiden guardar una regla que el motor no honraría.
  begin
    insert into public.pricing_rules (scope, strategy, percentage)
    values ('business', 'percentage', 5);
    raise exception 'se guardó una regla de negocio sin business_id';
  exception when check_violation then null;
  end;

  begin
    insert into public.pricing_rules (scope, business_id, strategy)
    values ('business', v_biz, 'percentage');
    raise exception 'se guardó una regla percentage sin porcentaje';
  exception when check_violation then null;
  end;

  begin
    insert into public.pricing_rules (scope, business_id, strategy, percentage)
    values ('category', v_biz, 'percentage', 5);
    raise exception 'se guardó un scope que el motor todavía no resuelve';
  exception when check_violation then null;
  end;

  begin
    insert into public.pricing_rules (scope, business_id, strategy, percentage)
    values ('business', v_biz, 'percentage', 7);
    raise exception 'se guardaron dos reglas activas para el mismo negocio';
  exception when unique_violation then null;
  end;

  -- 11. EL ACUMULADO: se suma sobre `sales`, no sobre `orders`.
  --
  -- Un pedido aceptado o en preparación todavía no es dinero; la venta nace
  -- cuando se ENTREGA. Y una venta anulada deja de contar, que es la
  -- devolución sin construir nada nuevo.
  update public.pricing_rules set status = 'archived' where business_id = v_biz;
  insert into public.pricing_rules (scope, business_id, strategy, percentage)
  values ('business', v_biz, 'percentage', 10) returning id into v_regla;

  insert into public.orders (business_id, contact_phone, status, subtotal, discount, total, currency, source)
  values (v_biz, '593900000921', 'completado', 100, 0, 100, 'USD', 'manual')
  returning id into v_pedido;

  -- Sin venta todavía: el pedido existe pero no ha entrado al acumulado.
  select coalesce(sum(margen), 0) into v_suma
  from public.platform_markup_summary('2000-01-01', '2100-01-01', v_biz);
  if v_suma <> 0 then
    raise exception 'un pedido sin venta no puede acumular comisión, acumuló %', v_suma;
  end if;

  insert into public.sales (business_id, order_id, total, status, sold_at)
  values (v_biz, v_pedido, 100, 'completada', now());

  select coalesce(sum(margen), 0) into v_suma
  from public.platform_markup_summary('2000-01-01', '2100-01-01', v_biz);
  if v_suma <> 10 then
    raise exception 'el acumulado debería ser 10.00, fue %', v_suma;
  end if;

  -- Anular la venta retira su comisión.
  update public.sales set status = 'anulada' where order_id = v_pedido;
  select coalesce(sum(margen), 0) into v_suma
  from public.platform_markup_summary('2000-01-01', '2100-01-01', v_biz);
  if v_suma <> 0 then
    raise exception 'una venta anulada no puede seguir cobrando, quedó %', v_suma;
  end if;

  -- Y el acumulado tampoco cruza la frontera entre negocios.
  if exists (select 1 from public.platform_markup_summary('2000-01-01', '2100-01-01', gen_random_uuid())) then
    raise exception 'el acumulado de un negocio se vio desde otro';
  end if;

  -- ── LA CARRERA NO ES DEL LOCAL ─────────────────────────────────────────
  --
  -- Dicho por el dueño el 2026-09-21 mirando Finanzas: «suma el valor de la
  -- carrera y eso es del motorizado». `comercio = bruto − margen` le atribuía
  -- al local un dinero de quien entrega: sobre un pedido de $15.18 decía que
  -- se quedaba $13.98 cuando de su comida solo eran $11.98.
  --
  -- Las tres bolsas tienen que sumar lo que pagó el cliente, y ninguna puede
  -- llevarse lo de otra.
  declare
    v_con_envio uuid;
    v_r record;
  begin
    -- ⚠️ NO se borra nada de lo anterior: la venta de arriba quedó `anulada`
    -- y el resumen solo mira las `completada`, así que aquí no estorba. Y la
    -- prueba 12 la resucita para cerrar el mes — borrarla la dejaba sin nada
    -- que cerrar.
    insert into public.orders (
      business_id, contact_phone, status, subtotal, shipping, discount, total, currency, source
    )
    values (v_biz, '593900000921', 'completado', 11.98, 2.00, 0, 15.18, 'USD', 'storefront')
    returning id into v_con_envio;

    insert into public.sales (business_id, order_id, total, status, sold_at)
    values (v_biz, v_con_envio, 15.18, 'completada', now());

    select * into v_r
    from public.platform_markup_summary('2000-01-01', '2100-01-01', v_biz);

    -- El margen se calcula sobre el PRODUCTO, nunca sobre el total con
    -- carrera: 10 % de 11.98 son 1.20, y de 13.98 serían 1.40.
    if v_r.margen <> 1.20 then
      raise exception 'el margen debía salir del producto (1.20), fue %', v_r.margen;
    end if;
    if v_r.reparto <> 2.00 then
      raise exception 'la carrera debía informarse aparte (2.00), fue %', v_r.reparto;
    end if;
    if v_r.productos <> 11.98 then
      raise exception 'al local le tocan SUS PRODUCTOS (11.98), no % con la carrera dentro',
        v_r.productos;
    end if;
    -- La invariante: ninguna bolsa se lleva lo de otra.
    if round(v_r.productos + v_r.reparto + v_r.margen, 2) <> v_r.bruto then
      raise exception 'las tres bolsas no suman lo que pagó el cliente: % + % + % <> %',
        v_r.productos, v_r.reparto, v_r.margen, v_r.bruto;
    end if;

    -- Quien retira en el local no paga carrera, y ahí `productos` se lo lleva
    -- todo: sin esto, un negocio sin reparto podría quedar descuadrado.
    delete from public.sales  where order_id = v_con_envio;
    delete from public.orders where id       = v_con_envio;
    insert into public.orders (
      business_id, contact_phone, status, subtotal, shipping, discount, total, currency, source
    )
    values (v_biz, '593900000921', 'completado', 11.98, 0, 0, 13.18, 'USD', 'storefront')
    returning id into v_con_envio;
    insert into public.sales (business_id, order_id, total, status, sold_at)
    values (v_biz, v_con_envio, 13.18, 'completada', now());

    select * into v_r
    from public.platform_markup_summary('2000-01-01', '2100-01-01', v_biz);
    if v_r.reparto <> 0 or v_r.productos <> 11.98 then
      raise exception 'sin reparto: carrera % y productos %', v_r.reparto, v_r.productos;
    end if;

    -- Se retira SOLO lo de esta prueba, y se deja intacto lo que la 12 espera.
    delete from public.sales  where order_id = v_con_envio;
    delete from public.orders where id       = v_con_envio;
  end;

  -- 12. EL CIERRE DE MES lleva la comisión a la factura.
  --
  -- ⚠️ El mes va en la zona del NEGOCIO —`America/Guayaquil`—, igual que en
  -- `create_business_onboarding`, y no en UTC. Con `now()` a secas esto fallaba
  -- las primeras 5 horas UTC del día 1 de cada mes: la factura la había creado
  -- el alta para el mes que en Ecuador todavía corría, y el cierre la buscaba
  -- en el que ya había entrado en UTC. No la encontraba y devolvía NULL.
  --
  -- Es idempotente por naturaleza: no suma, RECALCULA desde `sales`. Correrlo
  -- dos veces tiene que dar el mismo número, o un reintento tras un fallo de
  -- red cobraría el doble.
  update public.sales set status = 'completada' where order_id = v_pedido;

  v_cierre := public.settle_month_commission(date_trunc('month', timezone('America/Guayaquil', now()))::date);
  select commission_amount into v_suma
  from public.billing
  where business_id = v_biz and period_start = date_trunc('month', timezone('America/Guayaquil', now()))::date;
  if coalesce(v_suma, -1) <> 10 then
    raise exception 'el cierre debería dejar 10.00 de comisión, dejó %', v_suma;
  end if;

  perform public.settle_month_commission(date_trunc('month', timezone('America/Guayaquil', now()))::date);
  perform public.settle_month_commission(date_trunc('month', timezone('America/Guayaquil', now()))::date);
  select commission_amount into v_suma
  from public.billing
  where business_id = v_biz and period_start = date_trunc('month', timezone('America/Guayaquil', now()))::date;
  if v_suma <> 10 then
    raise exception 'tres cierres seguidos cambiaron el importe: %', v_suma;
  end if;

  -- La CUOTA no se toca: `amount` es el servicio, la comisión va aparte.
  select amount into v_suma
  from public.billing
  where business_id = v_biz and period_start = date_trunc('month', timezone('America/Guayaquil', now()))::date;
  if v_suma is null then
    raise exception 'el cierre borró la cuota mensual';
  end if;

  -- Un mes ya PAGADO no se reescribe: una factura emitida es un hecho.
  update public.billing set status = 'paid'
  where business_id = v_biz and period_start = date_trunc('month', timezone('America/Guayaquil', now()))::date;
  update public.orders set subtotal = 500, total = 500 where id = v_pedido;
  update public.sales set total = 500 where order_id = v_pedido;
  perform public.settle_month_commission(date_trunc('month', timezone('America/Guayaquil', now()))::date);
  select commission_amount into v_suma
  from public.billing
  where business_id = v_biz and period_start = date_trunc('month', timezone('America/Guayaquil', now()))::date;
  if v_suma <> 10 then
    raise exception 'se reescribió un mes ya pagado: quedó en %', v_suma;
  end if;

  -- Y el cierre solo acepta el primer día de un mes.
  begin
    perform public.settle_month_commission('2026-08-15'::date);
    raise exception 'el cierre aceptó una fecha que no es inicio de mes';
  exception when sqlstate '22023' then null;
  end;

  -- 13. LOS TRES CASOS LÍMITE.
  --
  -- Los tres son de dinero y los tres se encontraron auditando, no fallando.
  -- Se parte de cero: los bloques anteriores dejaron ventas de ESTE mes y sus
  -- comisiones se sumarían a las de aquí, midiendo otra cosa.
  delete from public.sales where business_id = v_biz;
  delete from public.orders where business_id = v_biz;
  update public.pricing_rules set status = 'archived' where business_id = v_biz;
  insert into public.pricing_rules (scope, business_id, strategy, percentage)
  values ('business', v_biz, 'percentage', 10) returning id into v_regla;

  -- (a) El mes termina en ECUADOR. Una venta del último día a las 20:00 hora
  -- local son las 01:00 UTC del día siguiente: sin la conversión se facturaba
  -- en el mes que no era, y son las cinco últimas horas de cada día.
  insert into public.orders (business_id, contact_phone, status, subtotal, discount, total, currency, source)
  values (v_biz, '593900000931', 'completado', 100, 0, 100, 'USD', 'manual')
  returning id into v_pedido;
  insert into public.sales (business_id, order_id, total, status, sold_at)
  values (v_biz, v_pedido, 100, 'completada', '2026-08-31 20:00:00-05');

  select coalesce(sum(margen), 0) into v_suma
  from public.platform_markup_summary('2026-08-01', '2026-09-01', v_biz);
  if v_suma <> 10 then
    raise exception 'la venta del 31 a las 20:00 de Ecuador no cayó en agosto: %', v_suma;
  end if;
  select coalesce(sum(margen), 0) into v_suma
  from public.platform_markup_summary('2026-09-01', '2026-10-01', v_biz);
  if v_suma <> 0 then
    raise exception 'esa venta se coló en septiembre: %', v_suma;
  end if;
  delete from public.sales where order_id = v_pedido;
  delete from public.orders where id = v_pedido;

  -- (b) El descuento sale de la base: no se cobra comisión sobre dinero que
  -- el comercio no recibió.
  insert into public.orders (business_id, contact_phone, status, subtotal, discount, total, currency, source)
  values (v_biz, '593900000932', 'completado', 100, 20, 80, 'USD', 'manual')
  returning platform_markup, merchant_subtotal into v_ped;
  if v_ped.platform_markup <> 8.00 then
    raise exception 'con $20 de descuento la comisión debía ser 8.00, fue %', v_ped.platform_markup;
  end if;
  if v_ped.merchant_subtotal <> 72.00 then
    raise exception 'al comercio debían quedarle 72.00, le quedaron %', v_ped.merchant_subtotal;
  end if;

  -- (c) `on_top` SÍ se puede guardar desde el 2026-08-25, y el comercio cobra
  -- entero.
  --
  -- ⚠️ Aquí ponía lo CONTRARIO: que `on_top` estaba prohibido, «descartado por
  -- el dueño el 2026-08-16 —lo que está en la app no tiene que subir de
  -- valor—». El dueño revirtió esa decisión el 2026-08-25 al ver que el modelo
  -- absorbido le descontaba el margen al local: sobre un pedido de $8 el
  -- comercio recibía $7,20, un descuento forzoso que nunca pactó.
  --
  -- La otra condición que exigía —que el catálogo pintara los precios con
  -- margen— se cumplió en la misma entrega, así que el freno se levantó cuando
  -- lo que pedía existía, no antes.
  update public.pricing_rules set markup_mode = 'on_top' where id = v_regla;

  delete from public.orders where business_id = v_biz;
  insert into public.orders (business_id, contact_phone, status, subtotal, total, currency, source)
  values (v_biz, '593900000932', 'completado', 100, 100, 'USD', 'storefront')
  returning platform_markup, merchant_subtotal into v_ped;

  -- El comercio cobra sus 100 ENTEROS y la plataforma suma su 10 encima.
  if v_ped.merchant_subtotal <> 100.00 then
    raise exception 'con on_top el comercio debía cobrar 100.00 entero, y cobró %', v_ped.merchant_subtotal;
  end if;
  if v_ped.platform_markup <> 10.00 then
    raise exception 'con on_top la plataforma debía sumar 10.00, y sumó %', v_ped.platform_markup;
  end if;

  -- (d) EL TECHO Y EL PISO SE RESPETAN TAMBIÉN CON `on_top`.
  --
  -- ⚠️ La prueba (c) NO cubría esto y por eso el fallo vivió meses: inserta un
  -- pedido SIN LÍNEAS, y sin `order_items` el camino por línea ni se activa.
  -- Aquí se recorre el camino de verdad —pedido, líneas, y DESPUÉS el subtotal,
  -- que es el orden exacto de `create_storefront_order`— porque el disparador
  -- es BEFORE y solo ve las líneas en el UPDATE.
  --
  -- El fallo, medido el 2026-09-20 contra PostgreSQL real: con `on_top` al 10 %
  -- y techo de $1, un pedido de $50 sellaba $5.00 de margen —cinco veces el
  -- techo— y cobraba $55 cuando la app había enseñado $51. Fallaba también al
  -- revés: con piso de $3 sobre $5 sellaba $0.50.
  --
  -- La causa era que `order_markup_by_line` no aplica `min_amount` ni
  -- `max_amount`, y el disparador la dejaba pisar el margen ya recortado.
  declare
    v_pedido_id uuid;
    v_margen numeric;
  begin
    update public.pricing_rules
       set markup_mode = 'on_top', percentage = 10, max_amount = 1.00
     where id = v_regla;

    delete from public.orders where business_id = v_biz;
    insert into public.orders (business_id, contact_phone, status, subtotal, total, currency, source)
    values (v_biz, '593900000932', 'pendiente', 0, 0, 'USD', 'storefront')
    returning id into v_pedido_id;

    insert into public.order_items (order_id, business_id, product_name, quantity, unit_price, line_total)
    values (v_pedido_id, v_biz, 'Arroz 5kg', 10, 5.00, 50.00);

    update public.orders set subtotal = 50.00, total = 50.00 where id = v_pedido_id;

    select platform_markup into v_margen from public.orders where id = v_pedido_id;
    if v_margen <> 1.00 then
      raise exception 'el TECHO de $1 se ignoró con on_top: se sellaron % (el cliente vio $51 y pagaría $%)',
        v_margen, 50 + v_margen;
    end if;

    -- Y el piso, en la otra dirección.
    update public.pricing_rules
       set max_amount = null, min_amount = 3.00
     where id = v_regla;

    delete from public.orders where business_id = v_biz;
    insert into public.orders (business_id, contact_phone, status, subtotal, total, currency, source)
    values (v_biz, '593900000932', 'pendiente', 0, 0, 'USD', 'storefront')
    returning id into v_pedido_id;
    insert into public.order_items (order_id, business_id, product_name, quantity, unit_price, line_total)
    values (v_pedido_id, v_biz, 'Arroz 5kg', 1, 5.00, 5.00);
    update public.orders set subtotal = 5.00, total = 5.00 where id = v_pedido_id;

    select platform_markup into v_margen from public.orders where id = v_pedido_id;
    if v_margen <> 3.00 then
      raise exception 'el PISO de $3 se ignoró con on_top: se sellaron %', v_margen;
    end if;

    -- Y SIN frenos se sigue calculando por línea, que es lo que hace que el
    -- total coincida con lo que el cliente sumó en pantalla. Esto NO cambia.
    update public.pricing_rules
       set min_amount = null, max_amount = null
     where id = v_regla;

    delete from public.orders where business_id = v_biz;
    insert into public.orders (business_id, contact_phone, status, subtotal, total, currency, source)
    values (v_biz, '593900000932', 'pendiente', 0, 0, 'USD', 'storefront')
    returning id into v_pedido_id;
    -- 3 × $0.75: por línea da 3 × $0.08 = $0.24; sobre el subtotal daría $0.23.
    insert into public.order_items (order_id, business_id, product_name, quantity, unit_price, line_total)
    values (v_pedido_id, v_biz, 'Empanada', 3, 0.75, 2.25);
    update public.orders set subtotal = 2.25, total = 2.25 where id = v_pedido_id;

    select platform_markup into v_margen from public.orders where id = v_pedido_id;
    if v_margen <> 0.24 then
      raise exception 'sin frenos el margen debía seguir yendo por línea (0.24), fue %', v_margen;
    end if;
  end;

  update public.pricing_rules
     set markup_mode = 'on_top', min_amount = null, max_amount = null
   where id = v_regla;

  -- Y un modo inventado sigue fallando CERRADO.
  begin
    update public.pricing_rules set markup_mode = 'regalado' where id = v_regla;
    raise exception 'se guardó un modo de margen que no existe';
  exception when check_violation then null;
  end;

  update public.pricing_rules set markup_mode = 'absorbed' where id = v_regla;


  -- 14. LOS MÉTODOS DE PAGO son del negocio, no del código.
  delete from public.orders where business_id = v_biz;
  insert into public.business_payment_methods (business_id, method_code, enabled)
  values (v_biz, 'transferencia', true), (v_biz, 'efectivo', true)
  on conflict (business_id, method_code) do update set enabled = true;

  if (select count(*) from public.storefront_payment_methods(v_biz)) <> 2 then
    raise exception 'la tienda debería ofrecer los dos métodos activos';
  end if;

  -- Apagar el efectivo lo quita de la tienda...
  update public.business_payment_methods set enabled = false
  where business_id = v_biz and method_code = 'efectivo';
  if exists (select 1 from public.storefront_payment_methods(v_biz) where code = 'efectivo') then
    raise exception 'un método apagado sigue ofreciéndose en la tienda';
  end if;

  -- ...y el cinturón impide pagar con él, cerrando la carrera entre que la
  -- app lo pinta y el cliente confirma.
  begin
    insert into public.orders (business_id, contact_phone, status, subtotal, discount, total, currency, source, payment_method)
    values (v_biz, '593900000941', 'pendiente', 10, 0, 10, 'USD', 'storefront', 'efectivo');
    raise exception 'se creó un pedido con un método que el local no acepta';
  exception when sqlstate '22023' then null;
  end;

  -- El de MOSTRADOR no se toca: lo teclea el dueño con la persona delante.
  insert into public.orders (business_id, contact_phone, status, subtotal, discount, total, currency, source, payment_method)
  values (v_biz, 'mostrador', 'completado', 10, 0, 10, 'USD', 'manual', 'efectivo');

  -- Y no se puede activar lo que la plataforma no sabe procesar.
  begin
    insert into public.business_payment_methods (business_id, method_code, enabled)
    values (v_biz, 'tarjeta', true);
    raise exception 'se activó un método sin pasarela que lo procese';
  exception when sqlstate '22023' then null;
  end;

  -- 15. EL ARRASTRE: lo anulado después de cobrar baja del mes siguiente.
  --
  -- Una factura emitida es un hecho: no se reescribe. La diferencia se ajusta
  -- en la siguiente, y se reclama por periodo para que la tarea diaria no
  -- aplique el mismo descuento cada día.
  -- Se parte de cero: los bloques anteriores dejaron ventas de este mismo mes
  -- y sus comisiones se sumarían a la de aquí, midiendo otra cosa.
  delete from public.sales where business_id = v_biz;
  delete from public.orders where business_id = v_biz;
  delete from public.billing_adjustments where business_id = v_biz;
  update public.billing set commission_amount = 0, commission_adjustment = 0, status = 'pending'
  where business_id = v_biz;
  update public.pricing_rules set status = 'archived' where business_id = v_biz;
  insert into public.pricing_rules (scope, business_id, strategy, percentage)
  values ('business', v_biz, 'percentage', 10);

  insert into public.orders (business_id, contact_phone, status, subtotal, discount, total, currency, source)
  values (v_biz, '593900000951', 'completado', 200, 0, 200, 'USD', 'manual')
  returning id into v_pedido;
  insert into public.sales (business_id, order_id, total, status, sold_at)
  values (v_biz, v_pedido, 200, 'completada', '2026-08-10 12:00-05');

  perform public.settle_month_commission('2026-08-01');
  update public.billing set status = 'paid'
  where business_id = v_biz and period_start = '2026-08-01';

  -- Se anula una venta del mes ya pagado.
  update public.sales set status = 'anulada' where order_id = v_pedido;
  insert into public.billing (business_id, amount, currency, period_start, period_end, status)
  values (v_biz, 25, 'USD', '2026-09-01', '2026-09-30', 'pending')
  on conflict (business_id, period_start) do nothing;

  perform public.carry_commission_adjustments('2026-09-01');

  select commission_amount into v_suma
  from public.billing where business_id = v_biz and period_start = '2026-08-01';
  if v_suma <> 20 then
    raise exception 'se reescribió un mes ya pagado: quedó en %', v_suma;
  end if;

  select commission_adjustment into v_suma
  from public.billing where business_id = v_biz and period_start = '2026-09-01';
  if v_suma <> -20 then
    raise exception 'el descuento debía arrastrarse como -20.00, fue %', v_suma;
  end if;

  -- Y no se aplica dos veces, que es lo que haría la tarea diaria sin reclamo.
  perform public.carry_commission_adjustments('2026-09-01');
  perform public.carry_commission_adjustments('2026-09-01');
  select commission_adjustment into v_suma
  from public.billing where business_id = v_biz and period_start = '2026-09-01';
  if v_suma <> -20 then
    raise exception 'el arrastre se aplicó más de una vez: %', v_suma;
  end if;


  -- 16. LAS FAMILIAS: una regla para toda la comida.
  --
  -- Antes cada uno de los 52 tipos era una isla y cubrir la comida exigía 24
  -- reglas iguales. La prioridad va de lo más específico a lo más general.
  update public.pricing_rules set status = 'archived' where status = 'active';
  update public.businesses set type = 'pizzería' where id = v_biz;

  insert into public.pricing_rules (scope, target_name, strategy, percentage)
  values ('family', 'comida', 'percentage', 8);
  if (public.calculate_platform_markup(v_biz, 100) ->> 'markup')::numeric <> 8 then
    raise exception 'la pizzería no heredó el margen de la familia comida';
  end if;

  -- El TIPO gana a la familia...
  insert into public.pricing_rules (scope, target_name, strategy, percentage)
  values ('business_type', 'pizzería', 'percentage', 6);
  if (public.calculate_platform_markup(v_biz, 100) ->> 'markup')::numeric <> 6 then
    raise exception 'la regla de tipo no ganó a la de familia';
  end if;

  -- ...y el NEGOCIO gana a todo.
  insert into public.pricing_rules (scope, business_id, strategy, percentage)
  values ('business', v_biz, 'percentage', 5);
  if (public.calculate_platform_markup(v_biz, 100) ->> 'markup')::numeric <> 5 then
    raise exception 'la regla de negocio no ganó a las demás';
  end if;

  -- Un tipo SIN familia cae a la global y no rompe nada.
  update public.pricing_rules set status = 'archived'
  where scope in ('business', 'business_type', 'family');
  insert into public.pricing_rules (scope, strategy, percentage)
  values ('global', 'percentage', 3);
  update public.businesses set type = 'tipo que nadie clasificó' where id = v_biz;
  if (public.calculate_platform_markup(v_biz, 100) ->> 'markup')::numeric <> 3 then
    raise exception 'un tipo sin familia debía caer a la regla global';
  end if;

  -- Una regla de familia SIN familia se aplicaría a toda la plataforma.
  begin
    insert into public.pricing_rules (scope, strategy, percentage)
    values ('family', 'percentage', 5);
    raise exception 'se guardó una regla de familia sin familia';
  exception when check_violation then null;
  end;

  -- ── Limpieza ──────────────────────────────────────────────────────────────
  -- Las reglas, los pedidos y las ventas se van en cascada con el negocio.
  delete from public.businesses where id = v_biz;
end;
$$;

select '✅ motor de margen: reglas, frenos, disparador y congelado' as resultado;


-- ═══════════════════════════════════════════════════════════════════════════
-- EL TECHO DE GASTO DEL MARKETPLACE (2026-08-24)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El número de Umbani contesta a cada mensaje, y desde el 1 de octubre de 2026
-- cada respuesta se paga. El techo del canal PROPIO (`claim_miniapp_reply`) no
-- cubría este camino: se llama desde `bot-conversation.ts` y el marketplace no
-- pasa por ahí.
do $$
declare
  v_cliente uuid;
  v_r jsonb;
  v_i integer;
begin
  insert into public.customers (phone) values ('593900000824')
  returning id into v_cliente;

  -- El tope es ALTO a propósito: armar un pedido dentro del chat son
  -- fácilmente 15-25 mensajes. Con 5 se cortaría a un cliente de verdad.
  for v_i in 1..25 loop
    v_r := public.claim_marketplace_reply(v_cliente, 25, 12);
    if (v_r->>'permitido')::boolean is not true then
      raise exception 'la respuesta % no debía callarse todavía: %', v_i, v_r;
    end if;
    if (v_r->>'respuestas')::integer <> v_i then
      raise exception 'la cuenta debía ir por % y va por %', v_i, v_r->>'respuestas';
    end if;
  end loop;

  -- La 26 calla.
  v_r := public.claim_marketplace_reply(v_cliente, 25, 12);
  if (v_r->>'permitido')::boolean is not false or v_r->>'motivo' <> 'silenciado' then
    raise exception 'pasado el tope debía callar, y fue %', v_r;
  end if;

  -- ⚠️ …pero AVISA, y solo esta vez (2026-09-27). El dueño se quedó escribiendo
  -- MENÚ a un chat mudo sin saber por qué ni hasta cuándo.
  if (v_r->>'aviso')::boolean is not true then
    raise exception 'el mensaje que cruza el techo debía avisar: %', v_r;
  end if;
  if (v_r->>'hasta')::timestamptz < now() + interval '11 hours 59 minutes' then
    raise exception 'el aviso debía decir hasta cuándo (12 h): %', v_r;
  end if;
  v_r := public.claim_marketplace_reply(v_cliente, 25, 12);
  if (v_r->>'aviso')::boolean is true then
    raise exception 'el silenciado recibe el aviso UNA vez, no en cada intento: %', v_r;
  end if;
  if v_r->>'hasta' is null then
    raise exception 'el silencio debe seguir diciendo hasta cuándo: %', v_r;
  end if;

  -- Y el silencio NO se levanta al cambiar de hora: con una ventana que se
  -- reinicia sola, quien molesta con paciencia pagaría el techo entero cada
  -- hora — 25 por hora son 600 mensajes pagados al día.
  update public.marketplace_conversations
  set reply_window_start = now() - interval '2 hours', reply_count = 0
  where customer_id = v_cliente;

  v_r := public.claim_marketplace_reply(v_cliente, 25, 12);
  if (v_r->>'permitido')::boolean is not false then
    raise exception 'el silencio no puede levantarse al cambiar de hora: %', v_r;
  end if;

  -- Vencido el silencio, vuelve a contestar desde cero.
  update public.marketplace_conversations
  set muted_until = now() - interval '1 minute'
  where customer_id = v_cliente;

  v_r := public.claim_marketplace_reply(v_cliente, 25, 12);
  if (v_r->>'permitido')::boolean is not true or (v_r->>'respuestas')::integer <> 1 then
    raise exception 'pasado el silencio debía empezar de cero: %', v_r;
  end if;

  -- ⚠️ IDEMPOTENTE POR ID DE MENSAJE. La entrada es *at-least-once*: si la
  -- confirmación a PostgreSQL no llega, el worker reintenta y el mismo mensaje
  -- se procesa otra vez. Sin esto, cinco reintentos acercaban al silencio a un
  -- cliente legítimo.
  v_r := public.claim_marketplace_reply(v_cliente, 25, 12, 'wamid.repetido');
  if (v_r->>'respuestas')::integer <> 2 then
    raise exception 'el primer mensaje con id debía contar: %', v_r;
  end if;
  v_r := public.claim_marketplace_reply(v_cliente, 25, 12, 'wamid.repetido');
  if (v_r->>'permitido')::boolean is not true
     or (v_r->>'respuestas')::integer <> 2
     or (v_r->>'repetido')::boolean is not true then
    raise exception 'el reintento del MISMO mensaje no puede volver a contar: %', v_r;
  end if;

  -- ⚠️ NO toca `version`. El bloqueo optimista protege el estado del menú, y
  -- subirlo aquí haría que contar una respuesta invalidara el avance que se
  -- guarda en el mismo mensaje: el cliente elegiría local y se perdería.
  declare
    v_version integer;
    v_despues integer;
  begin
    select version into v_version
    from public.marketplace_conversations where customer_id = v_cliente;
    v_r := public.claim_marketplace_reply(v_cliente, 25, 12, 'wamid.otro');
    select version into v_despues
    from public.marketplace_conversations where customer_id = v_cliente;
    if v_despues <> v_version then
      raise exception 'el techo movió la versión de la conversación (% → %)', v_version, v_despues;
    end if;
  end;

  -- Sin cliente se ATIENDE: quedarse mudo por un problema nuestro deja sin
  -- servicio a alguien de verdad.
  v_r := public.claim_marketplace_reply(null, 25, 12);
  if (v_r->>'permitido')::boolean is not true then
    raise exception 'sin cliente debía atender, y fue %', v_r;
  end if;

  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ techo del marketplace: tope, silencio, idempotencia y versión intacta' as resultado;


-- ═══════════════════════════════════════════════════════════════════════════
-- LOS DOS FRENOS DE ABUSO (2026-08-25)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El techo cuenta RESPUESTAS. No contaba pedidos, y ahí el daño no es dinero:
-- diez pedidos falsos son diez alarmas, diez comandas y comida que nadie
-- recoge. Y bloquear era por local: a quien molesta a cinco había que
-- bloquearlo cinco veces.
do $$
declare
  v_biz uuid;
  v_cliente uuid;
  v_dir uuid;
  v_prod uuid;
  v_i integer;
  v_rechazado boolean := false;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verificacion-frenos', 'Local Frenos', 'pizzería', 'marketplace', true, true)
  returning id into v_biz;

  insert into public.customers (phone) values ('593900000825')
  returning id into v_cliente;

  insert into public.customer_addresses (business_id, customer_id, address)
  values (v_biz, v_cliente, 'Calle de prueba 123')
  returning id into v_dir;

  insert into public.products (business_id, name, price, active)
  values (v_biz, 'Pizza de prueba', 10, true)
  returning id into v_prod;

  -- ── Tres pedidos abiertos entran; el cuarto NO ──────────────────────────
  for v_i in 1..3 loop
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (v_biz, v_cliente, '593900000825', 'storefront', 'pendiente', 10, 10);
  end loop;

  begin
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (v_biz, v_cliente, '593900000825', 'storefront', 'pendiente', 10, 10);
    raise exception 'el cuarto pedido sin confirmar debía rechazarse';
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  if not v_rechazado then
    raise exception 'el freno de pedidos abiertos no actuó';
  end if;

  -- ⚠️ En cuanto el dueño ACEPTA, ese pedido deja de contar: ya decidió
  -- tomarlo, y el cliente puede encargar otra cosa.
  update public.orders set status = 'preparacion'
  where business_id = v_biz and customer_id = v_cliente
    and id = (select id from public.orders where business_id = v_biz limit 1);

  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_biz, v_cliente, '593900000825', 'storefront', 'pendiente', 10, 10);

  -- ⚠️ MOSTRADOR (`source = 'manual'`) NO se frena: lo teclea el dueño con la
  -- persona delante, y si quiere meter cinco seguidos es su cocina.
  for v_i in 1..5 loop
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (v_biz, v_cliente, '593900000825', 'manual', 'pendiente', 10, 10);
  end loop;

  -- ⚠️ LA VENTANA ES IMPRESCINDIBLE. Sin ella, tres pedidos abandonados de
  -- hace un mes dejarían a ese cliente sin poder pedir NUNCA — y hoy nadie
  -- expira los abandonados.
  update public.orders set created_at = now() - interval '7 hours'
  where business_id = v_biz and source = 'storefront';

  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_biz, v_cliente, '593900000825', 'storefront', 'pendiente', 10, 10);

  -- ── El bloqueo de PLATAFORMA ────────────────────────────────────────────
  perform public.set_platform_blocked('+593 90 000 0825', true, 'pedidos falsos repetidos');

  if not exists (
    select 1 from public.customers
    where id = v_cliente and blocked_at is not null
      and blocked_reason = 'pedidos falsos repetidos'
  ) then
    raise exception 'el bloqueo de plataforma no se guardó, o no normalizó el teléfono';
  end if;

  -- ⚠️ Alcanza también al MOSTRADOR: si el superadmin lo expulsó de Umbani, un
  -- local no puede colarlo tecleándole el pedido a mano.
  v_rechazado := false;
  begin
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (v_biz, v_cliente, '593900000825', 'manual', 'pendiente', 10, 10);
    raise exception 'un bloqueado de plataforma no puede pedir ni de mostrador';
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  if not v_rechazado then
    raise exception 'el bloqueo de plataforma no frenó el pedido de mostrador';
  end if;

  -- Desbloquear lo suelta del todo, motivo incluido.
  perform public.set_platform_blocked('593900000825', false);
  if exists (
    select 1 from public.customers
    where id = v_cliente and (blocked_at is not null or blocked_reason is not null)
  ) then
    raise exception 'desbloquear debe limpiar la marca y el motivo';
  end if;

  -- Un teléfono a medias no puede acabar bloqueando a otra persona.
  v_rechazado := false;
  begin
    perform public.set_platform_blocked('5939', true);
    raise exception 'un teléfono corto debía rechazarse';
  exception when others then
    v_rechazado := true;
  end;
  if not v_rechazado then
    raise exception 'set_platform_blocked aceptó un teléfono inválido';
  end if;

  -- ⚠️ CREA al cliente si no existía: quien molesta puede no haber pedido
  -- nunca, y es justo a ese al que hay que poder bloquear ANTES de que lo
  -- intente.
  perform public.set_platform_blocked('593911112222', true, 'nunca pidió');
  if not exists (
    select 1 from public.customers where phone = '593911112222' and blocked_at is not null
  ) then
    raise exception 'bloquear a un desconocido debía crearlo';
  end if;

  delete from public.customers where phone in ('593900000825', '593911112222');
  delete from public.businesses where id = v_biz;
end;
$$;

select '✅ frenos de abuso: tope de pedidos abiertos y bloqueo de plataforma' as resultado;


-- ═══════════════════════════════════════════════════════════════════════════
-- MÍNIMO DE COMPRA Y TOPE POR HORA (2026-08-26)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El caso que no cubría el freno del 2026-08-25: cuarenta personas distintas
-- pidiendo una gaseosa cada una. Ninguna pasa de tres pedidos abiertos.
do $$
declare
  v_biz uuid;
  v_cliente uuid;
  v_i integer;
  v_rechazado boolean;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verificacion-minimo', 'Local Mínimo', 'pizzería', 'marketplace', true, true)
  returning id into v_biz;
  insert into public.customers (phone) values ('593900000826')
  returning id into v_cliente;

  -- Nace SIN mínimo y con tope de 30: ningún local existente cambia de
  -- comportamiento sin haberlo pedido.
  if (select min_order_amount from public.businesses where id = v_biz) <> 0
     or (select max_orders_per_hour from public.businesses where id = v_biz) <> 30 then
    raise exception 'los valores de arranque cambiaron sin querer';
  end if;

  -- ── El mínimo ───────────────────────────────────────────────────────────
  update public.businesses set min_order_amount = 5 where id = v_biz;

  v_rechazado := false;
  begin
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (v_biz, v_cliente, '593900000826', 'storefront', 'pendiente', 1.50, 3.50);
    raise exception 'un pedido por debajo del mínimo debía rechazarse';
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  if not v_rechazado then
    raise exception 'el mínimo de compra no actuó';
  end if;

  -- ⚠️ SIN EL ENVÍO. Quien quiera un agua de $0,50 y pagar $2 de reparto está
  -- en su derecho: el local decide cuánto vale la pena COCINAR, no cuánto
  -- gasta el cliente. `subtotal` = 5 basta aunque el total sea otro.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_biz, v_cliente, '593900000826', 'storefront', 'pendiente', 5.00, 7.00);

  -- El descuento SÍ baja la base: cobrar el mínimo sobre dinero que el
  -- comercio no recibe sería cobrarle dos veces.
  v_rechazado := false;
  begin
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, discount, total)
    values (v_biz, v_cliente, '593900000826', 'storefront', 'pendiente', 6.00, 2.00, 4.00);
    raise exception 'el descuento debía bajar la base del mínimo';
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  if not v_rechazado then
    raise exception 'el mínimo ignoró el descuento';
  end if;

  -- Mostrador exento: si el dueño quiere venderle un chicle, es su decisión.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_biz, v_cliente, '593900000826', 'manual', 'pendiente', 0.50, 0.50);

  -- ── El tope por hora ────────────────────────────────────────────────────
  update public.businesses set min_order_amount = 0, max_orders_per_hour = 3 where id = v_biz;
  delete from public.orders where business_id = v_biz;

  -- ⚠️ CUARENTA PERSONAS DISTINTAS: el freno por cliente no las ve. Este sí.
  for v_i in 1..3 loop
    insert into public.customers (phone) values ('59390000090' || v_i);
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (
      v_biz,
      (select id from public.customers where phone = '59390000090' || v_i),
      '59390000090' || v_i, 'storefront', 'pendiente', 1.50, 1.50
    );
  end loop;

  v_rechazado := false;
  begin
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (v_biz, v_cliente, '593900000826', 'storefront', 'pendiente', 1.50, 1.50);
    raise exception 'el cuarto pedido de la hora debía rechazarse';
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  if not v_rechazado then
    raise exception 'el tope por hora no actuó con clientes distintos';
  end if;

  -- ⚠️ Cuenta TAMBIÉN los cancelados: un pedido cancelado ocupó a alguien, y
  -- contarlos solo «abiertos» dejaría el freno inútil justo cuando el dueño va
  -- cancelando la avalancha a mano.
  update public.orders set status = 'cancelado' where business_id = v_biz and source = 'storefront';
  v_rechazado := false;
  begin
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (v_biz, v_cliente, '593900000826', 'storefront', 'pendiente', 1.50, 1.50);
    raise exception 'cancelar la avalancha no puede levantar el tope';
  exception when insufficient_privilege then
    v_rechazado := true;
  end;
  if not v_rechazado then
    raise exception 'el tope por hora se levantó al cancelar';
  end if;

  -- Pasada la hora vuelve a vender.
  update public.orders set created_at = now() - interval '2 hours' where business_id = v_biz;
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_biz, v_cliente, '593900000826', 'storefront', 'pendiente', 1.50, 1.50);

  -- Ni el mínimo ni el tope aceptan valores imposibles.
  begin
    update public.businesses set max_orders_per_hour = 0 where id = v_biz;
    raise exception 'un tope de cero dejaría al local sin poder vender';
  exception when check_violation then null;
  end;
  begin
    update public.businesses set min_order_amount = -1 where id = v_biz;
    raise exception 'un mínimo negativo no tiene sentido';
  exception when check_violation then null;
  end;

  delete from public.businesses where id = v_biz;
  delete from public.customers where phone like '5939000009%' or phone = '593900000826';
end;
$$;

select '✅ mínimo de compra y tope por hora: sin envío, con descuento, mostrador exento' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- PEDIR SUELTA EL TECHO · AL BLOQUEADO SE LE EXPLICA UNA VEZ (2026-08-27)
--
-- Armar un pedido dentro del chat son 15-25 mensajes, así que quien pedía dos
-- veces en la misma hora se comía el techo de 25 y quedaba mudo 12 h: el
-- cliente que MÁS pide era el que más cerca estaba del silencio.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_biz uuid;
  v_cliente uuid;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verificacion-aviso', 'Local Aviso', 'pizzería', 'marketplace', true, true)
  returning id into v_biz;
  insert into public.customers (phone) values ('593900000827')
  returning id into v_cliente;

  -- ── Pedir suelta el techo ───────────────────────────────────────────────
  insert into public.marketplace_conversations
    (customer_id, reply_count, reply_window_start, muted_until)
  values (v_cliente, 20, now(), now() + interval '2 hours');

  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_biz, v_cliente, '593900000827', 'storefront', 'pendiente', 10.00, 10.00);

  if (select reply_count from public.marketplace_conversations where customer_id = v_cliente) <> 0 then
    raise exception 'crear un pedido debía soltar el contador del techo';
  end if;

  -- ⚠️ Pero NO levanta un silencio ya caído: si bastara con pedir para
  -- recuperar la voz, el silenciado haría un pedido falso y volvería a empezar.
  if (select muted_until from public.marketplace_conversations where customer_id = v_cliente) is null then
    raise exception 'pedir no puede levantar un silencio ya activo';
  end if;

  -- El de MOSTRADOR lo teclea el dueño con la persona delante: no puede ser
  -- una vía para soltarle el contador a nadie.
  update public.marketplace_conversations set reply_count = 15 where customer_id = v_cliente;
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_biz, v_cliente, '593900000827', 'manual', 'pendiente', 10.00, 10.00);

  if (select reply_count from public.marketplace_conversations where customer_id = v_cliente) <> 15 then
    raise exception 'el pedido de mostrador no debía tocar el contador';
  end if;

  -- ── El aviso al bloqueado, una sola vez ─────────────────────────────────
  insert into public.business_customers (business_id, customer_id)
  values (v_biz, v_cliente)
  on conflict (business_id, customer_id) do nothing;

  -- Sin bloqueo no hay nada que explicar: sin esta condición, la primera
  -- visita de CUALQUIER cliente gastaría el reclamo en silencio.
  if public.claim_blocked_notice(v_biz, v_cliente) is not false then
    raise exception 'no se puede reclamar el aviso de quien no está bloqueado';
  end if;

  update public.business_customers set blocked_at = now()
   where business_id = v_biz and customer_id = v_cliente;

  if public.claim_blocked_notice(v_biz, v_cliente) is not true then
    raise exception 'el primer intento del bloqueado debía llevar explicación';
  end if;

  -- La segunda NO: avisar en cada intento haría que el bloqueado costara más
  -- mensajes que un cliente normal, y quien molesta insiste.
  if public.claim_blocked_notice(v_biz, v_cliente) is not false then
    raise exception 'el aviso debía salir UNA sola vez';
  end if;

  -- Desbloquear y volver a bloquear es una decisión NUEVA del dueño, y merece
  -- su propia explicación. Sin limpiar la marca, el segundo bloqueo sería mudo.
  update public.business_customers set blocked_at = null, blocked_notified_at = null
   where business_id = v_biz and customer_id = v_cliente;
  update public.business_customers set blocked_at = now()
   where business_id = v_biz and customer_id = v_cliente;

  if public.claim_blocked_notice(v_biz, v_cliente) is not true then
    raise exception 'un bloqueo nuevo merece su propia explicación';
  end if;

  -- Y no cruza la frontera del negocio ni la del cliente.
  if public.claim_blocked_notice(gen_random_uuid(), v_cliente) is not false
     or public.claim_blocked_notice(v_biz, gen_random_uuid()) is not false then
    raise exception 'el aviso cruzó la frontera del negocio o del cliente';
  end if;

  delete from public.businesses where id = v_biz;
  delete from public.marketplace_conversations where customer_id = v_cliente;
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ pedir suelta el techo · al bloqueado se le explica una vez' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL PEDIDO SIN PAGAR CADUCA SOLO (2026-08-28)
--
-- Primera tarea que cambia el estado de un pedido sola. Lo que se comprueba
-- aquí no es que expire —eso es fácil— sino los CUATRO frenos que sustituyen a
-- la vieja prohibición: que no toque al que ya pagó, que respete la ventana
-- del dueño, que no barra el histórico y que se pueda apagar.
--
-- ⚠️ CADA PEDIDO ES DE UN CLIENTE DISTINTO, y no por realismo: con todos del
-- mismo, el disparador `orders_limit_open_per_customer` —3 abiertos en 6 h,
-- del 2026-08-25— rechaza el cuarto y el escenario ni llega a montarse. Lo
-- cazó el CI a la primera, que es justo para lo que está.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_biz uuid;
  v_reciente uuid;
  v_vencido uuid;
  v_pagado uuid;
  v_antiguo uuid;
  v_mostrador uuid;
  v_n integer;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verificacion-caducan', 'Local Caduca', 'pizzería', 'marketplace', true, true)
  returning id into v_biz;

  insert into public.customers (phone) values
    ('593900000841'), ('593900000842'), ('593900000843'),
    ('593900000844'), ('593900000845');

  -- ⚠️ Nace en 15 minutos desde el 2026-08-31. Eran 120, y esta comprobación
  -- existe justo para que el número no se mueva sin que alguien lo decida:
  -- cazó este cambio a la primera. Dos horas es tiempo de sobra para
  -- transferir, y mientras tanto el pedido ocupa el candado del cliente y la
  -- cabeza del dueño. Medido contra lo que tarda de verdad una transferencia
  -- —abrir el banco, buscar la cuenta, el código de un solo uso, volver y
  -- mandar la foto— son unos 8 minutos.
  if (select payment_window_minutes from public.businesses where id = v_biz) <> 15 then
    raise exception 'el valor de arranque de la ventana de pago cambió sin querer';
  end if;

  update public.businesses set payment_window_minutes = 60 where id = v_biz;

  -- 1. Recién hecho: NO se toca.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  select v_biz, id, phone, 'storefront', 'esperando_pago', 10, 10
  from public.customers where phone = '593900000841'
  returning id into v_reciente;

  -- 2. Vencido: este SÍ.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total, created_at)
  select v_biz, id, phone, 'storefront', 'esperando_pago', 10, 10, now() - interval '3 hours'
  from public.customers where phone = '593900000842'
  returning id into v_vencido;

  -- 3. Vencido PERO con comprobante: no es un pedido sin pagar.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total, created_at, payment_proof_url)
  select v_biz, id, phone, 'storefront', 'esperando_pago', 10, 10, now() - interval '3 hours', 'https://ejemplo/comprobante.jpg'
  from public.customers where phone = '593900000843'
  returning id into v_pagado;

  -- 4. De hace dos días: histórico, fuera de la ventana superior.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total, created_at)
  select v_biz, id, phone, 'storefront', 'esperando_pago', 10, 10, now() - interval '2 days'
  from public.customers where phone = '593900000844'
  returning id into v_antiguo;

  -- 5. De mostrador: lo teclea el dueño con la persona delante.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total, created_at)
  select v_biz, id, phone, 'manual', 'esperando_pago', 10, 10, now() - interval '3 hours'
  from public.customers where phone = '593900000845'
  returning id into v_mostrador;

  select count(*) into v_n from public.expire_unpaid_orders(20);
  if v_n <> 1 then
    raise exception 'debía expirar EXACTAMENTE uno, y expiró %', v_n;
  end if;

  if (select status from public.orders where id = v_vencido) <> 'expirado' then
    raise exception 'el pedido vencido debía expirar';
  end if;
  if (select status from public.orders where id = v_reciente) <> 'esperando_pago' then
    raise exception 'un pedido recién hecho no puede expirar';
  end if;
  -- ⚠️ El más importante: quien mandó su comprobante YA PAGÓ. Expirarlo sería
  -- quedarse con su dinero y cancelarle el pedido.
  if (select status from public.orders where id = v_pagado) <> 'esperando_pago' then
    raise exception 'NUNCA se expira a quien ya mandó comprobante';
  end if;
  if (select status from public.orders where id = v_antiguo) <> 'esperando_pago' then
    raise exception 'la ventana de 24 h debía dejar el histórico intacto';
  end if;
  if (select status from public.orders where id = v_mostrador) <> 'esperando_pago' then
    raise exception 'el pedido de mostrador no se expira';
  end if;

  -- Dejó su rastro, como cualquier cambio de estado hecho por la vía buena.
  if not exists (
    select 1 from public.order_events
    where order_id = v_vencido and to_status = 'expirado'
  ) then
    raise exception 'expirar debía quedar registrado en order_events';
  end if;

  -- Un pedido en revisión JAMÁS se toca: el cliente ya pagó y espera al dueño.
  update public.orders set status = 'pago_en_revision', payment_proof_url = null,
         created_at = now() - interval '5 hours'
   where id = v_reciente;
  select count(*) into v_n from public.expire_unpaid_orders(20);
  if v_n <> 0 then
    raise exception 'un pedido en revisión no puede expirar';
  end if;

  -- Apagado (0) no toca nada, por vencido que esté.
  update public.orders set status = 'esperando_pago', created_at = now() - interval '5 hours'
   where id = v_reciente;
  update public.businesses set payment_window_minutes = 0 where id = v_biz;
  select count(*) into v_n from public.expire_unpaid_orders(20);
  if v_n <> 0 then
    raise exception 'con la ventana en 0 no debía expirar nada';
  end if;

  -- Y el tope por tanda manda: es el freno contra los cien avisos de golpe.
  update public.businesses set payment_window_minutes = 60 where id = v_biz;
  select count(*) into v_n from public.expire_unpaid_orders(1);
  if v_n <> 1 then
    raise exception 'el tope por tanda no se respetó: %', v_n;
  end if;

  delete from public.businesses where id = v_biz;
  delete from public.customers where phone like '59390000084%' or phone = '593900000845';
end;
$$;

select '✅ el pedido sin pagar caduca solo: ni el pagado, ni el histórico, ni el de mostrador' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- QUIEN DEJA TRES PEDIDOS SIN PAGAR SE QUEDA FUERA DE ESE LOCAL (2026-08-31)
--
-- Un mismo teléfono dejó SEIS pedidos sin pagar en Monster Pizza: pedía, no
-- transfería, el pedido caducaba, el candado se soltaba y volvía a pedir.
-- Se EJECUTA la función, no se comprueba que exista: una que existe y cuenta
-- mal bloquea a un cliente honesto o no frena a ninguno.
do $$
declare
  v_biz      uuid;
  v_cliente  uuid;
  v_pedido   uuid;
  v_r        jsonb;
  v_bloqueo  timestamptz;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verificacion-faltas', 'Local Faltas', 'pizzería', 'marketplace', true, true)
  returning id into v_biz;

  insert into public.customers (phone) values ('593900000931')
  returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id)
  values (v_biz, v_cliente);

  insert into public.orders (business_id, customer_id, contact_phone, status, subtotal, total, source)
  values (v_biz, v_cliente, '593900000931', 'expirado', 10, 10, 'storefront')
  returning id into v_pedido;

  -- Primera falta: cuenta, pero NO bloquea.
  v_r := public.register_unpaid_expiry(v_biz, v_pedido);
  if (v_r ->> 'strikes')::int <> 1 or (v_r ->> 'blocked')::boolean then
    raise exception 'la primera falta no debía bloquear: %', v_r;
  end if;

  -- ⚠️ Segunda: AHORA SÍ bloquea. El límite bajó de 3 a 2 el 2026-08-31, y
  -- esta comprobación decía lo contrario — para eso está.
  v_r := public.register_unpaid_expiry(v_biz, v_pedido);
  if (v_r ->> 'strikes')::int <> 2 or not (v_r ->> 'blocked')::boolean then
    raise exception 'la segunda falta TENÍA que bloquear: %', v_r;
  end if;

  -- ⚠️ El límite bajó a DOS el 2026-08-31, así que la segunda YA bloqueó
  -- arriba. La tercera solo comprueba que seguir contando no rompe nada.
  v_r := public.register_unpaid_expiry(v_biz, v_pedido);
  if (v_r ->> 'strikes')::int <> 3 or not (v_r ->> 'blocked')::boolean then
    raise exception 'la tercera falta TENÍA que seguir bloqueando: %', v_r;
  end if;

  select blocked_at into v_bloqueo from public.business_customers
  where business_id = v_biz and customer_id = v_cliente;
  if v_bloqueo is null then
    raise exception 'el bloqueo no llegó a la fila';
  end if;

  -- ⚠️ Y una cuarta no PISA `blocked_at`: si el dueño lo desbloquea y vuelve a
  -- caer, la fecha original importa para saber qué pasó. Lo que sí se renueva
  -- es `blocked_until`, que es de ESTE bloqueo.
  v_r := public.register_unpaid_expiry(v_biz, v_pedido);
  if (select blocked_at from public.business_customers
      where business_id = v_biz and customer_id = v_cliente) <> v_bloqueo then
    raise exception 'la cuarta falta pisó la fecha del bloqueo';
  end if;

  -- ⚠️ Un pedido de OTRO negocio no suma faltas aquí: quien abandona en una
  -- pizzería puede ser impecable en la heladería de al lado.
  v_r := public.register_unpaid_expiry(gen_random_uuid(), v_pedido);
  if (v_r ->> 'strikes')::int <> 0 then
    raise exception 'una falta se contó cruzando negocios: %', v_r;
  end if;

  delete from public.businesses where id = v_biz;
  delete from public.customers where phone = '593900000931';
end;
$$;

select '✅ dos pedidos sin pagar bloquean en ESE local, avisando antes y sin cruzar negocios' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL BLOQUEO CADUCA SOLO (2026-09-01)
--
-- Hasta hoy `blocked_at` era para siempre y el aviso al cliente no podía
-- prometer un plazo. Ahora hay dos formas y tienen que distinguirse bien:
-- permanente (el del dueño) y temporal (el automático, que vuelve solo).
--
-- Se EJECUTA `storefront_customer_blocked` en los cuatro casos, porque es la
-- función que decide si alguien puede comprar: si contestara mal, o deja pedir
-- a un bloqueado o deja fuera para siempre a quien cumplió su plazo.
do $$
declare
  v_biz     uuid;
  v_cliente uuid;
  v_pedido  uuid;
  v_r       jsonb;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled, block_minutes)
  values ('verificacion-bloqueo-temporal', 'Local Bloqueo', 'pizzería', 'marketplace', true, true, 30)
  returning id into v_biz;

  insert into public.customers (phone) values ('593900000941') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id) values (v_biz, v_cliente);

  -- 1. Sin nada puesto: puede pedir.
  if public.storefront_customer_blocked(v_biz, v_cliente) then
    raise exception 'un cliente sin bloquear salió bloqueado';
  end if;

  -- 2. Bloqueo TEMPORAL vigente: no puede.
  v_r := public.block_customer_temporarily(v_biz, v_cliente, 'prueba');
  if (v_r ->> 'minutes')::int <> 30 then
    raise exception 'el bloqueo no tomó los minutos del local: %', v_r;
  end if;
  if not public.storefront_customer_blocked(v_biz, v_cliente) then
    raise exception 'el bloqueo temporal no bloquea';
  end if;

  -- ⚠️ Y se puede volver a avisar: es un bloqueo NUEVO, aunque ya se le
  -- hubiera explicado uno anterior.
  if (select blocked_notified_at from public.business_customers
      where business_id = v_biz and customer_id = v_cliente) is not null then
    raise exception 'el bloqueo nuevo no reabrió el aviso';
  end if;

  -- 3. CADUCADO: vuelve a poder pedir SOLO, sin que nadie lo levante.
  update public.business_customers
  set blocked_until = now() - interval '1 minute'
  where business_id = v_biz and customer_id = v_cliente;
  if public.storefront_customer_blocked(v_biz, v_cliente) then
    raise exception 'un bloqueo temporal vencido sigue bloqueando';
  end if;

  -- 4. PERMANENTE (el del dueño): sin fin, y no caduca nunca.
  update public.business_customers
  set blocked_at = now(), blocked_until = null
  where business_id = v_biz and customer_id = v_cliente;
  if not public.storefront_customer_blocked(v_biz, v_cliente) then
    raise exception 'el bloqueo permanente del dueño dejó de bloquear';
  end if;

  -- ⚠️ Y un bloqueo automático NO puede pisar la decisión del dueño
  -- convirtiéndola en 30 minutos.
  v_r := public.block_customer_temporarily(v_biz, v_cliente, 'intento');
  if not coalesce((v_r ->> 'permanente')::boolean, false) then
    raise exception 'un bloqueo temporal pisó el permanente del dueño: %', v_r;
  end if;
  if not public.storefront_customer_blocked(v_biz, v_cliente) then
    raise exception 'el permanente se perdió tras el intento temporal';
  end if;

  -- 5. Y el contador de pedidos: al SEGUNDO bloquea, no al tercero.
  update public.business_customers
  set blocked_at = null, blocked_until = null, unpaid_expiries = 0
  where business_id = v_biz and customer_id = v_cliente;

  insert into public.orders (business_id, customer_id, contact_phone, status, subtotal, total, source)
  values (v_biz, v_cliente, '593900000941', 'expirado', 10, 10, 'storefront')
  returning id into v_pedido;

  v_r := public.register_unpaid_expiry(v_biz, v_pedido);
  if (v_r ->> 'strikes')::int <> 1 or (v_r ->> 'blocked')::boolean then
    raise exception 'la primera falta no debía bloquear: %', v_r;
  end if;

  v_r := public.register_unpaid_expiry(v_biz, v_pedido);
  if (v_r ->> 'strikes')::int <> 2 or not (v_r ->> 'blocked')::boolean then
    raise exception 'la SEGUNDA falta tenía que bloquear: %', v_r;
  end if;
  -- Y el bloqueo que pone es TEMPORAL: tiene fin.
  if (select blocked_until from public.business_customers
      where business_id = v_biz and customer_id = v_cliente) is null then
    raise exception 'el bloqueo por pedidos sin pagar salió permanente';
  end if;

  delete from public.businesses where id = v_biz;
  delete from public.customers where phone = '593900000941';
end;
$$;

select '✅ el bloqueo temporal caduca solo, no pisa el del dueño, y dos faltas bastan' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- INSISTIR CON IMÁGENES QUE NO SON UN PAGO CUESTA (2026-09-01)
--
-- La compuerta ya rechazaba la foto de un perro y pedía la captura buena. Lo
-- que faltaba es que la SEGUNDA seguida tuviera consecuencia.
--
-- ⚠️ El contador se pone a CERO con un comprobante bueno: cuenta la
-- insistencia, no el historial. Sin eso, un cliente fiel acabaría bloqueado
-- por dos despistes separados por meses — y esa es la parte que más fácil se
-- rompe al tocar esto, así que se ejecuta.
do $$
declare
  v_biz     uuid;
  v_cliente uuid;
  v_r       jsonb;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled, block_minutes)
  values ('verificacion-rechazos', 'Local Rechazos', 'pizzería', 'marketplace', true, true, 45)
  returning id into v_biz;

  insert into public.customers (phone) values ('593900000951') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id) values (v_biz, v_cliente);

  -- 1ª imagen que no es un pago: cuenta, avisa, NO bloquea.
  v_r := public.register_rejected_receipt(v_biz, v_cliente);
  if (v_r ->> 'strikes')::int <> 1 or (v_r ->> 'blocked')::boolean then
    raise exception 'el primer rechazo no debía bloquear: %', v_r;
  end if;
  if public.storefront_customer_blocked(v_biz, v_cliente) then
    raise exception 'el primer rechazo dejó al cliente bloqueado';
  end if;

  -- 2ª: bloquea, y con los minutos DE ESTE LOCAL.
  v_r := public.register_rejected_receipt(v_biz, v_cliente);
  if (v_r ->> 'strikes')::int <> 2 or not (v_r ->> 'blocked')::boolean then
    raise exception 'el segundo rechazo TENÍA que bloquear: %', v_r;
  end if;
  if (v_r ->> 'minutes')::int <> 45 then
    raise exception 'el bloqueo no tomó los minutos del local: %', v_r;
  end if;
  if not public.storefront_customer_blocked(v_biz, v_cliente) then
    raise exception 'el segundo rechazo no bloqueó de verdad';
  end if;

  -- ⚠️ Y un comprobante BUENO borra la cuenta.
  perform public.clear_rejected_receipts(v_biz, v_cliente);
  if (select rejected_receipts from public.business_customers
      where business_id = v_biz and customer_id = v_cliente) <> 0 then
    raise exception 'un comprobante bueno no puso a cero la cuenta';
  end if;

  -- ⚠️ Pero NO levanta el bloqueo que ya estaba: son dos cosas distintas, y
  -- mandar una captura buena después de quedar fuera no reabre el local.
  if not public.storefront_customer_blocked(v_biz, v_cliente) then
    raise exception 'limpiar los rechazos levantó el bloqueo';
  end if;

  -- Tras limpiar, vuelve a hacer falta insistir dos veces.
  update public.business_customers
  set blocked_at = null, blocked_until = null
  where business_id = v_biz and customer_id = v_cliente;
  v_r := public.register_rejected_receipt(v_biz, v_cliente);
  if (v_r ->> 'strikes')::int <> 1 or (v_r ->> 'blocked')::boolean then
    raise exception 'la cuenta no arrancó de cero tras el comprobante bueno: %', v_r;
  end if;

  delete from public.businesses where id = v_biz;
  delete from public.customers where phone = '593900000951';
end;
$$;

select '✅ dos imágenes que no son un pago bloquean un rato, y una buena pone la cuenta a cero' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- UN SOLO PEDIDO SIN PAGAR A LA VEZ (2026-09-02)
--
-- Lo encontró el dueño probando: pidió, no pagó, volvió al chat, le dieron un
-- enlace nuevo y creó OTRO pedido. El primero se quedó en el limbo. Con el tope
-- de 3 podía repetirlo tres veces, y el dueño veía tres comandas de la misma
-- persona por un solo pedido real.
--
-- Se ejecuta el disparador insertando de verdad, porque lo que hay que
-- demostrar es que RECHAZA — y un `raise` que no salta no se ve leyendo.
do $$
declare
  v_biz   uuid;
  v_cli   uuid;
  v_uno   uuid;
  v_error text;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verificacion-un-pedido', 'Local Un Pedido', 'pizzería', 'marketplace', true, true)
  returning id into v_biz;
  insert into public.customers (phone) values ('593900000961') returning id into v_cli;

  -- El primero entra sin problema.
  insert into public.orders (business_id, customer_id, contact_phone, status, subtotal, total, source)
  values (v_biz, v_cli, '593900000961', 'esperando_pago', 10, 10, 'storefront')
  returning id into v_uno;

  -- ⚠️ El SEGUNDO tiene que ser rechazado mientras el primero espera pago.
  begin
    insert into public.orders (business_id, customer_id, contact_phone, status, subtotal, total, source)
    values (v_biz, v_cli, '593900000961', 'esperando_pago', 10, 10, 'storefront');
    raise exception 'se pudo crear un segundo pedido debiendo un comprobante';
  exception when insufficient_privilege then
    get stacked diagnostics v_error = message_text;
    if v_error not like '%comprobante%' then
      raise exception 'rechazó, pero con el mensaje equivocado: %', v_error;
    end if;
  end;

  -- ⚠️ Y tampoco en OTRO local: el número es único para todo Umbani, así que
  -- la heladería no tiene forma de saber que debe algo en la pizzería.
  declare v_otro uuid;
  begin
    insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
    values ('verificacion-un-pedido-2', 'Otro Local', 'pizzería', 'marketplace', true, true)
    returning id into v_otro;
    begin
      insert into public.orders (business_id, customer_id, contact_phone, status, subtotal, total, source)
      values (v_otro, v_cli, '593900000961', 'esperando_pago', 10, 10, 'storefront');
      raise exception 'pudo pedir en otro local debiendo un comprobante';
    exception when insufficient_privilege then
      null;
    end;
    delete from public.businesses where id = v_otro;
  end;

  -- ⚠️ Al MANDAR el comprobante (`pago_en_revision`) vuelve a poder pedir: ya
  -- no debe nada, espera al dueño. Retenerlo ahí sería castigarlo porque el
  -- local va lento.
  update public.orders set status = 'pago_en_revision' where id = v_uno;
  insert into public.orders (business_id, customer_id, contact_phone, status, subtotal, total, source)
  values (v_biz, v_cli, '593900000961', 'pendiente', 10, 10, 'storefront');

  -- Y un pedido que NO viene de la tienda nunca se frena: el de mostrador lo
  -- teclea el dueño con la persona delante, y si quiere meter cinco seguidos
  -- es su cocina y su decisión.
  insert into public.orders (business_id, customer_id, contact_phone, status, subtotal, total, source)
  values (v_biz, v_cli, 'mostrador', 'esperando_pago', 10, 10, 'manual');

  delete from public.businesses where id = v_biz;
  delete from public.customers where phone = '593900000961';
end;
$$;

select '✅ un solo pedido sin pagar a la vez, en toda la plataforma, sin frenar al que ya mandó su comprobante' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL MARGEN SE SUMA AL PRECIO, NO SE LE QUITA AL DUEÑO (2026-08-25)
--
-- Hasta hoy, sobre un pedido de $8 el comercio recibía $7,20. El dueño pone el
-- precio al que quiere vender; quitarle una parte es un descuento que no pactó.
--
-- ⚠️ El disparador NO se tocó en esta entrega: ya sabía hacer `on_top`, y
-- mejor —por línea y restando el descuento—. Lo que faltaba era el CHECK que
-- lo impedía y la vista que el catálogo necesita. Aquí se comprueban las dos,
-- y que lo sellado no cambie.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_biz uuid;
  v_cliente uuid;
  v_regla uuid;
  v_pedido uuid;
  v_vista jsonb;
  v_merchant numeric;
  v_markup numeric;
  v_total numeric;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled, delivery_fee)
  values ('verificacion-margen', 'Local Margen', 'pizzería', 'marketplace', true, true, 1.50)
  returning id into v_biz;
  insert into public.customers (phone) values ('593900000861') returning id into v_cliente;

  -- Una regla de NEGOCIO al 10 %, sumada al precio. Que esto se pueda guardar
  -- ES la corrección: hasta hoy el CHECK lo impedía.
  insert into public.pricing_rules (business_id, scope, strategy, percentage, markup_mode, status)
  values (v_biz, 'business', 'percentage', 10, 'on_top', 'active')
  returning id into v_regla;

  -- ── La vista que consume el catálogo ────────────────────────────────────
  v_vista := public.business_pricing_view(v_biz);
  if v_vista is null or (v_vista ->> 'mode') <> 'on_top'
     or (v_vista ->> 'percentage')::numeric <> 10 then
    raise exception 'el catálogo no vería la regla vigente: %', v_vista;
  end if;

  -- La jerarquía manda: una regla de NEGOCIO gana a la de su TIPO.
  --
  -- ⚠️ Se prueba con `business_type` y no con `global` porque
  -- `idx_pricing_rules_activa_global` solo admite UNA global activa, y en una
  -- base con datos ya existe. Lo cazó el ensayo contra producción.
  insert into public.pricing_rules (scope, target_name, strategy, percentage, markup_mode, status)
  values ('business_type', 'pizzería', 'percentage', 99, 'on_top', 'active');
  v_vista := public.business_pricing_view(v_biz);
  if (v_vista ->> 'percentage')::numeric <> 10 then
    raise exception 'la regla del tipo no puede ganarle a la del negocio: %', v_vista;
  end if;
  delete from public.pricing_rules where scope = 'business_type' and percentage = 99;

  -- ── Un pedido de $8 con envío de $1,50 ──────────────────────────────────
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, shipping, total)
  values (v_biz, v_cliente, '593900000861', 'storefront', 'pendiente', 8.00, 1.50, 9.50)
  returning id into v_pedido;

  select merchant_subtotal, platform_markup, total
    into v_merchant, v_markup, v_total
  from public.orders where id = v_pedido;

  -- ⚠️ EL COMERCIO COBRA ENTERO. Esta es la corrección: antes recibía 7,20.
  if v_merchant <> 8.00 then
    raise exception 'el comercio debía cobrar 8.00 entero, y cobró %', v_merchant;
  end if;
  if v_markup <> 0.80 then
    raise exception 'la plataforma debía ganar 0.80, y ganó %', v_markup;
  end if;
  -- ⚠️ EL ENVÍO QUEDA FUERA DEL MARGEN: 8 + 0,80 + 1,50 = 10,30, nunca el
  -- 10 % de 9,50.
  if v_total <> 10.30 then
    raise exception 'el cliente debía pagar 10.30 y paga %', v_total;
  end if;

  -- ── EL PEDIDO YA SELLADO NO CAMBIA CUANDO CAMBIA EL PORCENTAJE ──────────
  --
  -- Es la garantía que hace auditable el histórico: subir la comisión mañana
  -- no puede reescribir lo que se cobró ayer.
  update public.pricing_rules set percentage = 25 where id = v_regla;
  update public.orders set status = 'confirmado' where id = v_pedido;

  select merchant_subtotal, platform_markup, total
    into v_merchant, v_markup, v_total
  from public.orders where id = v_pedido;

  if v_markup <> 0.80 or v_merchant <> 8.00 or v_total <> 10.30 then
    raise exception 'un pedido sellado cambió al mover el porcentaje: markup=% comercio=% total=%',
      v_markup, v_merchant, v_total;
  end if;

  -- ── El descuento sale de la base ANTES del porcentaje ───────────────────
  update public.pricing_rules set percentage = 10 where id = v_regla;
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, discount, shipping, total)
  values (v_biz, v_cliente, '593900000861', 'storefront', 'pendiente', 100, 20, 0, 100)
  returning platform_markup, merchant_subtotal into v_markup, v_merchant;
  if v_markup <> 8.00 then
    raise exception 'con 20 de descuento el margen debía ser 8.00 (10 %% de 80), y fue %', v_markup;
  end if;
  if v_merchant <> 80.00 then
    raise exception 'el comercio debía cobrar 80.00 tras su descuento, y cobró %', v_merchant;
  end if;

  -- ── `absorbed` sigue funcionando para lo ya cobrado ─────────────────────
  update public.pricing_rules set markup_mode = 'absorbed' where id = v_regla;
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, shipping, total)
  values (v_biz, v_cliente, '593900000861', 'storefront', 'pendiente', 8.00, 0, 8.00)
  returning merchant_subtotal, platform_markup into v_merchant, v_markup;
  if v_merchant <> 7.20 or v_markup <> 0.80 then
    raise exception 'absorbed debía descontar: comercio=% markup=%', v_merchant, v_markup;
  end if;

  delete from public.businesses where id = v_biz;
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ el margen se suma al precio: el comercio cobra entero, el envío queda fuera y lo sellado no cambia' as resultado;


-- ═══════════════════════════════════════════════════════════════════════════
-- EL CANDADO DURA HASTA PAGAR, Y EL TOPE ES DE LA PERSONA (2026-08-30)
--
-- Nace del escenario que el dueño describió: pedir en un local, no pagar,
-- escribir MENÚ, y repetir en el siguiente. Se colaba por dos sitios a la vez
-- —el tope contaba por local, y el candado se soltaba al CREAR el pedido—, así
-- que aquí se comprueban los dos y, sobre todo, que el freno NO se pase de
-- listo: quien paga tiene que quedar libre.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_a uuid; v_b uuid; v_c uuid; v_d uuid;
  v_cliente uuid;
  v_pedido uuid;
  v_bloqueado boolean;
  v_local uuid;
  v_falló boolean;
begin
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verif-candado-a', 'Pizzeria', 'pizzería', 'marketplace', true, true) returning id into v_a;
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verif-candado-b', 'Cevicheria', 'pizzería', 'marketplace', true, true) returning id into v_b;
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verif-candado-c', 'Asadero', 'pizzería', 'marketplace', true, true) returning id into v_c;
  insert into public.businesses (slug, name, type, whatsapp_provider, takes_orders, storefront_enabled)
  values ('verif-candado-d', 'Heladeria', 'pizzería', 'marketplace', true, true) returning id into v_d;

  insert into public.customers (phone) values ('593900000900') returning id into v_cliente;

  -- ── 1. EL SALTO ENTRE LOCALES ────────────────────────────────────────────
  --
  -- ⚠️ Esta comprobación cambió el 2026-09-02, y el cambio es que el freno se
  -- ENDURECIÓ. Antes montaba tres pedidos sin pagar —uno por local— y exigía
  -- que rebotara el CUARTO. Ahora rebota el SEGUNDO: quien debe un comprobante
  -- no puede encargar nada más, ni en el mismo local ni en otro.
  --
  -- Lo pidió el dueño tras encontrar el hueco probando: pedía, no pagaba,
  -- volvía al chat y creaba otro. El tope de 3 protegía la cocina del local,
  -- no el bolsillo de nadie.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_a, v_cliente, '593900000900', 'storefront', 'esperando_pago', 5, 5);

  -- El SEGUNDO local tiene que rebotar aunque en él no haya ni un pedido: el
  -- número es único para todo Umbani, así que la cevichería no tiene forma de
  -- saber que este cliente debe algo en la pizzería.
  v_falló := false;
  begin
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (v_b, v_cliente, '593900000900', 'storefront', 'esperando_pago', 5, 5);
  exception when insufficient_privilege then
    v_falló := true;
  end;
  if not v_falló then
    raise exception 'el salto entre locales se coló: se pudo pedir en otro local debiendo un comprobante';
  end if;

  -- ── 2. EL DE MOSTRADOR NO CUENTA ─────────────────────────────────────────
  -- Lo teclea el dueño con la persona delante.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_d, v_cliente, '593900000900', 'manual', 'pendiente', 5, 5);

  -- ── 3. PAGAR SUELTA EL CANDADO ───────────────────────────────────────────
  insert into public.marketplace_conversations
    (customer_id, current_state, selected_business_id, shopping_locked)
  values (v_cliente, 'comprando', v_a, true);

  -- ⚠️ El escenario de DOS pendientes se monta con un UPDATE, no insertando:
  -- desde el 2026-09-02 el disparador `orders_limit_open_per_customer` impide
  -- crear un segundo pedido debiendo un comprobante, así que por la vía normal
  -- ya no puede ocurrir. La defensa del candado sigue haciendo falta —quedan
  -- los pedidos históricos y los que no vienen de la tienda—, y es justo lo
  -- que esta comprobación protege: soltarlo con uno pendiente sería premiar el
  -- pago parcial con vía libre.
  -- Se convierte en uno de la TIENDA, que es lo que mira el candado: un
  -- `manual` no cuenta ahí, igual que no cuenta para el tope.
  update public.orders set status = 'esperando_pago', source = 'storefront'
   where business_id = v_d and customer_id = v_cliente and source = 'manual';

  -- Resolver UNO no basta: le queda otro comprobante pendiente.
  update public.orders set status = 'preparacion'
   where business_id = v_a and customer_id = v_cliente and status = 'esperando_pago';
  select shopping_locked into v_bloqueado
    from public.marketplace_conversations where customer_id = v_cliente;
  if not v_bloqueado then
    raise exception 'el candado se soltó con un comprobante todavía pendiente';
  end if;

  -- Resolver los dos que quedan sí lo suelta: ya no debe nada.
  update public.orders set status = 'preparacion'
   where customer_id = v_cliente and status = 'esperando_pago';
  select shopping_locked, selected_business_id into v_bloqueado, v_local
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_bloqueado then
    raise exception 'el candado NO se soltó tras resolver todos los pedidos';
  end if;
  -- Soltar el candado suelta el local: el CHECK prohíbe estar bloqueado en
  -- ninguna parte, y dejarlo elegido metería el siguiente mensaje en un local
  -- que la persona ya terminó.
  if v_local is not null then
    raise exception 'el candado se soltó pero el local siguió elegido';
  end if;

  -- ── 4. Y VUELVE A PODER PEDIR ────────────────────────────────────────────
  -- El freno estorba mientras se debe, no después. Si esto fallara, pagar
  -- dejaría a la persona igual de bloqueada que no pagar.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_d, v_cliente, '593900000900', 'storefront', 'esperando_pago', 5, 5)
  returning id into v_pedido;

  -- ── 5. MANDAR EL COMPROBANTE **NO** SUELTA EL CANDADO ────────────────────
  --
  -- ⚠️ ESTA AFIRMACIÓN SE INVIRTIÓ EL 2026-08-30, y se deja escrito por qué.
  -- Hasta esa fecha esta misma prueba exigía lo CONTRARIO: que `esperando_pago`
  -- → `pago_en_revision` soltara el candado, con el argumento de que retenerlo
  -- sería castigar al cliente porque el local va lento.
  --
  -- El argumento sigue siendo cierto y el dueño lo conoce: se le expuso y
  -- eligió cerrar. Pesó algo que aquel análisis no vio — con el candado suelto
  -- el cliente quedaba SIN LOCAL, así que su siguiente mensaje caía en el menú
  -- del marketplace y recibía «🙏 No te entendí, ¿qué deseas pedir?». Lo vivió
  -- con el pedido #75, mandando una foto mientras su comprobante estaba en
  -- revisión: el bot lo invitó a pedir en otro sitio.
  --
  -- El TOPE sigue contándolo igual: son dos preguntas distintas.
  update public.marketplace_conversations
     set shopping_locked = true, selected_business_id = v_d,
         current_state = 'esperando_comprobante'
   where customer_id = v_cliente;
  update public.orders set status = 'pago_en_revision' where id = v_pedido;
  select shopping_locked into v_bloqueado
    from public.marketplace_conversations where customer_id = v_cliente;
  if not v_bloqueado then
    raise exception 'mandar el comprobante soltó el candado: Umbani dejó de estar cerrado';
  end if;

  -- Y la conversación tiene que SABER que la foto ya llegó, o el bot le pedirá
  -- a esta persona una captura que acaba de mandar.
  if (select current_state from public.marketplace_conversations
       where customer_id = v_cliente) <> 'pago_en_revision' then
    raise exception 'la conversación no supo que el comprobante está en revisión';
  end if;

  -- ── 6. Y LO SUELTA CUANDO EL LOCAL LO ACEPTA ─────────────────────────────
  -- Es lo que impide que «cerrado» signifique «atrapado»: el candado se va en
  -- cualquier salida —aceptado, cancelado, rechazado o caducado—.
  update public.orders set status = 'preparacion' where id = v_pedido;
  select shopping_locked into v_bloqueado
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_bloqueado then
    raise exception 'aceptar el pedido NO soltó el candado';
  end if;

  delete from public.businesses where id in (v_a, v_b, v_c, v_d);
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ el candado dura hasta que el local ACEPTA, no hasta el comprobante, y el tope cuenta en toda la plataforma' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- UN ENLACE VIVO A LA VEZ (2026-09-03)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `revoke_other_storefront_sessions` cierra el agujero de los enlaces: el chat
-- impedía ir hacia atrás desde el 2026-08-30, pero los enlaces emitidos se
-- quedaban vivos para siempre y NADIE escribía `revoked_at` jamás.
--
-- Se ejecuta con los tres casos que la pueden romper, porque plpgsql no valida
-- su cuerpo hasta que corre: el enlace de otro local cae, el del local que
-- DEBE dinero no, y sin sesión que conservar no se toca nada.
do $$
declare
  v_pizza     uuid;
  v_ceviche   uuid;
  v_helado    uuid;
  v_cliente   uuid;
  v_s_pizza   uuid;
  v_s_cevi    uuid;
  v_s_helado  uuid;
  v_s_nueva   uuid;
  v_revocadas integer;
  v_estado    timestamptz;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values
    ('pizza-enlace-v', 'Pizza', 'pizzeria', 'ycloud', '+593900666001', '+593900666001', true, 'miniapp'),
    ('cevi-enlace-v', 'Cevichería', 'restaurante', 'ycloud', '+593900666002', '+593900666002', true, 'miniapp'),
    ('helado-enlace-v', 'Heladería', 'heladeria', 'ycloud', '+593900666003', '+593900666003', true, 'miniapp');

  select id into v_pizza   from businesses where slug = 'pizza-enlace-v';
  select id into v_ceviche from businesses where slug = 'cevi-enlace-v';
  select id into v_helado  from businesses where slug = 'helado-enlace-v';

  insert into public.customers (phone) values ('593900666100') returning id into v_cliente;

  -- Tres enlaces vivos de tres locales: el agujero, tal cual estaba.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_pizza,   v_cliente, repeat('a', 64), '593900666100', null) returning id into v_s_pizza;
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_ceviche, v_cliente, repeat('b', 64), '593900666100', null) returning id into v_s_cevi;
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_helado,  v_cliente, repeat('c', 64), '593900666100', null) returning id into v_s_helado;

  -- En la pizzería quedó un pedido sin pagar: los datos bancarios viven detrás
  -- de esa sesión, así que es intocable.
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total
  ) values (v_pizza, v_cliente, '593900666100', 'storefront', 'esperando_pago', 9, 9);

  -- Elige la heladería: enlace nuevo de ese local.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_helado, v_cliente, repeat('d', 64), '593900666100', null) returning id into v_s_nueva;

  v_revocadas := public.revoke_other_storefront_sessions(v_cliente, v_s_nueva);
  if v_revocadas <> 1 then
    raise exception 'debía revocar solo el enlace de la cevichería y revocó %', v_revocadas;
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_cevi;
  if v_estado is null then
    raise exception 'el enlace de OTRO local siguió vivo: se puede volver hacia atrás';
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_pizza;
  if v_estado is not null then
    raise exception 'se revocó el enlace de un local con un pedido SIN PAGAR';
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_helado;
  if v_estado is not null then
    raise exception 'se revocó un enlace del MISMO local recién entregado';
  end if;

  -- Resuelto el pedido, la pizzería deja de estar protegida.
  update public.orders set status = 'pago_en_revision'
   where business_id = v_pizza and customer_id = v_cliente;
  v_revocadas := public.revoke_other_storefront_sessions(v_cliente, v_s_nueva);
  if v_revocadas <> 1 then
    raise exception 'pagado el pedido, el enlace de la pizzería debía caer: %', v_revocadas;
  end if;

  -- Sin sesión que conservar no se toca nada: falla hacia dejar enlaces vivos.
  v_revocadas := public.revoke_other_storefront_sessions(
    v_cliente, '00000000-0000-0000-0000-000000000000'
  );
  if v_revocadas <> 0 then
    raise exception 'con una sesión inexistente revocó % enlaces', v_revocadas;
  end if;

  delete from businesses where id in (v_pizza, v_ceviche, v_helado);
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ un enlace vivo a la vez: cae el de otro local, sobrevive el del local vigente y el que debe dinero' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- «SEGUIR MI PEDIDO» MATA TODO LO DE ATRÁS (2026-09-16)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El dueño: «si se estaba haciendo el pedido pero el cliente lo dejó y
-- selecciona continuar con un pedido, que pase igual: todo lo de atrás no
-- funcione». `revoke_other_storefront_sessions` perdona TODAS las sesiones del
-- mismo local —para no vaciar un carrito que vive en memoria—, así que tras
-- «seguir» el enlace viejo de ese local seguía abriendo la tienda.
--
-- Esa protección casi no protege nada en WhatsApp: el navegador interno se
-- cierra al volver al chat, y el carrito se pierde con él. Cuando alguien
-- escribe «seguir mi pedido», su carrito YA no existe.
--
-- ⚠️ Lo que NO cede: el local que DEBE dinero. Ahí vive la captura del pago,
-- y el camino del dinero no se corta nunca.
do $$
declare
  v_pizza     uuid;
  v_ceviche   uuid;
  v_helado    uuid;
  v_cliente   uuid;
  v_s_vieja   uuid;
  v_s_nueva   uuid;
  v_s_cevi    uuid;
  v_s_helado  uuid;
  v_revocadas integer;
  v_estado    timestamptz;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values
    ('pizza-seguir-v', 'Pizza', 'pizzeria', 'ycloud', '+593900667001', '+593900667001', true, 'miniapp'),
    ('cevi-seguir-v', 'Cevichería', 'restaurante', 'ycloud', '+593900667002', '+593900667002', true, 'miniapp'),
    ('helado-seguir-v', 'Heladería', 'heladeria', 'ycloud', '+593900667003', '+593900667003', true, 'miniapp');

  select id into v_pizza   from businesses where slug = 'pizza-seguir-v';
  select id into v_ceviche from businesses where slug = 'cevi-seguir-v';
  select id into v_helado  from businesses where slug = 'helado-seguir-v';

  insert into public.customers (phone) values ('593900667100') returning id into v_cliente;

  -- El enlace VIEJO de la pizzería, del pedido que dejó a medias.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_pizza, v_cliente, repeat('e0', 32), '593900667100', null) returning id into v_s_vieja;
  -- Un local donde DEBE dinero: intocable.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_ceviche, v_cliente, repeat('e1', 32), '593900667100', null) returning id into v_s_cevi;
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total
  ) values (v_ceviche, v_cliente, '593900667100', 'storefront', 'esperando_pago', 9, 9);
  -- Otro local sin nada pendiente.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_helado, v_cliente, repeat('e2', 32), '593900667100', null) returning id into v_s_helado;

  -- «Seguir mi pedido»: enlace NUEVO de la misma pizzería.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_pizza, v_cliente, repeat('e3', 32), '593900667100', null) returning id into v_s_nueva;

  v_revocadas := public.revoke_storefront_sessions_except(v_cliente, v_s_nueva);
  if v_revocadas <> 2 then
    raise exception 'debía revocar el enlace viejo de la pizzería y el de la heladería, y revocó %', v_revocadas;
  end if;

  -- ⚠️ La diferencia con `revoke_other_storefront_sessions`, y el punto entero.
  select revoked_at into v_estado from public.storefront_sessions where id = v_s_vieja;
  if v_estado is null then
    raise exception 'el enlace VIEJO del mismo local siguió vivo tras «seguir mi pedido»';
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_nueva;
  if v_estado is not null then
    raise exception 'se revocó el enlace NUEVO: el cliente se quedó sin ninguno';
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_cevi;
  if v_estado is not null then
    raise exception 'se revocó el enlace de un local donde DEBE dinero';
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_helado;
  if v_estado is null then
    raise exception 'el enlace de otro local sin nada pendiente siguió vivo';
  end if;

  -- Sin sesión que conservar no se toca nada: falla hacia dejar enlaces vivos.
  v_revocadas := public.revoke_storefront_sessions_except(
    v_cliente, '00000000-0000-0000-0000-000000000000'
  );
  if v_revocadas <> 0 then
    raise exception 'con una sesión inexistente revocó % enlaces', v_revocadas;
  end if;
  v_revocadas := public.revoke_storefront_sessions_except(v_cliente, null);
  if v_revocadas <> 0 then
    raise exception 'con una sesión nula revocó % enlaces', v_revocadas;
  end if;

  delete from businesses where id in (v_pizza, v_ceviche, v_helado);
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ «seguir mi pedido» deja vivo SOLO el enlace nuevo, salvo donde se debe dinero' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- AL SALIR CON MENÚ, EL ENLACE LO DECIDEN LOS PEDIDOS (2026-09-27)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El caso real del amigo del dueño: pidió en La Abuelita (#25), escribió MENÚ
-- esperando comprobante, el pedido SE CANCELÓ… y el enlace siguió abriendo la
-- tienda. La excepción «quien debe comprobante conserva su enlace» se aplicaba
-- mirando el estado del chat de ANTES de cancelar.
do $$
declare
  v_abuelita  uuid;
  v_ceviche   uuid;
  v_helado    uuid;
  v_cliente   uuid;
  v_s_abuela  uuid;
  v_s_cevi    uuid;
  v_s_helado  uuid;
  v_revocadas integer;
  v_estado    timestamptz;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values
    ('abuela-salir-v', 'La Abuelita', 'almuerzos', 'ycloud', '+593900668001', '+593900668001', true, 'miniapp'),
    ('cevi-salir-v', 'Cevichería', 'restaurante', 'ycloud', '+593900668002', '+593900668002', true, 'miniapp'),
    ('helado-salir-v', 'Heladería', 'heladeria', 'ycloud', '+593900668004', '+593900668004', true, 'miniapp');

  select id into v_abuelita from businesses where slug = 'abuela-salir-v';
  select id into v_ceviche  from businesses where slug = 'cevi-salir-v';
  select id into v_helado   from businesses where slug = 'helado-salir-v';

  insert into public.customers (phone) values ('593900668100') returning id into v_cliente;

  -- Primero la Cevichería, como en la vida real: ya mandó el comprobante, se está revisando. Tiene que poder
  -- seguir viendo su pedido.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_ceviche, v_cliente, repeat('f1', 32), '593900668100', null) returning id into v_s_cevi;
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_ceviche, v_cliente, '593900668100', 'storefront', 'pago_en_revision', 9, 9);
  -- Después La Abuelita (un pedido en revisión no impide otro): el pedido esperando comprobante, que MENÚ va a cancelar.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_abuelita, v_cliente, repeat('f0', 32), '593900668100', null) returning id into v_s_abuela;
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_abuelita, v_cliente, '593900668100', 'storefront', 'esperando_pago', 3.5, 3.5);
  -- (Un segundo pedido esperando comprobante en OTRO local no puede existir:
  -- `orders_limit_open_per_customer` lo impide —«envíalo y podrás hacer
  -- otro»—, así que no hay ese caso que probar.)
  -- Heladería: nada pendiente.
  insert into public.storefront_sessions (business_id, customer_id, token_hash, contact_phone, expires_at)
  values (v_helado, v_cliente, repeat('f3', 32), '593900668100', null) returning id into v_s_helado;

  -- MENÚ, en su orden: primero se cancela el pedido del local elegido…
  if public.cancel_unpaid_order_on_purpose(v_abuelita, v_cliente) <> 1 then
    raise exception 'MENÚ no canceló el pedido sin pagar de La Abuelita';
  end if;
  -- …y DESPUÉS se deciden los enlaces, mirando los pedidos tal como quedaron.
  v_revocadas := public.revoke_storefront_sessions_on_exit(v_cliente);
  if v_revocadas <> 2 then
    raise exception 'debía revocar La Abuelita y la Heladería, y revocó %', v_revocadas;
  end if;

  select revoked_at into v_estado from public.storefront_sessions where id = v_s_abuela;
  if v_estado is null then
    raise exception 'el enlace de La Abuelita siguió vivo con su pedido ya CANCELADO (el caso del #25)';
  end if;
  select revoked_at into v_estado from public.storefront_sessions where id = v_s_cevi;
  if v_estado is not null then
    raise exception 'se revocó el enlace de quien tiene el pago EN REVISIÓN';
  end if;
  select revoked_at into v_estado from public.storefront_sessions where id = v_s_helado;
  if v_estado is null then
    raise exception 'el enlace de un local sin nada pendiente siguió vivo';
  end if;

  -- Sin cliente no se toca nada.
  if public.revoke_storefront_sessions_on_exit(null) <> 0 then
    raise exception 'sin cliente revocó enlaces';
  end if;

  delete from businesses where id in (v_abuelita, v_ceviche, v_helado);
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ al salir con MENÚ el enlace lo deciden los pedidos: cae el del pedido recién cancelado' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- UNA SOLA DEFINICIÓN DE «BLOQUEADO» (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El dueño, probando de madrugada, entró a la tienda estando bloqueado y creó
-- el pedido #74. Se coló porque «bloqueado» se respondía en dos sitios con dos
-- reglas: el chat miraba `blocked_at` a secas y la base miraba la regla
-- completa. Con un bloqueo temporal YA VENCIDO —`blocked_at` puesto,
-- `blocked_until` en el pasado— el chat decía «bloqueado» y el disparador
-- decía «adelante».
--
-- Se ejecutan los cuatro estados, incluido ese, y se comprueba que el booleano
-- que usa el disparador NUNCA se separa del estado que ven las pantallas.
do $$
declare
  v_local   uuid;
  v_cliente uuid;
  v_estado  jsonb;
  v_pedido  uuid;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'bloqueo-uno-v', 'Bloqueo', 'pizzeria', 'ycloud',
    '+593900444001', '+593900444001', true, 'miniapp'
  ) returning id into v_local;

  insert into public.customers (phone) values ('593900444100') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id)
  values (v_local, v_cliente);

  -- ── 1. Sin bloqueo: pide con normalidad ─────────────────────────────────
  v_estado := public.storefront_customer_block_state(v_local, v_cliente);
  if (v_estado->>'blocked')::boolean then
    raise exception 'un cliente sin bloqueo salió bloqueado: %', v_estado;
  end if;

  -- ── 2. Permanente (el del dueño): sin plazo que prometer ────────────────
  update public.business_customers set blocked_at = now(), blocked_until = null
   where business_id = v_local and customer_id = v_cliente;
  v_estado := public.storefront_customer_block_state(v_local, v_cliente);
  if not (v_estado->>'blocked')::boolean or not (v_estado->>'permanent')::boolean then
    raise exception 'el bloqueo del dueño no salió permanente: %', v_estado;
  end if;
  if v_estado->>'until' is not null then
    raise exception 'un bloqueo permanente NO puede prometer plazo: %', v_estado;
  end if;

  -- Y el disparador lo respeta: el pedido NO entra.
  begin
    insert into public.orders (
      business_id, customer_id, contact_phone, source, status, subtotal, total
    ) values (v_local, v_cliente, '593900444100', 'storefront', 'esperando_pago', 5, 5);
    raise exception 'un cliente BLOQUEADO pudo crear un pedido';
  exception when insufficient_privilege then
    null;
  end;

  -- ── 3. Temporal vigente: bloquea y dice hasta cuándo ────────────────────
  update public.business_customers
     set blocked_at = now(), blocked_until = now() + interval '30 minutes'
   where business_id = v_local and customer_id = v_cliente;
  v_estado := public.storefront_customer_block_state(v_local, v_cliente);
  if not (v_estado->>'blocked')::boolean then
    raise exception 'el bloqueo temporal vigente no bloqueó: %', v_estado;
  end if;
  if (v_estado->>'permanent')::boolean or v_estado->>'until' is null then
    raise exception 'un bloqueo temporal tiene que decir hasta cuándo y no ser permanente: %', v_estado;
  end if;

  -- ── 4. EL CASO QUE SE COLÓ ──────────────────────────────────────────────
  --
  -- Temporal VENCIDO con `blocked_at` todavía puesto. Ya cumplió su castigo:
  -- las dos respuestas —la de la pantalla y la del disparador— tienen que
  -- decir que puede pedir, y el pedido tiene que ENTRAR.
  update public.business_customers
     set blocked_at = now() - interval '2 hours',
         blocked_until = now() - interval '1 hour'
   where business_id = v_local and customer_id = v_cliente;
  v_estado := public.storefront_customer_block_state(v_local, v_cliente);
  if (v_estado->>'blocked')::boolean then
    raise exception 'un bloqueo temporal VENCIDO siguió bloqueando: %', v_estado;
  end if;
  if public.storefront_customer_blocked(v_local, v_cliente) then
    raise exception 'el booleano se separó del estado: la grieta del #74 sigue abierta';
  end if;

  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total
  ) values (v_local, v_cliente, '593900444100', 'storefront', 'esperando_pago', 5, 5)
  returning id into v_pedido;
  if v_pedido is null then
    raise exception 'cumplido el castigo, el pedido debía entrar';
  end if;

  -- ── 5. El booleano y el estado NUNCA se separan ─────────────────────────
  update public.business_customers
     set blocked_at = now(), blocked_until = now() + interval '10 minutes'
   where business_id = v_local and customer_id = v_cliente;
  if public.storefront_customer_blocked(v_local, v_cliente)
     <> (public.storefront_customer_block_state(v_local, v_cliente)->>'blocked')::boolean then
    raise exception 'el booleano y el estado se contradicen';
  end if;

  delete from businesses where id = v_local;
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ un solo bloqueo: el disparador y las pantallas comparten la regla, y el temporal caduca de verdad' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- LOS BLOQUEADOS QUE VE EL DUEÑO (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La pregunta del dueño mirando su pantalla de Clientes: «¿ese tiempo va con
-- el de bloqueado aquí en el panel?». No iba: el panel listaba `blocked_at is
-- not null` y el bloqueo temporal también pone `blocked_at`, así que a los 30
-- minutos el cliente ya podía pedir y el panel seguía diciendo «Bloqueado».
--
-- Cuarta copia de la regla en aparecer. Ahora la lista la calcula la MISMA
-- función que usa el disparador de pedidos, y se ejecuta con los cuatro
-- estados para que no puedan volver a separarse.
do $$
declare
  v_local    uuid;
  v_perm     uuid;
  v_temporal uuid;
  v_cumplido uuid;
  v_libre    uuid;
  v_filas    integer;
  v_hasta    timestamptz;
  v_esperm   boolean;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'panel-bloqueo-v', 'Panel', 'pizzeria', 'ycloud',
    '+593900222001', '+593900222001', true, 'miniapp'
  ) returning id into v_local;

  insert into public.customers (phone) values ('593900222101') returning id into v_perm;
  insert into public.customers (phone) values ('593900222102') returning id into v_temporal;
  insert into public.customers (phone) values ('593900222103') returning id into v_cumplido;
  insert into public.customers (phone) values ('593900222104') returning id into v_libre;

  insert into public.business_customers (business_id, customer_id, blocked_at, blocked_until)
  values
    (v_local, v_perm,     now(),                      null),
    (v_local, v_temporal, now(),                      now() + interval '20 minutes'),
    (v_local, v_cumplido, now() - interval '2 hours', now() - interval '1 hour'),
    (v_local, v_libre,    null,                       null);

  select count(*) into v_filas from public.business_blocked_contacts(v_local);
  if v_filas <> 2 then
    raise exception 'el panel debía listar 2 bloqueados y listó %', v_filas;
  end if;

  -- EL FALLO QUE VEÍA EL DUEÑO: el que cumplió su castigo desaparece solo.
  if exists (
    select 1 from public.business_blocked_contacts(v_local) where phone = '593900222103'
  ) then
    raise exception 'un bloqueo temporal CUMPLIDO seguía saliendo en el panel';
  end if;
  if exists (
    select 1 from public.business_blocked_contacts(v_local) where phone = '593900222104'
  ) then
    raise exception 'un cliente sin bloquear salió en la lista';
  end if;

  -- El permanente no promete plazo; el temporal sí. Es lo que deja al panel
  -- decir «Bloqueado por ti» o «Bloqueado 20 min» sin adivinar.
  select until, permanent into v_hasta, v_esperm
  from public.business_blocked_contacts(v_local) where phone = '593900222101';
  if not v_esperm or v_hasta is not null then
    raise exception 'el bloqueo del dueño salió con plazo o sin marcar permanente';
  end if;

  select until, permanent into v_hasta, v_esperm
  from public.business_blocked_contacts(v_local) where phone = '593900222102';
  if v_esperm or v_hasta is null then
    raise exception 'el bloqueo temporal salió sin plazo o marcado permanente';
  end if;

  -- ── Y LOS DOS BOTONES DEL PANEL ─────────────────────────────────────────
  --
  -- «Bloquear» limpia `blocked_until`: la decisión del dueño manda sobre
  -- cualquier automático pendiente. Sin esto, bloquear a quien tuvo un
  -- temporal antes NO surtía efecto — ni permanente (blocked_until no nulo)
  -- ni temporal (vencido).
  update public.business_customers
     set blocked_at = now(), blocked_until = null
   where business_id = v_local and customer_id = v_cumplido;
  if not public.storefront_customer_blocked(v_local, v_cumplido) then
    raise exception 'el dueño bloqueó a quien tuvo un temporal y NO quedó bloqueado';
  end if;

  -- «Desbloquear» lo limpia todo: cuando el dueño perdona, perdona entero.
  update public.business_customers
     set blocked_at = null, blocked_until = null
   where business_id = v_local and customer_id = v_temporal;
  if public.storefront_customer_blocked(v_local, v_temporal) then
    raise exception 'el dueño desbloqueó y el cliente siguió bloqueado';
  end if;

  delete from businesses where id = v_local;
  delete from public.customers where id in (v_perm, v_temporal, v_cumplido, v_libre);
end;
$$;

select '✅ el panel lista solo a los bloqueados AHORA, con su plazo, y los dos botones del dueño mandan' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL COMPROBANTE FALSO DEJA EL PEDIDO EXPIRADO (2026-09-02)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo encontró el dueño probando: mandó dos comprobantes falsos, se bloqueó
-- —bien—, escribió «hola» y recibió «tienes un pedido en proceso». El pedido
-- seguía vivo en `esperando_pago`, así que el candado no se soltaba, el dueño
-- veía en su panel una comanda que nadie iba a pagar, y seguía contando contra
-- el tope de pedidos abiertos.
--
-- Ahora el bloqueo mata el pedido, y de ahí sale todo lo demás solo.
do $$
declare
  v_local   uuid;
  v_otro    uuid;
  v_cliente uuid;
  v_p1      uuid;
  v_p2      uuid;
  v_ajeno   uuid;
  v_r       jsonb;
  v_estado  text;
  v_locked  boolean;
  v_impagos integer;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values
    ('falso-uno-v', 'Pizza', 'pizzeria', 'ycloud', '+593900666301', '+593900666301', true, 'miniapp'),
    ('falso-dos-v', 'Otra', 'pizzeria', 'ycloud', '+593900666302', '+593900666302', true, 'miniapp');
  select id into v_local from businesses where slug = 'falso-uno-v';
  select id into v_otro  from businesses where slug = 'falso-dos-v';

  insert into public.customers (phone) values ('593900666400') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id) values (v_local, v_cliente);
  insert into public.business_customers (business_id, customer_id) values (v_otro, v_cliente);
  insert into public.marketplace_conversations (
    customer_id, selected_business_id, shopping_locked, current_state
  ) values (v_cliente, v_local, true, 'esperando_comprobante');

  -- ── ESCENARIO REAL: UN pedido esperando su comprobante ──────────────────
  --
  -- ⚠️ Se inserta como MOSTRADOR y se convierte en pedido de TIENDA con un
  -- update: `orders_limit_open_per_customer` es BEFORE INSERT y solo mira
  -- `source = 'storefront'`. Se cambia solo `source`, nunca el estado, para no
  -- disparar `orders_release_shopping_lock` (es `after update of status`).
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_local, v_cliente, '593900666400', 'manual', 'esperando_pago', 9, 9)
  returning id into v_p1;
  update public.orders set source = 'storefront' where id = v_p1;

  -- 1. La PRIMERA imagen mala avisa y no mata nada.
  v_r := public.register_rejected_receipt(v_local, v_cliente);
  if (v_r->>'blocked')::boolean then
    raise exception 'la PRIMERA imagen mala no puede bloquear: %', v_r;
  end if;
  select status into v_estado from public.orders where id = v_p1;
  if v_estado <> 'esperando_pago' then
    raise exception 'la primera falta mató el pedido: %', v_estado;
  end if;

  -- 2. La SEGUNDA bloquea Y deja el pedido EXPIRADO.
  v_r := public.register_rejected_receipt(v_local, v_cliente);
  if not (v_r->>'blocked')::boolean or (v_r->>'expired')::integer <> 1 then
    raise exception 'la segunda debía bloquear y expirar 1: %', v_r;
  end if;
  select status into v_estado from public.orders where id = v_p1;
  if v_estado <> 'expirado' then
    raise exception 'el pedido sin pagar debía quedar EXPIRADO, quedó %', v_estado;
  end if;

  -- 3. Y EL CANDADO SE SUELTA SOLO. Es lo que hace que el siguiente mensaje
  -- del cliente vea las categorías en vez de «tienes un pedido en proceso»,
  -- que es lo que el dueño vivió el 2026-09-02.
  select shopping_locked into v_locked
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_locked then
    raise exception 'expirado el pedido, el candado siguió puesto';
  end if;

  -- 4. Y NO se cuenta además como impago: ya se le bloqueó por los
  -- comprobantes, y sumarle una falta de «pedido sin pagar» sería cobrarle dos
  -- castigos por el mismo acto.
  select unpaid_expiries into v_impagos
    from public.business_customers
   where business_id = v_local and customer_id = v_cliente;
  if coalesce(v_impagos, 0) <> 0 then
    raise exception 'el comprobante falso contó además como impago: %', v_impagos;
  end if;

  -- ── AISLAMIENTO: lo que NO es suyo no se toca ───────────────────────────
  --
  -- Se prueba aparte porque en producción no pueden coexistir —#296 deja UN
  -- pedido sin pagar a la vez—, pero la función tiene que filtrar igual: un
  -- histórico o un pedido de mostrador podrían estar ahí.
  update public.business_customers
     set rejected_receipts = 0, blocked_at = null, blocked_until = null
   where business_id = v_local and customer_id = v_cliente;

  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_otro, v_cliente, '593900666400', 'manual', 'esperando_pago', 5, 5)
  returning id into v_ajeno;
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total, payment_proof_url
  ) values (v_local, v_cliente, '593900666400', 'manual', 'esperando_pago', 7, 7, 'https://x/y.jpg')
  returning id into v_p2;
  update public.orders set source = 'storefront' where id in (v_ajeno, v_p2);

  perform public.register_rejected_receipt(v_local, v_cliente);
  v_r := public.register_rejected_receipt(v_local, v_cliente);
  -- Ninguno de los dos entra: uno es de otro local, el otro ya tiene su foto.
  if (v_r->>'expired')::integer <> 0 then
    raise exception 'expiró pedidos que no debía: %', v_r;
  end if;

  select status into v_estado from public.orders where id = v_ajeno;
  if v_estado <> 'esperando_pago' then
    raise exception 'se expiró un pedido de OTRO local: %', v_estado;
  end if;
  select status into v_estado from public.orders where id = v_p2;
  if v_estado <> 'esperando_pago' then
    raise exception 'se expiró un pedido que YA tenía comprobante: %', v_estado;
  end if;

  delete from businesses where id in (v_local, v_otro);
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ el comprobante falso bloquea, expira su pedido, suelta el candado y no cuenta dos veces' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- LA PIZARRA SE LIMPIA CUANDO EL LOCAL ACEPTA (2026-09-03)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `unpaid_expiries` no se ponía a cero NUNCA: ni comprando bien, ni pagando
-- puntual, ni con el «Desbloquear» del dueño. El límite son 2, así que alguien
-- que dejó dos pedidos tirados hace un año quedaba marcado de por vida — y
-- cada pedido que se le caducara volvía a bloquearlo 30 minutos, para siempre.
--
-- En un local con clientes reales eso golpea sobre todo a los que MÁS piden,
-- que son los que tienen más ocasiones de que se les pase la ventana una vez.
--
-- Ahora se cuenta la RACHA, no el historial — la misma regla que ya seguía
-- `rejected_receipts`, escrita en el código desde entonces.
do $$
declare
  v_local   uuid;
  v_otro    uuid;
  v_cliente uuid;
  v_pedido  uuid;
  v_faltas  integer;
  v_fotos   integer;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values
    ('pizarra-uno-v', 'Pizza', 'pizzeria', 'ycloud', '+593900444301', '+593900444301', true, 'miniapp'),
    ('pizarra-dos-v', 'Otra', 'pizzeria', 'ycloud', '+593900444302', '+593900444302', true, 'miniapp');
  select id into v_local from businesses where slug = 'pizarra-uno-v';
  select id into v_otro  from businesses where slug = 'pizarra-dos-v';

  insert into public.customers (phone) values ('593900444400') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id, unpaid_expiries, rejected_receipts)
  values (v_local, v_cliente, 4, 3);
  insert into public.business_customers (business_id, customer_id, unpaid_expiries, rejected_receipts)
  values (v_otro, v_cliente, 2, 1);

  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_local, v_cliente, '593900444400', 'storefront', 'pago_en_revision', 9, 9)
  returning id into v_pedido;

  -- ── 1. Mientras el local no lo acepte, la pizarra NO se toca ────────────
  update public.orders set status = 'cancelado' where id = v_pedido;
  select unpaid_expiries into v_faltas
    from public.business_customers where business_id = v_local and customer_id = v_cliente;
  if v_faltas <> 4 then
    raise exception 'cancelar un pedido limpió la pizarra: %', v_faltas;
  end if;

  -- ── 2. Aceptarlo SÍ la limpia ───────────────────────────────────────────
  update public.orders set status = 'preparacion' where id = v_pedido;
  select unpaid_expiries, rejected_receipts into v_faltas, v_fotos
    from public.business_customers where business_id = v_local and customer_id = v_cliente;
  if v_faltas <> 0 or v_fotos <> 0 then
    raise exception 'el local aceptó y la pizarra no se limpió: impagos=% fotos=%', v_faltas, v_fotos;
  end if;

  -- ── 3. Y SOLO en ese local ──────────────────────────────────────────────
  -- La confianza se gana con quien se compra: haber sido buen cliente en una
  -- pizzería no dice nada de cómo se porta uno en otra.
  select unpaid_expiries into v_faltas
    from public.business_customers where business_id = v_otro and customer_id = v_cliente;
  if v_faltas <> 2 then
    raise exception 'se limpió la pizarra de OTRO local: %', v_faltas;
  end if;

  -- ── 4. Avanzar dentro del grupo no vuelve a escribir ────────────────────
  -- `preparacion` → `en_camino` es el mismo pedido avanzando, no una segunda
  -- demostración.
  update public.business_customers set unpaid_expiries = 1
   where business_id = v_local and customer_id = v_cliente;
  update public.orders set status = 'en_camino' where id = v_pedido;
  select unpaid_expiries into v_faltas
    from public.business_customers where business_id = v_local and customer_id = v_cliente;
  if v_faltas <> 1 then
    raise exception 'avanzar dentro del grupo volvió a limpiar: %', v_faltas;
  end if;

  delete from businesses where id in (v_local, v_otro);
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ la pizarra se limpia cuando el local acepta: solo ahí, solo en ese local y una vez por pedido' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL PEDIDO AVISA A LA CONVERSACIÓN (2026-09-04)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El checkout DEL CHAT marcaba `esperando_comprobante`; el de la MINI APP
-- —por donde pide todo el mundo hoy— no tocaba la conversación. Con el estado
-- en `navegando`, el bot le decía «termínalo» a quien ya había pedido y solo
-- debía el comprobante. Lo vivió el dueño el 2026-09-04.
--
-- Y quien pulsa «Empezar de nuevo» está avisando de que deja el pedido: ahora
-- se cancela en el momento en vez de dejarlo caducar y sumarle una falta.
-- Avisar y desaparecer no pueden costar lo mismo.
do $$
declare
  v_local   uuid;
  v_cliente uuid;
  v_pedido  uuid;
  v_conPago uuid;
  v_estado  text;
  v_n       integer;
  v_impagos integer;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'aviso-uno-v', 'Pizza', 'pizzeria', 'ycloud',
    '+593900222501', '+593900222501', true, 'miniapp'
  ) returning id into v_local;

  insert into public.customers (phone) values ('593900222600') returning id into v_cliente;
  insert into public.business_customers (business_id, customer_id) values (v_local, v_cliente);
  -- ⚠️ Con la pregunta «¿Empezamos de nuevo o sigues?» PENDIENTE: es lo que
  -- tiene quien escribió algo en el chat antes de pedir (2026-09-27).
  insert into public.marketplace_conversations (
    customer_id, selected_business_id, shopping_locked, current_state, flow_state
  ) values (
    v_cliente, v_local, true, 'confirmando_reinicio',
    '{"vista": {"vista": "confirmando_reinicio", "pagina": 0}}'::jsonb
  );

  -- ── 1. CREAR EL PEDIDO MARCA LA CONVERSACIÓN ────────────────────────────
  -- Es el fallo que vivió el dueño: pidió por la mini app y el bot le siguió
  -- diciendo «termínalo».
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_local, v_cliente, '593900222600', 'storefront', 'esperando_pago', 9, 9)
  returning id into v_pedido;

  select current_state into v_estado
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_estado <> 'esperando_comprobante' then
    raise exception 'crear el pedido no avisó a la conversación: %', v_estado;
  end if;

  -- ── 1b. Y BORRA LA PREGUNTA PENDIENTE (2026-09-27) ──────────────────────
  -- Con ella viva, el «Empezar de nuevo» de ANTES de pedir cancelaba este
  -- pedido recién nacido —lo reprodujo staging—, aunque ya hubiera transferido.
  if (select flow_state from public.marketplace_conversations
       where customer_id = v_cliente) is not null then
    raise exception 'el pedido nuevo dejó viva la pregunta de «Empezar de nuevo»';
  end if;

  -- ── 2. ABANDONAR A PROPÓSITO CANCELA ────────────────────────────────────
  v_n := public.cancel_unpaid_order_on_purpose(v_local, v_cliente);
  if v_n <> 1 then
    raise exception 'debía cancelar 1 pedido y canceló %', v_n;
  end if;
  select status into v_estado from public.orders where id = v_pedido;
  if v_estado <> 'cancelado' then
    raise exception 'el pedido abandonado a propósito quedó en %', v_estado;
  end if;

  -- ── 3. Y NO se cuenta como impago ───────────────────────────────────────
  -- Avisar y desaparecer no pueden costar lo mismo.
  select unpaid_expiries into v_impagos
    from public.business_customers where business_id = v_local and customer_id = v_cliente;
  if coalesce(v_impagos, 0) <> 0 then
    raise exception 'irse avisando contó como impago: %', v_impagos;
  end if;

  -- ── 4. Con la foto ya mandada, el cliente NO puede retirarlo ────────────
  insert into public.orders (
    business_id, customer_id, contact_phone, source, status, subtotal, total, payment_proof_url
  ) values (v_local, v_cliente, '593900222600', 'storefront', 'esperando_pago', 7, 7, 'https://x/y.jpg')
  returning id into v_conPago;

  v_n := public.cancel_unpaid_order_on_purpose(v_local, v_cliente);
  if v_n <> 0 then
    raise exception 'canceló un pedido que YA tenía comprobante: %', v_n;
  end if;
  select status into v_estado from public.orders where id = v_conPago;
  if v_estado <> 'esperando_pago' then
    raise exception 'se tocó un pedido con comprobante: %', v_estado;
  end if;

  delete from businesses where id = v_local;
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ el pedido avisa a la conversación, e irse avisando cancela sin contar como impago' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL PEDIDO QUE NACE SIN DEBER NADA SUELTA EL CANDADO (2026-09-27)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El de efectivo nace en `pendiente` y nunca pasa por un estado que retenga,
-- así que el disparador —que solo miraba UPDATE— no lo veía: el candado se
-- quedaba puesto para siempre. En staging, con el pedido ya ENTREGADO, un
-- «hola» seguía recibiendo «¿Empezamos de nuevo o sigues con tu pedido?». Lo
-- soltaba a mano el checkout del chat, y se fue con él en el #360.
do $$
declare
  v_a        uuid;
  v_b        uuid;
  v_cliente  uuid;
  v_otro     uuid;
  v_bloqueado boolean;
  v_local    uuid;
  v_estado   text;
  v_flujo    jsonb;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'efectivo-a-v', 'Pizza', 'pizzeria', 'ycloud',
    '+593900333501', '+593900333501', true, 'miniapp'
  ) returning id into v_a;
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'efectivo-b-v', 'Cevichería', 'restaurante', 'ycloud',
    '+593900333502', '+593900333502', true, 'miniapp'
  ) returning id into v_b;

  -- ── 1. EL DE EFECTIVO SUELTA EL CANDADO Y EL LOCAL ──────────────────────
  insert into public.customers (phone) values ('593900333600') returning id into v_cliente;
  insert into public.marketplace_conversations (
    customer_id, selected_business_id, shopping_locked, current_state, flow_state
  ) values (
    v_cliente, v_a, true, 'confirmando_reinicio',
    '{"vista": {"vista": "confirmando_reinicio", "pagina": 0}}'::jsonb
  );
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_a, v_cliente, '593900333600', 'storefront', 'pendiente', 9, 9);

  select shopping_locked, selected_business_id, current_state, flow_state
    into v_bloqueado, v_local, v_estado, v_flujo
    from public.marketplace_conversations where customer_id = v_cliente;
  if v_bloqueado then
    raise exception 'el pedido en efectivo NO soltó el candado';
  end if;
  if v_local is not null then
    raise exception 'el candado se soltó pero el local siguió elegido';
  end if;
  if v_estado <> 'navegando' or v_flujo is not null then
    raise exception 'la conversación quedó en % con vista %: el chat seguiría preguntando', v_estado, v_flujo;
  end if;

  -- ── 2. SOLO EN SU LOCAL ─────────────────────────────────────────────────
  -- Si la persona ya anda eligiendo en OTRO local, ese candado es de lo que
  -- hace ahora: un pedido que nace en el primero no se lo puede quitar.
  update public.marketplace_conversations
     set shopping_locked = true, selected_business_id = v_b, current_state = 'en_local'
   where customer_id = v_cliente;
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_a, v_cliente, '593900333600', 'storefront', 'pendiente', 9, 9);
  select shopping_locked, selected_business_id into v_bloqueado, v_local
    from public.marketplace_conversations where customer_id = v_cliente;
  if not v_bloqueado or v_local is distinct from v_b then
    raise exception 'un pedido en OTRO local soltó el candado de donde está ahora';
  end if;

  -- ── 3. EL QUE NACE DEBIENDO NO LO SUELTA ────────────────────────────────
  -- Transferencia: el candado se queda hasta que el local acepte. Es la
  -- decisión del 2026-08-30 («Umbani cerrado») y no cambia.
  insert into public.customers (phone) values ('593900333601') returning id into v_otro;
  insert into public.marketplace_conversations (
    customer_id, selected_business_id, shopping_locked, current_state
  ) values (v_otro, v_a, true, 'en_local');
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_a, v_otro, '593900333601', 'storefront', 'esperando_pago', 9, 9);
  select shopping_locked into v_bloqueado
    from public.marketplace_conversations where customer_id = v_otro;
  if not v_bloqueado then
    raise exception 'un pedido esperando pago soltó el candado al nacer';
  end if;

  -- ── 4. EL DE MOSTRADOR NO TOCA LA CONVERSACIÓN ──────────────────────────
  -- Lo teclea el dueño con la persona delante.
  update public.marketplace_conversations
     set shopping_locked = true, selected_business_id = v_b, current_state = 'en_local'
   where customer_id = v_cliente;
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_b, v_cliente, '593900333600', 'manual', 'pendiente', 9, 9);
  select shopping_locked into v_bloqueado
    from public.marketplace_conversations where customer_id = v_cliente;
  if not v_bloqueado then
    raise exception 'un pedido de MOSTRADOR soltó el candado del chat';
  end if;

  delete from businesses where id in (v_a, v_b);
  delete from public.customers where id in (v_cliente, v_otro);
end;
$$;

select '✅ el pedido en efectivo suelta el candado al nacer, solo en su local; el que debe y el de mostrador no' as resultado;

-- ═══════════════════════════════════════════════════════════════════════════
-- INSULTOS: ADVERTENCIA, 15 DÍAS FUERA, Y EL AVISO AL VOLVER (2026-09-27)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_local   uuid;
  v_cliente uuid;
  v_r       jsonb;
  v_falló   boolean;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'insultos-v', 'Pizza', 'pizzeria', 'ycloud',
    '+593900444501', '+593900444501', true, 'miniapp'
  ) returning id into v_local;
  insert into public.customers (phone) values ('593900444600') returning id into v_cliente;

  -- ── 1. La primera vez, solo una advertencia ─────────────────────────────
  v_r := public.register_insult(v_cliente, 15);
  if v_r->>'accion' <> 'advertido' then
    raise exception 'el primer insulto debía advertir: %', v_r;
  end if;
  if (public.claim_platform_block_state(v_cliente)->>'bloqueado')::boolean then
    raise exception 'una advertencia no puede bloquear';
  end if;

  -- ── 2. La segunda, 15 días fuera de TODA la app ──────────────────────────
  v_r := public.register_insult(v_cliente, 15);
  if v_r->>'accion' <> 'bloqueado'
     or (v_r->>'hasta')::timestamptz < now() + interval '14 days 23 hours' then
    raise exception 'el segundo insulto debía bloquear 15 días: %', v_r;
  end if;
  v_r := public.claim_platform_block_state(v_cliente);
  if not (v_r->>'bloqueado')::boolean or v_r->>'tipo' <> 'insultos' then
    raise exception 'el bloqueo por insultos no se ve: %', v_r;
  end if;
  if public.register_insult(v_cliente, 15)->>'accion' <> 'ya_bloqueado' then
    raise exception 'un insulto estando bloqueado no puede alargar ni tocar nada';
  end if;

  -- Ni el bot le contesta ni NINGÚN local acepta su pedido.
  v_falló := false;
  begin
    insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
    values (v_local, v_cliente, '593900444600', 'storefront', 'pendiente', 9, 9);
  exception when insufficient_privilege then
    v_falló := true;
  end;
  if not v_falló then
    raise exception 'el bloqueado por insultos pudo pedir';
  end if;

  -- ── 3. Caduca SOLO, y al volver se le avisa UNA vez ──────────────────────
  update public.customers set blocked_until = now() - interval '1 minute' where id = v_cliente;
  v_r := public.claim_platform_block_state(v_cliente);
  if (v_r->>'bloqueado')::boolean or not coalesce((v_r->>'avisar_desbloqueo')::boolean, false) then
    raise exception 'al caducar debía desbloquear y avisar: %', v_r;
  end if;
  if (select blocked_at from public.customers where id = v_cliente) is not null then
    raise exception 'el bloqueo caducado no se limpió';
  end if;
  if coalesce((public.claim_platform_block_state(v_cliente)->>'avisar_desbloqueo')::boolean, false) then
    raise exception 'el aviso de desbloqueo salió DOS veces';
  end if;
  -- Y ya puede pedir.
  insert into public.orders (business_id, customer_id, contact_phone, source, status, subtotal, total)
  values (v_local, v_cliente, '593900444600', 'storefront', 'pendiente', 9, 9);

  -- ── 4. Si vuelve a pasar, directo al bloqueo: la advertencia ya se dio ───
  if public.register_insult(v_cliente, 15)->>'accion' <> 'bloqueado' then
    raise exception 'tras el desbloqueo, el siguiente insulto debía bloquear directo';
  end if;

  -- ── 5. El superadmin lo levanta antes: también se le avisa al volver ─────
  perform public.set_platform_blocked('593900444600', false, null);
  v_r := public.claim_platform_block_state(v_cliente);
  if (v_r->>'bloqueado')::boolean or not coalesce((v_r->>'avisar_desbloqueo')::boolean, false) then
    raise exception 'levantarlo a mano debía dejar el aviso para su próximo mensaje: %', v_r;
  end if;

  -- ── 6. El bloqueo MANUAL no cambia: permanente, y sin aviso al levantarlo ─
  perform public.set_platform_blocked('593900444600', true, 'Pedidos falsos');
  if (select blocked_kind || '|' || coalesce(blocked_until::text, 'sin fecha')
        from public.customers where id = v_cliente) <> 'manual|sin fecha' then
    raise exception 'el bloqueo del superadmin debía ser manual y permanente';
  end if;
  perform public.set_platform_blocked('593900444600', false, null);
  if coalesce((public.claim_platform_block_state(v_cliente)->>'avisar_desbloqueo')::boolean, false) then
    raise exception 'levantar un bloqueo MANUAL no lleva el aviso de los insultos';
  end if;

  delete from public.orders where customer_id = v_cliente;
  delete from businesses where id = v_local;
  delete from public.customers where id = v_cliente;
end;
$$;

select '✅ insultos: advertencia, 15 días fuera de toda la app, caduca solo y avisa UNA vez al volver' as resultado;
