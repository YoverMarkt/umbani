-- ============================================================================
-- EL CUADRE DIARIO CONTRA PAYPHONE
--
-- Lo que faltaba del PR A2 de las liquidaciones (2026-09-29). Hasta hoy
-- nuestra base decía qué se cobró y qué se devolvió, y nadie lo comparaba con
-- lo que dice PayPhone. El 2026-09-28 se vio por qué hace falta: el portal de
-- pruebas de PayPhone enseñaba «Pendiente» un cobro que su API daba por
-- DEVUELTO; y la devolución se pidió a las 22:06, pasada la hora límite de las
-- 20:00 que dice su documentación. En el sandbox salió bien. En producción,
-- una devolución después de las 20:00 podría contestar «sí» y no hacerse — y
-- el cliente creería que le devolvieron el dinero.
--
-- Una vez al día, cada cobro de los últimos 3 días se pregunta a PayPhone por
-- su referencia y se compara (`services/cuadre-payphone.ts`). Esta migración
-- solo guarda el RESULTADO. ⚠️ El cuadre NUNCA mueve dinero ni cambia el
-- estado de un cobro: avisa, y la persona decide.
--
-- ⚠️ No toca `updated_at`: el freno de tarjetas robadas cuenta los rechazos por
-- esa fecha, y cuadrar un rechazo le reiniciaría las 24 horas.
-- ============================================================================

alter table public.payments
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciliation text,
  add column if not exists reconciliation_detail text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_reconciliation_check') then
    alter table public.payments
      add constraint payments_reconciliation_check
      check (reconciliation is null or reconciliation in ('cuadra', 'descuadre'));
  end if;
end $$;

comment on column public.payments.reconciliation is
  'El último cuadre contra PayPhone: cuadra o descuadre. Lo escribe la tarea diaria; nunca cambia el estado del cobro.';

-- Los cobros que tocan cuadrar: los de los últimos 3 días que no se cuadraron
-- en las últimas 20 h. Los que siguen vivos (`iniciado`, `confirmando`) son
-- trabajo de la tarea de cobros; solo se miran si llevan más de 30 minutos.
create or replace function public.payments_to_reconcile(p_environment text, p_limite integer default 120)
returns table (
  id uuid,
  business_id uuid,
  business_name text,
  order_id uuid,
  order_number integer,
  client_transaction_id text,
  provider_transaction_id text,
  status text,
  amount_cents integer,
  captured_cents integer,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.business_id, b.name, p.order_id, o.order_number, p.client_transaction_id,
         p.provider_transaction_id, p.status, p.amount_cents, p.captured_cents, p.created_at
    from public.payments p
    join public.businesses b on b.id = p.business_id
    left join public.orders o on o.id = p.order_id and o.business_id = p.business_id
   where p.environment = p_environment
     and p.created_at > now() - interval '3 days'
     and (p.reconciled_at is null or p.reconciled_at < now() - interval '20 hours')
     and (p.status not in ('iniciado', 'confirmando') or p.created_at < now() - interval '30 minutes')
   order by p.created_at
   limit least(greatest(coalesce(p_limite, 120), 1), 300);
$$;

revoke all on function public.payments_to_reconcile(text, integer) from public, anon, authenticated;
grant execute on function public.payments_to_reconcile(text, integer) to service_role;

create or replace function public.mark_payment_reconciled(p_id uuid, p_resultado text, p_detalle text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_resultado not in ('cuadra', 'descuadre') then
    raise exception using errcode = '22023', message = 'Resultado de cuadre inválido';
  end if;
  -- ⚠️ Sin `updated_at`: ver la cabecera.
  update public.payments
     set reconciled_at = now(),
         reconciliation = p_resultado,
         reconciliation_detail = left(nullif(btrim(coalesce(p_detalle, '')), ''), 300)
   where id = p_id;
  return found;
end;
$$;

revoke all on function public.mark_payment_reconciled(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_payment_reconciled(uuid, text, text) to service_role;
