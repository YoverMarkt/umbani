-- ============================================================================
-- LA MARCA DE LA TARJETA, ENTERA (2026-10-11)
--
-- PayPhone dice la marca y el banco de la tarjeta, por ejemplo «Discover Banco
-- Diners Club del Ecuador», y `settle_card_payment` guardaba solo 30 letras:
-- «Discover Banco Diners Club del». Solo es lo que se enseña en el detalle del
-- cobro; no toca dinero. Apuntado desde la primera prueba real (2026-09-27)
-- para el próximo cambio que tocara la función.
--
-- ⚠️ Copiada ENTERA de la vigente (migration-2026-10-10-usar-el-saldo.sql);
-- cambia SOLO el largo de la marca.
-- ============================================================================

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
  -- 80, no 30 (2026-10-11): «Discover Banco Diners Club del Ecuador» se quedaba
  -- en «Discover Banco Diners Club del». Solo es lo que se enseña; no toca dinero.
  v_marca   text := left(nullif(btrim(coalesce(p_card_brand, '')), ''), 80);
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
