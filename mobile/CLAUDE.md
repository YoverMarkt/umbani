# CLAUDE.md — las apps móviles de Umbani (Flutter)

Estás trabajando en las apps del **cliente** (`mobile/cliente/`) o del
**motorizado** (`mobile/motorizado/`). El backend de Umbani ya existe y está
probado de punta a punta; estas apps solo lo consumen.

**Lee antes de escribir nada:** `docs/apps/README.md`, `docs/apps/API-UMBANI.md`
y la guía de la app que toque (`APP-CLIENTE.md` o `APP-MOTORIZADO.md`). El
contrato exacto está en `docs/apps/openapi.yaml`.

## Reglas que no se negocian

1. **La app PINTA, nunca calcula dinero.** Ni sumas, ni porcentajes, ni
   redondeos: cada importe llega del servidor y ya suma (`subtotal + shipping +
   serviceFee = total`). Si necesitas un número que no llega, pídelo al
   servidor; no lo derives.
2. **Solo la API.** Nunca Supabase directo, nunca la base, nunca claves de
   servidor. La app solo guarda su sesión (en almacenamiento seguro: Keychain /
   Keystore).
3. **Siempre contra PRUEBAS:** `https://umbani-pruebas.up.railway.app`. La URL
   de producción no se escribe en el código de desarrollo; si hace falta,
   llega por una configuración de compilación.
4. **La tarjeta se paga en el navegador del SISTEMA** (`url_launcher` en modo
   externo), nunca en un WebView: PayPhone lo rechaza y los datos de la tarjeta
   no deben pasar por la app.
5. **No toques `server/` ni `apps/`** (el backend y la web). Si la API no da
   algo, se anota y se le pide al dueño; no se arregla desde aquí.
6. **Textos en español neutro** (Ecuador/Colombia). Los errores de la API ya
   vienen escritos para el cliente: enséñalos tal cual.

## Cómo se trabaja

- Una rama por cambio y un PR contra `main` (protegida: no se sube directo).
- Comentarios del código en español.
- Antes de dar algo por hecho: `flutter analyze` y `flutter test` en verde, y
  probado contra el servidor de pruebas (inicio de sesión por el simulador del
  superadmin de pruebas: ver `docs/apps/API-UMBANI.md` §1a).
