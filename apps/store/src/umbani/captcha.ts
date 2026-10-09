import { NO_COMPROBADO, prepararFichaHumana, type FichaHumana } from '../lib/turnstile'
import { configDeEntrada } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// EL CAPTCHA DE LA PANTALLA DE ENTRAR (2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Si el servidor lo tiene encendido, cada petición de código va con su ficha
// de persona (`lib/turnstile.ts`); apagado, nada cambia. La clave y el widget
// se preparan al abrir la pantalla, y quien toca ANTES de que estén listos
// ESPERA a que lo estén: probado en el navegador, tocar rápido fallaba con
// «no pudimos comprobar que eres una persona» sin que nadie hubiera fallado.

export interface Captcha { clave?: Promise<string | null>; humano?: Promise<FichaHumana> }

/** La clave de sitio, si el servidor la da. Sin config se pide sin ficha: si hacía falta, el servidor lo dice. */
export function claveDelCaptcha(captcha: Captcha): Promise<string | null> {
  captcha.clave ??= configDeEntrada().then(config => config.turnstile?.claveDeSitio ?? null, () => null)
  return captcha.clave
}

export async function humanoListo(captcha: Captcha, lugar: HTMLElement | null): Promise<FichaHumana | null> {
  const clave = await claveDelCaptcha(captcha)
  if (!clave) return null
  if (!lugar) throw new Error(NO_COMPROBADO)
  captcha.humano ??= prepararFichaHumana(lugar, clave)
  return captcha.humano
}

/** Quita el widget y olvida la clave: el próximo intento los vuelve a pedir. */
export function olvidarCaptcha(captcha: Captcha): void {
  void captcha.humano?.then(humano => humano.quitar(), () => {})
  delete captcha.clave
  delete captcha.humano
}
