#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// STAGING LOCAL — donde probar Umbani sin tocar a un solo cliente
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta el 2026-09-19, el primer sitio donde se probaba un cambio era el número
// de WhatsApp de verdad: `server/.env` apunta a la base de producción, así que
// desarrollar y producción eran el mismo sitio.
//
//   npm run staging:up                        levanta Supabase y siembra
//   npm run dev:staging -w @botpanel/server   arranca el servidor contra él
//   npm run verify:smoke:staging -w @botpanel/server
//   npm run staging:down                      lo apaga
//
// ⚠️ **No sirve un PostgreSQL pelado.** El servidor habla con la base por HTTP
// (supabase-js → PostgREST), no por SQL, así que hace falta el stack de
// Supabase entero. Lo levanta `supabase start`, configurado en
// `supabase/config.toml` con Auth, Storage y Realtime apagados porque este
// proyecto no usa ninguno.
//
// ⚠️ La semilla NO inventa un catálogo a mano: crea el negocio y llama a
// `apply_business_template`, la MISMA función que corre el alta real. Un
// staging sembrado por otro camino prueba un mundo que no existe.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const servidor = path.resolve(aqui, '..')
const raiz = path.resolve(servidor, '..')
const require = createRequire(path.join(servidor, 'package.json'))

// ── Lo que define este entorno, en un solo sitio ────────────────────────────
//
// Son credenciales de mentira para un Docker que solo existe en esta máquina.
// Viven aquí y no en un `.env` a propósito: un archivo de entorno más es un
// archivo más que alguien puede confundir con el de producción.
const PUERTO = process.env.STAGING_PORT || '3100'
const BASE = `http://localhost:${PUERTO}`
const JWT_SECRET = 'staging-local-jwt-secret-de-32-caracteres-o-mas'
const ADMIN_EMAIL = 'admin@umbani.local'
const ADMIN_PASSWORD = 'staging-admin-2026'
const SLUG = 'demo'
const DUENO_EMAIL = 'demo@umbani.local'
const DUENO_CLAVE = 'staging-demo-2026'

/** La base que levanta la CLI. Se puede apuntar a otra con STAGING_DB_URL. */
const URL_BASE = process.env.STAGING_DB_URL
  || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

// ── LA GUARDIA ──────────────────────────────────────────────────────────────
//
// `preparar` APLICA EL ESQUEMA Y ESCRIBE. Apuntado a producción por descuido
// sería una catástrofe, y un descuido así es de lo más fácil del mundo: basta
// una variable heredada de otra terminal. Por eso no se pide confirmación —se
// niega— y por eso la comprobación está arriba del todo.
const anfitrion = (() => {
  try {
    return new URL(URL_BASE).hostname
  } catch {
    return ''
  }
})()

if (!HOSTS_LOCALES.has(anfitrion)) {
  console.error('\n❌ Esto solo corre contra una base LOCAL.')
  console.error(`   La cadena apunta a: ${anfitrion || '(ilegible)'}\n`)
  process.exit(1)
}

// El contenedor alcanza la máquina por `host.docker.internal`, no por localhost.
const urlDesdeDocker = URL_BASE.replace(
  /@(localhost|127\.0\.0\.1|0\.0\.0\.0)/,
  '@host.docker.internal',
)

// ⚠️ Con `psql` instalado se usa ESE, y si no, el de un contenedor. El Mac no
// suele tenerlo y tira de Docker como siempre; el CI (Linux) lo instala con apt
// y además NO conoce `host.docker.internal` —ese nombre solo existe en Docker
// Desktop—, así que ahí el contenedor iría a ciegas. Lo descubrieron los
// recorridos de punta a punta, que son los primeros en sembrar desde el CI.
const hayPsqlLocal = (() => {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

export const psql = (args, entrada) => execFileSync(
  hayPsqlLocal ? 'psql' : 'docker',
  hayPsqlLocal
    ? [URL_BASE, '-v', 'ON_ERROR_STOP=1', ...args]
    : [
        'run', '--rm', '-i',
        // En Linux el contenedor comparte la red de la máquina y ve localhost.
        ...(process.platform === 'linux' ? ['--network', 'host'] : []),
        'pgvector/pgvector:pg17',
        'psql', process.platform === 'linux' ? URL_BASE : urlDesdeDocker, '-v', 'ON_ERROR_STOP=1', ...args,
      ],
  {
    input: entrada,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  },
)

/**
 * Espera a que la base acepte consultas, en vez de rendirse al primer intento.
 *
 * ⚠️ Nace de una fricción diaria: al arrancar Docker, el contenedor de la base
 * tarda medio minuto en estar sano y `supabase start` corta con «container is
 * not ready: starting». No es un error —es prisa—, pero dejaba `staging:up` en
 * rojo y había que reintentar a mano cada mañana.
 */
function esperarALaBase({ intentos = 40 } = {}) {
  for (let i = 0; i < intentos; i++) {
    try {
      psql(['-tAc', 'select 1'])
      return true
    } catch {
      if (i === 0) process.stdout.write('   esperando a la base')
      else process.stdout.write('.')
      execFileSync('sleep', ['3'])
    }
  }
  console.error('\n\n❌ El Supabase local no responde.')
  console.error('   ¿Está Docker corriendo?  Levántalo con:  npm run staging:up\n')
  process.exit(1)
}

export function exigirQueEsteLevantado() {
  const inicio = Date.now()
  esperarALaBase()
  if (Date.now() - inicio > 3000) console.log(' listo')
}

/**
 * La clave de servicio del Supabase local.
 *
 * ⚠️ Desde la CLI 2.x, `supabase status` ya NO la devuelve —solo URLs—, y este
 * script se quedaba sin arrancar. Tampoco sirve firmarla a mano: el
 * `PGRST_JWT_SECRET` del PostgREST local es un JWKS con clave EC, así que un
 * token HS256 firmado por nosotros lo rechaza con «No suitable key».
 *
 * La que vale es la que la propia CLI reparte a sus contenedores. Solo abre un
 * Docker de esta máquina.
 */
function claveDeServicio() {
  // 1. La CLI, por si alguna versión vuelve a darla.
  const deLaCli = estadoDeSupabase().SERVICE_ROLE_KEY
  if (deLaCli) return deLaCli

  // 2. Donde vive de verdad: los secretos con los que la CLI arranca sus
  //    propios contenedores. Es una ruta interna suya y puede cambiar, por eso
  //    se intenta después de preguntárselo a ella.
  const secretos = path.join(raiz, 'supabase/.temp/start-secrets')
  const pendientes = [secretos]
  while (pendientes.length) {
    const actual = pendientes.pop()
    let entradas = []
    try {
      entradas = readdirSync(actual, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entrada of entradas) {
      const completa = path.join(actual, entrada.name)
      if (entrada.isDirectory()) {
        pendientes.push(completa)
        continue
      }
      if (!entrada.name.endsWith('.env')) continue
      const clave = readFileSync(completa, 'utf8')
        .split('\n')
        .find(linea => linea.startsWith('SUPABASE_SERVICE_ROLE_KEY='))
        ?.slice('SUPABASE_SERVICE_ROLE_KEY='.length)
        .trim()
      if (clave) return clave
    }
  }

  console.error('\n❌ No encuentro la clave de servicio del Supabase local.')
  console.error('   Reinícialo:  npm run staging:down && npm run staging:up\n')
  process.exit(1)
}

/** Las URLs del Supabase local. */
function estadoDeSupabase() {
  try {
    const salida = execFileSync('supabase', ['status', '-o', 'env'], {
      cwd: raiz,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const valores = {}
    for (const linea of salida.split('\n')) {
      const igual = linea.indexOf('=')
      if (igual < 1) continue
      valores[linea.slice(0, igual).trim()] = linea.slice(igual + 1).trim().replace(/^"|"$/g, '')
    }
    return valores
  } catch {
    console.error('\n❌ El Supabase local no responde.')
    console.error('   Levántalo con:  npm run staging:up\n')
    process.exit(1)
  }
}

/**
 * El entorno con el que corre el servidor de staging.
 *
 * ⚠️ Se construye desde CERO y NO hereda `server/.env`: heredarlo dejaría
 * colarse el `SUPABASE_URL` de producción, y el staging apuntaría —sin avisar—
 * justo a lo que viene a evitar.
 */
export function entornoDeStaging() {
  const estado = estadoDeSupabase()
  const servicio = claveDeServicio()
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'development',
    SUPABASE_URL: estado.API_URL || 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_KEY: servicio,
    SUPABASE_KEY: servicio,
    JWT_SECRET,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    PORT: PUERTO,
    // ⚠️ SÍ lleva BASE_URL, y apuntando aquí mismo: sin ella no se puede armar
    // el enlace de la tienda y elegir un local contesta «no pude abrir la
    // tienda». Que apunte a localhost es justo lo que hace que
    // `isProductionEnvironment` siga diciendo que esto NO es producción.
    BASE_URL: BASE,
    UMBANI_ENTORNO: 'staging',
  }
}

const literal = valor => `'${String(valor).replace(/'/g, "''")}'`

// ── preparar ────────────────────────────────────────────────────────────────

/**
 * Vacía la base de staging, aplica el esquema y siembra.
 *
 * Por defecto, la del Docker de esta máquina. `staging-remoto.mjs` la reutiliza
 * para el staging en INTERNET pasándole su propio `ejecutar` y una clave del
 * dueño que no está escrita en ningún sitio público (esta lo está: aquí abajo).
 */
export function preparar({ ejecutar = psql, claveDelDueno = DUENO_CLAVE, esperar = exigirQueEsteLevantado } = {}) {
  esperar()

  // ⚠️ SE EMPIEZA DE CERO, y no es por comodidad: `schema.sql` tiene
  // `alter table … add constraint` que NO son idempotentes, así que
  // reaplicarlo sobre una base ya poblada revienta con «constraint … already
  // exists». La primera vez funciona y la segunda no — el peor tipo de
  // comando, el que solo falla cuando ya confiabas en él.
  //
  // Vaciar es seguro AQUÍ porque la guardia de arriba ya se negó a correr
  // contra nada que no sea una base local de esta máquina.
  console.log('\n🧹 Vaciando la base de staging…')
  ejecutar(['-q'], `
drop schema if exists public cascade;
create schema public;
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres;
`)

  console.log('📐 Aplicando el esquema…')
  ejecutar(['-q'], readFileSync(path.join(servidor, 'schema.sql'), 'utf8'))
  console.log('   ✅ schema.sql aplicado')

  // ⚠️ Y SE DEVUELVEN LOS PERMISOS. Al vaciar el esquema se van también los
  // `grant` que Supabase concede de fábrica a sus roles, y sin ellos el
  // servidor arranca, contesta `/api/health` en verde… y todo lo que toque la
  // base falla con «permission denied for table customers». Verde por fuera y
  // muerto por dentro, que es la peor forma de estar roto.
  //
  // ⚠️ SOLO a `postgres` y `service_role`, NUNCA a `anon` ni `authenticated`
  // (2026-10-01). Antes se devolvía todo a todos, como hace Supabase de
  // fábrica, y eso DESHACÍA los 135 `revoke … from anon` que `schema.sql` pone
  // en las funciones del dinero, y abría a la clave pública las tablas sin RLS
  // (`server_settings`, con la clave de dos pasos del superadmin). En el Docker
  // de una máquina daba igual; desde que existe el staging en INTERNET, no.
  // El servidor solo usa `service_role` —los paneles nunca hablan con la base—,
  // así que nadie más necesita nada.
  ejecutar(['-q'], `
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant all on all tables    in schema public to postgres, service_role;
grant all on all functions in schema public to postgres, service_role;
grant all on all sequences in schema public to postgres, service_role;
alter default privileges in schema public
  grant all on tables    to postgres, service_role;
alter default privileges in schema public
  grant all on functions to postgres, service_role;
alter default privileges in schema public
  grant all on sequences to postgres, service_role;
`)
  console.log('   ✅ permisos devueltos (solo al servidor: postgres y service_role)')

  const bcrypt = require('bcryptjs')
  const plantillas = require(path.join(servidor, 'dist/services/business-templates.js'))
  // ⚠️ EL TIPO SALE DEL CATÁLOGO DEL MARKETPLACE, con su tilde.
  //
  // `businessTypesWithTemplate()` los nombra SIN tildes (`pizzeria`), mientras
  // que `marketplace_category_types` —la tabla que decide en qué cajón entra un
  // local— los tiene CON tilde (`pizzería`). No es un fallo: buscar la
  // plantilla normaliza acentos, así que las dos formas encuentran la suya.
  //
  // Pero el `type` que se GUARDA es el que usa el marketplace para asignar
  // cajón, y sembrando con la forma sin tilde el local nacía fuera de toda
  // categoría: el menú contestaba «ahora mismo no hay locales disponibles» con
  // el local ahí, invisible. Producción usa `pizzería`, y esto también.
  const tipo = 'pizzería'
  const plantilla = JSON.stringify(plantillas.templateForBusinessType(tipo))

  console.log(`🌱 Sembrando «${SLUG}» (tipo: ${tipo})…`)
  ejecutar(['-q'], `
do $$
declare
  v_negocio uuid;
  v_resultado jsonb;
begin
  delete from businesses where slug = ${literal(SLUG)};

  -- 'marketplace': sin canal propio, lo atiende el número de la plataforma.
  -- Es lo que son hoy todos los locales de verdad.
  -- ⚠️ storefront_enabled en true: un local nace con la TIENDA APAGADA y la
  -- enciende el superadmin. Sin encenderla aquí, el menú del marketplace no lo
  -- lista —marketplace_categories_disponibles() solo cuenta los que pueden
  -- vender— y el chat contesta «ahora mismo no hay locales disponibles» con el
  -- local sembrado y en su cajón, invisible.
  insert into businesses (slug, name, type, whatsapp_provider, takes_orders, active,
                          storefront_enabled)
  values (${literal(SLUG)}, 'Local de Pruebas', ${literal(tipo)}, 'marketplace', true, true,
          true)
  returning id into v_negocio;

  v_resultado := public.apply_business_template(v_negocio, ${literal(plantilla)}::jsonb);
  if (v_resultado->>'aplicada')::boolean is not true then
    raise exception 'La plantilla no se aplicó: %', v_resultado;
  end if;

  -- El ejemplo nace AGOTADO en el alta real, porque su precio es inventado.
  -- Aquí sí queremos poder comprarlo: es lo que se viene a probar.
  update products set stock = 'disponible' where business_id = v_negocio;

  -- Sin cajón el local NO EXISTE para el cliente: el menú del marketplace se
  -- arma desde las categorías, no desde la tabla businesses. Es lo mismo que hace el
  -- superadmin al dar de alta un local de verdad.
  insert into business_marketplace_categories (business_id, category_id, principal)
  select v_negocio, t.category_id, true
    from marketplace_category_types t
   where t.business_type = ${literal(tipo)}
   limit 1;

  if not found then
    raise exception 'El tipo «%» no está en marketplace_category_types: el local nacería invisible', ${literal(tipo)};
  end if;

  insert into client_users (business_id, email, password_hash, name, role)
  values (v_negocio, ${literal(DUENO_EMAIL)}, ${literal(bcrypt.hashSync(claveDelDueno, 10))},
          'Dueño de Pruebas', 'owner');
end $$;
`)

  // ⚠️ El menú va APARTE, en `menu-de-pruebas.sql`. La plantilla del alta deja
  // un local con su producto de ejemplo, que sirve para comprobar que el alta
  // funciona pero no para probar la tienda: sin categorías ni opciones no hay
  // nada que le exija nada al motor. Ese archivo pone una pizzería completa.
  console.log('🍕 Montando el menú de la pizzería…')
  ejecutar(['-q'], readFileSync(path.join(aqui, 'menu-de-pruebas.sql'), 'utf8'))

  // 🔐 LA MARCA: esta base es de staging. Sin ella, un servidor con
  // UMBANI_ENTORNO=staging se niega a arrancar (podría ser la de producción), y
  // uno de producción se niega si la encuentra. Ver
  // `src/config/identidad-de-la-base.ts`.
  ejecutar(['-q'], `
insert into server_settings (key, value) values ('entorno', 'staging')
on conflict (key) do update set value = 'staging', updated_at = now();
`)

  // 📱 Lo que necesitan las APPS (2026-10-01) para probarse contra el staging:
  //
  //   · un número de Umbani, aunque sea falso: sin él la app no puede pedir el
  //     código de inicio de sesión («El número de Umbani no está configurado»).
  //     El código se manda desde el SIMULADOR del superadmin. La clave es
  //     falsa: lo que el staging intente enviar a YCloud lo rechaza YCloud.
  //   · un REPARTIDOR del local de pruebas, con el teléfono del simulador, para
  //     la app del motorizado. Es de la flota del local: no cambia quién cobra.
  //     ⚠️ Con los repartidores propios ENCENDIDOS en ese local (2026-10-04):
  //     se encienden local por local y nacen apagados, y apagados la base no
  //     le ofrece ningún pedido — la app del motorizado se vería vacía.
  //   · el local de pruebas EN CHONE (2026-10-05): sin ciudad, un local no
  //     aparece a ningún cliente — ni en el chat ni en la app.
  ejecutar(['-q'], `
insert into server_settings (key, value) values
  ('platform_ycloud_api_key', 'clave-falsa-del-staging'),
  ('platform_ycloud_number', '593990000001')
on conflict (key) do update set value = excluded.value, updated_at = now();

update businesses set own_fleet = true, delivery_by = 'local',
  city_id = (select id from cities where lower(name) = 'chone') where slug = ${literal(SLUG)};

insert into couriers (phone, name, vehicle, fleet_business_id)
select '000000000000', 'Motorizado de Pruebas', 'moto', id from businesses where slug = ${literal(SLUG)}
on conflict (phone) do nothing;
`)

  // 🏪 EL LOCAL DE PRUEBAS, COMO UNO DE VERDAD (2026-10-01). Con lo que dejaba
  // la plantilla del alta no se podía revisar nada: abría de 9 a 18 (de noche,
  // «cerrado»), solo aceptaba transferencia y no tenía envío, ni margen ni
  // tarifa — así que la línea «Tarifa de servicio» no había cómo verla. Ahora:
  // abierto siempre, los tres cobros, cuenta para transferir, envío, y el
  // dinero de Umbani como en PRODUCCIÓN (10 % por producto y $0,10 de tarifa).
  // Los recorridos lo reajustan desde los paneles al empezar.
  ejecutar(['-q'], `
do $$
declare
  v_negocio uuid := (select id from businesses where slug = ${literal(SLUG)});
begin
  delete from business_schedule where business_id = v_negocio;
  update businesses set delivery_fee = 1.50 where id = v_negocio;

  insert into business_bank_accounts (business_id, bank_name, account_type, account_number, holder_name)
  values (v_negocio, 'Banco de Pruebas', 'ahorros', '2200000000', 'Local de Pruebas');

  insert into business_payment_methods (business_id, method_code, enabled, sort)
  select v_negocio, m.code, true, m.sort from payment_methods m
   where m.code in ('efectivo', 'transferencia', 'pago_al_retirar')
  on conflict (business_id, method_code) do update set enabled = true;

  insert into pricing_rules (business_id, scope, strategy, percentage, markup_mode, notes)
  values (v_negocio, 'business', 'percentage', 10, 'on_top', 'Como en producción (semilla del staging)');
end $$;

insert into server_settings (key, value) values ('service_fee', '0.10')
on conflict (key) do update set value = excluded.value, updated_at = now();
`)

  const [negocios, productos, usuarios] = ejecutar(['-tAc', `
    select (select count(*) from businesses),
           (select count(*) from products),
           (select count(*) from client_users)
  `]).trim().split('|')

  console.log(`
✅ STAGING LISTO — ${negocios} negocio(s), ${productos} producto(s), ${usuarios} usuario(s)

   Arranca el servidor:  npm run dev:staging -w @botpanel/server
`)
}

// ── servidor ────────────────────────────────────────────────────────────────

function arrancarServidor() {
  const entorno = entornoDeStaging()
  console.log(`
🧪 STAGING LOCAL
   Base:   ${entorno.SUPABASE_URL}
   Panel:  ${BASE}/app        (${DUENO_EMAIL} / ${DUENO_CLAVE})
   Admin:  ${BASE}/app-admin  (${ADMIN_EMAIL} / ${ADMIN_PASSWORD})
   Tienda: el enlace sale del simulador del admin, como en la vida real.

   Los datos son de MENTIRA. Producción no se entera de nada de lo que hagas.
   La página lleva una etiqueta «STAGING» abajo a la izquierda.
`)
  const hijo = spawn('node', [path.join(servidor, 'dist/index.js')], {
    cwd: servidor,
    env: entorno,
    stdio: 'inherit',
  })
  hijo.on('exit', codigo => process.exit(codigo ?? 0))
}

// ── actualizar ──────────────────────────────────────────────────────────────

/**
 * La huella del esquema: el consolidado más la lista de migraciones.
 *
 * Sirve para una sola pregunta, y es la que evita la peor confusión de este
 * entorno: ¿lo que acabo de traer cambia la forma de la base? Si cambió y la
 * base de staging sigue con la de ayer, la aplicación falla con errores de
 * columna que parecen bugs de la app y no lo son.
 */
export function huellaDelEsquema(esquema, migraciones) {
  return createHash('sha1').update(esquema).update([...migraciones].sort().join(',')).digest('hex')
}

/** La huella de lo que hay ahora mismo en el disco. */
function huellaDelDisco() {
  return huellaDelEsquema(
    readFileSync(path.join(servidor, 'schema.sql'), 'utf8'),
    readdirSync(servidor).filter(n => n.startsWith('migration-') && n.endsWith('.sql')),
  )
}

/**
 * Trae lo último de GitHub, lo reconstruye entero y arranca el staging.
 *
 * ⚠️ Existe porque «tengo el staging levantado» NO significa «el staging
 * tiene lo último», y las tres razones por las que no lo tiene son
 * invisibles:
 *
 *   1. el repositorio local no se actualiza solo (falta `git pull`);
 *   2. el servidor no vigila cambios — compila al arrancar y ya;
 *   3. y la peor: `npm run build` del SERVIDOR no construye los paneles. La
 *      mini app se sirve desde `apps/store/dist`, así que sin reconstruirla
 *      el staging enseña la tienda de antes con un servidor nuevo. Esa
 *      trampa ya se pagó una vez en producción.
 *
 * Un comando en vez de cuatro pasos que hay que recordar en el orden correcto.
 */
function actualizar() {
  const git = (...args) => execFileSync('git', args, { cwd: raiz, encoding: 'utf8' }).trim()

  // ⚠️ NUNCA un pull encima de trabajo sin guardar: el conflicto llegaría a
  // media construcción y con el staging a medio arrancar.
  if (git('status', '--porcelain')) {
    console.error(`
❌ Hay cambios sin guardar en el repositorio.

   Guárdalos o descártalos antes de actualizar el staging:
     git status          ver qué hay
     git stash           apartarlos para luego
`)
    process.exit(1)
  }

  const rama = git('rev-parse', '--abbrev-ref', 'HEAD')
  const antes = huellaDelDisco()

  console.log(`\n⬇️  Trayendo lo último de «${rama}»…`)
  execFileSync('git', ['pull', '--ff-only'], { cwd: raiz, stdio: 'inherit' })

  // ⚠️ El build de la RAÍZ, que construye el servidor Y los tres frontales.
  // El del servidor solo compila `server/src`, y ahí está la trampa del punto 3.
  console.log('\n🔨 Reconstruyendo servidor, paneles y mini app…')
  execFileSync('npm', ['run', 'build'], { cwd: raiz, stdio: 'inherit' })

  if (huellaDelDisco() !== antes) {
    console.error(`
⚠️  LO QUE TRAJISTE CAMBIA LA BASE, y la de staging sigue con la de antes.

   Arrancar así da errores de columna que parecen bugs de la app. Resetea
   primero (borra los datos de prueba y vuelve a sembrar):

     npm run staging:reset && npm run staging:actualizar
`)
    process.exit(1)
  }

  exigirQueEsteLevantado()
  arrancarServidor()
}

// ── humo ────────────────────────────────────────────────────────────────────

function humo() {
  // El MISMO script que se corre contra producción, con las credenciales de
  // staging. Así el paso 5 —dar de alta un cliente, el camino que se rompió el
  // 2026-08-02— deja de crear negocios de prueba en la base real.
  const hijo = spawn('node', [path.join(aqui, 'humo-produccion.mjs'), BASE], {
    cwd: servidor,
    env: { ...process.env, JWT_SECRET, ADMIN_EMAIL, SMOKE_URL: BASE },
    stdio: 'inherit',
  })
  hijo.on('exit', codigo => process.exit(codigo ?? 0))
}

/**
 * `supabase start` + sembrar, tolerando que Docker acabe de arrancar.
 */
function levantar() {
  console.log('🐳 Levantando Supabase…')
  try {
    execFileSync('supabase', ['start'], { cwd: raiz, stdio: 'inherit' })
  } catch {
    // ⚠️ NO se aborta: `supabase start` corta con «container is not ready»
    // cuando los contenedores ya existen y están subiendo. La base acaba
    // respondiendo unos segundos después, y `preparar` la espera.
    console.log('   (los contenedores siguen subiendo…)')
  }
  preparar()
}

const comandos = { levantar, preparar, servidor: arrancarServidor, humo, actualizar }

// Solo corre cuando se ejecuta como programa: importado desde las pruebas, no.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const comando = process.argv[2] || 'preparar'
  if (!comandos[comando]) {
    console.error(`\n❌ No conozco «${comando}». Usa: levantar | preparar | servidor | humo | actualizar\n`)
    process.exit(1)
  }
  comandos[comando]()
}
