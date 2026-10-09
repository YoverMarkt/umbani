/**
 * La app de Umbani, la puerta de todo desde el 2026-10-09: Umbani es SOLO APP,
 * se entra con la cuenta y la tienda de un local se abre desde ella. Cualquier
 * salida de la tienda —volver, un acceso que no vale, un pedido cancelado—
 * lleva aquí, nunca a WhatsApp.
 */
export const DIRECCION_DE_UMBANI = '/u'

/** La app abierta directo en «Mis pedidos»: la salida natural después de pedir. */
export const DIRECCION_DE_MIS_PEDIDOS = '/u#pedidos'

export const volverAUmbani = (): void => {
  window.location.assign(DIRECCION_DE_UMBANI)
}
