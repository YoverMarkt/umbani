-- ============================================================================
-- ANULAR UNA VENTA DE LA APP: SOLO UMBANI (2026-10-11)
--
-- Decisión del dueño (2026-10-11), «como las grandes»: el local ya no puede
-- anular un pedido de la app que ya entregó.
--
-- Hasta hoy, el dueño —o un empleado con permiso de «ventas»— anulaba
-- cualquier venta desde su panel, y la base la sacaba del libro: en efectivo,
-- el local se ahorraba la comisión de Umbani (y si la semana ya estaba
-- liquidada, Umbani se la devolvía en la siguiente), sin que quedara nada en
-- el registro de dinero. En Uber Eats o Rappi el local no puede anular un
-- pedido entregado: el ajuste lo hace la plataforma.
--
--   · Las ventas de MOSTRADOR (y las manuales de antes) las sigue anulando el
--     local: son suyas, las tecleó él.
--   · Las de la app solo las anula Umbani, con `anular_venta_por_umbani`:
--     motivo obligatorio y una fila en el registro de dinero con quién fue.
--   · Lo exige la BASE (un disparador), no solo la pantalla: una ruta que
--     mañana se olvide de la regla no puede saltársela.
-- ============================================================================


-- ── 1. La regla, en la base ─────────────────────────────────────────────────
-- Solo deja pasar a «anulada» una venta de la app si la anula Umbani: la
-- marca `umbani.anula_umbani` la pone ÚNICAMENTE `anular_venta_por_umbani`, y
-- vive lo que dura su transacción (`set_config(…, true)`).
create or replace function public.sales_anular_solo_umbani()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'anulada' and old.status is distinct from 'anulada'
     and coalesce(old.source, 'manual') not in ('mostrador', 'manual')
     and coalesce(current_setting('umbani.anula_umbani', true), '') <> 'si' then
    raise exception using errcode = '42501',
      message = 'Los pedidos de la app solo los anula Umbani.';
  end if;
  return new;
end;
$$;

revoke all on function public.sales_anular_solo_umbani() from public, anon, authenticated;

drop trigger if exists sales_anular_solo_umbani on public.sales;
create trigger sales_anular_solo_umbani
  before update of status on public.sales
  for each row execute function public.sales_anular_solo_umbani();


-- ── 2. Umbani anula: con motivo y con rastro ────────────────────────────────
-- Por el número del pedido en su local, que es como lo dice el dueño o el
-- cliente. El libro se ajusta solo (`sales_void_ledger`): sin liquidar, sale
-- de la semana; ya liquidada, deja un reverso en la siguiente.
create or replace function public.anular_venta_por_umbani(
  p_business_id uuid, p_order_number integer, p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_o public.orders%rowtype;
  v_s public.sales%rowtype;
begin
  if char_length(v_motivo) < 3 or char_length(v_motivo) > 300 then
    return jsonb_build_object('result', 'motivo_invalido');
  end if;

  select * into v_o from public.orders
   where business_id = p_business_id and order_number = p_order_number;
  if v_o.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into v_s from public.sales
   where order_id = v_o.id and business_id = p_business_id
  for update;
  if v_s.id is null then
    return jsonb_build_object('result', 'sin_venta');
  end if;
  if v_s.status = 'anulada' then
    return jsonb_build_object('result', 'ya_anulada');
  end if;

  perform set_config('umbani.anula_umbani', 'si', true);
  update public.sales set status = 'anulada' where id = v_s.id;
  perform set_config('umbani.anula_umbani', '', true);

  perform public.anotar_movimiento_de_dinero(
    p_business_id, 'venta_anulada', 'sales', v_s.id::text,
    jsonb_build_object('numero', v_o.order_number, 'total', v_s.total,
                       'metodo', v_o.payment_method, 'motivo', v_motivo));

  return jsonb_build_object('result', 'ok', 'numero', v_o.order_number, 'total', v_s.total);
end;
$$;

revoke all on function public.anular_venta_por_umbani(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.anular_venta_por_umbani(uuid, integer, text) to service_role;
