-- ============================================================================
-- LA CAPTURA SE SUBE EN LA APP, NO POR EL CHAT DE WHATSAPP (2026-10-09)
--
-- Decisión del dueño: Umbani es SOLO APP. El comprobante de una transferencia
-- se sube en la pantalla del pedido, y al cliente ya no se le escribe por
-- WhatsApp. El checkout seguía diciendo, debajo de «Transferencia bancaria»,
-- «Transfiere y manda la captura por el mismo chat de WhatsApp».
--
-- Lo destapó recorrer el staging con un navegador: el guardián de la tienda
-- (`solo-app.test.mjs`) mira el CÓDIGO, y este texto vive en la BASE. Lo leen
-- igual la tienda web y las apps Flutter.
--
-- ⚠️ Solo si sigue diciendo lo de antes: si alguien ya lo cambió a mano, no se
-- pisa. Y `schema.sql` siembra ya el texto nuevo para las bases que nacen.
-- ============================================================================

update public.payment_methods
set help_text = 'Al confirmar ves la cuenta. Transfiere y sube la captura aquí, en la app.'
where code = 'transferencia'
  and help_text = 'Transfiere y manda la captura por el mismo chat de WhatsApp.';
