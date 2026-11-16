export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
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
  public: {
    Tables: {
      api_idempotency_keys: {
        Row: {
          created_at: string
          device_id: string
          endpoint: string
          idempotency_key: string
          request_hash: string
          response_body: Json | null
          response_status: number | null
        }
        Insert: {
          created_at?: string
          device_id: string
          endpoint: string
          idempotency_key: string
          request_hash: string
          response_body?: Json | null
          response_status?: number | null
        }
        Update: {
          created_at?: string
          device_id?: string
          endpoint?: string
          idempotency_key?: string
          request_hash?: string
          response_body?: Json | null
          response_status?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "api_idempotency_keys_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device_registry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_idempotency_keys_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "v_device_status"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_label: string | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          created_at: string
          id: number
          new_value: Json | null
          previous_value: Json | null
          reason: string | null
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_label?: string | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          created_at?: string
          id?: never
          new_value?: Json | null
          previous_value?: Json | null
          reason?: string | null
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_label?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          created_at?: string
          id?: never
          new_value?: Json | null
          previous_value?: Json | null
          reason?: string | null
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: []
      }
      calculators: {
        Row: {
          code: string
          condition: Database["public"]["Enums"]["calculator_condition"]
          created_at: string
          id: string
          locker_id: string | null
          model: string
          notes: string | null
          rfid_uid: string
          status: Database["public"]["Enums"]["calculator_status"]
          updated_at: string
        }
        Insert: {
          code: string
          condition?: Database["public"]["Enums"]["calculator_condition"]
          created_at?: string
          id?: string
          locker_id?: string | null
          model: string
          notes?: string | null
          rfid_uid: string
          status?: Database["public"]["Enums"]["calculator_status"]
          updated_at?: string
        }
        Update: {
          code?: string
          condition?: Database["public"]["Enums"]["calculator_condition"]
          created_at?: string
          id?: string
          locker_id?: string | null
          model?: string
          notes?: string | null
          rfid_uid?: string
          status?: Database["public"]["Enums"]["calculator_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calculators_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: true
            referencedRelation: "lockers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calculators_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: true
            referencedRelation: "v_lockers"
            referencedColumns: ["id"]
          },
        ]
      }
      coin_events: {
        Row: {
          detected_value: number
          device_id: string
          id: string
          occurred_at: string
          payment_id: string | null
          pulse_count: number
          received_at: string
          session_id: string | null
        }
        Insert: {
          detected_value: number
          device_id: string
          id: string
          occurred_at: string
          payment_id?: string | null
          pulse_count: number
          received_at?: string
          session_id?: string | null
        }
        Update: {
          detected_value?: number
          device_id?: string
          id?: string
          occurred_at?: string
          payment_id?: string | null
          pulse_count?: number
          received_at?: string
          session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "coin_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device_registry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coin_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "v_device_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coin_events_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      device_credentials: {
        Row: {
          created_at: string
          device_id: string
          rotated_at: string
          secret_hash: string
        }
        Insert: {
          created_at?: string
          device_id: string
          rotated_at?: string
          secret_hash: string
        }
        Update: {
          created_at?: string
          device_id?: string
          rotated_at?: string
          secret_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_credentials_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: true
            referencedRelation: "device_registry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_credentials_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: true
            referencedRelation: "v_device_status"
            referencedColumns: ["id"]
          },
        ]
      }
      device_events: {
        Row: {
          device_id: string
          event_type: Database["public"]["Enums"]["device_event_type"]
          id: string
          locker_id: string | null
          message: string | null
          occurred_at: string
          payload: Json
          severity: Database["public"]["Enums"]["event_severity"]
          synced_at: string
          transaction_id: string | null
        }
        Insert: {
          device_id: string
          event_type: Database["public"]["Enums"]["device_event_type"]
          id?: string
          locker_id?: string | null
          message?: string | null
          occurred_at: string
          payload?: Json
          severity?: Database["public"]["Enums"]["event_severity"]
          synced_at?: string
          transaction_id?: string | null
        }
        Update: {
          device_id?: string
          event_type?: Database["public"]["Enums"]["device_event_type"]
          id?: string
          locker_id?: string | null
          message?: string | null
          occurred_at?: string
          payload?: Json
          severity?: Database["public"]["Enums"]["event_severity"]
          synced_at?: string
          transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "device_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device_registry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "v_device_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_events_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: false
            referencedRelation: "lockers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_events_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: false
            referencedRelation: "v_lockers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_events_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "rental_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_events_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "v_rentals"
            referencedColumns: ["id"]
          },
        ]
      }
      device_registry: {
        Row: {
          cpu_temp_c: number | null
          created_at: string
          device_code: string
          health: Database["public"]["Enums"]["device_health"]
          id: string
          ip_address: unknown
          is_enabled: boolean
          last_health: Json
          last_heartbeat_at: string | null
          local_db_ok: boolean | null
          location: string | null
          name: string
          network_state: string | null
          notes: string | null
          software_version: string | null
          sync_queue_count: number
          updated_at: string
        }
        Insert: {
          cpu_temp_c?: number | null
          created_at?: string
          device_code: string
          health?: Database["public"]["Enums"]["device_health"]
          id?: string
          ip_address?: unknown
          is_enabled?: boolean
          last_health?: Json
          last_heartbeat_at?: string | null
          local_db_ok?: boolean | null
          location?: string | null
          name: string
          network_state?: string | null
          notes?: string | null
          software_version?: string | null
          sync_queue_count?: number
          updated_at?: string
        }
        Update: {
          cpu_temp_c?: number | null
          created_at?: string
          device_code?: string
          health?: Database["public"]["Enums"]["device_health"]
          id?: string
          ip_address?: unknown
          is_enabled?: boolean
          last_health?: Json
          last_heartbeat_at?: string | null
          local_db_ok?: boolean | null
          location?: string | null
          name?: string
          network_state?: string | null
          notes?: string | null
          software_version?: string | null
          sync_queue_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      lockers: {
        Row: {
          created_at: string
          device_health: Database["public"]["Enums"]["device_health"]
          device_id: string
          door_state: Database["public"]["Enums"]["door_state"]
          hardware_channel: number
          id: string
          last_detected_rfid_uid: string | null
          last_seen_at: string | null
          lock_state: Database["public"]["Enums"]["lock_state"]
          locker_number: number
          name: string
          notes: string | null
          rfid_state: Database["public"]["Enums"]["rfid_state"]
          status: Database["public"]["Enums"]["locker_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          device_health?: Database["public"]["Enums"]["device_health"]
          device_id: string
          door_state?: Database["public"]["Enums"]["door_state"]
          hardware_channel: number
          id?: string
          last_detected_rfid_uid?: string | null
          last_seen_at?: string | null
          lock_state?: Database["public"]["Enums"]["lock_state"]
          locker_number: number
          name: string
          notes?: string | null
          rfid_state?: Database["public"]["Enums"]["rfid_state"]
          status?: Database["public"]["Enums"]["locker_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          device_health?: Database["public"]["Enums"]["device_health"]
          device_id?: string
          door_state?: Database["public"]["Enums"]["door_state"]
          hardware_channel?: number
          id?: string
          last_detected_rfid_uid?: string | null
          last_seen_at?: string | null
          lock_state?: Database["public"]["Enums"]["lock_state"]
          locker_number?: number
          name?: string
          notes?: string | null
          rfid_state?: Database["public"]["Enums"]["rfid_state"]
          status?: Database["public"]["Enums"]["locker_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lockers_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device_registry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lockers_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "v_device_status"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_received: number
          created_at: string
          device_id: string | null
          id: string
          method: Database["public"]["Enums"]["payment_method"]
          notes: string | null
          paid_at: string | null
          payment_type: Database["public"]["Enums"]["payment_type"]
          penalty_id: string | null
          recorded_by: string | null
          rental_transaction_id: string | null
          required_amount: number
          session_id: string | null
          status: Database["public"]["Enums"]["payment_status"]
          student_id: string
          updated_at: string
        }
        Insert: {
          amount_received?: number
          created_at?: string
          device_id?: string | null
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          notes?: string | null
          paid_at?: string | null
          payment_type: Database["public"]["Enums"]["payment_type"]
          penalty_id?: string | null
          recorded_by?: string | null
          rental_transaction_id?: string | null
          required_amount: number
          session_id?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          student_id: string
          updated_at?: string
        }
        Update: {
          amount_received?: number
          created_at?: string
          device_id?: string | null
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          notes?: string | null
          paid_at?: string | null
          payment_type?: Database["public"]["Enums"]["payment_type"]
          penalty_id?: string | null
          recorded_by?: string | null
          rental_transaction_id?: string | null
          required_amount?: number
          session_id?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          student_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device_registry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "v_device_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_penalty_id_fkey"
            columns: ["penalty_id"]
            isOneToOne: false
            referencedRelation: "penalties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_rental_transaction_id_fkey"
            columns: ["rental_transaction_id"]
            isOneToOne: false
            referencedRelation: "rental_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_rental_transaction_id_fkey"
            columns: ["rental_transaction_id"]
            isOneToOne: false
            referencedRelation: "v_rentals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
      penalties: {
        Row: {
          amount_due: number | null
          amount_paid: number
          calculated_amount: number
          calculated_at: string
          created_at: string
          id: string
          notes: string | null
          overdue_minutes: number
          paid_at: string | null
          reason: Database["public"]["Enums"]["penalty_reason"]
          rental_transaction_id: string
          status: Database["public"]["Enums"]["penalty_status"]
          student_id: string
          updated_at: string
          waive_reason: string | null
          waived_amount: number
          waived_at: string | null
          waived_by: string | null
        }
        Insert: {
          amount_due?: number | null
          amount_paid?: number
          calculated_amount: number
          calculated_at?: string
          created_at?: string
          id?: string
          notes?: string | null
          overdue_minutes?: number
          paid_at?: string | null
          reason?: Database["public"]["Enums"]["penalty_reason"]
          rental_transaction_id: string
          status?: Database["public"]["Enums"]["penalty_status"]
          student_id: string
          updated_at?: string
          waive_reason?: string | null
          waived_amount?: number
          waived_at?: string | null
          waived_by?: string | null
        }
        Update: {
          amount_due?: number | null
          amount_paid?: number
          calculated_amount?: number
          calculated_at?: string
          created_at?: string
          id?: string
          notes?: string | null
          overdue_minutes?: number
          paid_at?: string | null
          reason?: Database["public"]["Enums"]["penalty_reason"]
          rental_transaction_id?: string
          status?: Database["public"]["Enums"]["penalty_status"]
          student_id?: string
          updated_at?: string
          waive_reason?: string | null
          waived_amount?: number
          waived_at?: string | null
          waived_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "penalties_rental_transaction_id_fkey"
            columns: ["rental_transaction_id"]
            isOneToOne: false
            referencedRelation: "rental_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalties_rental_transaction_id_fkey"
            columns: ["rental_transaction_id"]
            isOneToOne: false
            referencedRelation: "v_rentals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalties_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalties_waived_by_fkey"
            columns: ["waived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          is_active: boolean
          last_login_at: string | null
          role: Database["public"]["Enums"]["admin_role"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          is_active?: boolean
          last_login_at?: string | null
          role?: Database["public"]["Enums"]["admin_role"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          is_active?: boolean
          last_login_at?: string | null
          role?: Database["public"]["Enums"]["admin_role"]
          updated_at?: string
        }
        Relationships: []
      }
      rental_transactions: {
        Row: {
          amount_paid: number
          calculator_id: string
          created_at: string
          device_id: string | null
          due_at: string | null
          ended_at: string | null
          failure_reason: string | null
          id: string
          locker_id: string
          overdue_minutes: number
          paid_at: string | null
          payment_expires_at: string | null
          rental_duration_minutes: number
          rental_fee: number
          rental_rfid_verified: boolean
          rented_at: string | null
          reserved_at: string
          resolution_note: string | null
          resolved_by: string | null
          return_client_ref: string | null
          return_rfid_uid: string | null
          return_rfid_verified: boolean
          return_started_at: string | null
          return_verified_offline: boolean
          returned_at: string | null
          settings_snapshot: Json
          start_idempotency_key: string | null
          status: Database["public"]["Enums"]["rental_status"]
          student_id: string
          transaction_code: string
          updated_at: string
          was_overdue: boolean
        }
        Insert: {
          amount_paid?: number
          calculator_id: string
          created_at?: string
          device_id?: string | null
          due_at?: string | null
          ended_at?: string | null
          failure_reason?: string | null
          id?: string
          locker_id: string
          overdue_minutes?: number
          paid_at?: string | null
          payment_expires_at?: string | null
          rental_duration_minutes: number
          rental_fee: number
          rental_rfid_verified?: boolean
          rented_at?: string | null
          reserved_at?: string
          resolution_note?: string | null
          resolved_by?: string | null
          return_client_ref?: string | null
          return_rfid_uid?: string | null
          return_rfid_verified?: boolean
          return_started_at?: string | null
          return_verified_offline?: boolean
          returned_at?: string | null
          settings_snapshot?: Json
          start_idempotency_key?: string | null
          status?: Database["public"]["Enums"]["rental_status"]
          student_id: string
          transaction_code?: string
          updated_at?: string
          was_overdue?: boolean
        }
        Update: {
          amount_paid?: number
          calculator_id?: string
          created_at?: string
          device_id?: string | null
          due_at?: string | null
          ended_at?: string | null
          failure_reason?: string | null
          id?: string
          locker_id?: string
          overdue_minutes?: number
          paid_at?: string | null
          payment_expires_at?: string | null
          rental_duration_minutes?: number
          rental_fee?: number
          rental_rfid_verified?: boolean
          rented_at?: string | null
          reserved_at?: string
          resolution_note?: string | null
          resolved_by?: string | null
          return_client_ref?: string | null
          return_rfid_uid?: string | null
          return_rfid_verified?: boolean
          return_started_at?: string | null
          return_verified_offline?: boolean
          returned_at?: string | null
          settings_snapshot?: Json
          start_idempotency_key?: string | null
          status?: Database["public"]["Enums"]["rental_status"]
          student_id?: string
          transaction_code?: string
          updated_at?: string
          was_overdue?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "rental_transactions_calculator_id_fkey"
            columns: ["calculator_id"]
            isOneToOne: false
            referencedRelation: "calculators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_calculator_id_fkey"
            columns: ["calculator_id"]
            isOneToOne: false
            referencedRelation: "v_lockers"
            referencedColumns: ["calculator_id"]
          },
          {
            foreignKeyName: "rental_transactions_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device_registry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "v_device_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: false
            referencedRelation: "lockers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: false
            referencedRelation: "v_lockers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
      students: {
        Row: {
          blocked_reason: string | null
          course_program: string
          created_at: string
          full_name: string
          id: string
          last_transaction_at: string | null
          notes: string | null
          qr_identifier: string | null
          status: Database["public"]["Enums"]["student_status"]
          student_number: string
          updated_at: string
          year_level: number | null
        }
        Insert: {
          blocked_reason?: string | null
          course_program: string
          created_at?: string
          full_name: string
          id?: string
          last_transaction_at?: string | null
          notes?: string | null
          qr_identifier?: string | null
          status?: Database["public"]["Enums"]["student_status"]
          student_number: string
          updated_at?: string
          year_level?: number | null
        }
        Update: {
          blocked_reason?: string | null
          course_program?: string
          created_at?: string
          full_name?: string
          id?: string
          last_transaction_at?: string | null
          notes?: string | null
          qr_identifier?: string | null
          status?: Database["public"]["Enums"]["student_status"]
          student_number?: string
          updated_at?: string
          year_level?: number | null
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          accepted_coin_denominations: number[]
          allow_offline_rentals: boolean
          allow_offline_returns: boolean
          grace_period_minutes: number
          id: number
          max_concurrent_rentals_per_student: number
          max_penalty: number | null
          payment_timeout_seconds: number
          penalty_amount: number
          penalty_enabled: boolean
          penalty_interval_minutes: number
          penalty_steps: Json
          penalty_type: Database["public"]["Enums"]["penalty_type"]
          removal_timeout_seconds: number
          rental_duration_minutes: number
          rental_fee: number
          return_timeout_seconds: number
          unpaid_penalty_blocks_rental: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          accepted_coin_denominations: number[]
          allow_offline_rentals?: boolean
          allow_offline_returns?: boolean
          grace_period_minutes: number
          id?: number
          max_concurrent_rentals_per_student?: number
          max_penalty?: number | null
          payment_timeout_seconds?: number
          penalty_amount: number
          penalty_enabled: boolean
          penalty_interval_minutes: number
          penalty_steps?: Json
          penalty_type: Database["public"]["Enums"]["penalty_type"]
          removal_timeout_seconds?: number
          rental_duration_minutes: number
          rental_fee: number
          return_timeout_seconds?: number
          unpaid_penalty_blocks_rental: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          accepted_coin_denominations?: number[]
          allow_offline_rentals?: boolean
          allow_offline_returns?: boolean
          grace_period_minutes?: number
          id?: number
          max_concurrent_rentals_per_student?: number
          max_penalty?: number | null
          payment_timeout_seconds?: number
          penalty_amount?: number
          penalty_enabled?: boolean
          penalty_interval_minutes?: number
          penalty_steps?: Json
          penalty_type?: Database["public"]["Enums"]["penalty_type"]
          removal_timeout_seconds?: number
          rental_duration_minutes?: number
          rental_fee?: number
          return_timeout_seconds?: number
          unpaid_penalty_blocks_rental?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "system_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_device_status: {
        Row: {
          connection_status: string | null
          cpu_temp_c: number | null
          created_at: string | null
          device_code: string | null
          health: Database["public"]["Enums"]["device_health"] | null
          id: string | null
          ip_address: unknown
          is_enabled: boolean | null
          last_health: Json | null
          last_heartbeat_at: string | null
          local_db_ok: boolean | null
          location: string | null
          name: string | null
          network_state: string | null
          notes: string | null
          seconds_since_heartbeat: number | null
          software_version: string | null
          sync_queue_count: number | null
          updated_at: string | null
        }
        Insert: {
          connection_status?: never
          cpu_temp_c?: number | null
          created_at?: string | null
          device_code?: string | null
          health?: Database["public"]["Enums"]["device_health"] | null
          id?: string | null
          ip_address?: unknown
          is_enabled?: boolean | null
          last_health?: Json | null
          last_heartbeat_at?: string | null
          local_db_ok?: boolean | null
          location?: string | null
          name?: string | null
          network_state?: string | null
          notes?: string | null
          seconds_since_heartbeat?: never
          software_version?: string | null
          sync_queue_count?: number | null
          updated_at?: string | null
        }
        Update: {
          connection_status?: never
          cpu_temp_c?: number | null
          created_at?: string | null
          device_code?: string | null
          health?: Database["public"]["Enums"]["device_health"] | null
          id?: string | null
          ip_address?: unknown
          is_enabled?: boolean | null
          last_health?: Json | null
          last_heartbeat_at?: string | null
          local_db_ok?: boolean | null
          location?: string | null
          name?: string | null
          network_state?: string | null
          notes?: string | null
          seconds_since_heartbeat?: never
          software_version?: string | null
          sync_queue_count?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      v_lockers: {
        Row: {
          calculator_code: string | null
          calculator_id: string | null
          calculator_model: string | null
          calculator_status:
            | Database["public"]["Enums"]["calculator_status"]
            | null
          created_at: string | null
          device_code: string | null
          device_connection_status: string | null
          device_health: Database["public"]["Enums"]["device_health"] | null
          device_id: string | null
          door_state: Database["public"]["Enums"]["door_state"] | null
          expected_rfid_uid: string | null
          hardware_channel: number | null
          has_inventory_mismatch: boolean | null
          id: string | null
          is_assignable: boolean | null
          last_detected_rfid_uid: string | null
          last_seen_at: string | null
          lock_state: Database["public"]["Enums"]["lock_state"] | null
          locker_number: number | null
          name: string | null
          notes: string | null
          rfid_state: Database["public"]["Enums"]["rfid_state"] | null
          status: Database["public"]["Enums"]["locker_status"] | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lockers_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device_registry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lockers_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "v_device_status"
            referencedColumns: ["id"]
          },
        ]
      }
      v_rentals: {
        Row: {
          amount_paid: number | null
          calculator_code: string | null
          calculator_id: string | null
          calculator_model: string | null
          created_at: string | null
          device_id: string | null
          due_at: string | null
          effective_status: Database["public"]["Enums"]["rental_status"] | null
          ended_at: string | null
          failure_reason: string | null
          id: string | null
          is_overdue_now: boolean | null
          locker_id: string | null
          locker_name: string | null
          locker_number: number | null
          overdue_minutes: number | null
          overdue_minutes_now: number | null
          paid_at: string | null
          payment_expires_at: string | null
          penalty_amount_due: number | null
          rental_duration_minutes: number | null
          rental_fee: number | null
          rental_rfid_verified: boolean | null
          rented_at: string | null
          reserved_at: string | null
          resolution_note: string | null
          resolved_by: string | null
          return_client_ref: string | null
          return_rfid_uid: string | null
          return_rfid_verified: boolean | null
          return_started_at: string | null
          return_verified_offline: boolean | null
          returned_at: string | null
          settings_snapshot: Json | null
          start_idempotency_key: string | null
          status: Database["public"]["Enums"]["rental_status"] | null
          student_course_program: string | null
          student_full_name: string | null
          student_id: string | null
          student_number: string | null
          transaction_code: string | null
          updated_at: string | null
          was_overdue: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "rental_transactions_calculator_id_fkey"
            columns: ["calculator_id"]
            isOneToOne: false
            referencedRelation: "calculators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_calculator_id_fkey"
            columns: ["calculator_id"]
            isOneToOne: false
            referencedRelation: "v_lockers"
            referencedColumns: ["calculator_id"]
          },
          {
            foreignKeyName: "rental_transactions_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "device_registry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "v_device_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: false
            referencedRelation: "lockers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: false
            referencedRelation: "v_lockers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_transactions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      current_admin_role: {
        Args: never
        Returns: Database["public"]["Enums"]["admin_role"]
      }
      is_admin: { Args: never; Returns: boolean }
      is_officer: { Args: never; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
    }
    Enums: {
      actor_type: "ADMIN" | "DEVICE" | "SYSTEM"
      admin_role: "SUPER_ADMIN" | "OFFICER" | "VIEWER"
      calculator_condition: "GOOD" | "FAIR" | "DAMAGED"
      calculator_status:
        | "AVAILABLE"
        | "RENTED"
        | "MAINTENANCE"
        | "MISSING"
        | "DISABLED"
      device_event_type:
        | "QR_SCANNED"
        | "QR_INVALID"
        | "COIN_INSERTED"
        | "COIN_UNATTRIBUTED"
        | "PAYMENT_COMPLETE"
        | "PAYMENT_TIMEOUT"
        | "LOCKER_UNLOCK_REQUESTED"
        | "LOCKER_UNLOCKED"
        | "LOCKER_OPENED"
        | "LOCKER_CLOSED"
        | "RFID_DETECTED"
        | "RFID_REMOVED"
        | "RFID_MISMATCH"
        | "RENTAL_STARTED"
        | "RETURN_STARTED"
        | "RETURN_VERIFIED"
        | "INVENTORY_MISMATCH"
        | "DEVICE_OFFLINE"
        | "DEVICE_ONLINE"
        | "SYNC_FAILED"
        | "SYNC_SUCCESS"
        | "SYSTEM_ERROR"
      device_health: "OK" | "DEGRADED" | "FAULT" | "UNKNOWN"
      door_state: "OPEN" | "CLOSED" | "UNKNOWN"
      event_severity: "INFO" | "WARNING" | "ERROR" | "CRITICAL"
      lock_state: "LOCKED" | "UNLOCKED" | "UNKNOWN"
      locker_status:
        | "AVAILABLE"
        | "RESERVED"
        | "OPEN"
        | "RENTED"
        | "RETURNING"
        | "ERROR"
        | "MAINTENANCE"
        | "OFFLINE"
      payment_method: "COIN" | "CASH" | "GCASH" | "OTHER"
      payment_status: "PENDING" | "PARTIAL" | "PAID" | "CANCELLED" | "REFUNDED"
      payment_type: "RENTAL" | "PENALTY" | "MANUAL_ADJUSTMENT"
      penalty_reason: "OVERDUE" | "DAMAGE" | "LOST" | "OTHER"
      penalty_status: "UNPAID" | "PARTIAL" | "PAID" | "WAIVED"
      penalty_type: "FLAT" | "PER_INTERVAL" | "STEPPED"
      rental_status:
        | "PENDING"
        | "PAYMENT_PENDING"
        | "PAID"
        | "DISPENSING"
        | "ACTIVE"
        | "OVERDUE"
        | "RETURNING"
        | "COMPLETED"
        | "CANCELLED"
        | "FAILED"
      rfid_state: "EXPECTED_TAG" | "NO_TAG" | "WRONG_TAG" | "UNKNOWN"
      student_status: "ACTIVE" | "BLOCKED" | "INACTIVE"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      actor_type: ["ADMIN", "DEVICE", "SYSTEM"],
      admin_role: ["SUPER_ADMIN", "OFFICER", "VIEWER"],
      calculator_condition: ["GOOD", "FAIR", "DAMAGED"],
      calculator_status: [
        "AVAILABLE",
        "RENTED",
        "MAINTENANCE",
        "MISSING",
        "DISABLED",
      ],
      device_event_type: [
        "QR_SCANNED",
        "QR_INVALID",
        "COIN_INSERTED",
        "COIN_UNATTRIBUTED",
        "PAYMENT_COMPLETE",
        "PAYMENT_TIMEOUT",
        "LOCKER_UNLOCK_REQUESTED",
        "LOCKER_UNLOCKED",
        "LOCKER_OPENED",
        "LOCKER_CLOSED",
        "RFID_DETECTED",
        "RFID_REMOVED",
        "RFID_MISMATCH",
        "RENTAL_STARTED",
        "RETURN_STARTED",
        "RETURN_VERIFIED",
        "INVENTORY_MISMATCH",
        "DEVICE_OFFLINE",
        "DEVICE_ONLINE",
        "SYNC_FAILED",
        "SYNC_SUCCESS",
        "SYSTEM_ERROR",
      ],
      device_health: ["OK", "DEGRADED", "FAULT", "UNKNOWN"],
      door_state: ["OPEN", "CLOSED", "UNKNOWN"],
      event_severity: ["INFO", "WARNING", "ERROR", "CRITICAL"],
      lock_state: ["LOCKED", "UNLOCKED", "UNKNOWN"],
      locker_status: [
        "AVAILABLE",
        "RESERVED",
        "OPEN",
        "RENTED",
        "RETURNING",
        "ERROR",
        "MAINTENANCE",
        "OFFLINE",
      ],
      payment_method: ["COIN", "CASH", "GCASH", "OTHER"],
      payment_status: ["PENDING", "PARTIAL", "PAID", "CANCELLED", "REFUNDED"],
      payment_type: ["RENTAL", "PENALTY", "MANUAL_ADJUSTMENT"],
      penalty_reason: ["OVERDUE", "DAMAGE", "LOST", "OTHER"],
      penalty_status: ["UNPAID", "PARTIAL", "PAID", "WAIVED"],
      penalty_type: ["FLAT", "PER_INTERVAL", "STEPPED"],
      rental_status: [
        "PENDING",
        "PAYMENT_PENDING",
        "PAID",
        "DISPENSING",
        "ACTIVE",
        "OVERDUE",
        "RETURNING",
        "COMPLETED",
        "CANCELLED",
        "FAILED",
      ],
      rfid_state: ["EXPECTED_TAG", "NO_TAG", "WRONG_TAG", "UNKNOWN"],
      student_status: ["ACTIVE", "BLOCKED", "INACTIVE"],
    },
  },
} as const
