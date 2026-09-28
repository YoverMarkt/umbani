# Apps de Umbani (Flutter) — por dónde empezar

Todo lo que necesita un desarrollador para construir las apps **sin tocar el
servidor**. El backend ya está hecho: las apps solo pintan pantallas y llaman
a esta API.

| Documento | Para qué |
|---|---|
| [API-UMBANI.md](API-UMBANI.md) | Las reglas de la API: sesión, cabeceras, errores, dinero, tarjeta. **Léelo primero.** |
| [APP-CLIENTE.md](APP-CLIENTE.md) | La app del cliente, pantalla por pantalla, con qué endpoint llama cada una. |
| [openapi.yaml](openapi.yaml) | El contrato exacto (OpenAPI 3.1). De aquí se genera el cliente de Dart. |
| `apps/store/src/lib/types.ts` | Los tipos detallados de la carta y del pedido. La mini app web usa la MISMA API. |

La app del motorizado llega con su propio documento cuando se construya su API.

## Cómo pedírselo a Claude

> «Lee `docs/apps/README.md`, `API-UMBANI.md`, `APP-CLIENTE.md` y
> `openapi.yaml`. Crea la app del cliente de Umbani en Flutter siguiendo esas
> pantallas y ese contrato. La app pinta, nunca calcula: todo importe llega del
> servidor.»

## Las tres reglas que no se negocian

1. **La app PINTA, nunca calcula.** Precios, totales, envío, tarifa, comisión:
   todo llega calculado. Si la app sumara algo, mostraría un número y se
   cobraría otro.
2. **La tarjeta se paga en la página de PayPhone**, abierta en el navegador del
   sistema (nunca en un WebView). Los datos de la tarjeta no pasan por la app ni
   por Umbani.
3. **Nada de secretos en la app.** No hay claves de PayPhone, de Supabase ni de
   nada: la app solo tiene su sesión.
