import { BlockList, isIPv4, isIPv6 } from 'node:net'

// ═══════════════════════════════════════════════════════════════════════════
// LAS DIRECCIONES DESDE LAS QUE CLOUDFLARE NOS HABLA (2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Con el dominio, Cloudflare se pone delante (DOMINIO.md §2) y la IP que
// Railway escribe en `X-Real-IP` pasa a ser la de un nodo de Cloudflare. El
// cliente de verdad llega en `CF-Connecting-IP`, y ESA cabecera solo se puede
// creer si la petición viene de una de estas redes: cualquiera puede mandarla
// inventada si le habla a Railway directamente.
//
// La lista es la publicada en https://www.cloudflare.com/ips/ (descargada el
// 2026-10-09; la API https://api.cloudflare.com/client/v4/ips daba la etiqueta
// `38f79d050aa027e3be3865e495dcc9bc`). Cambia muy de tarde en tarde.
// ⚠️ Si Cloudflare publica una red nueva y no se añade aquí, las peticiones
// que entren por ella vuelven a contar por NODO (el fallo del PR #448). No se
// rompe nada más, y `ip-del-cliente.ts` lo avisa en el registro.

const IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]

const IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]

export const RANGOS_DE_CLOUDFLARE: readonly string[] = [...IPV4, ...IPV6]

const redes = new BlockList()
for (const rango of IPV4) {
  const [red, prefijo] = rango.split('/')
  redes.addSubnet(red, Number(prefijo), 'ipv4')
}
for (const rango of IPV6) {
  const [red, prefijo] = rango.split('/')
  redes.addSubnet(red, Number(prefijo), 'ipv6')
}

/** ¿Es esta dirección un nodo de Cloudflare? También escrita como IPv6 (`::ffff:104.16.0.1`). */
export function esDeCloudflare(direccion: string | undefined): boolean {
  const ip = (direccion ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')
  if (isIPv4(ip)) return redes.check(ip, 'ipv4')
  if (isIPv6(ip)) return redes.check(ip, 'ipv6')
  return false
}
