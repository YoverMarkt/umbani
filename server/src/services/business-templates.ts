import { businessTypesWithTemplate, normalizeBusinessType, templateForBusinessType } from './plantillas-por-tipo'

// Con qué NACE un negocio según su tipo: su carta (`plantillas-por-tipo.ts`, que
// vivía aquí hasta el 2026-10-07) y cuánto tarda (abajo). Los importadores de
// siempre siguen pidiendo las dos cosas aquí.
export { businessTypesWithTemplate, templateForBusinessType }

// ══════════════════════════════════════════════════════════════════════════
// CUÁNTO TARDA CADA TIPO DE NEGOCIO
//
// Con qué tiempo de preparación NACE un negocio, igual que nace con su carta.
// Antes era 30 minutos para todos, escrito a mano en la ruta de la tienda: una
// heladería y un asadero ofrecían las mismas franjas, y una de las dos siempre
// mentía.
//
// ⚠️ Misma regla que las plantillas y las capacidades: **solo recomienda al
// crear**. En cuanto el negocio existe manda su dueño desde el panel, y nada
// de aquí vuelve a tocarlo. El dueño conoce su cocina; esto solo evita que
// empiece con un número inventado.
//
// El defecto de los tipos que no están listados son 25 minutos, que es lo que
// tarda una cocina normal y el valor por defecto de la columna en la base.
// ══════════════════════════════════════════════════════════════════════════

const MINUTOS_POR_TIPO: Record<string, number> = {
  // Se sirve al momento: ya está hecho, solo hay que despacharlo.
  heladeria: 10,
  postres: 10,
  batidos: 10,
  jugos: 10,
  // Se arma en el mostrador.
  cafeteria: 15,
  panaderia: 15,
  pasteleria: 15,
  desayunos: 15,
  tienda: 15,
  farmacia: 15,
  supermercado: 15,
  ferreteria: 15,
  perfumeria: 15,
  // Cocina rápida, pensada para salir deprisa.
  'comida rapida': 20,
  hamburgueseria: 20,
  sushi: 20,
  'comida china': 20,
  // Cocina de plato, que es el caso normal (y el defecto de la columna).
  pizzeria: 25,
  restaurante: 25,
  almuerzos: 25,
  'menu ejecutivo': 25,
  'comida tipica': 25,
  'comida mexicana': 25,
  'comida saludable': 25,
  'emprendimiento de comida': 25,
  // Carbón y leña: no se acelera, y prometer menos deja al cliente esperando
  // en la puerta.
  asadero: 40,
  parrillada: 40,
  'pollo asado': 40,
  marisqueria: 40,
  carniceria: 40,
}

/** Lo que tarda una cocina normal, y el defecto de la columna en la base. */
export const PREP_TIME_POR_DEFECTO = 25

/**
 * Los minutos con los que nace un negocio de este tipo.
 *
 * Casa igual que `templateForBusinessType` —exacto primero, después por
 * contención y gana el más largo— para que un tipo escrito a mano como
 * «heladería artesanal» herede los diez minutos de la heladería en vez de
 * caer al defecto.
 */
export const prepTimeForBusinessType = (type?: string | null): number => {
  const normalized = normalizeBusinessType(type || '')
  if (!normalized) return PREP_TIME_POR_DEFECTO

  const exacto = MINUTOS_POR_TIPO[normalized]
  if (exacto) return exacto

  const candidatos = Object.keys(MINUTOS_POR_TIPO)
    .filter(clave => normalized.includes(clave))
    .sort((a, b) => b.length - a.length)

  return candidatos.length ? MINUTOS_POR_TIPO[candidatos[0]] : PREP_TIME_POR_DEFECTO
}

/** Los tipos con tiempo propio. Lo usa la prueba que los contrasta con el panel. */
export const businessTypesWithPrepTime = (): string[] => Object.keys(MINUTOS_POR_TIPO)
