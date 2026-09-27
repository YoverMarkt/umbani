-- ============================================================================
-- EL TECHO DEL MARKETPLACE AVISA UNA VEZ, EN VEZ DE CALLAR
--
-- Lo vivió el dueño el 2026-09-27 probando con su teléfono: a las 00:42 llegó a
-- la respuesta 26 de la hora y `claim_marketplace_reply` lo silenció 12 horas.
-- Sus «Menu» siguientes no recibieron NADA — ni un «vuelve más tarde» — y lo
-- leyó como que el chat se había colgado, o que WhatsApp lo estaba frenando.
--
-- El techo se queda como está (25 por hora, 12 h de silencio): lo que cambia es
-- que el mensaje que lo CRUZA devuelve `aviso: true` y `hasta`, y el código le
-- dice una sola vez hasta cuándo. Es la misma regla que ya sigue el bloqueo del
-- dueño —«al bloqueado se le explica UNA vez»—: avisar en cada intento haría
-- que el silenciado costara más mensajes que un cliente normal.
--
-- ⚠️ Solo cambian los dos `return` del silencio. Antes de reescribirla se
-- comprobó que la función de producción era IDÉNTICA a la de `schema.sql`.
-- ============================================================================

create or replace function public.claim_marketplace_reply(
  p_customer_id uuid,
  p_tope integer default 25,
  p_silencio_horas integer default 12,
  -- Nulo = no se puede identificar el mensaje. Se cuenta igual: contar de más
  -- es menos malo que no contar.
  p_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila public.marketplace_conversations%rowtype;
  v_ahora timestamptz := now();
  v_cuenta integer;
begin
  -- Sin cliente no hay a quién contarle nada: se atiende. Quedarse mudo por un
  -- problema nuestro deja sin servicio a alguien de verdad, mientras que
  -- equivocarse al revés cuesta un mensaje.
  if p_customer_id is null then
    return jsonb_build_object('permitido', true, 'respuestas', 0);
  end if;

  -- La conversación puede no existir todavía: el primer mensaje de alguien que
  -- nunca escribió llega antes de que nadie la cree.
  insert into public.marketplace_conversations (customer_id)
  values (p_customer_id)
  on conflict (customer_id) do nothing;

  select * into v_fila
  from public.marketplace_conversations
  where customer_id = p_customer_id
  for update;

  if v_fila.muted_until is not null and v_fila.muted_until > v_ahora then
    return jsonb_build_object(
      'permitido', false, 'motivo', 'silenciado',
      'respuestas', coalesce(v_fila.reply_count, 0),
      -- Hasta cuándo, pero SIN aviso: ya se le dijo al silenciarlo.
      'hasta', v_fila.muted_until
    );
  end if;

  -- ── El mismo mensaje otra vez ────────────────────────────────────────────
  -- Se devuelve lo que le tocaba y NO se suma. Un reintento del worker no
  -- puede acercar a nadie al silencio.
  if p_message_id is not null
     and v_fila.last_reply_message_id is not distinct from p_message_id then
    return jsonb_build_object(
      'permitido', true,
      'respuestas', coalesce(v_fila.reply_count, 0),
      'repetido', true
    );
  end if;

  if v_fila.reply_window_start is null
     or v_fila.reply_window_start < v_ahora - interval '1 hour' then
    v_cuenta := 1;
    update public.marketplace_conversations
       set reply_window_start = v_ahora,
           reply_count = 1,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  else
    v_cuenta := coalesce(v_fila.reply_count, 0) + 1;
    update public.marketplace_conversations
       set reply_count = v_cuenta,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  end if;

  if v_cuenta > p_tope then
    update public.marketplace_conversations
       set muted_until = v_ahora + make_interval(hours => p_silencio_horas),
           updated_at = v_ahora
     where id = v_fila.id;
    -- ⚠️ `aviso` SOLO aquí, en el mensaje que cruza el techo (2026-09-27).
    -- Es la única vez que se le explica: los siguientes caen en la rama de
    -- arriba, sin aviso. Callar siempre dejaba al cliente —y al dueño
    -- probando— escribiendo MENÚ a un chat mudo sin saber por qué ni hasta
    -- cuándo.
    return jsonb_build_object(
      'permitido', false, 'motivo', 'silenciado', 'respuestas', v_cuenta,
      'aviso', true,
      'hasta', v_ahora + make_interval(hours => p_silencio_horas)
    );
  end if;

  return jsonb_build_object('permitido', true, 'respuestas', v_cuenta);
end;
$$;
