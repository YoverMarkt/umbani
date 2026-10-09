import { randomBytes } from 'node:crypto'

// ═══════════════════════════════════════════════════════════════════════════
// COMPROBAR UNA CLAVE SIN DECIR SI LA CUENTA EXISTE (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// Los inicios de sesión ya CONTESTABAN lo mismo exista o no la cuenta
// («Credenciales incorrectas»), pero no TARDABAN lo mismo: con un correo sin
// cuenta se respondía al momento, y con uno que sí la tiene se pagaba un bcrypt
// (decenas de milisegundos). Cronometrando se sabía qué correos son de un
// dueño o de una cooperativa: la mitad del trabajo de quien prueba claves
// robadas de otras webs.
//
// Sin cuenta se compara contra un hash de RELLENO con el mismo coste que los de
// la base: tarda lo mismo y nunca da por buena ninguna clave. Y de paso, una
// cuenta creada SIN clave (`password_hash` vacío) ya no revienta en un 500
// —`bcrypt.compare(clave, null)` lanza—: es un «no» como cualquier otro.

interface Bcrypt {
  compare(clave: string, hash: string): Promise<boolean>
  hash(clave: string, coste: number): Promise<string>
}
// Por el objeto del módulo y no desestructurado: las pruebas espían `compare`.
const bcrypt: Bcrypt = require('bcryptjs') as typeof import('bcryptjs')

/**
 * El coste con el que la plataforma guarda las claves (`bcrypt.hash(clave, 10)`).
 * ⚠️ Si sube allí, sube aquí: un relleno más barato volvería a delatar la cuenta.
 * Lo vigila `clave-sin-pistas.test.js`, que lee cada `bcrypt.hash` del servidor.
 */
export const COSTE_DE_LAS_CLAVES = 10

let relleno: Promise<string> | null = null
// Se calcula la primera vez que hace falta, no al cargar: así no retrasa el
// arranque ni deja trabajo suelto al terminar una prueba.
const hashDeRelleno = () => (relleno ??= bcrypt.hash(randomBytes(18).toString('base64'), COSTE_DE_LAS_CLAVES))

/** ¿Es `clave` la de esa cuenta? Sin cuenta o sin hash, tarda lo mismo y dice que no. */
export async function claveCorrecta(clave: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(clave, await hashDeRelleno())
    return false
  }
  return bcrypt.compare(clave, hash)
}
