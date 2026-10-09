// ═══════════════════════════════════════════════════════════════════════════
// QUIÉN ES EL CLIENTE DETRÁS DEL PROXY DE RAILWAY (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// Todos los frenos contra abusos (`express-rate-limit`) cuentan por `req.ip`,
// y `req.ip` sale de `X-Forwarded-For` según en qué saltos se confía.
//
// El borde de Railway REESCRIBE esa cabecera y deja dos entradas: la IP real
// del cliente y, a su derecha, un salto de su propia red (100.x.x.x, varios
// nodos). Con `trust proxy 1` —lo que había—, Express se quedaba con la de la
// DERECHA: el nodo. Así que cada freno contaba por nodo de Railway, no por
// cliente. Medido en el staging con `RateLimit-Remaining`: UNA sola IP veía
// dos contadores intercalados (89, 88, 87, 89, 88…), y el foro de Railway
// describe la misma cadena. En producción eso quería decir que el freno de
// pedidos (8 por minuto), el de los códigos por correo (5) o el de los fallos
// de login (20) eran para TODOS los clientes que pasaban por el mismo nodo.
//
// Ahora se confía en los saltos locales y privados, y en la red de Railway
// (100.0.0.0/8, el rango de su propia guía para Caddy). Empezando por la
// derecha, la primera dirección que NO es de ellos es el cliente.
//
// ⚠️ Falla hacia lo seguro. Si Railway cambiara de rango, se volvería a contar
// por nodo —lo de antes—, nunca a creerse una IP inventada: el cliente no
// puede colarse en la cadena (el borde la reescribe), y aunque pudiera, su IP
// real —que no es de esos rangos— corta la búsqueda antes de llegar a lo que
// él escribió. ⚠️ Nunca `true`: con `true` mandaría la entrada de la IZQUIERDA,
// que es justo la que escribiría quien quisiera saltarse los frenos.
// ⚠️ Los recorridos simulan cada archivo desde una red `10.x` con esta misma
// cabecera: es privada, así que sigue valiendo como antes.

export const PROXIES_DE_CONFIANZA = ['loopback', 'linklocal', 'uniquelocal', '100.0.0.0/8']
