-- ============================================================================
-- FRENOS CONTRA QUIEN PRUEBA TARJETAS ROBADAS
--
-- Cuarto PR del bloque de seguridad del cobro con tarjeta (2026-09-29), con
-- los números que eligió el dueño («equilibrado»):
--
--   · 5 intentos de cobro por HORA y por CLIENTE, entre todos sus pedidos.
--     Hasta hoy eran 5 por PEDIDO: se esquivaba creando pedidos nuevos.
--   · 3 tarjetas RECHAZADAS en 24 h → la tarjeta se le apaga 24 h. Puede pagar
--     en efectivo o por transferencia.
--   · $150 como máximo por pedido con tarjeta.
--
-- ⚠️ Solo cuenta `rechazado`, que es cuando PayPhone contesta «Canceled» sobre
-- una transacción que EXISTE —se presentó una tarjeta—. Quien cancela en su
-- página sin meter ninguna no crea transacción y acaba en `caducado`, que no
-- cuenta: arrepentirse no apaga nada. ⚠️ SIN VERIFICAR hasta probar en el
-- sandbox una tarjeta rechazada.
--
-- ⚠️ EL TOPE va en un disparador sobre `orders`, no en la ruta: la tienda no
-- puede cambiar el método de un pedido ya creado, así que un pedido con
-- tarjeta por encima del tope quedaría esperando un pago imposible. Con el
-- disparador el alta entera se deshace y el cliente ve el motivo al confirmar.
-- ⚠️ Se llama `orders_tope_de_tarjeta` A PROPÓSITO: los disparadores del mismo
-- evento corren por ORDEN ALFABÉTICO, y tiene que ir DESPUÉS de
-- `orders_stamp_pricing`, que es el que suma el margen y la tarifa al total en
-- el `update` con que `create_storefront_order` cierra el pedido.
-- ============================================================================

-- Los números del freno, en un solo sitio. Cambiarlos es una migración.
create or replace function public.frenos_de_tarjeta()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'intentos_por_hora', 5,
    'rechazos_por_dia', 3,
    'tope_por_pedido_cents', 15000
  )
$$;

revoke all on function public.frenos_de_tarjeta() from public, anon, authenticated;
grant execute on function public.frenos_de_tarjeta() to service_role;

-- ¿Tiene este cliente la tarjeta apagada por rechazos recientes?
create or replace function public.tarjeta_apagada_para(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_customer_id is not null and (
    select count(*)
      from public.payments p
      join public.orders o on o.id = p.order_id and o.business_id = p.business_id
     where o.customer_id = p_customer_id
       and p.status = 'rechazado'
       and p.updated_at > now() - interval '24 hours'
  ) >= (public.frenos_de_tarjeta() ->> 'rechazos_por_dia')::integer
$$;

revoke all on function public.tarjeta_apagada_para(uuid) from public, anon, authenticated;
grant execute on function public.tarjeta_apagada_para(uuid) to service_role;

-- El pedido con tarjeta: ni por encima del tope, ni de un cliente con la
-- tarjeta apagada. El mensaje llega tal cual a la tienda.
create or replace function public.orders_tope_de_tarjeta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tope integer := (public.frenos_de_tarjeta() ->> 'tope_por_pedido_cents')::integer;
begin
  if tg_op = 'INSERT' and public.tarjeta_apagada_para(new.customer_id) then
    raise exception using
      errcode = 'P0001',
      message = 'Por seguridad, el pago con tarjeta está desactivado 24 horas para tu número '
        || 'tras varios intentos rechazados. Puedes pagar en efectivo o por transferencia.';
  end if;
  if round(coalesce(new.total, 0) * 100) > v_tope then
    raise exception using
      errcode = 'P0001',
      message = format(
        'Con tarjeta el máximo por pedido es $%s y tu pedido suma $%s. Paga en efectivo o por transferencia.',
        to_char(v_tope / 100.0, 'FM999999990.00'),
        to_char(coalesce(new.total, 0), 'FM999999990.00')
      );
  end if;
  return new;
end;
$$;

revoke all on function public.orders_tope_de_tarjeta() from public, anon, authenticated;

drop trigger if exists orders_tope_de_tarjeta on public.orders;
create trigger orders_tope_de_tarjeta
  before insert or update of total, payment_method on public.orders
  for each row when (new.payment_method = 'tarjeta' and new.payment_confirmed_at is null)
  execute function public.orders_tope_de_tarjeta();

-- Y el inicio del cobro, con el freno POR CLIENTE, la tarjeta apagada y el tope.
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

  v_centavos := round(coalesce(v_order.total, 0) * 100)::integer;
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

revoke all on function public.start_card_payment(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.start_card_payment(uuid, uuid, text, text)
  to service_role;
