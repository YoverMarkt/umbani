import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fuenteDeLasRutasDeLocales } from './fuente-de-rutas.mjs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migration = readFileSync(
  `${serverDir}/migration-atomicidad-onboarding.sql`,
  'utf8',
)
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const businessesRepository = readFileSync(
  `${serverDir}/src/db/repositories/businesses.ts`,
  'utf8',
)
const routeSource = fuenteDeLasRutasDeLocales()

describe('atomicidad del onboarding de clientes', () => {
  it('crea todas las entidades dentro de una sola función PostgreSQL', () => {
    expect(migration).toContain(
      'create or replace function public.create_business_onboarding',
    )
    expect(migration).toContain('insert into businesses')
    expect(migration).toContain('insert into bot_policies')
    expect(migration).toContain('insert into business_schedule')
    expect(migration).toContain('on conflict (business_id, day_of_week) do nothing')
    expect(migration).toContain('insert into client_users')
    expect(migration).toContain('insert into billing')
    expect(migration).toContain('generate_series(0, 11)')
    expect(migration).not.toContain('exception when')
  })

  it('acepta únicamente campos de negocio explícitos y cifra al dueño', () => {
    expect(migration).not.toContain("p_business ->> 'business_id'")
    expect(migration).not.toContain('jsonb_populate_record')
    expect(migration).toContain("v_password_hash !~ '^\\$2[aby]\\$[0-9]{2}\\$'")
    expect(migration).toContain("'owner'")
  })

  it('expone la RPC solo al backend service_role', () => {
    expect(migration).toContain('security definer')
    expect(migration).toContain('from anon;')
    expect(migration).toContain('from authenticated;')
    expect(migration).toContain('to service_role;')
  })

  it('mantiene el esquema consolidado y la capa de datos sincronizados', () => {
    expect(schema).toContain(
      'create or replace function public.create_business_onboarding',
    )
    expect(businessesRepository).toContain("db.rpc('create_business_onboarding'")
    expect(routeSource).toContain('db.createBusinessOnboarding(')
    expect(routeSource).not.toContain('rollback onboarding')
  })
})
