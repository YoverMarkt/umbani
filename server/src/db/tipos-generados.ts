// ═══════════════════════════════════════════════════════════════════════════
// TIPOS GENERADOS DESDE LA BASE — NO SE EDITA A MANO
// ═══════════════════════════════════════════════════════════════════════════
//
// Los escribe la CLI de Supabase leyendo el esquema REAL, no una copia:
//
//   npm run tipos:generar -w @botpanel/server
//
// ⚠️ Cierra la familia del incidente del 2026-08-02: 115 `as` en la capa de
// datos que el compilador NO comprobaba, porque afirmar un tipo no es
// verificarlo. Destapó cuatro bugs reales.
//
// ⚠️ Generarlos no basta: sin `SupabaseClient<Database>` en cada repositorio,
// esto es decoración. `SupabaseClient` a secas es `SupabaseClient<any>`.
//
// ⚠️ Si al regenerar salen cambios que no esperabas, NO los edites: mira qué
// cambió en la base. Este archivo es el reflejo, no la fuente.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      ai_gaps: {
        Row: {
          business_id: string
          contact_phone: string | null
          created_at: string | null
          id: string
          question: string
          reason: string | null
        }
        Insert: {
          business_id: string
          contact_phone?: string | null
          created_at?: string | null
          id?: string
          question: string
          reason?: string | null
        }
        Update: {
          business_id?: string
          contact_phone?: string | null
          created_at?: string | null
          id?: string
          question?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_gaps_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      app_login_codes: {
        Row: {
          code: string
          created_at: string
          expires_at: string
          id: string
          phone: string | null
          used_at: string | null
          verified_at: string | null
        }
        Insert: {
          code: string
          created_at?: string
          expires_at: string
          id?: string
          phone?: string | null
          used_at?: string | null
          verified_at?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          expires_at?: string
          id?: string
          phone?: string | null
          used_at?: string | null
          verified_at?: string | null
        }
        Relationships: []
      }
      billing: {
        Row: {
          amount: number | null
          business_id: string
          commission_adjustment: number
          commission_amount: number
          commission_closed_at: string | null
          commission_orders: number
          created_at: string | null
          currency: string | null
          id: string
          notes: string | null
          paid_at: string | null
          period_end: string | null
          period_start: string | null
          status: string | null
        }
        Insert: {
          amount?: number | null
          business_id: string
          commission_adjustment?: number
          commission_amount?: number
          commission_closed_at?: string | null
          commission_orders?: number
          created_at?: string | null
          currency?: string | null
          id?: string
          notes?: string | null
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          status?: string | null
        }
        Update: {
          amount?: number | null
          business_id?: string
          commission_adjustment?: number
          commission_amount?: number
          commission_closed_at?: string | null
          commission_orders?: number
          created_at?: string | null
          currency?: string | null
          id?: string
          notes?: string | null
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_adjustments: {
        Row: {
          amount: number
          billing_id: string | null
          business_id: string
          created_at: string
          id: string
          reason: string
          source_period: string
        }
        Insert: {
          amount: number
          billing_id?: string | null
          business_id: string
          created_at?: string
          id?: string
          reason: string
          source_period: string
        }
        Update: {
          amount?: number
          billing_id?: string | null
          business_id?: string
          created_at?: string
          id?: string
          reason?: string
          source_period?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_adjustments_billing_fkey"
            columns: ["billing_id", "business_id"]
            isOneToOne: false
            referencedRelation: "billing"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "billing_adjustments_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_month_claims: {
        Row: {
          billing_id: string | null
          business_id: string
          claimed_at: string
          period_start: string
        }
        Insert: {
          billing_id?: string | null
          business_id: string
          claimed_at?: string
          period_start: string
        }
        Update: {
          billing_id?: string | null
          business_id?: string
          claimed_at?: string
          period_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_month_claims_billing_id_fkey"
            columns: ["billing_id"]
            isOneToOne: false
            referencedRelation: "billing"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_month_claims_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      business_bank_accounts: {
        Row: {
          account_number: string
          account_type: string
          active: boolean
          bank_name: string
          business_id: string
          created_at: string
          holder_id: string | null
          holder_name: string
          id: string
          instructions: string | null
          updated_at: string
        }
        Insert: {
          account_number: string
          account_type?: string
          active?: boolean
          bank_name: string
          business_id: string
          created_at?: string
          holder_id?: string | null
          holder_name: string
          id?: string
          instructions?: string | null
          updated_at?: string
        }
        Update: {
          account_number?: string
          account_type?: string
          active?: boolean
          bank_name?: string
          business_id?: string
          created_at?: string
          holder_id?: string | null
          holder_name?: string
          id?: string
          instructions?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_bank_accounts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      business_channel_identifiers: {
        Row: {
          business_id: string
          canonical_identifier: string
          created_at: string
          id: string
          identifier_type: string
          provider: string
        }
        Insert: {
          business_id: string
          canonical_identifier: string
          created_at?: string
          id?: string
          identifier_type: string
          provider: string
        }
        Update: {
          business_id?: string
          canonical_identifier?: string
          created_at?: string
          id?: string
          identifier_type?: string
          provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_channel_identifiers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      business_customers: {
        Row: {
          blocked_at: string | null
          blocked_notified_at: string | null
          blocked_until: string | null
          business_id: string
          created_at: string
          customer_id: string
          display_name: string | null
          first_order_at: string | null
          id: string
          last_order_at: string | null
          last_reply_message_id: string | null
          marketing_consent: boolean
          muted_until: string | null
          notes: string | null
          rejected_receipts: number
          reply_count: number
          reply_window_start: string | null
          storefront_link_sent_at: string | null
          total_orders: number
          total_spent: number
          unpaid_expiries: number
          updated_at: string
        }
        Insert: {
          blocked_at?: string | null
          blocked_notified_at?: string | null
          blocked_until?: string | null
          business_id: string
          created_at?: string
          customer_id: string
          display_name?: string | null
          first_order_at?: string | null
          id?: string
          last_order_at?: string | null
          last_reply_message_id?: string | null
          marketing_consent?: boolean
          muted_until?: string | null
          notes?: string | null
          rejected_receipts?: number
          reply_count?: number
          reply_window_start?: string | null
          storefront_link_sent_at?: string | null
          total_orders?: number
          total_spent?: number
          unpaid_expiries?: number
          updated_at?: string
        }
        Update: {
          blocked_at?: string | null
          blocked_notified_at?: string | null
          blocked_until?: string | null
          business_id?: string
          created_at?: string
          customer_id?: string
          display_name?: string | null
          first_order_at?: string | null
          id?: string
          last_order_at?: string | null
          last_reply_message_id?: string | null
          marketing_consent?: boolean
          muted_until?: string | null
          notes?: string | null
          rejected_receipts?: number
          reply_count?: number
          reply_window_start?: string | null
          storefront_link_sent_at?: string | null
          total_orders?: number
          total_spent?: number
          unpaid_expiries?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_customers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_customers_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      business_families: {
        Row: {
          code: string
          created_at: string
          label: string
          sort: number
        }
        Insert: {
          code: string
          created_at?: string
          label: string
          sort?: number
        }
        Update: {
          code?: string
          created_at?: string
          label?: string
          sort?: number
        }
        Relationships: []
      }
      business_marketplace_categories: {
        Row: {
          business_id: string
          category_id: string
          created_at: string
          principal: boolean
        }
        Insert: {
          business_id: string
          category_id: string
          created_at?: string
          principal?: boolean
        }
        Update: {
          business_id?: string
          category_id?: string
          created_at?: string
          principal?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "business_marketplace_categories_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_marketplace_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "marketplace_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      business_payment_methods: {
        Row: {
          business_id: string
          enabled: boolean
          method_code: string
          sort: number
          updated_at: string
        }
        Insert: {
          business_id: string
          enabled?: boolean
          method_code: string
          sort?: number
          updated_at?: string
        }
        Update: {
          business_id?: string
          enabled?: boolean
          method_code?: string
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_payment_methods_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_payment_methods_method_code_fkey"
            columns: ["method_code"]
            isOneToOne: false
            referencedRelation: "payment_methods"
            referencedColumns: ["code"]
          },
        ]
      }
      business_schedule: {
        Row: {
          business_id: string
          close_time: string
          day_of_week: number
          id: string
          is_24h: boolean
          is_active: boolean | null
          open_time: string
          slot_duration: number
        }
        Insert: {
          business_id: string
          close_time?: string
          day_of_week: number
          id?: string
          is_24h?: boolean
          is_active?: boolean | null
          open_time?: string
          slot_duration?: number
        }
        Update: {
          business_id?: string
          close_time?: string
          day_of_week?: number
          id?: string
          is_24h?: boolean
          is_active?: boolean | null
          open_time?: string
          slot_duration?: number
        }
        Relationships: [
          {
            foreignKeyName: "business_schedule_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      business_type_families: {
        Row: {
          business_type: string
          family_code: string
          updated_at: string
        }
        Insert: {
          business_type: string
          family_code: string
          updated_at?: string
        }
        Update: {
          business_type?: string
          family_code?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_type_families_family_code_fkey"
            columns: ["family_code"]
            isOneToOne: false
            referencedRelation: "business_families"
            referencedColumns: ["code"]
          },
        ]
      }
      businesses: {
        Row: {
          active: boolean | null
          address: string | null
          ai_provider: string | null
          block_minutes: number
          bot_active: boolean | null
          brand_color: string | null
          calcom_link: string | null
          card_mode: string | null
          chat_mode: string
          cover_url: string | null
          created_at: string | null
          delivery_by: string
          delivery_extra_minutes: number
          delivery_fee: number
          description: string | null
          hours: string | null
          id: string
          is_demo: boolean
          last_order_number: number
          latitude: number | null
          logo_url: string | null
          longitude: number | null
          max_orders_per_hour: number
          meta_phone_id: string | null
          meta_token: string | null
          min_order_amount: number
          monthly_contact_limit: number | null
          monthly_outbound_message_limit: number | null
          monthly_rate: number | null
          name: string
          notes: string | null
          notify_owner_whatsapp: boolean
          own_fleet: boolean
          owner_phone: string | null
          payment_methods: string | null
          payment_window_minutes: number
          phone: string | null
          plan: string | null
          plan_expires_at: string | null
          prep_time_minutes: number
          slogan: string | null
          slug: string
          social: string | null
          storefront_enabled: boolean
          suspended: boolean | null
          suspension_reason: string | null
          takes_orders: boolean
          telegram_bot_token: string | null
          type: string | null
          whatsapp_number: string | null
          whatsapp_provider: string | null
          ycloud_api_key: string | null
          ycloud_number: string | null
          ycloud_webhook_endpoint_id: string | null
          ycloud_webhook_secret: string | null
        }
        Insert: {
          active?: boolean | null
          address?: string | null
          ai_provider?: string | null
          block_minutes?: number
          bot_active?: boolean | null
          brand_color?: string | null
          calcom_link?: string | null
          card_mode?: string | null
          chat_mode?: string
          cover_url?: string | null
          created_at?: string | null
          delivery_by?: string
          delivery_extra_minutes?: number
          delivery_fee?: number
          description?: string | null
          hours?: string | null
          id?: string
          is_demo?: boolean
          last_order_number?: number
          latitude?: number | null
          logo_url?: string | null
          longitude?: number | null
          max_orders_per_hour?: number
          meta_phone_id?: string | null
          meta_token?: string | null
          min_order_amount?: number
          monthly_contact_limit?: number | null
          monthly_outbound_message_limit?: number | null
          monthly_rate?: number | null
          name: string
          notes?: string | null
          notify_owner_whatsapp?: boolean
          own_fleet?: boolean
          owner_phone?: string | null
          payment_methods?: string | null
          payment_window_minutes?: number
          phone?: string | null
          plan?: string | null
          plan_expires_at?: string | null
          prep_time_minutes?: number
          slogan?: string | null
          slug: string
          social?: string | null
          storefront_enabled?: boolean
          suspended?: boolean | null
          suspension_reason?: string | null
          takes_orders?: boolean
          telegram_bot_token?: string | null
          type?: string | null
          whatsapp_number?: string | null
          whatsapp_provider?: string | null
          ycloud_api_key?: string | null
          ycloud_number?: string | null
          ycloud_webhook_endpoint_id?: string | null
          ycloud_webhook_secret?: string | null
        }
        Update: {
          active?: boolean | null
          address?: string | null
          ai_provider?: string | null
          block_minutes?: number
          bot_active?: boolean | null
          brand_color?: string | null
          calcom_link?: string | null
          card_mode?: string | null
          chat_mode?: string
          cover_url?: string | null
          created_at?: string | null
          delivery_by?: string
          delivery_extra_minutes?: number
          delivery_fee?: number
          description?: string | null
          hours?: string | null
          id?: string
          is_demo?: boolean
          last_order_number?: number
          latitude?: number | null
          logo_url?: string | null
          longitude?: number | null
          max_orders_per_hour?: number
          meta_phone_id?: string | null
          meta_token?: string | null
          min_order_amount?: number
          monthly_contact_limit?: number | null
          monthly_outbound_message_limit?: number | null
          monthly_rate?: number | null
          name?: string
          notes?: string | null
          notify_owner_whatsapp?: boolean
          own_fleet?: boolean
          owner_phone?: string | null
          payment_methods?: string | null
          payment_window_minutes?: number
          phone?: string | null
          plan?: string | null
          plan_expires_at?: string | null
          prep_time_minutes?: number
          slogan?: string | null
          slug?: string
          social?: string | null
          storefront_enabled?: boolean
          suspended?: boolean | null
          suspension_reason?: string | null
          takes_orders?: boolean
          telegram_bot_token?: string | null
          type?: string | null
          whatsapp_number?: string | null
          whatsapp_provider?: string | null
          ycloud_api_key?: string | null
          ycloud_number?: string | null
          ycloud_webhook_endpoint_id?: string | null
          ycloud_webhook_secret?: string | null
        }
        Relationships: []
      }
      client_users: {
        Row: {
          business_id: string
          created_at: string | null
          email: string
          id: string
          name: string | null
          password_hash: string
          permissions: Json | null
          role: string
        }
        Insert: {
          business_id: string
          created_at?: string | null
          email: string
          id?: string
          name?: string | null
          password_hash: string
          permissions?: Json | null
          role?: string
        }
        Update: {
          business_id?: string
          created_at?: string | null
          email?: string
          id?: string
          name?: string | null
          password_hash?: string
          permissions?: Json | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_users_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_history: {
        Row: {
          business_id: string
          contact_phone: string
          content: string
          created_at: string | null
          id: string
          role: string | null
        }
        Insert: {
          business_id: string
          contact_phone: string
          content: string
          created_at?: string | null
          id?: string
          role?: string | null
        }
        Update: {
          business_id?: string
          contact_phone?: string
          content?: string
          created_at?: string | null
          id?: string
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversation_history_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_sessions: {
        Row: {
          business_id: string
          closed_sale_at: string | null
          contact_name: string | null
          contact_phone: string
          id: string
          last_message: string | null
          last_message_at: string | null
          manual_mode: boolean | null
          tags: Json | null
          unread_owner: boolean | null
        }
        Insert: {
          business_id: string
          closed_sale_at?: string | null
          contact_name?: string | null
          contact_phone: string
          id?: string
          last_message?: string | null
          last_message_at?: string | null
          manual_mode?: boolean | null
          tags?: Json | null
          unread_owner?: boolean | null
        }
        Update: {
          business_id?: string
          closed_sale_at?: string | null
          contact_name?: string | null
          contact_phone?: string
          id?: string
          last_message?: string | null
          last_message_at?: string | null
          manual_mode?: boolean | null
          tags?: Json | null
          unread_owner?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "conversation_sessions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_tags: {
        Row: {
          business_id: string
          color: string | null
          created_at: string | null
          id: string
          name: string
        }
        Insert: {
          business_id: string
          color?: string | null
          created_at?: string | null
          id?: string
          name: string
        }
        Update: {
          business_id?: string
          color?: string | null
          created_at?: string | null
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_tags_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      courier_settlements: {
        Row: {
          arrastre_cents: number
          courier_id: string
          created_at: string
          derecho_cents: number
          en_mano_cents: number
          id: string
          neto_cents: number
          orders_count: number
          paid_at: string | null
          period_end: string
          period_start: string
          reference: string | null
          status: string
          updated_at: string
        }
        Insert: {
          arrastre_cents?: number
          courier_id: string
          created_at?: string
          derecho_cents?: number
          en_mano_cents?: number
          id?: string
          neto_cents: number
          orders_count?: number
          paid_at?: string | null
          period_end: string
          period_start: string
          reference?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          arrastre_cents?: number
          courier_id?: string
          created_at?: string
          derecho_cents?: number
          en_mano_cents?: number
          id?: string
          neto_cents?: number
          orders_count?: number
          paid_at?: string | null
          period_end?: string
          period_start?: string
          reference?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "courier_settlements_courier_id_fkey"
            columns: ["courier_id"]
            isOneToOne: false
            referencedRelation: "couriers"
            referencedColumns: ["id"]
          },
        ]
      }
      couriers: {
        Row: {
          active: boolean
          available: boolean
          cash_limit_cents: number
          created_at: string
          fleet_business_id: string | null
          id: string
          name: string
          phone: string
          updated_at: string
          vehicle: string | null
        }
        Insert: {
          active?: boolean
          available?: boolean
          cash_limit_cents?: number
          created_at?: string
          fleet_business_id?: string | null
          id?: string
          name: string
          phone: string
          updated_at?: string
          vehicle?: string | null
        }
        Update: {
          active?: boolean
          available?: boolean
          cash_limit_cents?: number
          created_at?: string
          fleet_business_id?: string | null
          id?: string
          name?: string
          phone?: string
          updated_at?: string
          vehicle?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "couriers_fleet_business_id_fkey"
            columns: ["fleet_business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_addresses: {
        Row: {
          accuracy_m: number | null
          active: boolean
          address: string
          building_type: string | null
          business_id: string
          courier_notes: string | null
          created_at: string
          customer_id: string
          id: string
          is_default: boolean
          label: string
          latitude: number | null
          longitude: number | null
          reference: string | null
          updated_at: string
        }
        Insert: {
          accuracy_m?: number | null
          active?: boolean
          address: string
          building_type?: string | null
          business_id: string
          courier_notes?: string | null
          created_at?: string
          customer_id: string
          id?: string
          is_default?: boolean
          label?: string
          latitude?: number | null
          longitude?: number | null
          reference?: string | null
          updated_at?: string
        }
        Update: {
          accuracy_m?: number | null
          active?: boolean
          address?: string
          building_type?: string | null
          business_id?: string
          courier_notes?: string | null
          created_at?: string
          customer_id?: string
          id?: string
          is_default?: boolean
          label?: string
          latitude?: number | null
          longitude?: number | null
          reference?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_addresses_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_addresses_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          app_sessions_valid_after: string | null
          blocked_at: string | null
          blocked_kind: string | null
          blocked_reason: string | null
          blocked_until: string | null
          created_at: string
          id: string
          insult_warned_at: string | null
          name: string | null
          phone: string
          unblock_notice_pending: boolean
          updated_at: string
        }
        Insert: {
          app_sessions_valid_after?: string | null
          blocked_at?: string | null
          blocked_kind?: string | null
          blocked_reason?: string | null
          blocked_until?: string | null
          created_at?: string
          id?: string
          insult_warned_at?: string | null
          name?: string | null
          phone: string
          unblock_notice_pending?: boolean
          updated_at?: string
        }
        Update: {
          app_sessions_valid_after?: string | null
          blocked_at?: string | null
          blocked_kind?: string | null
          blocked_reason?: string | null
          blocked_until?: string | null
          created_at?: string
          id?: string
          insult_warned_at?: string | null
          name?: string | null
          phone?: string
          unblock_notice_pending?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      marketplace_categories: {
        Row: {
          active: boolean
          code: string
          emoji: string | null
          id: string
          label: string
          sort: number
        }
        Insert: {
          active?: boolean
          code: string
          emoji?: string | null
          id?: string
          label: string
          sort?: number
        }
        Update: {
          active?: boolean
          code?: string
          emoji?: string | null
          id?: string
          label?: string
          sort?: number
        }
        Relationships: []
      }
      marketplace_category_types: {
        Row: {
          business_type: string
          category_id: string
        }
        Insert: {
          business_type: string
          category_id: string
        }
        Update: {
          business_type?: string
          category_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_category_types_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "marketplace_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      marketplace_conversations: {
        Row: {
          created_at: string
          current_state: string
          customer_id: string
          expires_at: string | null
          flow_state: Json | null
          id: string
          last_message_at: string
          last_reply_at: string | null
          last_reply_hash: string | null
          last_reply_message_id: string | null
          menu_mark: string | null
          menu_paused_until: string | null
          muted_until: string | null
          reply_count: number
          reply_window_start: string | null
          selected_business_id: string | null
          shopping_locked: boolean
          stale_tap_warned_at: string | null
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          current_state?: string
          customer_id: string
          expires_at?: string | null
          flow_state?: Json | null
          id?: string
          last_message_at?: string
          last_reply_at?: string | null
          last_reply_hash?: string | null
          last_reply_message_id?: string | null
          menu_mark?: string | null
          menu_paused_until?: string | null
          muted_until?: string | null
          reply_count?: number
          reply_window_start?: string | null
          selected_business_id?: string | null
          shopping_locked?: boolean
          stale_tap_warned_at?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          current_state?: string
          customer_id?: string
          expires_at?: string | null
          flow_state?: Json | null
          id?: string
          last_message_at?: string
          last_reply_at?: string | null
          last_reply_hash?: string | null
          last_reply_message_id?: string | null
          menu_mark?: string | null
          menu_paused_until?: string | null
          muted_until?: string | null
          reply_count?: number
          reply_window_start?: string | null
          selected_business_id?: string | null
          shopping_locked?: boolean
          stale_tap_warned_at?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_conversations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketplace_conversations_selected_business_id_fkey"
            columns: ["selected_business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      marketplace_events: {
        Row: {
          business_id: string | null
          category_code: string | null
          consulta: string | null
          created_at: string
          customer_id: string | null
          id: string
          resultados: number | null
          tipo: string
        }
        Insert: {
          business_id?: string | null
          category_code?: string | null
          consulta?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          resultados?: number | null
          tipo: string
        }
        Update: {
          business_id?: string | null
          category_code?: string | null
          consulta?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          resultados?: number | null
          tipo?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketplace_events_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      marketplace_search_aliases: {
        Row: {
          category_code: string
          created_at: string
          term: string
        }
        Insert: {
          category_code: string
          created_at?: string
          term: string
        }
        Update: {
          category_code?: string
          created_at?: string
          term?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketplace_search_aliases_category_code_fkey"
            columns: ["category_code"]
            isOneToOne: false
            referencedRelation: "marketplace_categories"
            referencedColumns: ["code"]
          },
        ]
      }
      menu_modifiers: {
        Row: {
          active: boolean
          business_id: string
          category_tag: string | null
          created_at: string
          description: string | null
          group_label: string
          id: string
          max_selectable: number | null
          name: string
          price_delta: number
          product_id: string | null
          sort: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          category_tag?: string | null
          created_at?: string
          description?: string | null
          group_label?: string
          id?: string
          max_selectable?: number | null
          name: string
          price_delta?: number
          product_id?: string | null
          sort?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          category_tag?: string | null
          created_at?: string
          description?: string | null
          group_label?: string
          id?: string
          max_selectable?: number | null
          name?: string
          price_delta?: number
          product_id?: string | null
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_modifiers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_modifiers_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      message_usage_events: {
        Row: {
          business_id: string
          contact_key_hash: string
          created_at: string
          direction: string
          id: string
          message_type: string
          occurred_at: string
          provider: string
          source_key: string
          source_kind: string
        }
        Insert: {
          business_id: string
          contact_key_hash: string
          created_at?: string
          direction: string
          id?: string
          message_type: string
          occurred_at?: string
          provider: string
          source_key: string
          source_kind: string
        }
        Update: {
          business_id?: string
          contact_key_hash?: string
          created_at?: string
          direction?: string
          id?: string
          message_type?: string
          occurred_at?: string
          provider?: string
          source_key?: string
          source_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_usage_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      message_usage_migration_state: {
        Row: {
          completed_at: string
          key: string
        }
        Insert: {
          completed_at?: string
          key: string
        }
        Update: {
          completed_at?: string
          key?: string
        }
        Relationships: []
      }
      money_audit_log: {
        Row: {
          action: string
          actor: string
          business_id: string | null
          business_name: string | null
          created_at: string
          detail: Json
          id: number
          target_id: string | null
          target_table: string
        }
        Insert: {
          action: string
          actor: string
          business_id?: string | null
          business_name?: string | null
          created_at?: string
          detail?: Json
          id?: never
          target_id?: string | null
          target_table: string
        }
        Update: {
          action?: string
          actor?: string
          business_id?: string | null
          business_name?: string | null
          created_at?: string
          detail?: Json
          id?: never
          target_id?: string | null
          target_table?: string
        }
        Relationships: []
      }
      option_groups: {
        Row: {
          active: boolean
          business_id: string
          category_id: string | null
          created_at: string
          description: string | null
          free_selections: number
          id: string
          is_meal_part: boolean
          loose_price: number | null
          max_selectable: number
          max_total_quantity: number | null
          min_selectable: number
          name: string
          option_template_id: string | null
          pricing_strategy: string
          product_id: string | null
          required: boolean
          selection_type: string
          sort: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          category_id?: string | null
          created_at?: string
          description?: string | null
          free_selections?: number
          id?: string
          is_meal_part?: boolean
          loose_price?: number | null
          max_selectable?: number
          max_total_quantity?: number | null
          min_selectable?: number
          name: string
          option_template_id?: string | null
          pricing_strategy?: string
          product_id?: string | null
          required?: boolean
          selection_type?: string
          sort?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          category_id?: string | null
          created_at?: string
          description?: string | null
          free_selections?: number
          id?: string
          is_meal_part?: boolean
          loose_price?: number | null
          max_selectable?: number
          max_total_quantity?: number | null
          min_selectable?: number
          name?: string
          option_template_id?: string | null
          pricing_strategy?: string
          product_id?: string | null
          required?: boolean
          selection_type?: string
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_option_groups_categoria_del_negocio"
            columns: ["category_id", "business_id"]
            isOneToOne: false
            referencedRelation: "product_categories"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fk_option_groups_plantilla_del_negocio"
            columns: ["option_template_id", "business_id"]
            isOneToOne: false
            referencedRelation: "option_templates"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fk_option_groups_producto_del_negocio"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "option_groups_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      option_template_items: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          default_selected: boolean
          description: string | null
          id: string
          image_public_id: string | null
          image_url: string | null
          name: string
          option_template_id: string
          price_adjustment: number
          references_product_id: string | null
          sort: number
          stock: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          default_selected?: boolean
          description?: string | null
          id?: string
          image_public_id?: string | null
          image_url?: string | null
          name: string
          option_template_id: string
          price_adjustment?: number
          references_product_id?: string | null
          sort?: number
          stock?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          default_selected?: boolean
          description?: string | null
          id?: string
          image_public_id?: string | null
          image_url?: string | null
          name?: string
          option_template_id?: string
          price_adjustment?: number
          references_product_id?: string | null
          sort?: number
          stock?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_option_template_items_plantilla_del_negocio"
            columns: ["option_template_id", "business_id"]
            isOneToOne: false
            referencedRelation: "option_templates"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fk_option_template_items_producto_del_negocio"
            columns: ["references_product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "option_template_items_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      option_templates: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "option_templates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      options: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          default_selected: boolean
          description: string | null
          id: string
          image_public_id: string | null
          image_url: string | null
          name: string
          option_group_id: string
          option_template_item_id: string | null
          price_adjustment: number
          references_product_id: string | null
          sort: number
          stock: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          default_selected?: boolean
          description?: string | null
          id?: string
          image_public_id?: string | null
          image_url?: string | null
          name: string
          option_group_id: string
          option_template_item_id?: string | null
          price_adjustment?: number
          references_product_id?: string | null
          sort?: number
          stock?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          default_selected?: boolean
          description?: string | null
          id?: string
          image_public_id?: string | null
          image_url?: string | null
          name?: string
          option_group_id?: string
          option_template_item_id?: string | null
          price_adjustment?: number
          references_product_id?: string | null
          sort?: number
          stock?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_options_grupo_del_negocio"
            columns: ["option_group_id", "business_id"]
            isOneToOne: false
            referencedRelation: "option_groups"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fk_options_item_de_plantilla_del_negocio"
            columns: ["option_template_item_id", "business_id"]
            isOneToOne: false
            referencedRelation: "option_template_items"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fk_options_producto_del_negocio"
            columns: ["references_product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "options_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      order_events: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          from_status: string | null
          id: string
          note: string | null
          order_id: string
          order_item_id: string | null
          to_status: string
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          from_status?: string | null
          id?: string
          note?: string | null
          order_id: string
          order_item_id?: string | null
          to_status: string
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          from_status?: string | null
          id?: string
          note?: string | null
          order_id?: string
          order_item_id?: string | null
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_order_events_hecho_por"
            columns: ["created_by", "business_id"]
            isOneToOne: false
            referencedRelation: "client_users"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fk_order_events_linea"
            columns: ["order_item_id", "business_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fk_order_events_pedido_del_negocio"
            columns: ["order_id", "business_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "order_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      order_item_options: {
        Row: {
          business_id: string
          created_at: string
          group_sort: number
          id: string
          option_group_id: string | null
          option_group_name: string
          option_id: string | null
          option_name: string
          order_item_id: string
          quantity: number
          total_price_adjustment: number
          unit_price_adjustment: number
        }
        Insert: {
          business_id: string
          created_at?: string
          group_sort?: number
          id?: string
          option_group_id?: string | null
          option_group_name: string
          option_id?: string | null
          option_name: string
          order_item_id: string
          quantity?: number
          total_price_adjustment?: number
          unit_price_adjustment?: number
        }
        Update: {
          business_id?: string
          created_at?: string
          group_sort?: number
          id?: string
          option_group_id?: string | null
          option_group_name?: string
          option_id?: string | null
          option_name?: string
          order_item_id?: string
          quantity?: number
          total_price_adjustment?: number
          unit_price_adjustment?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_order_item_options_item_del_negocio"
            columns: ["order_item_id", "business_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "order_item_options_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          business_id: string
          created_at: string | null
          extras_names: string[]
          id: string
          item_note: string | null
          line_total: number
          order_id: string | null
          prepared_at: string | null
          prepared_by: string | null
          product_id: string | null
          product_name: string
          quantity: number
          unit_price: number
          variant_id: string | null
          variant_name: string | null
        }
        Insert: {
          business_id: string
          created_at?: string | null
          extras_names?: string[]
          id?: string
          item_note?: string | null
          line_total?: number
          order_id?: string | null
          prepared_at?: string | null
          prepared_by?: string | null
          product_id?: string | null
          product_name: string
          quantity?: number
          unit_price?: number
          variant_id?: string | null
          variant_name?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string | null
          extras_names?: string[]
          id?: string
          item_note?: string | null
          line_total?: number
          order_id?: string | null
          prepared_at?: string | null
          prepared_by?: string | null
          product_id?: string | null
          product_name?: string
          quantity?: number
          unit_price?: number
          variant_id?: string | null
          variant_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_order_items_preparado_por"
            columns: ["prepared_by", "business_id"]
            isOneToOne: false
            referencedRelation: "client_users"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "order_items_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      order_ledger: {
        Row: {
          business_id: string
          courier_id: string | null
          courier_settlement_id: string | null
          created_at: string
          en_mano: string
          id: string
          kind: string
          local_cents: number
          order_id: string
          payment_method: string | null
          provider_fee_cents: number
          reparto_cents: number
          reparto_para: string
          retenido: boolean
          retenido_motivo: string | null
          sale_id: string | null
          settlement_id: string | null
          sold_at: string
          total_cents: number
          umbani_cents: number
        }
        Insert: {
          business_id: string
          courier_id?: string | null
          courier_settlement_id?: string | null
          created_at?: string
          en_mano: string
          id?: string
          kind?: string
          local_cents: number
          order_id: string
          payment_method?: string | null
          provider_fee_cents?: number
          reparto_cents: number
          reparto_para?: string
          retenido?: boolean
          retenido_motivo?: string | null
          sale_id?: string | null
          settlement_id?: string | null
          sold_at: string
          total_cents: number
          umbani_cents: number
        }
        Update: {
          business_id?: string
          courier_id?: string | null
          courier_settlement_id?: string | null
          created_at?: string
          en_mano?: string
          id?: string
          kind?: string
          local_cents?: number
          order_id?: string
          payment_method?: string | null
          provider_fee_cents?: number
          reparto_cents?: number
          reparto_para?: string
          retenido?: boolean
          retenido_motivo?: string | null
          sale_id?: string | null
          settlement_id?: string | null
          sold_at?: string
          total_cents?: number
          umbani_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_ledger_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_ledger_courier_fk"
            columns: ["courier_id"]
            isOneToOne: false
            referencedRelation: "couriers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_ledger_courier_settlement_id_fkey"
            columns: ["courier_settlement_id"]
            isOneToOne: false
            referencedRelation: "courier_settlements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_ledger_order_fk"
            columns: ["order_id", "business_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "order_ledger_settlement_fk"
            columns: ["settlement_id", "business_id"]
            isOneToOne: false
            referencedRelation: "settlements"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      orders: {
        Row: {
          address_id: string | null
          business_id: string
          contact_name: string | null
          contact_phone: string
          courier_assigned_at: string | null
          courier_id: string | null
          created_at: string | null
          currency: string
          customer_id: string | null
          customer_notified_at: string | null
          customer_notified_status: string | null
          delivery_accuracy_m: number | null
          delivery_address: string | null
          delivery_building_type: string | null
          delivery_courier_notes: string | null
          delivery_label: string | null
          delivery_latitude: number | null
          delivery_longitude: number | null
          delivery_notes: string | null
          delivery_reference: string | null
          discount: number
          fulfillment: string | null
          id: string
          idempotency_key: string | null
          merchant_subtotal: number | null
          order_number: number | null
          payment_confirmed_at: string | null
          payment_method: string | null
          payment_proof_public_id: string | null
          payment_proof_url: string | null
          platform_markup: number | null
          pricing_rule_id: string | null
          pricing_rule_version: number | null
          scheduled_for: string | null
          service_fee: number
          shipping: number
          source: string
          status: string
          subtotal: number
          total: number
          updated_at: string | null
        }
        Insert: {
          address_id?: string | null
          business_id: string
          contact_name?: string | null
          contact_phone: string
          courier_assigned_at?: string | null
          courier_id?: string | null
          created_at?: string | null
          currency?: string
          customer_id?: string | null
          customer_notified_at?: string | null
          customer_notified_status?: string | null
          delivery_accuracy_m?: number | null
          delivery_address?: string | null
          delivery_building_type?: string | null
          delivery_courier_notes?: string | null
          delivery_label?: string | null
          delivery_latitude?: number | null
          delivery_longitude?: number | null
          delivery_notes?: string | null
          delivery_reference?: string | null
          discount?: number
          fulfillment?: string | null
          id?: string
          idempotency_key?: string | null
          merchant_subtotal?: number | null
          order_number?: number | null
          payment_confirmed_at?: string | null
          payment_method?: string | null
          payment_proof_public_id?: string | null
          payment_proof_url?: string | null
          platform_markup?: number | null
          pricing_rule_id?: string | null
          pricing_rule_version?: number | null
          scheduled_for?: string | null
          service_fee?: number
          shipping?: number
          source?: string
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string | null
        }
        Update: {
          address_id?: string | null
          business_id?: string
          contact_name?: string | null
          contact_phone?: string
          courier_assigned_at?: string | null
          courier_id?: string | null
          created_at?: string | null
          currency?: string
          customer_id?: string | null
          customer_notified_at?: string | null
          customer_notified_status?: string | null
          delivery_accuracy_m?: number | null
          delivery_address?: string | null
          delivery_building_type?: string | null
          delivery_courier_notes?: string | null
          delivery_label?: string | null
          delivery_latitude?: number | null
          delivery_longitude?: number | null
          delivery_notes?: string | null
          delivery_reference?: string | null
          discount?: number
          fulfillment?: string | null
          id?: string
          idempotency_key?: string | null
          merchant_subtotal?: number | null
          order_number?: number | null
          payment_confirmed_at?: string | null
          payment_method?: string | null
          payment_proof_public_id?: string | null
          payment_proof_url?: string | null
          platform_markup?: number | null
          pricing_rule_id?: string | null
          pricing_rule_version?: number | null
          scheduled_for?: string | null
          service_fee?: number
          shipping?: number
          source?: string
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_address_id_fkey"
            columns: ["address_id"]
            isOneToOne: false
            referencedRelation: "customer_addresses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_courier_id_fkey"
            columns: ["courier_id"]
            isOneToOne: false
            referencedRelation: "couriers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      outbox_events: {
        Row: {
          aggregate_id: string
          aggregate_type: string
          attempts: number
          available_at: string
          business_id: string
          completed_at: string | null
          created_at: string
          dead_at: string | null
          event_type: string
          id: string
          last_error: string | null
          lease_owner: string | null
          lease_token: string | null
          leased_until: string | null
          max_attempts: number
          payload: Json
          status: string
          updated_at: string
        }
        Insert: {
          aggregate_id: string
          aggregate_type?: string
          attempts?: number
          available_at?: string
          business_id: string
          completed_at?: string | null
          created_at?: string
          dead_at?: string | null
          event_type: string
          id?: string
          last_error?: string | null
          lease_owner?: string | null
          lease_token?: string | null
          leased_until?: string | null
          max_attempts?: number
          payload: Json
          status?: string
          updated_at?: string
        }
        Update: {
          aggregate_id?: string
          aggregate_type?: string
          attempts?: number
          available_at?: string
          business_id?: string
          completed_at?: string | null
          created_at?: string
          dead_at?: string | null
          event_type?: string
          id?: string
          last_error?: string | null
          lease_owner?: string | null
          lease_token?: string | null
          leased_until?: string | null
          max_attempts?: number
          payload?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outbox_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_methods: {
        Row: {
          available: boolean
          code: string
          created_at: string
          help_text: string | null
          is_prepaid: boolean
          label: string
          requires_proof: boolean
          sort: number
        }
        Insert: {
          available?: boolean
          code: string
          created_at?: string
          help_text?: string | null
          is_prepaid?: boolean
          label: string
          requires_proof?: boolean
          sort?: number
        }
        Update: {
          available?: boolean
          code?: string
          created_at?: string
          help_text?: string | null
          is_prepaid?: boolean
          label?: string
          requires_proof?: boolean
          sort?: number
        }
        Relationships: []
      }
      payment_receipt_audit_logs: {
        Row: {
          action: string
          business_id: string
          created_at: string
          id: string
          metadata: Json | null
          new_status: string | null
          old_status: string | null
          receipt_id: string
          user_id: string | null
        }
        Insert: {
          action: string
          business_id: string
          created_at?: string
          id?: string
          metadata?: Json | null
          new_status?: string | null
          old_status?: string | null
          receipt_id: string
          user_id?: string | null
        }
        Update: {
          action?: string
          business_id?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          new_status?: string | null
          old_status?: string | null
          receipt_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_receipt_audit_logs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_receipt_audit_logs_del_negocio_fkey"
            columns: ["receipt_id", "business_id"]
            isOneToOne: false
            referencedRelation: "payment_receipts"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "payment_receipt_audit_logs_usuario_del_negocio_fkey"
            columns: ["user_id", "business_id"]
            isOneToOne: false
            referencedRelation: "client_users"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      payment_receipt_risk_flags: {
        Row: {
          business_id: string
          created_at: string
          description: string | null
          flag_type: string
          id: string
          points: number
          receipt_id: string
          severity: string
        }
        Insert: {
          business_id: string
          created_at?: string
          description?: string | null
          flag_type: string
          id?: string
          points?: number
          receipt_id: string
          severity?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          description?: string | null
          flag_type?: string
          id?: string
          points?: number
          receipt_id?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_receipt_risk_flags_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_receipt_risk_flags_del_negocio_fkey"
            columns: ["receipt_id", "business_id"]
            isOneToOne: false
            referencedRelation: "payment_receipts"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      payment_receipts: {
        Row: {
          amount: number | null
          analysis_json: Json | null
          bank_name: string | null
          beneficiary_name: string | null
          business_id: string
          created_at: string
          currency: string | null
          destination_account: string | null
          file_public_id: string | null
          file_size: number | null
          file_url: string
          id: string
          mime_type: string | null
          ocr_raw_text: string | null
          order_id: string
          perceptual_hash: string | null
          reference_number: string | null
          risk_level: string | null
          risk_score: number | null
          sender_name: string | null
          sha256_hash: string
          status: string
          transaction_date: string | null
          transaction_number: string | null
          transaction_time: string | null
          updated_at: string
        }
        Insert: {
          amount?: number | null
          analysis_json?: Json | null
          bank_name?: string | null
          beneficiary_name?: string | null
          business_id: string
          created_at?: string
          currency?: string | null
          destination_account?: string | null
          file_public_id?: string | null
          file_size?: number | null
          file_url: string
          id?: string
          mime_type?: string | null
          ocr_raw_text?: string | null
          order_id: string
          perceptual_hash?: string | null
          reference_number?: string | null
          risk_level?: string | null
          risk_score?: number | null
          sender_name?: string | null
          sha256_hash: string
          status?: string
          transaction_date?: string | null
          transaction_number?: string | null
          transaction_time?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number | null
          analysis_json?: Json | null
          bank_name?: string | null
          beneficiary_name?: string | null
          business_id?: string
          created_at?: string
          currency?: string | null
          destination_account?: string | null
          file_public_id?: string | null
          file_size?: number | null
          file_url?: string
          id?: string
          mime_type?: string | null
          ocr_raw_text?: string | null
          order_id?: string
          perceptual_hash?: string | null
          reference_number?: string | null
          risk_level?: string | null
          risk_score?: number | null
          sender_name?: string | null
          sha256_hash?: string
          status?: string
          transaction_date?: string | null
          transaction_number?: string | null
          transaction_time?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_receipts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_receipts_pedido_del_negocio_fkey"
            columns: ["order_id", "business_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_cents: number
          approved_at: string | null
          authorization_code: string | null
          business_id: string
          captured_cents: number | null
          card_brand: string | null
          card_last_digits: string | null
          client_transaction_id: string
          confirm_attempts: number
          created_at: string
          currency: string
          environment: string
          id: string
          method: string
          next_check_at: string
          order_id: string
          provider: string
          provider_transaction_id: string | null
          reconciled_at: string | null
          reconciliation: string | null
          reconciliation_detail: string | null
          reversed_at: string | null
          status: string
          status_detail: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          approved_at?: string | null
          authorization_code?: string | null
          business_id: string
          captured_cents?: number | null
          card_brand?: string | null
          card_last_digits?: string | null
          client_transaction_id: string
          confirm_attempts?: number
          created_at?: string
          currency?: string
          environment: string
          id?: string
          method?: string
          next_check_at?: string
          order_id: string
          provider?: string
          provider_transaction_id?: string | null
          reconciled_at?: string | null
          reconciliation?: string | null
          reconciliation_detail?: string | null
          reversed_at?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          approved_at?: string | null
          authorization_code?: string | null
          business_id?: string
          captured_cents?: number | null
          card_brand?: string | null
          card_last_digits?: string | null
          client_transaction_id?: string
          confirm_attempts?: number
          created_at?: string
          currency?: string
          environment?: string
          id?: string
          method?: string
          next_check_at?: string
          order_id?: string
          provider?: string
          provider_transaction_id?: string | null
          reconciled_at?: string | null
          reconciliation?: string | null
          reconciliation_detail?: string | null
          reversed_at?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_order_fk"
            columns: ["order_id", "business_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "business_id"]
          },
        ]
      }
      platform_errors: {
        Row: {
          business_id: string | null
          category: string
          code: string | null
          context: Json
          fingerprint: string
          first_seen_at: string
          id: string
          last_seen_at: string
          message: string
          occurrences: number
        }
        Insert: {
          business_id?: string | null
          category: string
          code?: string | null
          context?: Json
          fingerprint: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          message: string
          occurrences?: number
        }
        Update: {
          business_id?: string | null
          category?: string
          code?: string | null
          context?: Json
          fingerprint?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          message?: string
          occurrences?: number
        }
        Relationships: [
          {
            foreignKeyName: "platform_errors_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_rules: {
        Row: {
          business_id: string | null
          created_at: string
          effective_from: string
          effective_until: string | null
          fixed_amount: number | null
          id: string
          markup_mode: string
          max_amount: number | null
          min_amount: number | null
          notes: string | null
          percentage: number | null
          scope: string
          status: string
          strategy: string
          target_name: string | null
          tiers: Json | null
          updated_at: string
          version: number
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          effective_from?: string
          effective_until?: string | null
          fixed_amount?: number | null
          id?: string
          markup_mode?: string
          max_amount?: number | null
          min_amount?: number | null
          notes?: string | null
          percentage?: number | null
          scope: string
          status?: string
          strategy: string
          target_name?: string | null
          tiers?: Json | null
          updated_at?: string
          version?: number
        }
        Update: {
          business_id?: string | null
          created_at?: string
          effective_from?: string
          effective_until?: string | null
          fixed_amount?: number | null
          id?: string
          markup_mode?: string
          max_amount?: number | null
          min_amount?: number | null
          notes?: string | null
          percentage?: number | null
          scope?: string
          status?: string
          strategy?: string
          target_name?: string | null
          tiers?: Json | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "pricing_rules_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      product_categories: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          description: string | null
          id: string
          image_public_id: string | null
          image_url: string | null
          name: string
          sort: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          description?: string | null
          id?: string
          image_public_id?: string | null
          image_url?: string | null
          name: string
          sort?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          description?: string | null
          id?: string
          image_public_id?: string | null
          image_url?: string | null
          name?: string
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_categories_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      product_consultations: {
        Row: {
          business_id: string
          created_at: string | null
          id: string
          product_id: string | null
        }
        Insert: {
          business_id: string
          created_at?: string | null
          id?: string
          product_id?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string | null
          id?: string
          product_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_consultations_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_consultations_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_recommendations: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          id: string
          recommended_product_id: string
          section: string
          sort: number
          source_category_id: string | null
          source_product_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          id?: string
          recommended_product_id: string
          section?: string
          sort?: number
          source_category_id?: string | null
          source_product_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          id?: string
          recommended_product_id?: string
          section?: string
          sort?: number
          source_category_id?: string | null
          source_product_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_recomendaciones_categoria_origen"
            columns: ["source_category_id", "business_id"]
            isOneToOne: false
            referencedRelation: "product_categories"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fk_recomendaciones_producto_ofrecido"
            columns: ["recommended_product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "fk_recomendaciones_producto_origen"
            columns: ["source_product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "product_recommendations_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      product_variants: {
        Row: {
          active: boolean
          business_id: string
          created_at: string
          id: string
          name: string
          price: number
          price_sale: number | null
          product_id: string
          sort: number
          stock: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          business_id: string
          created_at?: string
          id?: string
          name: string
          price: number
          price_sale?: number | null
          product_id: string
          sort?: number
          stock?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          business_id?: string
          created_at?: string
          id?: string
          name?: string
          price?: number
          price_sale?: number | null
          product_id?: string
          sort?: number
          stock?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_product_variants_producto_del_negocio"
            columns: ["product_id", "business_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "product_variants_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          active: boolean | null
          available_days: number[] | null
          available_from: string | null
          available_until: string | null
          brand: string | null
          business_id: string
          category_id: string | null
          created_at: string | null
          description: string | null
          duration_minutes: number | null
          embedding: string | null
          external_sku: string | null
          featured: boolean
          id: string
          image_public_id: string | null
          image_url: string | null
          max_quantity: number
          min_quantity: number
          name: string
          popular: boolean
          preparation_time: number | null
          price: number
          price_sale: number | null
          product_type: string
          sort: number
          stock: string | null
          stock_control_enabled: boolean
          stock_quantity: number | null
          tags: string[] | null
          updated_at: string | null
          video_public_id: string | null
          video_url: string | null
        }
        Insert: {
          active?: boolean | null
          available_days?: number[] | null
          available_from?: string | null
          available_until?: string | null
          brand?: string | null
          business_id: string
          category_id?: string | null
          created_at?: string | null
          description?: string | null
          duration_minutes?: number | null
          embedding?: string | null
          external_sku?: string | null
          featured?: boolean
          id?: string
          image_public_id?: string | null
          image_url?: string | null
          max_quantity?: number
          min_quantity?: number
          name: string
          popular?: boolean
          preparation_time?: number | null
          price: number
          price_sale?: number | null
          product_type?: string
          sort?: number
          stock?: string | null
          stock_control_enabled?: boolean
          stock_quantity?: number | null
          tags?: string[] | null
          updated_at?: string | null
          video_public_id?: string | null
          video_url?: string | null
        }
        Update: {
          active?: boolean | null
          available_days?: number[] | null
          available_from?: string | null
          available_until?: string | null
          brand?: string | null
          business_id?: string
          category_id?: string | null
          created_at?: string | null
          description?: string | null
          duration_minutes?: number | null
          embedding?: string | null
          external_sku?: string | null
          featured?: boolean
          id?: string
          image_public_id?: string | null
          image_url?: string | null
          max_quantity?: number
          min_quantity?: number
          name?: string
          popular?: boolean
          preparation_time?: number | null
          price?: number
          price_sale?: number | null
          product_type?: string
          sort?: number
          stock?: string | null
          stock_control_enabled?: boolean
          stock_quantity?: number | null
          tags?: string[] | null
          updated_at?: string | null
          video_public_id?: string | null
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_products_categoria_del_negocio"
            columns: ["category_id", "business_id"]
            isOneToOne: false
            referencedRelation: "product_categories"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "products_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      sale_items: {
        Row: {
          business_id: string
          created_at: string | null
          id: string
          line_total: number
          product_id: string | null
          product_name: string
          quantity: number
          sale_id: string | null
          unit_price: number
        }
        Insert: {
          business_id: string
          created_at?: string | null
          id?: string
          line_total?: number
          product_id?: string | null
          product_name: string
          quantity?: number
          sale_id?: string | null
          unit_price?: number
        }
        Update: {
          business_id?: string
          created_at?: string | null
          id?: string
          line_total?: number
          product_id?: string | null
          product_name?: string
          quantity?: number
          sale_id?: string | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "sale_items_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
        ]
      }
      sales: {
        Row: {
          business_id: string
          contact_name: string | null
          contact_phone: string | null
          created_at: string | null
          created_by: string | null
          id: string
          order_id: string | null
          platform_markup: number
          shipping: number
          sold_at: string
          source: string | null
          status: string
          total: number
        }
        Insert: {
          business_id: string
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          order_id?: string | null
          platform_markup?: number
          shipping?: number
          sold_at?: string
          source?: string | null
          status?: string
          total?: number
        }
        Update: {
          business_id?: string
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          order_id?: string | null
          platform_markup?: number
          shipping?: number
          sold_at?: string
          source?: string | null
          status?: string
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_sales_pedido_del_negocio"
            columns: ["order_id", "business_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id", "business_id"]
          },
          {
            foreignKeyName: "sales_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "client_users"
            referencedColumns: ["id"]
          },
        ]
      }
      schema_migrations: {
        Row: {
          applied_at: string
          checksum: string
          name: string
          source: string
        }
        Insert: {
          applied_at?: string
          checksum: string
          name: string
          source?: string
        }
        Update: {
          applied_at?: string
          checksum?: string
          name?: string
          source?: string
        }
        Relationships: []
      }
      server_settings: {
        Row: {
          key: string
          updated_at: string | null
          value: string | null
        }
        Insert: {
          key: string
          updated_at?: string | null
          value?: string | null
        }
        Update: {
          key?: string
          updated_at?: string | null
          value?: string | null
        }
        Relationships: []
      }
      settlements: {
        Row: {
          arrastre_cents: number
          billing_id: string | null
          business_id: string
          courier_id: string | null
          created_at: string
          cuota_cents: number
          derecho_cents: number
          en_mano_cents: number
          id: string
          neto_cents: number
          orders_count: number
          paid_at: string | null
          party: string
          period_end: string
          period_start: string
          reference: string | null
          status: string
          updated_at: string
        }
        Insert: {
          arrastre_cents?: number
          billing_id?: string | null
          business_id: string
          courier_id?: string | null
          created_at?: string
          cuota_cents?: number
          derecho_cents?: number
          en_mano_cents?: number
          id?: string
          neto_cents: number
          orders_count?: number
          paid_at?: string | null
          party?: string
          period_end: string
          period_start: string
          reference?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          arrastre_cents?: number
          billing_id?: string | null
          business_id?: string
          courier_id?: string | null
          created_at?: string
          cuota_cents?: number
          derecho_cents?: number
          en_mano_cents?: number
          id?: string
          neto_cents?: number
          orders_count?: number
          paid_at?: string | null
          party?: string
          period_end?: string
          period_start?: string
          reference?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlements_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      storefront_sessions: {
        Row: {
          business_id: string
          claimed_at: string | null
          contact_phone: string
          created_at: string
          customer_id: string
          device_hash: string | null
          expires_at: string | null
          id: string
          last_seen_at: string | null
          revoked_at: string | null
          token_hash: string
          verified_at: string | null
        }
        Insert: {
          business_id: string
          claimed_at?: string | null
          contact_phone: string
          created_at?: string
          customer_id: string
          device_hash?: string | null
          expires_at?: string | null
          id?: string
          last_seen_at?: string | null
          revoked_at?: string | null
          token_hash: string
          verified_at?: string | null
        }
        Update: {
          business_id?: string
          claimed_at?: string | null
          contact_phone?: string
          created_at?: string
          customer_id?: string
          device_hash?: string | null
          expires_at?: string | null
          id?: string
          last_seen_at?: string | null
          revoked_at?: string | null
          token_hash?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "storefront_sessions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "storefront_sessions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_inbound_events: {
        Row: {
          attempts: number
          available_at: string
          business_id: string | null
          completed_at: string | null
          dead_at: string | null
          id: string
          last_error: string | null
          lease_owner: string | null
          lease_token: string | null
          leased_until: string | null
          max_attempts: number
          message_id_hash: string
          payload: Json | null
          payload_version: number
          provider: string
          received_at: string
          status: string
          stream_key_hash: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          available_at?: string
          business_id?: string | null
          completed_at?: string | null
          dead_at?: string | null
          id?: string
          last_error?: string | null
          lease_owner?: string | null
          lease_token?: string | null
          leased_until?: string | null
          max_attempts?: number
          message_id_hash: string
          payload?: Json | null
          payload_version?: number
          provider: string
          received_at?: string
          status?: string
          stream_key_hash?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          available_at?: string
          business_id?: string | null
          completed_at?: string | null
          dead_at?: string | null
          id?: string
          last_error?: string | null
          lease_owner?: string | null
          lease_token?: string | null
          leased_until?: string | null
          max_attempts?: number
          message_id_hash?: string
          payload?: Json | null
          payload_version?: number
          provider?: string
          received_at?: string
          status?: string
          stream_key_hash?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_inbound_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      marketplace_cajones_de_negocio: {
        Row: {
          business_id: string | null
          category_id: string | null
          principal: boolean | null
        }
        Relationships: []
      }
    }
    Functions: {
      actor_de_la_peticion: { Args: never; Returns: string }
      advance_marketplace_conversation: {
        Args: {
          p_business_id?: string
          p_clear_business?: boolean
          p_clear_flow?: boolean
          p_customer_id: string
          p_expected_version?: number
          p_flow_state?: Json
          p_shopping_locked?: boolean
          p_state?: string
        }
        Returns: Json
      }
      anotar_movimiento_de_dinero: {
        Args: {
          p_action: string
          p_business_id: string
          p_detail: Json
          p_target_id: string
          p_target_table: string
        }
        Returns: undefined
      }
      apply_business_menu: {
        Args: { p_business_id: string; p_menu: Json }
        Returns: Json
      }
      apply_business_template: {
        Args: { p_business_id: string; p_template: Json }
        Returns: Json
      }
      attach_storefront_payment_proof: {
        Args: {
          p_business_id: string
          p_contact_phone: string
          p_order_id: string
          p_public_id?: string
          p_url: string
        }
        Returns: Json
      }
      billing_plan_definition: {
        Args: { p_plan: string }
        Returns: {
          monthly_contact_limit: number
          monthly_outbound_message_limit: number
          monthly_rate: number
          plan_code: string
        }[]
      }
      block_customer_temporarily: {
        Args: {
          p_business_id: string
          p_customer_id: string
          p_motivo?: string
        }
        Returns: Json
      }
      business_blocked_contacts: {
        Args: { p_business_id: string }
        Returns: {
          permanent: boolean
          phone: string
          until: string
        }[]
      }
      business_pricing_view: { Args: { p_business_id: string }; Returns: Json }
      calculate_platform_markup: {
        Args: { p_business_id: string; p_rule_id?: string; p_subtotal: number }
        Returns: Json
      }
      cancel_unpaid_order_on_purpose: {
        Args: { p_business_id: string; p_customer_id: string }
        Returns: number
      }
      carry_commission_adjustments: {
        Args: { p_period_start: string }
        Returns: Json
      }
      claim_blocked_notice: {
        Args: { p_business_id: string; p_customer_id: string }
        Returns: boolean
      }
      claim_card_payment: {
        Args: {
          p_client_transaction_id: string
          p_provider_transaction_id?: string
        }
        Returns: Json
      }
      claim_marketplace_reply: {
        Args: {
          p_customer_id: string
          p_message_id?: string
          p_silencio_horas?: number
          p_tope?: number
        }
        Returns: Json
      }
      claim_miniapp_reply: {
        Args: {
          p_aviso_desde?: number
          p_business_id: string
          p_customer_id: string
          p_message_id?: string
          p_silencio_horas?: number
          p_tope?: number
        }
        Returns: Json
      }
      claim_platform_block_state: {
        Args: { p_customer_id: string }
        Returns: Json
      }
      claim_storefront_link_send: {
        Args: {
          p_business_id: string
          p_cooldown_hours?: number
          p_customer_id: string
        }
        Returns: boolean
      }
      claim_webhook_event: {
        Args: {
          p_business_id: string
          p_message_id_hash: string
          p_provider: string
        }
        Returns: boolean
      }
      cleanup_platform_errors: { Args: { p_days?: number }; Returns: number }
      cleanup_storefront_sessions: {
        Args: { p_days?: number }
        Returns: number
      }
      cleanup_webhook_events: { Args: never; Returns: number }
      clear_rejected_receipts: {
        Args: { p_business_id: string; p_customer_id: string }
        Returns: undefined
      }
      close_weekly_courier_settlements: {
        Args: { p_week_start: string }
        Returns: Json
      }
      close_weekly_settlements: {
        Args: { p_week_start: string }
        Returns: Json
      }
      comision_payphone_bps: { Args: never; Returns: number }
      complete_outbox_event: {
        Args: { p_id: string; p_token: string }
        Returns: boolean
      }
      complete_webhook_event: {
        Args: { p_event_id: string; p_lease_token: string }
        Returns: boolean
      }
      courier_advance_order: {
        Args: { p_courier_id: string; p_order_id: string; p_status: string }
        Returns: Json
      }
      courier_balance: { Args: { p_courier_id: string }; Returns: Json }
      courier_cash_in_hand: { Args: { p_courier_id: string }; Returns: number }
      courier_orders: { Args: { p_courier_id: string }; Returns: Json }
      courier_take_order: {
        Args: { p_courier_id: string; p_order_id: string }
        Returns: Json
      }
      crear_venta_desde_pedido: {
        Args: { p_business_id: string; p_order_id: string }
        Returns: string
      }
      create_business_onboarding: {
        Args: {
          p_business: Json
          p_client_email?: string
          p_monthly_rate?: number
          p_password_hash?: string
        }
        Returns: Json
      }
      create_order_with_items: {
        Args: {
          p_business_id: string
          p_contact_name: string
          p_contact_phone: string
          p_currency: string
          p_discount: number
          p_items: Json
          p_source?: string
          p_status: string
        }
        Returns: Json
      }
      create_storefront_order: {
        Args: {
          p_address_id: string
          p_business_id: string
          p_contact_name: string
          p_contact_phone: string
          p_customer_id: string
          p_fulfillment: string
          p_idempotency_key?: string
          p_items: Json
          p_notes?: string
          p_payment_method?: string
          p_scheduled_for?: string
        }
        Returns: Json
      }
      enqueue_outbox_event: {
        Args: {
          p_aggregate_id: string
          p_aggregate_type?: string
          p_business_id: string
          p_espera_s?: number
          p_event_type: string
          p_payload: Json
        }
        Returns: string
      }
      enqueue_webhook_event: {
        Args: {
          p_business_id: string
          p_message_id_hash: string
          p_payload: Json
          p_provider: string
          p_stream_key_hash: string
        }
        Returns: boolean
      }
      ensure_current_month_billing: { Args: never; Returns: number }
      expire_card_payment: {
        Args: { p_client_transaction_id: string; p_detail?: string }
        Returns: boolean
      }
      expire_unpaid_orders: {
        Args: { p_limite?: number }
        Returns: {
          business_id: string
          order_id: string
          order_number: number
        }[]
      }
      fail_outbox_event: {
        Args: { p_error: string; p_id: string; p_token: string }
        Returns: string
      }
      fail_webhook_event: {
        Args: {
          p_base_delay_seconds: number
          p_error: string
          p_event_id: string
          p_lease_token: string
        }
        Returns: string
      }
      finish_card_refund: {
        Args: {
          p_client_transaction_id: string
          p_detail?: string
          p_reversed: boolean
        }
        Returns: boolean
      }
      frenos_de_tarjeta: { Args: never; Returns: Json }
      get_admin_monthly_usage: {
        Args: { p_month?: string }
        Returns: {
          active_contacts: number
          business_id: string
          contact_limit: number
          contact_overage: number
          inbound_messages: number
          includes_history_estimate: boolean
          outbound_image_messages: number
          outbound_interactive_messages: number
          outbound_message_limit: number
          outbound_message_overage: number
          outbound_messages: number
          outbound_text_messages: number
          outbound_video_messages: number
          period_end: string
          period_start: string
        }[]
      }
      get_receipt_analysis: {
        Args: { p_business_id: string; p_order_id: string }
        Returns: Json
      }
      lease_card_payments: {
        Args: { p_lease_s?: number; p_limite?: number }
        Returns: {
          amount_cents: number
          business_id: string
          client_transaction_id: string
          confirm_attempts: number
          created_at: string
          environment: string
          id: string
          order_id: string
          provider_transaction_id: string
          status: string
        }[]
      }
      lease_outbox_events: {
        Args: { p_lease_s?: number; p_limite?: number; p_owner: string }
        Returns: {
          aggregate_id: string
          aggregate_type: string
          attempts: number
          available_at: string
          business_id: string
          completed_at: string | null
          created_at: string
          dead_at: string | null
          event_type: string
          id: string
          last_error: string | null
          lease_owner: string | null
          lease_token: string | null
          leased_until: string | null
          max_attempts: number
          payload: Json
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "outbox_events"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      lease_webhook_events: {
        Args: { p_lease_seconds: number; p_limit: number; p_worker_id: string }
        Returns: {
          attempts: number
          business_id: string
          id: string
          lease_token: string
          payload: Json
          provider: string
        }[]
      }
      lineas_del_plato_por_partes: {
        Args: {
          p_business_id: string
          p_elegidas: Json
          p_precio: number
          p_product_id: string
          p_product_name: string
        }
        Returns: Json
      }
      liquidacion_semanal_desde: { Args: never; Returns: string }
      local_embudo: {
        Args: { p_business_id: string; p_dias?: number }
        Returns: {
          clientes: number
          orden: number
          paso: string
        }[]
      }
      local_llegadas: {
        Args: { p_business_id: string; p_dias?: number }
        Returns: {
          code: string
          label: string
          veces: number
        }[]
      }
      marcar_linea_preparada: {
        Args: {
          p_business_id: string
          p_item_id: string
          p_order_id: string
          p_user_id?: string
        }
        Returns: Json
      }
      mark_courier_settlement_paid: {
        Args: { p_reference: string; p_settlement_id: string }
        Returns: Json
      }
      mark_payment_reconciled: {
        Args: { p_detalle: string; p_id: string; p_resultado: string }
        Returns: boolean
      }
      mark_settlement_paid: {
        Args: { p_reference: string; p_settlement_id: string }
        Returns: Json
      }
      marketplace_alias_parecido: {
        Args: { p_minimo?: number; p_palabras: string[] }
        Returns: {
          category_code: string
          parecido: number
          term: string
        }[]
      }
      marketplace_buscar_negocios: {
        Args: { p_limite?: number; p_query: string }
        Returns: {
          id: string
          motivo: string
          name: string
          orden: number
          slug: string
          type: string
        }[]
      }
      marketplace_buscar_productos: {
        Args: { p_business_id: string; p_limite?: number; p_query: string }
        Returns: {
          id: string
          name: string
          orden: number
          price: number
        }[]
      }
      marketplace_busquedas: {
        Args: { p_dias?: number }
        Returns: {
          consulta: string
          entendido: string
          sin_nada: number
          veces: number
        }[]
      }
      marketplace_cajones_del_negocio: {
        Args: { p_business_id: string }
        Returns: {
          code: string
          emoji: string
          label: string
          principal: boolean
        }[]
      }
      marketplace_cajones_tocados: {
        Args: { p_dias?: number }
        Returns: {
          abandonaron: number
          code: string
          eligieron: number
          entradas: number
          label: string
        }[]
      }
      marketplace_categories_disponibles: {
        Args: never
        Returns: {
          code: string
          emoji: string
          label: string
          locales: number
          sort: number
        }[]
      }
      marketplace_embudo: {
        Args: { p_dias?: number }
        Returns: {
          clientes: number
          orden: number
          paso: string
        }[]
      }
      marketplace_negocios_de_categoria: {
        Args: { p_code: string }
        Returns: {
          carta_desde: string
          con_carta: boolean
          id: string
          name: string
          prep_min: number
          slug: string
          type: string
        }[]
      }
      marketplace_normalizar_consulta: {
        Args: { p_texto: string }
        Returns: string
      }
      match_products: {
        Args: { biz_id: string; match_count: number; query_embedding: string }
        Returns: {
          brand: string
          description: string
          duration_minutes: number
          id: string
          image_url: string
          name: string
          price: number
          price_sale: number
          similarity: number
          stock: string
          tags: string[]
        }[]
      }
      money_audit_log_recent: {
        Args: { p_antes_de?: number; p_business_id?: string; p_limite?: number }
        Returns: {
          action: string
          actor: string
          business_id: string | null
          business_name: string | null
          created_at: string
          detail: Json
          id: number
          target_id: string | null
          target_table: string
        }[]
        SetofOptions: {
          from: "*"
          to: "money_audit_log"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      normalize_business_channel_identifier: {
        Args: { p_identifier_type: string; p_value: string }
        Returns: string
      }
      order_markup_by_line: {
        Args: { p_order_id: string; p_percentage: number }
        Returns: number
      }
      payments_to_reconcile: {
        Args: { p_environment: string; p_limite?: number }
        Returns: {
          amount_cents: number
          business_id: string
          business_name: string
          captured_cents: number
          client_transaction_id: string
          created_at: string
          id: string
          order_id: string
          order_number: number
          provider_transaction_id: string
          status: string
        }[]
      }
      platform_markup_summary: {
        Args: { p_business_id?: string; p_from: string; p_to: string }
        Returns: {
          bruto: number
          business_id: string
          business_name: string
          margen: number
          pedidos: number
          productos: number
          reparto: number
        }[]
      }
      producto_en_horario: {
        Args: {
          p_ahora?: string
          p_days: number[]
          p_from: string
          p_until: string
        }
        Returns: boolean
      }
      reactivate_business_with_billing: {
        Args: { p_business_id: string }
        Returns: boolean
      }
      record_platform_error: {
        Args: {
          p_business_id: string
          p_category: string
          p_code: string
          p_context: Json
          p_fingerprint: string
          p_message: string
        }
        Returns: string
      }
      refresh_business_channel_identifiers: {
        Args: { p_business_id: string }
        Returns: undefined
      }
      register_insult: {
        Args: { p_customer_id: string; p_dias?: number }
        Returns: Json
      }
      register_payment_receipt: {
        Args: {
          p_business_id: string
          p_file_public_id: string
          p_file_size?: number
          p_file_url: string
          p_mime_type?: string
          p_order_id: string
          p_perceptual_hash?: string
          p_sha256: string
        }
        Returns: Json
      }
      register_rejected_receipt: {
        Args: { p_business_id: string; p_customer_id: string }
        Returns: Json
      }
      register_unpaid_expiry: {
        Args: { p_business_id: string; p_order_id: string }
        Returns: Json
      }
      renew_webhook_event_lease: {
        Args: {
          p_event_id: string
          p_lease_seconds: number
          p_lease_token: string
        }
        Returns: boolean
      }
      reorder_option_groups: {
        Args: { p_business_id: string; p_ids: string[] }
        Returns: number
      }
      reorder_options: {
        Args: { p_business_id: string; p_group_id: string; p_ids: string[] }
        Returns: number
      }
      request_new_payment_proof: {
        Args: { p_business_id: string; p_order_id: string }
        Returns: Json
      }
      retain_courier_fee: {
        Args: { p_motivo: string; p_order_id: string }
        Returns: Json
      }
      revoke_other_storefront_sessions: {
        Args: { p_customer_id: string; p_keep_session_id: string }
        Returns: number
      }
      revoke_storefront_sessions_except: {
        Args: { p_customer_id: string; p_keep_session_id: string }
        Returns: number
      }
      revoke_storefront_sessions_on_exit: {
        Args: { p_customer_id: string }
        Returns: number
      }
      save_receipt_analysis: {
        Args: {
          p_analysis?: Json
          p_business_id: string
          p_datos?: Json
          p_flags?: Json
          p_puntos_referencia?: number
          p_receipt_id: string
          p_status: string
        }
        Returns: Json
      }
      set_business_marketplace_categories: {
        Args: { p_business_id: string; p_codes: string[]; p_principal?: string }
        Returns: number
      }
      set_order_status: {
        Args: { p_business_id: string; p_order_id: string; p_status: string }
        Returns: Json
      }
      set_platform_blocked: {
        Args: { p_blocked: boolean; p_phone: string; p_reason?: string }
        Returns: Json
      }
      settle_card_payment: {
        Args: {
          p_authorization_code?: string
          p_captured_cents: number
          p_card_brand?: string
          p_client_transaction_id: string
          p_currency: string
          p_detail?: string
          p_last_digits?: string
          p_provider_transaction_id: string
          p_status_code: number
        }
        Returns: Json
      }
      settle_month_commission: {
        Args: { p_period_start: string }
        Returns: Json
      }
      settlement_balances: {
        Args: { p_business_id?: string }
        Returns: {
          arrastre_cents: number
          business_id: string
          business_name: string
          derecho_cents: number
          en_mano_cents: number
          neto_cents: number
          payphone_cents: number
          pedidos: number
          pedidos_tarjeta: number
          umbani_cents: number
        }[]
      }
      sincronizar_plantilla_en_grupo: {
        Args: { p_group_id: string }
        Returns: undefined
      }
      start_card_payment: {
        Args: {
          p_business_id: string
          p_contact_phone: string
          p_environment: string
          p_order_id: string
        }
        Returns: Json
      }
      storefront_customer_block_state: {
        Args: { p_business_id: string; p_customer_id: string }
        Returns: Json
      }
      storefront_customer_blocked: {
        Args: { p_business_id: string; p_customer_id: string }
        Returns: boolean
      }
      storefront_payment_methods: {
        Args: { p_business_id: string }
        Returns: {
          code: string
          help_text: string
          is_prepaid: boolean
          label: string
          requires_proof: boolean
        }[]
      }
      tarifa_de_servicio: { Args: never; Returns: number }
      tarjeta_apagada_para: {
        Args: { p_customer_id: string }
        Returns: boolean
      }
      update_business_plan_billing: {
        Args: {
          p_business_id: string
          p_monthly_contact_limit: number
          p_monthly_outbound_message_limit: number
          p_monthly_rate: number
          p_plan: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

