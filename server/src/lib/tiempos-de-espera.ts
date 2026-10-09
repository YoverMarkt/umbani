import type { Server } from 'node:http'

// ═══════════════════════════════════════════════════════════════════════════
// CUÁNTO SE ESPERA A UN CLIENTE LENTO (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// El ataque «slowloris»: abrir muchas conexiones y mandar las cabeceras a
// cuentagotas, para tener al servidor esperándolas todas. Node espera 60 s por
// defecto a que lleguen; aquí, 20. Son unos cientos de bytes y un teléfono las
// manda en milisegundos, así que 20 s cubren de sobra la peor red, y quien
// ataca tiene que renovar cada conexión tres veces más a menudo.
//
// ⚠️ Lo que NO se acorta, a propósito: el tiempo para recibir la petición
// ENTERA. Las subidas llegan a 16 MB (fotos y vídeos del catálogo) y a 5 MB (el
// comprobante que un cliente sube desde la tienda, a veces con datos móviles):
// acortarlo cortaría subidas de verdad en una red lenta. A los cuerpos los
// frenan el tamaño máximo de cada ruta y los limitadores. Se escribe igual el
// valor, para que se lea como decisión y no dependa de lo que traiga Node.
//
// ⚠️ Delante está el proxy de Railway, que ve primero a cada cliente: esto es
// la segunda línea. La primera, cuando llegue el dominio, será Cloudflare.

export const ESPERA_DE_CABECERAS_MS = 20_000
export const ESPERA_DE_LA_PETICION_MS = 300_000

export function ajustarTiemposDeEspera(servidor: Pick<Server, 'headersTimeout' | 'requestTimeout'>): void {
  servidor.headersTimeout = ESPERA_DE_CABECERAS_MS
  servidor.requestTimeout = ESPERA_DE_LA_PETICION_MS
}
