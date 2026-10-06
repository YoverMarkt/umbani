import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bike } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { api, session } from '../../api/client'

// El acceso de la cooperativa: el correo y la contraseña que le dio Umbani al
// darla de alta. Si la olvida, Umbani le da una nueva.

type Respuesta = { token: string; cooperativa: { nombre: string; ciudad: string | null } }

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [cargando, setCargando] = useState(false)
  const navigate = useNavigate()

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setCargando(true)
    try {
      const r = await api<Respuesta>('/api/cooperativa/login', { method: 'POST', body: JSON.stringify({ email, password }) })
      session.save(r.token, r.cooperativa.nombre)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo entrar')
    } finally {
      setCargando(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Bike className="size-6" />
          </div>
          <CardTitle className="text-xl"><h1>Umbani — Cooperativas</h1></CardTitle>
          <CardDescription>El panel de tu cooperativa de reparto</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={e => void entrar(e)} className="space-y-4">
            <div>
              <Label htmlFor="email">Correo</Label>
              <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="cooperativa@correo.com" autoComplete="email" />
            </div>
            <div>
              <Label htmlFor="password">Contraseña</Label>
              <Input id="password" type="password" required value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••••••" autoComplete="current-password" />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={cargando} className="w-full">
              {cargando ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>
          <p className="mt-4 text-center text-xs text-muted-foreground">¿Olvidaste tu contraseña? Pídele una nueva a Umbani.</p>
        </CardContent>
      </Card>
    </div>
  )
}
