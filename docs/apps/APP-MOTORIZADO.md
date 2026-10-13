# App del motorizado — pantalla por pantalla

Misma sesión que la app del cliente (ver [API-UMBANI.md](API-UMBANI.md) §1a:
entrar con el CORREO). La diferencia: estas rutas exigen que ese correo sea el
de un **motorizado activo** —el que escribió quien lo dio de alta: su local, su
cooperativa o Umbani—. Si no lo es → `403`. No necesita el paso del número: el
suyo lo registró quien lo dio de alta.

> 🌐 **La app web de repartidores es la referencia viva** (2026-10-05): abre
> `https://umbani-pruebas.up.railway.app/r` en el móvil mientras construyes.
> Hace este recorrido entero —entrar, disponible, tomar, recoger, entregar con
> el efectivo confirmado, «Llegué» y «No estaba el cliente», «Mi semana» y las
> liquidaciones— con la MISMA API, y
> su código está en `apps/store/src/repartidor/` (`api.ts` es cada llamada).
> Una prueba vigila que sus nueve rutas estén en `openapi.yaml`. Su sesión va
> **aparte** de la de cliente, como irán las dos apps Flutter: entrar como
> repartidor no cierra la sesión de quien pide en el mismo teléfono.

Hay tres clases, y la app es la misma para las tres (`flota` en `/yo`):

| | Lo registra | Lleva pedidos de | La carrera es de | El efectivo |
|---|---|---|---|---|
| **De Umbani** (`flota: "umbani"`) | el superadmin, con su **ciudad** | los locales de SU ciudad con «Quién reparte: Umbani» | él | lo guarda él y liquida el lunes |
| **De una cooperativa** (`flota: "cooperativa"`, y `cooperativa` dice cuál) | su cooperativa, en su panel `/cooperativa` | los locales de SU ciudad con «Quién reparte: esa cooperativa» | él (su comisión queda entre él y su cooperativa) | lo guarda él y liquida el lunes con Umbani |
| **Del local** (`flota: "local"`) | el dueño del local, en su panel → Repartidores | solo ese local | el local | se lo entrega al local |

Para la app, **la de cooperativa es igual que la de Umbani**: enseña sus
carreras y sus liquidaciones. Solo cambia el nombre que se le dice («Repartes
con la Cooperativa X»). Si su cooperativa se apaga, deja de recibir pedidos
nuevos; lo que ya lleva lo termina.

Los **del local** solo reciben pedidos mientras ese local tenga los
**repartidores propios encendidos** (lo enciende el superadmin en la ficha de
cada local, y solo cuenta si el local reparte él mismo). Apagado, la lista
viene vacía y tomar responde `409 no_disponible`; el pedido que ya llevaba lo
sigue viendo hasta entregarlo. La app no tiene que hacer nada especial: con
la lista vacía, enseña el estado vacío de siempre.

🧪 En PRUEBAS, el repartidor de prueba tiene el teléfono del simulador
(`000000000000`) y es de la flota del local `demo`, que nace con sus
repartidores propios encendidos.

## Las reglas (las pone el servidor; la app solo las cuenta)
- **Guardas el efectivo** que cobras en la puerta y **liquidas cada lunes** lo
  de la semana anterior: tus carreras menos el efectivo que tienes.
- **Tope de efectivo** (normalmente $150): con más encima no puedes tomar
  pedidos en efectivo hasta liquidar.
- Solo ves pedidos que el local **ya aceptó**, a domicilio y de locales que
  reparten con Umbani (o de tu local, si eres de su flota y la tiene encendida).
- Si se cae la comida, **se te retiene la carrera** de ese pedido.
- Si un pedido tuvo un problema y Umbani confirma que respondías tú, **se te
  descuenta en tu liquidación del lunes** (2026-10-12): lo que se le devolvió
  al cliente menos la comisión de Umbani, o la comida que se perdió. Lo decide
  la base; la app solo lo enseña.

## 1. Inicio
- **Llama:** `GET /api/v1/motorizado/yo` → nombre, flota, `disponible`,
  `topeEfectivoCents`, `semana` (`carrerasCents`, `efectivoCobradoCents`,
  `efectivoEncimaCents`, `deAntesCents`, `ajustesCents`) y `ajustes`: lo que se
  le descontó (o reconoció) esta semana por una incidencia, cada uno con
  `numero`, `local`, `fecha`, `tipo` (qué pasó), `concepto` y `cents` (< 0: se
  le descuenta). Sin datos del cliente.
- ⚠️ **Enseña cada línea por separado; no las sumes por pedido.** En un «no
  llegó» en efectivo llegan dos: `no_cobro` (+, ese efectivo ya no le cuenta
  como cobrado) y `reclamo` (−, el pedido menos la comisión de Umbani). Sumadas
  parecerían a favor del repartidor, y en verdad paga la comida. Textos:
  `no_cobro` «No cobraste ese efectivo: ya no te cuenta», `reclamo` en un
  `no_llego` «El pedido que no llegó, menos la comisión de Umbani», `reclamo`
  en lo demás «Lo devuelto al cliente, menos la comisión de Umbani»,
  `comida_cobrada` «La comida que se perdió».
- **Enseña:** un interruptor grande «Disponible» (`PUT /api/v1/motorizado/disponible`
  con `{ disponible: true|false }`) y una barra «Efectivo encima: $X de $150».

## 2. Pedidos
- **Llama:** `GET /api/v1/motorizado/pedidos` cada 15–20 s mientras esté
  disponible. Cada pedido trae `mio`, `numero`, `estado`, `totalCents`,
  `carreraCents`, `cobrarEnEfectivo`, `cobrarCents`, `recoger` (local,
  dirección, lat/lng), `entregar` (cliente, dirección, referencia, notas,
  lat/lng y, solo desde «Llegué», `telefono`), `llegoEn` y `noEstabaDesde`
  (ver §3b).
- ⚠️ **Lo que cobra en la puerta es `cobrarCents`, nunca `totalCents`**
  (2026-10-10): si el cliente pagó una parte con su saldo Umbani, el total es
  mayor que lo que hay que cobrarle. «¿Cobraste $X en efectivo?» lleva
  `cobrarCents`.
- **Tomar:** `POST /api/v1/motorizado/pedidos/{id}/tomar`. `409` con `reason`:
  `ya_tomado` (otro llegó antes), `tope_de_efectivo`, `no_disponible`.
- **Botón «Cómo llegar»:** abre Google Maps con `lat,lng` (no hace falta clave).

## 3. Recoger y entregar
- **Recogido** (sale en camino): `POST /api/v1/motorizado/pedidos/{id}/recogido`.
  Si el local no terminó de empacar: `409` con lo que falta.
- **Entregado:** `POST /api/v1/motorizado/pedidos/{id}/entregado`. Si
  `cobrarEnEfectivo` es verdadero, la app pide confirmar «Cobré $X» antes, con
  $X = `cobrarCents`.
  El cliente ve cada paso («en camino», «entregado») en su app en cuanto esta
  lo marca; la app del motorizado no le manda nada. Desde el 2026-10-09 no se
  le avisa por WhatsApp, y las notificaciones push llegarán después.

## 3b. «Llegué» y «No estaba el cliente» (2026-10-12)
Como Uber Eats y DoorDash: si el cliente no sale, el repartidor espera, lo
llama y cierra el pedido sin entregarlo. Las reglas las pone la base.
- **«Llegué»** (en un pedido `en_camino`, cuando está en la puerta):
  `POST /api/v1/motorizado/pedidos/{id}/llegue`, con `{ lat, lng }` del
  teléfono **si los tienes** —se guarda a cuántos metros de la dirección
  estaba, la prueba si el cliente dice «sí estaba»—. Sin ubicación funciona
  igual: no bloquea nada. Responde `{ llegoEn, noEstabaDesde }`; el primer
  toque cuenta.
- Desde «Llegué», el pedido trae **`entregar.telefono`** (con «+»): enseña
  «Llamar al cliente» (`tel:`). Antes de «Llegué» y después de cerrar no viene.
- **«No estaba el cliente»**: aparece desde `noEstabaDesde` (10 minutos
  después de «Llegué»; es un ajuste del servidor, no lo escribas en la app).
  Pide confirmación —«¿Esperaste y lo llamaste? El pedido se cierra y no se
  puede deshacer»— y llama a
  `POST /api/v1/motorizado/pedidos/{id}/no-estaba`. Antes de tiempo la base
  responde `409 todavia_no` con `noEstabaDesde`: enseña su `error` tal cual.
- **Qué pasa con el dinero:** el pedido se cierra como entregado y se cobra
  sin devolución. **Su carrera la cobra igual**; si era en efectivo, **no
  debe nada** por ese pedido (su semana trae la línea `no_cobro`: «No
  cobraste ese efectivo: ya no te cuenta»). **La comida se la queda.**
- Si el cliente dice que sí estaba, lo revisa Umbani con la hora y la
  distancia del «Llegué». Si no llegó a la puerta, paga él la comida.

## 4. Mis liquidaciones
- **Llama:** `GET /api/v1/motorizado/liquidaciones` → cada semana con
  `derecho_cents` (tus carreras), `en_mano_cents` (efectivo cobrado),
  `ajustes_cents` (por incidencias: < 0 se te descontó),
  `neto_cents` (> 0: Umbani te paga; < 0: debes entregar ese efectivo) y `status`.

Todo importe llega en **centavos** (`…Cents`): divide entre 100 solo para
enseñarlo. La app no suma ni resta nada.
