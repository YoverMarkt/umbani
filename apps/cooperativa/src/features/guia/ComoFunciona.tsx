import type { ReactNode } from 'react'
import { Card } from '@botpanel/ui/components/card'

// ═══════════════════════════════════════════════════════════════════════════
// LA GUÍA PARA LA COOPERATIVA (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedida por el dueño: «dejar claro para la cooperativa» cómo se trabaja con
// Umbani. ⚠️ Solo lo que YA hace la plataforma: lo que llegue con las
// incidencias se dice como «pronto», nunca como si existiera.

function Bloque({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="mb-2 text-base font-semibold text-foreground">{titulo}</h2>
      <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
    </Card>
  )
}

export default function ComoFunciona() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Cómo funciona</h1>
        <p className="text-sm text-muted-foreground">Cómo trabaja tu cooperativa con Umbani, paso a paso.</p>
      </div>

      <Bloque titulo="1. Tus repartidores">
        <p>Los registras en «Repartidores» con su nombre, su WhatsApp, su cédula, su placa y su vehículo.</p>
        <p>
          Entran a la app de Umbani con su WhatsApp: la app les da un código, lo mandan a Umbani y entran. Sin
          contraseñas.
        </p>
        <p>
          Solo ven los pedidos de los locales que reparte tu cooperativa, en tu ciudad. Para recibir pedidos
          marcan «Disponible» en la app.
        </p>
      </Bloque>

      <Bloque titulo="2. Un pedido, de principio a fin">
        <p>El local acepta el pedido y aparece a tus repartidores disponibles. El primero que lo toma se lo lleva.</p>
        <p>Va al local y marca «Ya lo recogí» cuando el local terminó de empacarlo. El cliente recibe «va en camino».</p>
        <p>
          Lo entrega y marca «Lo entregué». Si el cliente paga en efectivo, la app le pide confirmar que lo cobró.
          El cliente recibe «llegó».
        </p>
      </Bloque>

      <Bloque titulo="3. El dinero">
        <p>La carrera de cada pedido es del repartidor. El efectivo que cobra en la puerta lo guarda él.</p>
        <p>
          Cada lunes Umbani cierra su semana: le paga sus carreras y le cobra el efectivo que tiene. Si cobró
          más efectivo que sus carreras, entrega la diferencia; si no, Umbani le paga.
        </p>
        <p>
          Tu comisión la acuerdas tú con cada repartidor: en «Carreras» ves y descargas lo de cada uno, semana a
          semana.
        </p>
      </Bloque>

      <Bloque titulo="4. El tope de efectivo">
        <p>
          Cada repartidor tiene un tope de efectivo encima (normalmente $150). Por encima no puede tomar pedidos
          en efectivo hasta liquidar. Lo ves en «Repartidores».
        </p>
      </Bloque>

      <Bloque titulo="5. Si algo sale mal">
        <p>
          Si a un repartidor se le cae la comida, Umbani le retiene la carrera de ese pedido y el local cobra su
          comida igual. Lo ves en «Problemas».
        </p>
        <p>Pronto: las demás incidencias (cliente ausente, un producto que faltó, un accidente), con quién responde por cada una.</p>
      </Bloque>

      <Bloque titulo="6. Apagar">
        <p>Si apagas a un repartidor, ya no puede entrar a la app. Hazlo cuando no lleve ningún pedido.</p>
        <p>
          Si Umbani apaga la cooperativa, tus repartidores dejan de recibir pedidos nuevos (lo que ya llevan, lo
          terminan) y este panel se cierra.
        </p>
      </Bloque>
    </div>
  )
}
