-- ============================================================================
-- EL PEDIDO CON TARJETA SIN PAGAR YA NO PIDE «COMPROBANTE»
--
-- 2026-09-30, encontrado al probar los frenos de tarjeta: a quien tenía un
-- pedido con tarjeta esperando pago e intentaba pedir otra cosa, la base le
-- contestaba «Tienes un pedido esperando tu COMPROBANTE. Envíalo…». Con tarjeta
-- no hay comprobante: el cliente se quedaba buscando algo que no existe.
--
-- Ahora, si todo lo que tiene sin pagar es con tarjeta, el mensaje da las dos
-- salidas reales: volver a pagarlo, o escribir MENÚ (que cancela el pedido sin
-- pagar). Las reglas no cambian, solo el texto.
-- ============================================================================

create or replace function public.orders_limit_open_per_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_en_el_local      integer;
  v_en_la_plataforma integer;
  v_sin_pagar        integer;
  v_sin_pagar_tarjeta integer;
  v_tope constant integer := 3;
  v_ventana constant interval := interval '6 hours';
  v_abiertos constant text[] := array['esperando_pago', 'pago_en_revision', 'pendiente'];
begin
  if coalesce(new.source, '') <> 'storefront' or new.customer_id is null then
    return new;
  end if;

  -- Un solo recorrido para los tres alcances: el índice
  -- `idx_orders_abiertos_por_cliente` ya cubre (business_id, customer_id,
  -- status, created_at), y contar tres veces sería pagar tres consultas por
  -- cada pedido nuevo para responder a preguntas que salen de la misma fila.
  select
    count(*) filter (where previo.business_id = new.business_id),
    count(*),
    count(*) filter (where previo.status = 'esperando_pago'),
    count(*) filter (where previo.status = 'esperando_pago' and previo.payment_method = 'tarjeta')
  into v_en_el_local, v_en_la_plataforma, v_sin_pagar, v_sin_pagar_tarjeta
  from public.orders as previo
  where previo.customer_id = new.customer_id
    and previo.source = 'storefront'
    and previo.status = any(v_abiertos)
    and previo.created_at > now() - v_ventana;

  -- ── EL QUE FALTABA, y va PRIMERO ────────────────────────────────────────
  --
  -- Va antes que los otros dos porque es el más específico y el que mejor
  -- explica qué hacer: los topes dicen «tienes varios sin confirmar», que a
  -- quien debe UN comprobante no le dice nada útil.
  --
  -- El texto nombra la salida —mandar el comprobante— y no acusa: la mayoría
  -- de las veces es alguien que se distrajo, no alguien que está probando.
  --
  -- ⚠️ Con TARJETA no hay comprobante (2026-09-30): a quien dejó un pago con
  -- tarjeta a medias se le decía «envía tu comprobante», que no existe. Se le
  -- dan las dos salidas de verdad: pagarlo, o MENÚ, que cancela el pedido sin
  -- pagar (si PayPhone lo aprobara después, no se confirma y lo devuelve solo).
  if v_sin_pagar >= 1 and v_sin_pagar = v_sin_pagar_tarjeta then
    raise exception using
      errcode = '42501',
      message = 'Tienes un pedido esperando su pago con tarjeta. Vuelve a él para pagarlo, '
        || 'o escribe MENÚ en el chat de Umbani para cancelarlo y pedir de nuevo.';
  end if;
  if v_sin_pagar >= 1 then
    raise exception using
      errcode = '42501',
      message = 'Tienes un pedido esperando tu comprobante. Envíalo y podrás hacer otro.';
  end if;

  -- El del LOCAL: cuando los dos se cumplen, su mensaje es el útil —dice dónde
  -- está el problema y por tanto qué hacer—.
  if v_en_el_local >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Ya tienes pedidos sin confirmar en este local. Espera a que los revisen antes de hacer otro.';
  end if;

  -- El de PLATAFORMA. El texto nombra Umbani a propósito: quien llega aquí ha
  -- pedido en varios locales, y decirle «en este local» lo mandaría a mirar el
  -- sitio equivocado.
  if v_en_la_plataforma >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Tienes varios pedidos sin confirmar en Umbani. Envía el comprobante de los que faltan y podrás pedir de nuevo.';
  end if;

  return new;
end;
$$;
