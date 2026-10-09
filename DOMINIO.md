# El día que haya dominio

> Escrito el 2026-10-09, cuando todavía no lo hay: producción vive en
> `https://web-production-3433c.up.railway.app` y el servidor de pruebas en
> `https://umbani-pruebas.up.railway.app`. El dueño lo comprará más adelante.
>
> **Por qué importa tanto:** sin dominio propio no se puede mandar el código
> de entrada por correo a cualquiera (Resend solo deja escribir al correo de la
> propia cuenta), no se puede poner Cloudflare delante (la defensa de verdad
> contra un DDoS) y la dirección no es presentable. Hasta entonces, en
> producción, `/u` y `/r` no dejan entrar con correo; en el servidor de pruebas
> el código sale en pantalla.

Los pasos van **en este orden**. Cada ⚠️ es algo que, hecho al revés, rompe
algo que hoy funciona.

## 1. Comprarlo (el dueño)

- Elegir el nombre y la terminación (`.com`, `.app`, `.ec`…). Si la terminación
  la vende **Cloudflare Registrar** (`.com` y `.app` sí; `.ec` no), conviene
  comprarlo allí: cobra a precio de coste y el paso 2 ya viene hecho.
- Pensar ya el subdominio del servidor de pruebas: `pruebas.<dominio>`.

## 2. Cloudflare delante (plan gratis)

1. Añadir el dominio a Cloudflare y cambiar los *nameservers* donde se compró.
2. En Railway, servicio `web` de **producción** → *Settings → Networking →
   Custom Domain* → `<dominio>` (y `www`). Railway da un destino: crear ese
   `CNAME` en Cloudflare **con la nube naranja** (pasa por Cloudflare).
3. SSL/TLS en **Full (strict)**. Con *Flexible* hay bucles de redirección.
4. ⚠️ **ANTES de encender la nube naranja en producción: la IP del cliente.**
   Con Cloudflare delante, el `X-Real-IP` que escribe Railway pasa a ser una IP
   **de Cloudflare**, y los frenos volverían a contar por nodo — el fallo del
   PR #448 ([DECISIONES.md](DECISIONES.md#la-ip-del-cliente-detrás-de-railway)).
   ✅ **El código ya está hecho (2026-10-09)**: `ip-del-cliente.ts` lee
   `CF-Connecting-IP` **solo** cuando el `X-Real-IP` es de los rangos publicados
   de Cloudflare (`server/src/lib/rangos-de-cloudflare.ts`). Antes de este paso,
   comprobar que la lista sigue igual que <https://www.cloudflare.com/ips/>.
   Se prueba primero en `pruebas.<dominio>` con
   `npm run test:carga -w @botpanel/server`: el escenario «Un contador por
   cliente» tiene que salir en verde. Si en el registro de Railway aparece
   «CF-Connecting-IP desde …, que no es una red de Cloudflare» con el dominio
   ya delante, falta una red en la lista.
5. ⚠️ **Que Cloudflare no bloquee a quien nos avisa**: excepciones en el WAF y
   en *Bot Fight Mode* para `/webhook`, `/webhook/ycloud` y `/pagos/payphone/*`
   (YCloud, Meta y PayPhone no resuelven desafíos).
6. Caché en el borde **solo** para `/assets/*` (los archivos de Vite llevan su
   huella en el nombre). ⚠️ Nunca el HTML ni `/api`: congelarían la app o
   repartirían datos de un cliente a otro.
7. Una regla de límite (el plan gratis trae una) para `POST /api/v1/auth/correo`
   y `POST /api/client/login`.
8. **Turnstile** (el CAPTCHA invisible de Cloudflare) al pedir el código por
   correo: es la defensa de verdad contra bots que piden códigos. Se construye
   con su clave de sitio y su secreto
   ([DECISIONES.md](DECISIONES.md#las-defensas-contra-bots-y-ataques)).

## 3. Cambiar la dirección de producción (en este orden)

1. ⚠️ **PayPhone primero**: registrar el dominio nuevo en la app de producción
   de PayPhone Developer, con la respuesta en
   `https://<dominio>/pagos/payphone/retorno`. PayPhone rechaza («NO AUTORIZADO»)
   los pagos que llegan de un dominio no registrado, y la dirección de vuelta
   sale de `BASE_URL`.
2. **YCloud**: webhook a `https://<dominio>/webhook/ycloud`. ⚠️ El vigilante de
   credenciales avisa `webhook_desviado` si el webhook no empieza por
   `BASE_URL`: se cambian los dos el mismo día. Si hay webhook de Meta, igual
   con `/webhook`.
3. Railway, variables de producción: `BASE_URL=https://<dominio>`. De ella
   salen el CORS, los enlaces de la tienda que se mandan por WhatsApp, la vuelta
   de PayPhone y el vigilante de credenciales.
4. GitHub → *Settings → Variables*: `PRODUCTION_URL=https://<dominio>`. La leen
   el vigía, el vigía de atención y el parte diario.
5. Comprobar: `npm run verify:deploy -w @botpanel/server -- https://<dominio>` y
   `npm run verify:smoke -w @botpanel/server -- https://<dominio>`, un pago con
   tarjeta en modo pruebas y un enlace de tienda recibido por WhatsApp.
6. La dirección vieja de Railway sigue sirviendo la misma app: los enlaces que
   ya se mandaron por WhatsApp siguen abriendo.

## 4. Entrar con correo (Resend)

1. Cuenta en Resend → *Domains* → añadir `<dominio>` y copiar en Cloudflare los
   registros que da (SPF, DKIM y DMARC). Esperar a que diga *Verified*.
2. Railway, variables: `RESEND_API_KEY` y `CORREO_REMITENTE`
   (por ejemplo `Umbani <codigos@<dominio>>`). Solo en variables, nunca en el
   código.
3. Primero en el servidor de pruebas. ⚠️ Con proveedor, el código **deja de
   salir en pantalla** también allí: hace falta un correo real para probar.
4. Mirar el plan antes de abrir al público (el gratis tiene un tope diario). El
   tope propio de la plataforma es `CORREO_CODIGOS_POR_HORA_EN_TOTAL` (120 por
   hora si no se pone): subirlo antes de una campaña.
5. Probar que el correo no cae en spam en Gmail y en Outlook.

## 5. Lo que notan quienes ya usan las apps

- ⚠️ Una app instalada (PWA) queda atada a la dirección desde la que se instaló,
  y la sesión también: quien instaló `/u` o `/r` desde `railway.app` tiene que
  instalarla otra vez desde el dominio y volver a entrar. Avisar a los
  repartidores y a los locales antes.
- Los paneles (`/app`, `/cooperativa`, `/app-admin`) piden entrar otra vez.

## 6. Lo que también espera al dominio

- **Google**: el ID de cliente OAuth necesita el dominio como origen autorizado
  (y `pruebas.<dominio>`).
- **Apple**: «Iniciar sesión con Apple» exige dominio verificado y la cuenta de
  desarrollador (99 USD al año). En iPhone es obligatorio si se ofrece Google.
- **Notificaciones push**: la suscripción va atada a la dirección. Hacerlas ya
  con el dominio final evita que todos tengan que suscribirse otra vez.
- **El servidor de pruebas** en `pruebas.<dominio>`: dominio propio en el
  proyecto de Railway del staging, su app de PayPhone de pruebas y
  `STAGING_REMOTO_URL` en `server/.env.staging-remoto`.
- **Documentos con la dirección vieja**: la guía de las apps Flutter
  (`docs/apps/API-UMBANI.md` y el `servers` de `docs/apps/openapi.yaml`),
  `DEPLOY-RAILWAY.md` y el `README.md`.

## 7. Cómo se sabe que quedó bien

- `npm run test:carga -w @botpanel/server` contra `pruebas.<dominio>`: «Un
  contador por cliente» en verde, y las cabeceras a cuentagotas ya cortadas
  (las cortará Cloudflare).
- `verify:deploy` y `verify:smoke` contra el dominio.
- Un código de entrada que llega a Gmail y a Outlook, un pago con tarjeta en
  pruebas que vuelve a la app, y un mensaje de WhatsApp que entra.
