-- ============================================================================
-- EL PEDIDO NUEVO LE DICE AL CHAT DÓNDE ESTÁ — y al de efectivo lo suelta
--
-- Dos fallos que se vieron en staging el 2026-09-27, los dos al NACER el
-- pedido, y los dos en la conversación de WhatsApp:
--
-- 1. EL «EMPEZAR DE NUEVO» DE ANTES DE PEDIR SEGUÍA VIVO.
--    Quien escribía algo en el chat estando en el local —un «hola»— recibía la
--    pregunta «¿Empezamos de nuevo o sigues con tu pedido?», y esa vista
--    (`confirmando_reinicio`) se quedaba guardada. Luego pedía por la mini app
--    y la pregunta seguía pendiente:
--      · tocar el «✅ Empezar de nuevo» de ANTES CANCELABA el pedido por
--        transferencia —aunque ya hubiera transferido—;
--      · y el «Hola, te envío el comprobante de mi pedido #N» que precarga la
--        mini app recibía «🙏 Con eso no te puedo ayudar por aquí».
--    Ahora el pedido que nace esperando pago BORRA la pregunta pendiente
--    (`flow_state = null`): la pregunta era sobre un carrito que ya es pedido.
--
-- 2. EL PEDIDO EN EFECTIVO NO SOLTABA EL CANDADO. NUNCA.
--    DECISIONES.md da por vigente que `pendiente` no retiene —«`marketplace-
--    entry` ya suelta el candado al crearlo»—, y era verdad solo en el checkout
--    DEL CHAT, que lo hacía a mano. Se retiró con él en el #360 (2026-09-15) y
--    la mini app nunca lo tuvo. `orders_release_shopping_lock` solo mira
--    UPDATE, y un pedido en efectivo nace directamente en `pendiente`: no hay
--    transición que lo suelte.
--    Efecto medido en staging: tras pedir en efectivo, «gracias» recibía
--    «Estás pidiendo en X. Termínalo…», y con el pedido YA ENTREGADO un «hola»
--    seguía recibiendo «¿Empezamos de nuevo o sigues con tu pedido?».
--    En producción no había nadie atascado (0 conversaciones con candado), pero
--    le iba a pasar a cada cliente que pague en efectivo.
--    Ahora el mismo disparador que suelta el candado mira también el INSERT.
--
-- ⚠️ Antes de reescribirlas se comprobó que las dos funciones de producción
-- eran IDÉNTICAS a las de `schema.sql` (pg_get_functiondef, 2026-09-27).
-- ============================================================================

-- ── 1. El pedido que nace esperando pago borra la pregunta pendiente ────────
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
       set current_state = 'esperando_comprobante',
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
       and conv.current_state <> 'esperando_comprobante';
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
  'de nuevo» de antes de pedir no puede cancelar el pedido recién nacido.';

-- ── 2. El pedido que nace sin deber nada suelta el candado ──────────────────
create or replace function public.orders_release_shopping_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Los dos estados en los que el cliente ya encargó y el local aún no dijo
  -- que sí. `pendiente` (efectivo) queda fuera: no lleva comprobante.
  v_retienen constant text[] := array['esperando_pago', 'pago_en_revision'];
begin
  if new.customer_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- ── Nace sin deber nada: se suelta (2026-09-27) ───────────────────────
    --
    -- Efectivo y pago al retirar nacen en `pendiente`, sin pasar nunca por un
    -- estado que retenga, así que la rama de UPDATE de abajo no los veía y el
    -- candado se quedaba puesto PARA SIEMPRE: el chat le decía «termínalo» a
    -- un pedido hecho, y seguía preguntando después de entregado. Lo hacía a
    -- mano el checkout del chat, y se fue con él en el #360.
    --
    -- ⚠️ Solo los de la TIENDA. El de mostrador lo teclea el dueño con la
    -- persona delante: no tiene nada que ver con su conversación.
    if coalesce(new.source, '') <> 'storefront' or new.status = any(v_retienen) then
      return new;
    end if;
  else
    -- ── Sigue debiendo: el candado se queda ───────────────────────────────
    if new.status = any(v_retienen) then
      -- Pero la conversación tiene que saber en cuál de los dos está, o el
      -- bot le pedirá la foto a quien acaba de mandarla.
      if new.status = 'pago_en_revision' and old.status <> 'pago_en_revision' then
        begin
          update public.marketplace_conversations as conv
             set current_state = 'pago_en_revision',
                 version       = conv.version + 1,
                 updated_at    = now()
           where conv.customer_id = new.customer_id
             and conv.shopping_locked = true
             and conv.selected_business_id = new.business_id;
        exception when others then
          -- El pedido ya avanzó: un fallo aquí no puede tumbarlo.
          null;
        end;
      end if;
      return new;
    end if;

    -- ── Salió de los estados que retienen: se suelta ──────────────────────
    if not (old.status = any(v_retienen)) then
      return new;
    end if;
  end if;

  begin
    -- ⚠️ Solo si no le quedan OTROS pedidos reteniendo. Alguien con dos a
    -- medias que resuelve uno sigue debiendo el otro; soltarle el candado ahí
    -- sería premiar el pago parcial con vía libre.
    if exists (
      select 1
      from public.orders as otro
      where otro.customer_id = new.customer_id
        and otro.id <> new.id
        and otro.source = 'storefront'
        and otro.status = any(v_retienen)
    ) then
      return new;
    end if;

    update public.marketplace_conversations as conv
       set shopping_locked     = false,
           -- Soltar el local va JUNTO con soltar el candado: el CHECK
           -- `marketplace_conversations_bloqueo_check` prohíbe estar bloqueado
           -- en ninguna parte, y dejar el local elegido sin candado haría que
           -- el siguiente mensaje entrara en un local que la persona ya
           -- terminó.
           selected_business_id = null,
           current_state        = 'navegando',
           flow_state           = null,
           version              = conv.version + 1,
           updated_at           = now()
     where conv.customer_id = new.customer_id
       and conv.shopping_locked = true
       -- ⚠️ Al NACER, solo si está en el local de ESTE pedido. Si ya anda
       -- eligiendo en otro, ese candado es de lo que hace ahora y no se toca.
       and (tg_op = 'UPDATE' or conv.selected_business_id = new.business_id);
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists orders_release_shopping_lock on public.orders;
create trigger orders_release_shopping_lock
  after insert or update of status on public.orders
  for each row execute function public.orders_release_shopping_lock();

comment on function public.orders_release_shopping_lock() is
  'Suelta `shopping_locked` cuando un pedido deja de estar abierto —o nace sin '
  'deber nada, como el de efectivo— y a la persona no le quedan otros. Va en '
  'disparador para cubrir todos los caminos, incluidos los que no existen todavía.';
