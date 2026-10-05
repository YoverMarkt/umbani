// ── Capacidades del negocio ───────────────────────────────────────
//
// ⚠️ Hasta el 2026-08-20 vivía aquí `isServiceBiz`, treinta expresiones
// regulares que reconocían barberías, clínicas, hoteles, gimnasios o abogados
// para que la barra lateral dijera «Servicios» en vez de «Catálogo». Se fue con
// los tipos que las alimentaban: Umbani reparte a domicilio y todo negocio que
// atiende por aquí tiene un catálogo de productos.
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

export type BusinessInfo = {
  id: string; name: string; type: string | null
  slogan: string | null; description: string | null; hours: string | null
  address: string | null; phone: string | null; social: string | null
  payment_methods: string | null; suspended: boolean; bot_active: boolean
  takes_orders: boolean
  /** ¿Puede registrar a sus propios repartidores? (lo enciende el superadmin) */
  flota_propia?: boolean
}

// Pedidos es capacidad propia del negocio (takes_orders), independiente de
// reservas. El flag vivo manda; el tipo solo lo recomienda al alta.
export const isOrderBiz = (takesOrders?: boolean | null) => takesOrders === true

export function useBusinessInfo() {
  return useQuery({
    queryKey: ['business'],
    queryFn: () => api<BusinessInfo>('/api/client/business'),
    staleTime: 5 * 60_000,
  })
}
