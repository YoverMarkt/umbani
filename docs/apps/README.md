# Apps de Umbani (Flutter) — empieza aquí

Todo lo que necesita un desarrollador para construir las dos apps **sin tocar el
servidor**. El backend ya está hecho y probado de punta a punta: las apps solo
pintan pantallas y llaman a esta API.

| Documento | Para qué |
|---|---|
| [API-UMBANI.md](API-UMBANI.md) | Las reglas de la API: servidores, sesión, cabeceras, errores, dinero, tarjeta, «Mis pedidos». **Léelo primero.** |
| [APP-CLIENTE.md](APP-CLIENTE.md) | La app del cliente, pantalla por pantalla, con qué endpoint llama cada una. |
| [APP-MOTORIZADO.md](APP-MOTORIZADO.md) | La app del motorizado: disponible, tomar, recoger, entregar y sus liquidaciones. |
| [openapi.yaml](openapi.yaml) | El contrato exacto (OpenAPI 3.1). De aquí se genera el cliente de Dart. |
| [../../mobile/CLAUDE.md](../../mobile/CLAUDE.md) | Las reglas que sigue Claude al trabajar en las apps. |

## 1. Antes de empezar

- **Flutter** (estable) y **Git**.
- Acceso al repositorio `YoverMarkt/umbani`: el dueño te invita como
  colaborador. Es público, así que puedes descargarlo antes de la invitación;
  la invitación hace falta para **subir** tu trabajo.
- La cuenta del **superadmin de pruebas**: te la da el dueño. Es de un servidor
  con datos de mentira, distinto del de producción.

## 2. Dónde va cada cosa

```
mobile/cliente/       ← la app del cliente (Flutter)
mobile/motorizado/    ← la app del motorizado (Flutter)
mobile/CLAUDE.md      ← las reglas para Claude
docs/apps/            ← esta documentación
server/ y apps/       ← el backend y la web: NO se tocan desde las apps
```

## 3. El servidor de pruebas

**`https://umbani-pruebas.up.railway.app`** — aquí se desarrolla, siempre.
Producción tiene clientes reales y **nunca** se usa para probar.

- **El local de prueba** es una pizzería con slug `demo`, abierta las 24 horas,
  con efectivo, transferencia y pago al retirar.
- **Iniciar sesión.** El servidor de pruebas no tiene WhatsApp de verdad, así que el código se manda
  desde el **Simulador** del superadmin de pruebas
  (`/app-admin` → Simulador → `Mi código de Umbani: XXXXXX`). Ver API-UMBANI.md §1a.
- **El repartidor de prueba** tiene el mismo teléfono que el simulador
  (`000000000000`): el mismo código abre la app del motorizado.
- **Las apps web de referencia** hacen cada recorrido con esta misma API, en
  el servidor de pruebas: **`/u`** (clientes) y **`/r`** (repartidores). Si
  dudas de cómo se usa una ruta, mira cómo lo hacen ellas
  (`apps/store/src/umbani/` y `apps/store/src/repartidor/`).
- **Tarjeta.** En pruebas no hay cobros reales; la tarjeta aparece cuando el dueño registre
  el dominio de pruebas en PayPhone.

## 4. Cómo pedírselo a Claude

> «Lee `docs/apps/README.md`, `API-UMBANI.md`, `APP-CLIENTE.md`,
> `openapi.yaml` y `mobile/CLAUDE.md`. Crea la app del cliente de Umbani en
> Flutter en `mobile/cliente/`, siguiendo esas pantallas y ese contrato, contra
> el servidor de pruebas. La app pinta, nunca calcula: todo importe llega del
> servidor.»

Para la del motorizado, lo mismo con `APP-MOTORIZADO.md` y `mobile/motorizado/`.

## 5. Cómo subir tu trabajo

1. Una **rama** por cambio, desde `main` (`git checkout -b app-cliente-carrito`).
2. Un **PR** contra `main`. `main` está protegida: no se puede subir directo.
3. El CI corre sus 7 controles (son del backend y la web; los de Flutter se
   añadirán cuando las apps existan).
4. El dueño revisa y fusiona.

## 6. Las tres reglas que no se negocian

1. **La app PINTA, nunca calcula.** Precios, totales, envío, tarifa: todo llega
   calculado y ya suma. Si la app sumara algo, mostraría un número y se
   cobraría otro.
2. **La tarjeta se paga en la página de PayPhone**, abierta en el navegador del
   sistema (nunca en un WebView). Los datos de la tarjeta no pasan por la app ni
   por Umbani.
3. **Nada de secretos en la app.** No hay claves de PayPhone, de Supabase ni de
   nada: la app solo tiene su sesión.
