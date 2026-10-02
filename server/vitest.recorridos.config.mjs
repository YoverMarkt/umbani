import { defineConfig } from 'vitest/config'

// Los RECORRIDOS de punta a punta: servidor de verdad contra la base del
// staging local (Supabase en Docker). Van aparte de `npm test` porque necesitan
// Docker y tardan; el CI los corre en su propio trabajo. Ver VERIFICACION.md.
export default defineConfig({
  test: {
    include: ['tests/recorridos/**/*.recorrido.js'],
    globalSetup: ['./tests/recorridos/entorno.mjs'],
    // Una sola base y un solo cliente (el teléfono del simulador): un recorrido
    // a la vez, o se pisarían los pedidos abiertos.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 180_000,
    env: {
      STAGING_DB_URL: process.env.STAGING_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    },
  },
})
