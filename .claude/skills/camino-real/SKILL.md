---
name: camino-real
description: 'Úsala SIEMPRE antes de dar por terminada una feature, una rama de comportamiento o un modo nuevo en BotPanel, y siempre que aparezca un "está construido pero no responde". Obliga a demostrar que la configuración REAL de producción llega hasta el código nuevo. Caza la clase de fallo que las pruebas no ven: código correcto, probado, y al que nadie llega nunca.'
---

# camino-real

## El fallo que esta skill existe para cazar

No es un bug. Es código **correcto, probado y con las pruebas en verde** al que
la configuración real nunca llega. El sistema no falla: calla.

Las pruebas no lo ven, y no por estar mal escritas. Una prueba responde *«dado
este input, el código hace X»*. Nunca responde ***«¿algún input real llega
hasta aquí?»***. Ese hueco es estructural, y por eso hace falta un paso aparte.

En BotPanel ya ha pasado **cinco veces**:

| Qué | Qué faltaba | Cómo se descubrió |
|---|---|---|
| `shopping_locked` | La columna, el texto y las pruebas existían. **Nadie la ponía en `true`.** | Leyendo el flujo, semanas después |
| Menú del marketplace | Construido y probado. **El único que lo importaba era su propio repositorio.** | Al ir a conectar el número |
| Buzón de comprobantes del marketplace | La foto se convertía en `[foto]` **sin descargarse nunca** | Cableando otra cosa |
| Alta de marketplace | `ClientModal` verificaba credenciales de un canal inexistente → moría con «Proveedor no reconocido» | El revisor, no las pruebas |
| **El número de la plataforma** | Un local era dueño del número, así que `resolveBusinessChannel` ganaba y **la rama del marketplace no corría jamás** | El dueño, escribiendo desde su teléfono |

En los cinco: **CI verde, cobertura estable, verificadores SQL en verde.**

## Las tres preguntas. Ninguna es opcional

Antes de decir «terminado», respóndelas **por escrito**, en el PR:

### 1. ¿Qué configuración EXACTA hace que este código se ejecute?

Nombrar columnas y valores, no intenciones. No vale «cuando el negocio use el
marketplace». Vale:

> `businesses.whatsapp_provider = 'marketplace'` **y**
> `server_settings.platform_ycloud_number` puesto **y** ningún negocio con ese
> número en `whatsapp_number` / `ycloud_number` / `meta_phone_id`.

Si no se puede escribir así de concreto, todavía no se entiende el camino — y
ese es el momento de parar, no después.

### 2. ¿La tiene producción HOY?

**Consultarlo, no suponerlo.** Solo lectura:

```bash
cd server && node --env-file=.env -e "…"   # o un .mjs temporal con pg
```

Tres respuestas posibles:

- **Sí, alguien la tiene** → sigue a la pregunta 3.
- **No, nadie** → está *construido y desconectado*. **Decirlo en el PR**, con
  qué haría falta para encenderlo. No es necesariamente un error —una fase 1
  puede ser deliberada— pero **callarlo sí lo es**.
- **La tiene, pero otra cosa la intercepta antes** → es el fallo del número, el
  más caro de los cinco. Ver la pregunta 3.

### 3. ¿Qué corre ANTES y podría ganarle?

La pregunta que faltó las cinco veces. Un `if` anterior, un `return` temprano,
un middleware, una resolución que acierta primero, una fila de otra tabla.

Recorrer el camino **de la entrada hacia dentro**, no del código hacia fuera:
del webhook al handler, del clic a la ruta. Y en cada bifurcación preguntar
*«¿con los datos de producción, por dónde se va?»*.

> El número de la plataforma estaba bien configurado. Los cuatro ajustes,
> correctos. Lo que nadie miró fue que `resolveBusinessChannel` corría **antes**
> y encontraba un dueño.

## Cerrar el camino, no solo abrirlo

Cuando la respuesta a la 3 destape un adelantamiento posible, **la defensa va
en la base de datos**, no solo en el panel:

- Quitar el campo de la pantalla evita el **error de dedo**.
- Solo una guarda en PostgreSQL evita que vuelva a entrar por una API, un
  script, una migración o un `update` a mano.

Y la guarda tiene que ser **precisa, no un muro**: `businesses_numero_de_plataforma`
bloquea el número de la plataforma y **deja configurar cualquier otro**. Una
guarda que impide más de lo que debe acaba desactivada, y entonces no protege
nada.

## Qué escribir en el PR

Tres líneas. Si no caben en tres, el camino no está claro:

```
Camino real
· Se ejecuta cuando: <columnas y valores exactos>
· Producción hoy: <quién la tiene, consultado — o «nadie, y por esto»>
· Antes corre: <qué podría ganarle, y por qué no gana>
```

## Cuándo NO hace falta

Cuando el cambio está en un camino que **ya se ejecuta hoy** y no añade
bifurcación: arreglar un cálculo, cambiar un texto, mejorar un índice.

La pregunta que decide: ***¿este cambio crea una rama nueva por la que el
sistema puede irse, o mejora una por la que ya va?***

## La regla que resume la skill

> **Una columna, un texto y unas pruebas no garantizan que exista la línea que
> las enciende.**

Vale igual para una configuración que nadie tiene, para un `if` que nadie
alcanza y para una pantalla que muestra una decisión que el sistema no cumple —
que es cómo nació el fallo del número.
