import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { raiz } from './pantallas.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// LOS BOCETOS DEL DUEÑO NO SE PUBLICAN
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño diseñó la app en Figma (2026-10-09) y se construye «tal cual» con
// la skill `fiel-al-boceto`: sus pantallas exportadas, las comparaciones
// boceto | app y los datos de prueba viven en `.bocetos/`.
//
// El repositorio es PÚBLICO. Un `git add -A` o un `git add -f` distraído
// publicaría el diseño entero antes del lanzamiento, y una vez en GitHub no se
// retira: queda en la historia y en cualquier copia. `.gitignore` evita el
// descuido; esto evita que alguien lo deshaga sin darse cuenta.

const git = (...argumentos) => execFileSync('git', argumentos, { cwd: raiz, encoding: 'utf8' }).trim()

describe('los bocetos del dueño no se publican', () => {
  it('.gitignore ignora la carpeta .bocetos/', () => {
    const lineas = readFileSync(path.join(raiz, '.gitignore'), 'utf8').split('\n').map((linea) => linea.trim())
    expect(lineas).toContain('.bocetos/')
  })

  it('git ignora DE VERDAD lo que se guarda allí', () => {
    // `check-ignore` responde por la regla que aplica git, no por el texto:
    // una excepción escrita más abajo (`!.bocetos/...`) se vería aquí.
    // Sale con código 1 si el archivo NO se ignora.
    let ignorado = ''
    try {
      ignorado = git('check-ignore', '--no-index', '.bocetos/figma/01-inicio.png')
    } catch {
      ignorado = ''
    }
    expect(ignorado, 'git subiría los bocetos: revisa .gitignore').toBe('.bocetos/figma/01-inicio.png')
  })

  it('ningún archivo de .bocetos/ está en el repositorio', () => {
    expect(git('ls-files', '--', '.bocetos'), 'Sácalos con `git rm --cached`: el repositorio es público').toBe('')
  })
})
