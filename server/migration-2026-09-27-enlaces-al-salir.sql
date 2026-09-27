-- ============================================================================
-- AL SALIR CON «MENÚ», EL ENLACE SE DECIDE POR LOS PEDIDOS, NO POR EL CHAT
--
-- Lo encontró el dueño con el teléfono de un amigo (2026-09-26), y con los
-- datos reales de producción:
--
--   10:57  el amigo elige La Abuelita y recibe su enlace
--   10:59  pide (#25) y queda esperando comprobante
--   11:01  escribe MENÚ → el pedido SE CANCELA… y el enlace NO se revoca
--   11:02  toca «Ver la carta» de arriba y la tienda le vuelve a abrir
--
-- Con el número del dueño nunca pasó, y no era por el número: él escribía MENÚ
-- sin un pago pendiente.
--
-- La causa era el ORDEN. MENÚ primero cancela el pedido sin pagar
-- (`cancel_unpaid_order_on_purpose`) y después decidía si revocar mirando el
-- estado del CHAT de antes de cancelar —«esperando_comprobante»—, que caía en
-- la excepción pensada para quien tiene que pagar: «conserva su enlace para
-- mandar el comprobante». Pero ese pedido ya no existía.
--
-- Ahora lo decide la base mirando los PEDIDOS en el mismo momento, igual que
-- ya hace `revoke_storefront_sessions_except` con «Seguir mi pedido»: se
-- revocan todos los enlaces del cliente SALVO los de un local donde aún tenga
-- un pedido de la tienda esperando pago o con el pago en revisión. La
-- excepción del dueño se conserva entera —quien ya transfirió sigue viendo su
-- pedido—, pero ya no se aplica a un pedido que acaba de cancelarse.
-- ============================================================================

create or replace function public.revoke_storefront_sessions_on_exit(
  p_customer_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revocadas integer;
begin
  if p_customer_id is null then
    return 0;
  end if;

  with revocadas as (
    update public.storefront_sessions as sesion
       set revoked_at = now()
     where sesion.customer_id = p_customer_id
       and sesion.revoked_at is null
       -- ⚠️ La excepción: el local donde todavía se le necesita. Se mira el
       -- pedido TAL COMO ESTÁ AHORA, después de que MENÚ cancelara el suyo.
       and not exists (
         select 1
           from public.orders as pedido
          where pedido.customer_id = p_customer_id
            and pedido.business_id = sesion.business_id
            and pedido.source      = 'storefront'
            and pedido.status in ('esperando_pago', 'pago_en_revision')
       )
    returning 1
  )
  select count(*)::integer into v_revocadas from revocadas;

  return coalesce(v_revocadas, 0);
end;
$$;

comment on function public.revoke_storefront_sessions_on_exit(uuid) is
  'MENÚ y «Empezar de nuevo»: revoca todos los enlaces del cliente salvo los de '
  'un local donde aún tenga un pedido de la tienda esperando pago o en revisión.';

revoke all on function public.revoke_storefront_sessions_on_exit(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_storefront_sessions_on_exit(uuid)
  to service_role;
