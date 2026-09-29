import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { session } from '../../api/client'
import { Button } from '@botpanel/ui/components/button'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Copy, Crown, ShieldCheck, Smartphone, X } from 'lucide-react'

// El superadmin entra en DOS PASOS (2026-09-29): la contraseña da un pase de
// 10 minutos, y la sesión solo llega con el código de 6 dígitos de la app de
// códigos. La primera vez, se configura la app aquí mismo.

type Paso = 'credenciales' | 'codigo' | 'configurar'

async function pedir<T>(ruta: string, cuerpo: unknown): Promise<T> {
  const res = await fetch(ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
  const d = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(d.error || 'Error de conexión')
  return d
}

/** «JBSW Y3DP EHPK 3PXP»: de cuatro en cuatro se copia a mano sin perderse. */
const enGrupos = (clave: string) => clave.match(/.{1,4}/g)?.join(' ') ?? clave

export default function Login() {
  const [paso, setPaso] = useState<Paso>('credenciales')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pase, setPase] = useState('')
  const [codigo, setCodigo] = useState('')
  const [configuracion, setConfiguracion] = useState<{ clave: string; enlace: string } | null>(null)
  const [copiada, setCopiada] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const conCarga = async (accion: () => Promise<void>) => {
    setError('')
    setLoading(true)
    try {
      await accion()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  const entrarConContrasena = (e: React.FormEvent) => {
    e.preventDefault()
    void conCarga(async () => {
      const d = await pedir<{ paso: 'codigo' | 'configurar'; pase: string }>(
        '/api/admin/login', { email, password },
      )
      setPase(d.pase)
      setCodigo('')
      if (d.paso === 'configurar') {
        const c = await pedir<{ clave: string; enlace: string }>('/api/admin/login/configurar', { pase: d.pase })
        setConfiguracion(c)
      }
      setPaso(d.paso)
    })
  }

  const entrarConCodigo = (e: React.FormEvent) => {
    e.preventDefault()
    void conCarga(async () => {
      const d = await pedir<{ token: string }>('/api/admin/login/codigo', { pase, codigo })
      session.save(d.token)
      navigate('/')
    })
  }

  const volver = () => {
    setPaso('credenciales')
    setPase('')
    setCodigo('')
    setConfiguracion(null)
    setError('')
  }

  const copiarClave = async () => {
    if (!configuracion) return
    try {
      await navigator.clipboard.writeText(configuracion.clave)
      setCopiada(true)
    } catch {
      setCopiada(false)
    }
  }

  const campoDelCodigo = (
    <div className="space-y-1.5">
      <Label htmlFor="codigo">Código de 6 dígitos</Label>
      <Input id="codigo" required inputMode="numeric" autoComplete="one-time-code" maxLength={6}
        pattern="[0-9]{6}" value={codigo} autoFocus
        onChange={e => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="123456" className="tracking-[0.4em] text-center text-lg" />
    </div>
  )

  const avisoDeError = error && (
    <p role="alert" className="text-sm text-destructive flex items-start gap-1.5">
      <X className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{error}</span>
    </p>
  )

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          {paso === 'credenciales'
            ? <Crown className="w-8 h-8 mx-auto mb-1 text-primary" />
            : <ShieldCheck className="w-8 h-8 mx-auto mb-1 text-primary" />}
          <CardTitle className="text-xl"><h1>BotPanel — Superadmin</h1></CardTitle>
          <CardDescription>
            {paso === 'credenciales' && 'Acceso del dueño de la plataforma'}
            {paso === 'codigo' && 'Escribe el código que muestra tu app de códigos'}
            {paso === 'configurar' && 'Primera vez: configura tu app de códigos'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {paso === 'credenciales' && (
            <form onSubmit={entrarConContrasena} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Correo</Label>
                <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="admin@botpanel.com" autoComplete="email" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Contraseña</Label>
                <Input id="password" type="password" required value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••" autoComplete="current-password" />
              </div>
              {avisoDeError}
              <Button variant="ghost" type="submit" disabled={loading} className="w-full">
                {loading ? 'Entrando…' : 'Entrar'}
              </Button>
            </form>
          )}

          {paso === 'codigo' && (
            <form onSubmit={entrarConCodigo} className="space-y-4">
              {campoDelCodigo}
              {avisoDeError}
              <Button variant="ghost" type="submit" disabled={loading || codigo.length !== 6} className="w-full">
                {loading ? 'Comprobando…' : 'Entrar'}
              </Button>
              <Button variant="link" type="button" onClick={volver} className="w-full">
                Volver
              </Button>
            </form>
          )}

          {paso === 'configurar' && configuracion && (
            <form onSubmit={entrarConCodigo} className="space-y-4">
              <ol className="text-sm text-muted-foreground space-y-2 list-decimal pl-5">
                <li>Instala en tu móvil <strong>Google Authenticator</strong> (o la app de códigos que prefieras).</li>
                <li>Toca <strong>Añadir código → Introducir clave de configuración</strong> y escribe esta clave, con el nombre «Umbani»:</li>
              </ol>
              <div className="rounded-md border bg-muted px-3 py-2 flex items-center justify-between gap-2">
                <code className="font-mono text-sm break-all select-all">{enGrupos(configuracion.clave)}</code>
                <Button variant="ghost" size="icon" type="button" onClick={() => void copiarClave()}
                  aria-label="Copiar la clave">
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              {copiada && <p className="text-xs text-muted-foreground">Clave copiada.</p>}
              <a href={configuracion.enlace}
                className="text-sm text-primary underline-offset-4 hover:underline inline-flex items-center gap-1.5">
                <Smartphone className="w-4 h-4" />
                Si estás en el móvil, ábrela directamente en la app
              </a>
              <p className="text-sm text-muted-foreground">
                3. Escribe el código de 6 dígitos que te muestra la app para terminar.
              </p>
              {campoDelCodigo}
              {avisoDeError}
              <Button variant="ghost" type="submit" disabled={loading || codigo.length !== 6} className="w-full">
                {loading ? 'Comprobando…' : 'Terminar y entrar'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Guarda esta clave en un lugar seguro. Si pierdes el móvil, se reinicia desde el servidor.
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
