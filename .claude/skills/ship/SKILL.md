---
name: ship
description: Desplegar a producción con la secuencia completa y en el orden correcto. Úsala cuando se vaya a publicar un cambio, tras fusionar a main, o cuando el usuario diga "subir", "desplegar", "ship" o "sacar a producción". Cubre el orden migraciones→código, la comprobación contra producción real y qué hacer si algo falla.
---

# ship

Sacar un cambio a producción sin dejar la app rota ni enterarse por un cliente.

> **El CI en verde no significa que producción funcione.** El CI verifica
> *simulaciones*: `verify:schema` corre sobre un PostgreSQL en Docker, los
> tests inyectan simulacros. Entre eso y la realidad caben los fallos de
> configuración — una variable ausente, un despliegue que no llegó, una
> credencial caducada—, y son justo los que dejan la app muerta con todo en
> verde. Por eso el último paso mira producción de verdad.

## Antes de empezar

- [ ] El cambio está fusionado a `main` y el CI de `main` está en verde.
- [ ] Se revisó el diff (**revisor-pr**).
- [ ] `server/.env` NO está en ningún commit.

## 1. Migraciones ANTES que el código

El orden importa y no es negociable: si el código sale primero, busca tablas o
columnas que aún no existen y responde 500 a clientes reales.

```bash
npm run migrate:status -w @botpanel/server    # ¿qué falta?
npm run migrate        -w @botpanel/server    # aplicar
```

- Si no hay nada pendiente, sigue al paso 2.
- Si `DATABASE_URL` no está configurada, ver **VERIFICACION.md** (es la conexión
  directa de Postgres, no `SUPABASE_URL`).
- **Primera vez en una base que ya existía:** hay que hacer el `migrate:baseline`
  antes. Léete la advertencia — es una afirmación, no una comprobación.

> Si una migración falla, **para aquí**. No despliegues el código: la base
> quedó en un estado que ese código no espera. Cada migración va en su propia
> transacción, así que la que falló no dejó nada a medias.

## 2. Desplegar

Railway despliega solo al empujar a la rama configurada. Confirma que el
despliegue **terminó** antes de seguir — no que arrancó.

> ⚠️ La URL real de producción está en la memoria del proyecto, y **no** es la
> que dice la guía de despliegue. Confírmala antes de apuntar nada a ella.

## 3. PRIMERO: ¿está corriendo lo que fusionaste?

```bash
npm run verify:deploy -w @botpanel/server -- https://LA-URL-REAL
```

Compara el commit que informa `/api/health` con el `HEAD` local. Si no
coinciden, **para aquí**: todo lo que compruebes después estará mirando el
código viejo.

⚠️ **Esto no es burocracia, es la lección del 2026-08-29.** Cuatro despliegues
seguidos se quedaron colgados en Railway (`in_progress`, sin reemplazar nunca
al contenedor) y producción sirvió el código de la mañana durante horas. Se dio
por desplegado porque la API de GitHub listaba esos despliegues — pero
`gh api deployments --jq '.[0].sha'` devuelve **el último que se PIDIÓ**, no el
que corre. Entre lo que se creyó desplegado había un arreglo de dinero: el
cliente veía $12.99 sobre un pedido de $14.09, y lo descubrió el dueño
probando la app.

**Comprobar que existe un despliegue no es comprobar que su código corre.**
Lo único que lo demuestra es preguntárselo al servidor que está atendiendo.

Si falla:
- Mira el panel de Railway: el despliegue puede estar colgado o haber fallado.
- Un commit vacío a `main` (`git commit --allow-empty`) vuelve a dispararlo.
- Y hasta que `verify:deploy` pase, **no digas que algo está en producción**.

## 4. Comprobar contra producción de verdad

```bash
npm run verify:smoke -w @botpanel/server -- https://LA-URL-REAL
```

Comprueba salud y cola de webhooks, que se sirvan los tres frontales, que la
tienda exija sesión, que el enlace corto no filtre negocio, que el panel
rechace sin token, y **da de alta un cliente y lo borra** — el camino que
estuvo roto meses sin que nadie lo notara.

> ⚠️ **Escribe en producción.** Crea UN negocio llamado `ZZZ PRUEBA DE HUMO …`
> y lo borra en el `finally`. Si el borrado falla, lo grita con el id: bórralo
> a mano. Nunca manda WhatsApp (costaría dinero y gastaría el saldo).

## 5. Mirar el canal, que es lo que se rompe en silencio

Un bot mudo no da error: simplemente nadie responde, y te enteras cuando un
cliente se queja. En julio de 2026 fueron **cinco días**.

- [ ] Panel admin → Dashboard → salud del canal. Ningún negocio activo en
      `silencio` ni `nunca_recibio`.
- [ ] Panel admin → registro de errores. Sin entradas nuevas de categoría
      `canal` ni `envio`.
- [ ] Mándale un mensaje real al bot desde WhatsApp y espera respuesta.

## 6. Retirar del registro lo que este cambio arregla

El dueño lo pidió así (2026-09-27): **lo arreglado desaparece**. Si se queda
30 días en la pantalla de Errores, cree que algo sigue mal, y el vigía de
atención le manda correos un día entero por algo ya resuelto.

```bash
npm run errores -w @botpanel/server                              # ver el registro
npm run errores -w @botpanel/server -- <código> [<código>…] --hasta=<hora del despliegue>
# …revisa lo que enseña, y repite con --borrar
```

- `--hasta` es la hora en que el arreglo quedó **corriendo** (la de
  `verify:deploy`). Lo que se repitió después **no se toca**: no estaba
  arreglado, y el comando lo dice.
- Si el error vuelve, **reaparece solo**: el registro crea la fila otra vez.
- Solo lo que ESTE cambio resuelve. Lo que depende del dueño —recargar saldo
  de YCloud u OpenAI— se retira cuando él confirma que lo hizo.

## Si algo salió mal

| Síntoma | Qué mirar primero |
|---|---|
| 500 en el panel | ¿Falta una migración? `migrate:status` |
| El bot no responde | Salud del canal + saldo del proveedor + `bot_active` |
| La tienda no abre | `BASE_URL` en Railway; el enlace se arma con ella |
| Todo verde pero nada funciona | Variables de entorno del despliegue |

Para volver atrás: revertir el commit y desplegar. **Las migraciones no se
revierten solas** — si el problema es de esquema, hace falta una migración
nueva que lo corrija, nunca editar la ya aplicada (la huella lo impide).

## Lo que este flujo NO cubre

- **Evals del bot** (`npm run evals -w @botpanel/server`): gastan dinero, así
  que se corren a mano antes de una demo o al cambiar el prompt o el modelo.
- **Deriva del esquema** (`npm run verify:drift`): pregunta si producción es de
  verdad lo que dice `schema.sql`. Útil de vez en cuando, no en cada envío.
