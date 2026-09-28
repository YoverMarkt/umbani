# App del motorizado — pantalla por pantalla

Misma sesión que la app del cliente (ver [API-UMBANI.md](API-UMBANI.md) §1a:
iniciar sesión con WhatsApp). La diferencia: estas rutas exigen que ese
teléfono sea de un **motorizado activo**, registrado por Umbani en su panel.
Si no lo es → `403`.

## Las reglas (las pone el servidor; la app solo las cuenta)
- **Guardas el efectivo** que cobras en la puerta y **liquidas cada lunes** lo
  de la semana anterior: tus carreras menos el efectivo que tienes.
- **Tope de efectivo** (normalmente $150): con más encima no puedes tomar
  pedidos en efectivo hasta liquidar.
- Solo ves pedidos que el local **ya aceptó**, a domicilio y de locales que
  reparten con Umbani (o de tu local, si eres de su flota).
- Si se cae la comida, **se te retiene la carrera** de ese pedido.

## 1. Inicio
- **Llama:** `GET /api/v1/motorizado/yo` → nombre, flota, `disponible`,
  `topeEfectivoCents` y `semana` (`carrerasCents`, `efectivoCobradoCents`,
  `efectivoEncimaCents`, `deAntesCents`).
- **Enseña:** un interruptor grande «Disponible» (`PUT /api/v1/motorizado/disponible`
  con `{ disponible: true|false }`) y una barra «Efectivo encima: $X de $150».

## 2. Pedidos
- **Llama:** `GET /api/v1/motorizado/pedidos` cada 15–20 s mientras esté
  disponible. Cada pedido trae `mio`, `numero`, `estado`, `totalCents`,
  `carreraCents`, `cobrarEnEfectivo`, `recoger` (local, dirección, lat/lng) y
  `entregar` (cliente, dirección, referencia, notas, lat/lng).
- **Tomar:** `POST /api/v1/motorizado/pedidos/{id}/tomar`. `409` con `reason`:
  `ya_tomado` (otro llegó antes), `tope_de_efectivo`, `no_disponible`.
- **Botón «Cómo llegar»:** abre Google Maps con `lat,lng` (no hace falta clave).

## 3. Recoger y entregar
- **Recogido** (sale en camino): `POST /api/v1/motorizado/pedidos/{id}/recogido`.
  Si el local no terminó de empacar: `409` con lo que falta.
- **Entregado:** `POST /api/v1/motorizado/pedidos/{id}/entregado`. Si
  `cobrarEnEfectivo` es verdadero, la app pide confirmar «Cobré $X» antes.
  El cliente recibe sus avisos por WhatsApp; la app no manda nada.

## 4. Mis liquidaciones
- **Llama:** `GET /api/v1/motorizado/liquidaciones` → cada semana con
  `derecho_cents` (tus carreras), `en_mano_cents` (efectivo cobrado),
  `neto_cents` (> 0: Umbani te paga; < 0: debes entregar ese efectivo) y `status`.

Todo importe llega en **centavos** (`…Cents`): divide entre 100 solo para
enseñarlo. La app no suma ni resta nada.
