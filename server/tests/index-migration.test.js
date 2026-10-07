import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

function readTypeScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const ruta = `${directory}/${entry.name}`
    if (entry.isDirectory()) return readTypeScriptFiles(ruta)
    return entry.name.endsWith('.ts') ? [ruta] : []
  })
}

/** Los `require()` de un archivo que salen de `src/`. */
const requiresFueraDeSrc = (archivo, fuente, src) => [...fuente.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)]
  .map(([, destino]) => destino)
  .filter(destino => !path.resolve(path.dirname(archivo), destino).startsWith(`${src}/`))

describe('entrypoint TypeScript', () => {
  it('compone el servidor desde src y arranca directamente desde dist', () => {
    const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const serverPackage = JSON.parse(fs.readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    ))

    expect(serverPackage.main).toBe('dist/index.js')
    expect(serverPackage.scripts.start).toBe('node dist/index.js')
    expect(source).toContain("dotenv.config({ path: path.join(serverRoot, '.env') })")
    expect(source).toContain("path.join(projectRoot, 'apps/client/dist')")
    expect(source).toContain("app.use('/api/client', activeClientGuard)")
    expect(source).toContain('app.use(webhooksRouter)')
    expect(source).not.toContain('@ts-nocheck')
  })

  it('resuelve módulos internos sin volver a las fachadas CommonJS raíz', () => {
    // Las fachadas vivían en la raíz del servidor: lo prohibido es SALIR de
    // `src/`. Hasta el 2026-10-07 se miraba que nadie escribiera `../../`, que
    // lo cazaba igual… y prohibía también subir dos carpetas DENTRO de `src/`,
    // que es legítimo desde que la tienda tiene sus secciones en `routes/tienda/`.
    const sourceDirectory = path.resolve(new URL('../src', import.meta.url).pathname)
    const fuera = readTypeScriptFiles(sourceDirectory).flatMap(archivo => (
      requiresFueraDeSrc(archivo, fs.readFileSync(archivo, 'utf8'), sourceDirectory).map(d => `${archivo} → ${d}`)
    ))

    expect(fuera).toEqual([])
  })

  it('caza de verdad un require que sale de src/', () => {
    // Un guardián que nunca ha visto lo que persigue no sirve de nada.
    const src = '/proyecto/server/src'
    expect(requiresFueraDeSrc(`${src}/routes/x.ts`, "require('../../db')", src)).toEqual(['../../db'])
    expect(requiresFueraDeSrc(`${src}/routes/tienda/x.ts`, "require('../../db')", src)).toEqual([])
    expect(requiresFueraDeSrc(`${src}/routes/x.ts`, "require('../db')", src)).toEqual([])
  })

  it('no conserva fachadas JavaScript fuera de la configuración de ESLint', () => {
    const serverDirectory = new URL('..', import.meta.url).pathname
    const javascript = fs.readdirSync(serverDirectory)
      .filter(name => name.endsWith('.js'))

    expect(javascript).toEqual(['eslint.config.js'])
  })
})
