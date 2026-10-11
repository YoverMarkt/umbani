import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// `SaleData` y `SaleItemData` vivían aquí para el alta manual de ventas, que
// se retiró el 2026-08-02: hoy toda venta nace de un pedido, una cita o una
// estadía, y las crea PostgreSQL.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')
const getSaleById = async (businessId: string, id: string) => {
  const { data } = await db.from('sales').select('*, sale_items(*)')
    .eq('business_id', businessId).eq('id', id).single()
  return data
}

const getSalesByContact = async (businessId: string, phone: string) => {
  const { data } = await db.from('sales').select('*, sale_items(*)')
    .eq('business_id', businessId).eq('contact_phone', phone)
    .order('sold_at', { ascending: false }).limit(10)
  return data || []
}

const getSaleCustomers = async (businessId: string) => {
  const { data, error } = await db.from('sales').select('contact_phone, sold_at')
    .eq('business_id', businessId).eq('status', 'completada')
  if (error) throw new Error(error.message)
  return data || []
}

const getCustomerSales = async (businessId: string) => {
  const { data, error } = await db.from('sales')
    // ⚠️ `shipping` y `platform_markup` van SÍ O SÍ: alimentan el directorio de
    // clientes, que suma cuánto ha gastado cada uno. Sin ellas `loDelLocal`
    // los leería como 0 y esta pantalla seguiría contando la carrera y la
    // comisión como dinero del local — justo lo que se vino a quitar. Es la
    // única consulta de ventas que enumera columnas en vez de pedir `*`.
    .select('contact_phone, contact_name, total, shipping, platform_markup, sold_at')
    .eq('business_id', businessId).eq('status', 'completada')
  if (error) throw new Error(error.message)
  return data || []
}

const voidSale = async (businessId: string, id: string) => db.from('sales')
  .update({ status: 'anulada' })
  .eq('business_id', businessId).eq('id', id).eq('status', 'completada')

const getSalesWithItems = async (
  businessId: string,
  from?: unknown,
  to?: unknown,
) => {
  let query = db.from('sales').select('*, sale_items(*)')
    .eq('business_id', businessId).eq('status', 'completada')
  if (from) query = query.gte('sold_at', from)
  if (to) query = query.lte('sold_at', to)
  const { data, error } = await query.order('sold_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

/**
 * Umbani anula una venta (2026-10-11): las de la app solo puede anularlas
 * Umbani, con motivo, y queda en el registro de dinero con quién fue. Por el
 * número del pedido en su local, que es como lo dice el dueño o el cliente.
 */
const voidSaleByPlatform = async (businessId: string, orderNumber: number, motivo: string) => {
  const { data, error } = await db.rpc('anular_venta_por_umbani', {
    p_business_id: businessId, p_order_number: orderNumber, p_motivo: motivo,
  })
  if (error) throw new Error(error.message)
  return (data || {}) as { result?: string; numero?: number; total?: number }
}

export = {
  getSaleById,
  getSalesByContact,
  getSaleCustomers,
  getCustomerSales,
  voidSale,
  voidSaleByPlatform,
  getSalesWithItems,
}
