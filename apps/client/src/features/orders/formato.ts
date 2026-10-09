// Cómo se dicen las horas en Pedidos: la de un pedido y cuánto lleva esperando.

export const hora = (iso: string) =>
  new Date(iso).toLocaleString('es-EC', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })

/** Cuánto lleva esperando. Es el dato que dice si algo va mal. */
export const espera = (iso: string) => {
  const minutos = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutos < 1) return 'ahora mismo'
  if (minutos < 60) return `hace ${minutos} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `hace ${horas} h`
  return `hace ${Math.floor(horas / 24)} d`
}
