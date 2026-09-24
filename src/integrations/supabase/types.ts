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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admin_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          id: string
          meta: Json
          target: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          id?: string
          meta?: Json
          target?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          meta?: Json
          target?: string | null
        }
        Relationships: []
      }
      agent_configs: {
        Row: {
          agent_key: string
          confidence_threshold: number
          created_at: string
          display_name: string
          enabled: boolean
          id: string
          retries: number
          run_order: number
          timeout_ms: number
          updated_at: string
        }
        Insert: {
          agent_key: string
          confidence_threshold?: number
          created_at?: string
          display_name: string
          enabled?: boolean
          id?: string
          retries?: number
          run_order: number
          timeout_ms?: number
          updated_at?: string
        }
        Update: {
          agent_key?: string
          confidence_threshold?: number
          created_at?: string
          display_name?: string
          enabled?: boolean
          id?: string
          retries?: number
          run_order?: number
          timeout_ms?: number
          updated_at?: string
        }
        Relationships: []
      }
      agent_findings: {
        Row: {
          agent_type: string
          case_id: string
          confidence: number | null
          created_at: string
          error: string | null
          findings: Json | null
          grounding_dropped_count: number | null
          id: string
          latency_ms: number | null
          status: string
          summary: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_type: string
          case_id: string
          confidence?: number | null
          created_at?: string
          error?: string | null
          findings?: Json | null
          grounding_dropped_count?: number | null
          id?: string
          latency_ms?: number | null
          status?: string
          summary?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_type?: string
          case_id?: string
          confidence?: number | null
          created_at?: string
          error?: string | null
          findings?: Json | null
          grounding_dropped_count?: number | null
          id?: string
          latency_ms?: number | null
          status?: string
          summary?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_findings_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_logs: {
        Row: {
          agent_index: number
          agent_key: string
          agent_name: string
          case_id: string
          confidence: number | null
          created_at: string
          documents_analyzed: number
          errors: Json | null
          findings_generated: number
          findings_produced: number
          findings_promoted: number
          findings_suppressed: number
          finished_at: string | null
          id: string
          no_output_reason: string | null
          output: Json | null
          output_file: string | null
          output_items: number
          processing_time_ms: number | null
          run_id: string
          started_at: string
          status: string
          tokens_used: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_index: number
          agent_key: string
          agent_name: string
          case_id: string
          confidence?: number | null
          created_at?: string
          documents_analyzed?: number
          errors?: Json | null
          findings_generated?: number
          findings_produced?: number
          findings_promoted?: number
          findings_suppressed?: number
          finished_at?: string | null
          id?: string
          no_output_reason?: string | null
          output?: Json | null
          output_file?: string | null
          output_items?: number
          processing_time_ms?: number | null
          run_id: string
          started_at?: string
          status: string
          tokens_used?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_index?: number
          agent_key?: string
          agent_name?: string
          case_id?: string
          confidence?: number | null
          created_at?: string
          documents_analyzed?: number
          errors?: Json | null
          findings_generated?: number
          findings_produced?: number
          findings_promoted?: number
          findings_suppressed?: number
          finished_at?: string | null
          id?: string
          no_output_reason?: string | null
          output?: Json | null
          output_file?: string | null
          output_items?: number
          processing_time_ms?: number | null
          run_id?: string
          started_at?: string
          status?: string
          tokens_used?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_logs_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_providers: {
        Row: {
          api_key_encrypted: string | null
          base_url: string | null
          config: Json
          created_at: string
          default_model: string | null
          display_name: string
          enabled: boolean
          id: string
          last_error: string | null
          last_error_at: string | null
          last_ok_at: string | null
          priority: number
          provider_type: string
          secret_name: string | null
          updated_at: string
        }
        Insert: {
          api_key_encrypted?: string | null
          base_url?: string | null
          config?: Json
          created_at?: string
          default_model?: string | null
          display_name: string
          enabled?: boolean
          id?: string
          last_error?: string | null
          last_error_at?: string | null
          last_ok_at?: string | null
          priority?: number
          provider_type: string
          secret_name?: string | null
          updated_at?: string
        }
        Update: {
          api_key_encrypted?: string | null
          base_url?: string | null
          config?: Json
          created_at?: string
          default_model?: string | null
          display_name?: string
          enabled?: boolean
          id?: string
          last_error?: string | null
          last_error_at?: string | null
          last_ok_at?: string | null
          priority?: number
          provider_type?: string
          secret_name?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      ai_task_routing: {
        Row: {
          created_at: string
          id: string
          model: string | null
          provider_id: string | null
          task: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          model?: string | null
          provider_id?: string | null
          task: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          model?: string | null
          provider_id?: string | null
          task?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_task_routing_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "ai_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage: {
        Row: {
          case_id: string | null
          created_at: string
          error: string | null
          groq_key_id: string | null
          id: string
          input_tokens: number | null
          latency_ms: number | null
          model: string
          operation: string
          output_tokens: number | null
          provider_type: string | null
          success: boolean
          total_tokens: number | null
          user_id: string
        }
        Insert: {
          case_id?: string | null
          created_at?: string
          error?: string | null
          groq_key_id?: string | null
          id?: string
          input_tokens?: number | null
          latency_ms?: number | null
          model: string
          operation: string
          output_tokens?: number | null
          provider_type?: string | null
          success?: boolean
          total_tokens?: number | null
          user_id: string
        }
        Update: {
          case_id?: string | null
          created_at?: string
          error?: string | null
          groq_key_id?: string | null
          id?: string
          input_tokens?: number | null
          latency_ms?: number | null
          model?: string
          operation?: string
          output_tokens?: number | null
          provider_type?: string | null
          success?: boolean
          total_tokens?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      analyses: {
        Row: {
          case_id: string
          contradictions: Json | null
          created_at: string
          evidence_relationships: Json | null
          key_findings: Json | null
          missing_evidence: Json | null
          procedural_issues: Json | null
          scoring: Json | null
          timeline: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          case_id: string
          contradictions?: Json | null
          created_at?: string
          evidence_relationships?: Json | null
          key_findings?: Json | null
          missing_evidence?: Json | null
          procedural_issues?: Json | null
          scoring?: Json | null
          timeline?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          case_id?: string
          contradictions?: Json | null
          created_at?: string
          evidence_relationships?: Json | null
          key_findings?: Json | null
          missing_evidence?: Json | null
          procedural_issues?: Json | null
          scoring?: Json | null
          timeline?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyses_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      arco_request_events: {
        Row: {
          actor_id: string | null
          created_at: string
          event_type: string
          id: string
          notes: string | null
          request_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          notes?: string | null
          request_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          notes?: string | null
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "arco_request_events_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "arco_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      arco_requests: {
        Row: {
          assigned_reviewer: string | null
          completed_at: string | null
          created_at: string
          id: string
          identity_verification_notes: string | null
          identity_verification_status: string
          organization_id: string | null
          reference: string
          request_details: string | null
          request_type: Database["public"]["Enums"]["arco_request_type"]
          requester_email: string
          requester_name: string
          requester_phone: string | null
          resolution: string | null
          resolution_notes: string | null
          response_deadline: string
          status: Database["public"]["Enums"]["arco_request_status"]
          submitted_at: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          assigned_reviewer?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          identity_verification_notes?: string | null
          identity_verification_status?: string
          organization_id?: string | null
          reference?: string
          request_details?: string | null
          request_type: Database["public"]["Enums"]["arco_request_type"]
          requester_email: string
          requester_name: string
          requester_phone?: string | null
          resolution?: string | null
          resolution_notes?: string | null
          response_deadline?: string
          status?: Database["public"]["Enums"]["arco_request_status"]
          submitted_at?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          assigned_reviewer?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          identity_verification_notes?: string | null
          identity_verification_status?: string
          organization_id?: string | null
          reference?: string
          request_details?: string | null
          request_type?: Database["public"]["Enums"]["arco_request_type"]
          requester_email?: string
          requester_name?: string
          requester_phone?: string | null
          resolution?: string | null
          resolution_notes?: string | null
          response_deadline?: string
          status?: Database["public"]["Enums"]["arco_request_status"]
          submitted_at?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          diff: Json
          entity_id: string | null
          entity_type: string
          id: string
          ip_address: unknown
          org_id: string | null
          session_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          diff?: Json
          entity_id?: string | null
          entity_type: string
          id?: string
          ip_address?: unknown
          org_id?: string | null
          session_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          diff?: Json
          entity_id?: string | null
          entity_type?: string
          id?: string
          ip_address?: unknown
          org_id?: string | null
          session_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          case_id: string | null
          created_at: string
          document_id: string | null
          id: string
          level: string
          message: string | null
          metadata: Json
          stage: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          case_id?: string | null
          created_at?: string
          document_id?: string | null
          id?: string
          level?: string
          message?: string | null
          metadata?: Json
          stage?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          case_id?: string | null
          created_at?: string
          document_id?: string | null
          id?: string
          level?: string
          message?: string | null
          metadata?: Json
          stage?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      authority_relationships: {
        Row: {
          created_at: string
          from_id: string
          from_type: string
          id: string
          relationship: string
          to_id: string
          to_type: string
        }
        Insert: {
          created_at?: string
          from_id: string
          from_type: string
          id?: string
          relationship: string
          to_id: string
          to_type: string
        }
        Update: {
          created_at?: string
          from_id?: string
          from_type?: string
          id?: string
          relationship?: string
          to_id?: string
          to_type?: string
        }
        Relationships: []
      }
      beta_invites: {
        Row: {
          email: string
          invited_at: string
          invited_by: string | null
          note: string | null
          redeemed_at: string | null
          redeemed_user_id: string | null
        }
        Insert: {
          email: string
          invited_at?: string
          invited_by?: string | null
          note?: string | null
          redeemed_at?: string | null
          redeemed_user_id?: string | null
        }
        Update: {
          email?: string
          invited_at?: string
          invited_by?: string | null
          note?: string | null
          redeemed_at?: string | null
          redeemed_user_id?: string | null
        }
        Relationships: []
      }
      billing_payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          id: string
          metadata: Json
          org_id: string
          paid_at: string | null
          provider: string
          provider_payment_id: string | null
          status: string
          subscription_id: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          id?: string
          metadata?: Json
          org_id: string
          paid_at?: string | null
          provider?: string
          provider_payment_id?: string | null
          status: string
          subscription_id?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          id?: string
          metadata?: Json
          org_id?: string
          paid_at?: string | null
          provider?: string
          provider_payment_id?: string | null
          status?: string
          subscription_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_payments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_payments_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "org_subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_plan_notes: {
        Row: {
          created_at: string
          notes: string | null
          plan_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          notes?: string | null
          plan_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          notes?: string | null
          plan_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_plan_notes_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: true
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_plans: {
        Row: {
          active: boolean
          ai_requests_monthly: number | null
          annual_price_cents: number | null
          byok_allowed: boolean
          case_limit: number | null
          code: string
          contact_url: string | null
          created_at: string
          currency: string
          description: string | null
          employee_seats: number
          feature_flags: Json
          features: Json
          id: string
          included_seats: number
          interval: string
          key: string | null
          label: string | null
          max_upload_size_bytes: number | null
          mercadopago_annual_plan_id: string | null
          mercadopago_plan_id: string | null
          monthly_document_pages: number | null
          name: string
          overage_price_cents: number | null
          owner_seats: number
          per_seat_price_cents: number | null
          per_seat_stripe_price_id: string | null
          price_cents: number
          self_serve: boolean
          sort_order: number
          storage_gb_limit: number | null
          storage_limit_bytes: number | null
          stripe_annual_price_id: string | null
          stripe_price_id: string | null
          tagline: string | null
          talk_to_case_monthly: number | null
          team_member_limit: number | null
          total_user_limit: number | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          ai_requests_monthly?: number | null
          annual_price_cents?: number | null
          byok_allowed?: boolean
          case_limit?: number | null
          code: string
          contact_url?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          employee_seats?: number
          feature_flags?: Json
          features?: Json
          id?: string
          included_seats?: number
          interval?: string
          key?: string | null
          label?: string | null
          max_upload_size_bytes?: number | null
          mercadopago_annual_plan_id?: string | null
          mercadopago_plan_id?: string | null
          monthly_document_pages?: number | null
          name: string
          overage_price_cents?: number | null
          owner_seats?: number
          per_seat_price_cents?: number | null
          per_seat_stripe_price_id?: string | null
          price_cents?: number
          self_serve?: boolean
          sort_order?: number
          storage_gb_limit?: number | null
          storage_limit_bytes?: number | null
          stripe_annual_price_id?: string | null
          stripe_price_id?: string | null
          tagline?: string | null
          talk_to_case_monthly?: number | null
          team_member_limit?: number | null
          total_user_limit?: number | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          ai_requests_monthly?: number | null
          annual_price_cents?: number | null
          byok_allowed?: boolean
          case_limit?: number | null
          code?: string
          contact_url?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          employee_seats?: number
          feature_flags?: Json
          features?: Json
          id?: string
          included_seats?: number
          interval?: string
          key?: string | null
          label?: string | null
          max_upload_size_bytes?: number | null
          mercadopago_annual_plan_id?: string | null
          mercadopago_plan_id?: string | null
          monthly_document_pages?: number | null
          name?: string
          overage_price_cents?: number | null
          owner_seats?: number
          per_seat_price_cents?: number | null
          per_seat_stripe_price_id?: string | null
          price_cents?: number
          self_serve?: boolean
          sort_order?: number
          storage_gb_limit?: number | null
          storage_limit_bytes?: number | null
          stripe_annual_price_id?: string | null
          stripe_price_id?: string | null
          tagline?: string | null
          talk_to_case_monthly?: number | null
          team_member_limit?: number | null
          total_user_limit?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      billing_provider_events: {
        Row: {
          actor_id: string | null
          enabled: boolean
          id: string
          occurred_at: string
          provider: string
        }
        Insert: {
          actor_id?: string | null
          enabled: boolean
          id?: string
          occurred_at?: string
          provider: string
        }
        Update: {
          actor_id?: string | null
          enabled?: boolean
          id?: string
          occurred_at?: string
          provider?: string
        }
        Relationships: []
      }
      billing_provider_settings: {
        Row: {
          enabled: boolean
          provider: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          provider: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          provider?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      billing_webhook_events: {
        Row: {
          error_detail: string | null
          event_type: string | null
          id: string
          org_id: string | null
          payload_hash: string | null
          processed_at: string | null
          processing_status: string
          provider: string
          provider_event_id: string
          provider_subscription_id: string | null
          received_at: string
          user_id: string | null
          verified: boolean
        }
        Insert: {
          error_detail?: string | null
          event_type?: string | null
          id?: string
          org_id?: string | null
          payload_hash?: string | null
          processed_at?: string | null
          processing_status?: string
          provider: string
          provider_event_id: string
          provider_subscription_id?: string | null
          received_at?: string
          user_id?: string | null
          verified?: boolean
        }
        Update: {
          error_detail?: string | null
          event_type?: string | null
          id?: string
          org_id?: string | null
          payload_hash?: string | null
          processed_at?: string | null
          processing_status?: string
          provider?: string
          provider_event_id?: string
          provider_subscription_id?: string | null
          received_at?: string
          user_id?: string | null
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "billing_webhook_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      canonical_analysis: {
        Row: {
          analysis_payload: Json
          case_id: string
          created_at: string
          id: string
          pipeline_stages: Json
          status: Database["public"]["Enums"]["canonical_status"]
          updated_at: string
          validation_errors: Json
          version: number
        }
        Insert: {
          analysis_payload?: Json
          case_id: string
          created_at?: string
          id?: string
          pipeline_stages?: Json
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
          validation_errors?: Json
          version?: number
        }
        Update: {
          analysis_payload?: Json
          case_id?: string
          created_at?: string
          id?: string
          pipeline_stages?: Json
          status?: Database["public"]["Enums"]["canonical_status"]
          updated_at?: string
          validation_errors?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "canonical_analysis_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_assignments: {
        Row: {
          assigned_by: string | null
          case_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          assigned_by?: string | null
          case_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          assigned_by?: string | null
          case_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_assignments_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_chat_messages: {
        Row: {
          case_id: string
          cited_finding_ids: string[] | null
          content: string
          created_at: string
          id: string
          message_language: string | null
          metadata: Json | null
          role: string
          user_id: string
        }
        Insert: {
          case_id: string
          cited_finding_ids?: string[] | null
          content: string
          created_at?: string
          id?: string
          message_language?: string | null
          metadata?: Json | null
          role: string
          user_id: string
        }
        Update: {
          case_id?: string
          cited_finding_ids?: string[] | null
          content?: string
          created_at?: string
          id?: string
          message_language?: string | null
          metadata?: Json | null
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_chat_messages_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_classification_evidence: {
        Row: {
          case_id: string
          confidence: number | null
          conflicting_values: Json
          detected_at: string
          field: string
          id: string
          source_document_id: string | null
          source_page: number | null
          source_quote: string | null
          status: string
          user_id: string
          value: string | null
        }
        Insert: {
          case_id: string
          confidence?: number | null
          conflicting_values?: Json
          detected_at?: string
          field: string
          id?: string
          source_document_id?: string | null
          source_page?: number | null
          source_quote?: string | null
          status: string
          user_id: string
          value?: string | null
        }
        Update: {
          case_id?: string
          confidence?: number | null
          conflicting_values?: Json
          detected_at?: string
          field?: string
          id?: string
          source_document_id?: string | null
          source_page?: number | null
          source_quote?: string | null
          status?: string
          user_id?: string
          value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "case_classification_evidence_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_classification_evidence_source_document_id_fkey"
            columns: ["source_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      case_communications: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          body: string
          case_id: string
          channel: string
          created_at: string
          direction: string
          id: string
          status: string
          subject: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          body: string
          case_id: string
          channel?: string
          created_at?: string
          direction?: string
          id?: string
          status?: string
          subject?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          body?: string
          case_id?: string
          channel?: string
          created_at?: string
          direction?: string
          id?: string
          status?: string
          subject?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_communications_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_deadlines: {
        Row: {
          case_id: string
          completed: boolean
          created_at: string
          created_by: string | null
          due_date: string
          id: string
          notes: string | null
          priority: string | null
          source: string
          title: string
        }
        Insert: {
          case_id: string
          completed?: boolean
          created_at?: string
          created_by?: string | null
          due_date: string
          id?: string
          notes?: string | null
          priority?: string | null
          source?: string
          title: string
        }
        Update: {
          case_id?: string
          completed?: boolean
          created_at?: string
          created_by?: string | null
          due_date?: string
          id?: string
          notes?: string | null
          priority?: string | null
          source?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_deadlines_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_decision_reconstructions: {
        Row: {
          case_id: string
          court_status: string | null
          created_at: string
          disposition_remedy_status: string | null
          id: string
          matter_identity_status: string | null
          raw_model_output: Json | null
          reconstruction: Json
          user_id: string
        }
        Insert: {
          case_id: string
          court_status?: string | null
          created_at?: string
          disposition_remedy_status?: string | null
          id?: string
          matter_identity_status?: string | null
          raw_model_output?: Json | null
          reconstruction: Json
          user_id: string
        }
        Update: {
          case_id?: string
          court_status?: string | null
          created_at?: string
          disposition_remedy_status?: string | null
          id?: string
          matter_identity_status?: string | null
          raw_model_output?: Json | null
          reconstruction?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_decision_reconstructions_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_domain_activations: {
        Row: {
          case_id: string
          created_at: string
          domain: string
          evidence_finding_ids: string[]
          id: string
          reason: string
          source: string
          trigger_id: string | null
        }
        Insert: {
          case_id: string
          created_at?: string
          domain: string
          evidence_finding_ids?: string[]
          id?: string
          reason: string
          source: string
          trigger_id?: string | null
        }
        Update: {
          case_id?: string
          created_at?: string
          domain?: string
          evidence_finding_ids?: string[]
          id?: string
          reason?: string
          source?: string
          trigger_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "case_domain_activations_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_events: {
        Row: {
          case_id: string
          created_at: string
          event_type: string
          id: string
          location: string | null
          notes: string | null
          reminder_channels: string[]
          reminder_enabled: boolean
          reminder_fired_at: string | null
          reminder_lead_minutes: number
          scheduled_at: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          case_id: string
          created_at?: string
          event_type?: string
          id?: string
          location?: string | null
          notes?: string | null
          reminder_channels?: string[]
          reminder_enabled?: boolean
          reminder_fired_at?: string | null
          reminder_lead_minutes?: number
          scheduled_at: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          case_id?: string
          created_at?: string
          event_type?: string
          id?: string
          location?: string | null
          notes?: string | null
          reminder_channels?: string[]
          reminder_enabled?: boolean
          reminder_fired_at?: string | null
          reminder_lead_minutes?: number
          scheduled_at?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_events_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_finding_patches: {
        Row: {
          action: string
          applied_at: string
          case_id: string
          chat_message_id: string | null
          confidence: number | null
          created_at: string
          finding_id: string | null
          id: string
          reason: string
          report_version: number | null
          result_finding_id: string | null
          source_document_id: string | null
          source_page: number | null
          source_quote: string | null
          user_id: string
        }
        Insert: {
          action: string
          applied_at?: string
          case_id: string
          chat_message_id?: string | null
          confidence?: number | null
          created_at?: string
          finding_id?: string | null
          id?: string
          reason: string
          report_version?: number | null
          result_finding_id?: string | null
          source_document_id?: string | null
          source_page?: number | null
          source_quote?: string | null
          user_id: string
        }
        Update: {
          action?: string
          applied_at?: string
          case_id?: string
          chat_message_id?: string | null
          confidence?: number | null
          created_at?: string
          finding_id?: string | null
          id?: string
          reason?: string
          report_version?: number | null
          result_finding_id?: string | null
          source_document_id?: string | null
          source_page?: number | null
          source_quote?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_finding_patches_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_finding_patches_chat_message_id_fkey"
            columns: ["chat_message_id"]
            isOneToOne: false
            referencedRelation: "case_chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_finding_patches_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "case_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_finding_patches_result_finding_id_fkey"
            columns: ["result_finding_id"]
            isOneToOne: false
            referencedRelation: "case_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_finding_patches_source_document_id_fkey"
            columns: ["source_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      case_findings: {
        Row: {
          adoption_status: string | null
          affected_party: string | null
          audit_classification: string | null
          authority_level: number
          benefited_party: string | null
          canonical_finding_id: string | null
          canonical_fingerprint: string | null
          case_id: string
          category: string
          category_key: string | null
          citation_quality: number | null
          confidence: number
          confidence_dimensions: Json | null
          created_at: string
          derived_from_finding_ids: string[]
          description: string
          evidence_refs: Json | null
          evidence_strength: number | null
          evidence_type: string | null
          finding_status: string
          finding_type: string | null
          id: string
          impact_direction: string | null
          legal_significance: string | null
          lifecycle_status: string | null
          metadata: Json | null
          potential_impact: string | null
          priority: number | null
          projected_from_row_id: string | null
          projected_from_table: string | null
          proposition_type: string | null
          rationale: Json | null
          reason_for_score_effect: string | null
          reconciliation_state: string | null
          related_finding_ids: string[] | null
          score_dimension: string | null
          severity: string
          source_doc_ids: string[] | null
          source_document_id: string | null
          source_module: string
          source_page: number | null
          source_quote: string | null
          speaker_role: string | null
          strategic_significance: string | null
          supporting_engines: string[]
          tags: string[] | null
          title: string
          updated_at: string
          user_id: string
          verification_notes: string | null
          verification_status: string
          verified_at: string | null
        }
        Insert: {
          adoption_status?: string | null
          affected_party?: string | null
          audit_classification?: string | null
          authority_level?: number
          benefited_party?: string | null
          canonical_finding_id?: string | null
          canonical_fingerprint?: string | null
          case_id: string
          category: string
          category_key?: string | null
          citation_quality?: number | null
          confidence?: number
          confidence_dimensions?: Json | null
          created_at?: string
          derived_from_finding_ids?: string[]
          description: string
          evidence_refs?: Json | null
          evidence_strength?: number | null
          evidence_type?: string | null
          finding_status?: string
          finding_type?: string | null
          id?: string
          impact_direction?: string | null
          legal_significance?: string | null
          lifecycle_status?: string | null
          metadata?: Json | null
          potential_impact?: string | null
          priority?: number | null
          projected_from_row_id?: string | null
          projected_from_table?: string | null
          proposition_type?: string | null
          rationale?: Json | null
          reason_for_score_effect?: string | null
          reconciliation_state?: string | null
          related_finding_ids?: string[] | null
          score_dimension?: string | null
          severity?: string
          source_doc_ids?: string[] | null
          source_document_id?: string | null
          source_module: string
          source_page?: number | null
          source_quote?: string | null
          speaker_role?: string | null
          strategic_significance?: string | null
          supporting_engines?: string[]
          tags?: string[] | null
          title: string
          updated_at?: string
          user_id: string
          verification_notes?: string | null
          verification_status?: string
          verified_at?: string | null
        }
        Update: {
          adoption_status?: string | null
          affected_party?: string | null
          audit_classification?: string | null
          authority_level?: number
          benefited_party?: string | null
          canonical_finding_id?: string | null
          canonical_fingerprint?: string | null
          case_id?: string
          category?: string
          category_key?: string | null
          citation_quality?: number | null
          confidence?: number
          confidence_dimensions?: Json | null
          created_at?: string
          derived_from_finding_ids?: string[]
          description?: string
          evidence_refs?: Json | null
          evidence_strength?: number | null
          evidence_type?: string | null
          finding_status?: string
          finding_type?: string | null
          id?: string
          impact_direction?: string | null
          legal_significance?: string | null
          lifecycle_status?: string | null
          metadata?: Json | null
          potential_impact?: string | null
          priority?: number | null
          projected_from_row_id?: string | null
          projected_from_table?: string | null
          proposition_type?: string | null
          rationale?: Json | null
          reason_for_score_effect?: string | null
          reconciliation_state?: string | null
          related_finding_ids?: string[] | null
          score_dimension?: string | null
          severity?: string
          source_doc_ids?: string[] | null
          source_document_id?: string | null
          source_module?: string
          source_page?: number | null
          source_quote?: string | null
          speaker_role?: string | null
          strategic_significance?: string | null
          supporting_engines?: string[]
          tags?: string[] | null
          title?: string
          updated_at?: string
          user_id?: string
          verification_notes?: string | null
          verification_status?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "case_findings_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_motion_drafts: {
        Row: {
          attorney_notes: string
          body_markdown: string
          case_id: string
          created_at: string
          error_message: string | null
          id: string
          motion_title: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attorney_notes?: string
          body_markdown?: string
          case_id: string
          created_at?: string
          error_message?: string | null
          id?: string
          motion_title: string
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attorney_notes?: string
          body_markdown?: string
          case_id?: string
          created_at?: string
          error_message?: string | null
          id?: string
          motion_title?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_motion_drafts_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_opportunities: {
        Row: {
          canonical_role: string | null
          case_id: string
          citations: Json | null
          confidence: number | null
          counter_response: string | null
          created_at: string
          description: string
          execution_id: string | null
          finding_type: string | null
          id: string
          opportunity_type: string
          recommended_investigations: Json | null
          recommended_motions: Json | null
          recommended_questions: Json | null
          severity: string | null
          side: string
          source_finding_ids: string[] | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          canonical_role?: string | null
          case_id: string
          citations?: Json | null
          confidence?: number | null
          counter_response?: string | null
          created_at?: string
          description: string
          execution_id?: string | null
          finding_type?: string | null
          id?: string
          opportunity_type: string
          recommended_investigations?: Json | null
          recommended_motions?: Json | null
          recommended_questions?: Json | null
          severity?: string | null
          side: string
          source_finding_ids?: string[] | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          canonical_role?: string | null
          case_id?: string
          citations?: Json | null
          confidence?: number | null
          counter_response?: string | null
          created_at?: string
          description?: string
          execution_id?: string | null
          finding_type?: string | null
          id?: string
          opportunity_type?: string
          recommended_investigations?: Json | null
          recommended_motions?: Json | null
          recommended_questions?: Json | null
          severity?: string | null
          side?: string
          source_finding_ids?: string[] | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_opportunities_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_outcome_assessments: {
        Row: {
          biggest_risk: string | null
          both_sides: Json
          case_analysis_mode: string
          case_id: string
          citation_reviews: Json
          confidence: string
          created_at: string
          factors: Json
          favorable_pct: number
          finding_reviews: Json
          id: string
          most_important_missing_evidence: string | null
          no_material_error_identified: boolean
          outcome_status: string
          overall_position: string
          principal_strength: string | null
          principal_weakness: string | null
          raw_model_output: Json | null
          unfavorable_pct: number
          user_id: string
          what_could_change: Json
        }
        Insert: {
          biggest_risk?: string | null
          both_sides?: Json
          case_analysis_mode: string
          case_id: string
          citation_reviews?: Json
          confidence: string
          created_at?: string
          factors?: Json
          favorable_pct: number
          finding_reviews?: Json
          id?: string
          most_important_missing_evidence?: string | null
          no_material_error_identified?: boolean
          outcome_status?: string
          overall_position: string
          principal_strength?: string | null
          principal_weakness?: string | null
          raw_model_output?: Json | null
          unfavorable_pct: number
          user_id: string
          what_could_change?: Json
        }
        Update: {
          biggest_risk?: string | null
          both_sides?: Json
          case_analysis_mode?: string
          case_id?: string
          citation_reviews?: Json
          confidence?: string
          created_at?: string
          factors?: Json
          favorable_pct?: number
          finding_reviews?: Json
          id?: string
          most_important_missing_evidence?: string | null
          no_material_error_identified?: boolean
          outcome_status?: string
          overall_position?: string
          principal_strength?: string | null
          principal_weakness?: string | null
          raw_model_output?: Json | null
          unfavorable_pct?: number
          user_id?: string
          what_could_change?: Json
        }
        Relationships: [
          {
            foreignKeyName: "case_outcome_assessments_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_parties: {
        Row: {
          case_id: string
          contact: Json
          created_at: string
          id: string
          name: string
          party_role: string
          role_description: string | null
          sort_order: number
          updated_at: string
          user_id: string
        }
        Insert: {
          case_id: string
          contact?: Json
          created_at?: string
          id?: string
          name: string
          party_role?: string
          role_description?: string | null
          sort_order?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          case_id?: string
          contact?: Json
          created_at?: string
          id?: string
          name?: string
          party_role?: string
          role_description?: string | null
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_parties_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_penal_dispositions: {
        Row: {
          amparo_result: string | null
          case_id: string
          confidence: number
          conviction_status: string | null
          court: string | null
          created_at: string
          decision_date: string | null
          id: string
          operative_orders: Json
          procedure_reopened: boolean | null
          remand: boolean
          remand_court: string | null
          remand_instructions: Json
          result: string | null
          sentence_status: string | null
          source_document_id: string
          source_page: number | null
          source_quote: string
          status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amparo_result?: string | null
          case_id: string
          confidence: number
          conviction_status?: string | null
          court?: string | null
          created_at?: string
          decision_date?: string | null
          id?: string
          operative_orders?: Json
          procedure_reopened?: boolean | null
          remand?: boolean
          remand_court?: string | null
          remand_instructions?: Json
          result?: string | null
          sentence_status?: string | null
          source_document_id: string
          source_page?: number | null
          source_quote: string
          status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amparo_result?: string | null
          case_id?: string
          confidence?: number
          conviction_status?: string | null
          court?: string | null
          created_at?: string
          decision_date?: string | null
          id?: string
          operative_orders?: Json
          procedure_reopened?: boolean | null
          remand?: boolean
          remand_court?: string | null
          remand_instructions?: Json
          result?: string | null
          sentence_status?: string | null
          source_document_id?: string
          source_page?: number | null
          source_quote?: string
          status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_penal_dispositions_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_penal_dispositions_source_document_id_fkey"
            columns: ["source_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      case_perspectives: {
        Row: {
          case_id: string
          confidence: number | null
          confidence_label: string | null
          counter_arguments: Json | null
          created_at: string
          finding_type: string | null
          id: string
          key_evidence: Json | null
          opposing_arguments: Json | null
          perspective: string
          recommended_actions: Json | null
          risk_score: number | null
          strength_score: number | null
          strengths: Json | null
          summary: string | null
          updated_at: string
          user_id: string
          weaknesses: Json | null
        }
        Insert: {
          case_id: string
          confidence?: number | null
          confidence_label?: string | null
          counter_arguments?: Json | null
          created_at?: string
          finding_type?: string | null
          id?: string
          key_evidence?: Json | null
          opposing_arguments?: Json | null
          perspective: string
          recommended_actions?: Json | null
          risk_score?: number | null
          strength_score?: number | null
          strengths?: Json | null
          summary?: string | null
          updated_at?: string
          user_id: string
          weaknesses?: Json | null
        }
        Update: {
          case_id?: string
          confidence?: number | null
          confidence_label?: string | null
          counter_arguments?: Json | null
          created_at?: string
          finding_type?: string | null
          id?: string
          key_evidence?: Json | null
          opposing_arguments?: Json | null
          perspective?: string
          recommended_actions?: Json | null
          risk_score?: number | null
          strength_score?: number | null
          strengths?: Json | null
          summary?: string | null
          updated_at?: string
          user_id?: string
          weaknesses?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "case_perspectives_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_scores: {
        Row: {
          appeal_risk: number | null
          case_id: string
          case_quality: number | null
          chain_of_custody: number | null
          constitutional_compliance: number | null
          conviction_risk: number | null
          created_at: string
          dimension_breakdowns: Json | null
          evidence_strength: number | null
          investigation_completeness: number | null
          methodology: string | null
          negative_contributors: Json | null
          overall_confidence: number | null
          positive_contributors: Json | null
          rationale: Json | null
          source_finding_ids: string[] | null
          timeline_integrity: number | null
          updated_at: string
          user_id: string
          witness_reliability: number | null
        }
        Insert: {
          appeal_risk?: number | null
          case_id: string
          case_quality?: number | null
          chain_of_custody?: number | null
          constitutional_compliance?: number | null
          conviction_risk?: number | null
          created_at?: string
          dimension_breakdowns?: Json | null
          evidence_strength?: number | null
          investigation_completeness?: number | null
          methodology?: string | null
          negative_contributors?: Json | null
          overall_confidence?: number | null
          positive_contributors?: Json | null
          rationale?: Json | null
          source_finding_ids?: string[] | null
          timeline_integrity?: number | null
          updated_at?: string
          user_id: string
          witness_reliability?: number | null
        }
        Update: {
          appeal_risk?: number | null
          case_id?: string
          case_quality?: number | null
          chain_of_custody?: number | null
          constitutional_compliance?: number | null
          conviction_risk?: number | null
          created_at?: string
          dimension_breakdowns?: Json | null
          evidence_strength?: number | null
          investigation_completeness?: number | null
          methodology?: string | null
          negative_contributors?: Json | null
          overall_confidence?: number | null
          positive_contributors?: Json | null
          rationale?: Json | null
          source_finding_ids?: string[] | null
          timeline_integrity?: number | null
          updated_at?: string
          user_id?: string
          witness_reliability?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "case_scores_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_strategy: {
        Row: {
          anticipated_opposing: Json | null
          case_id: string
          case_strength_score: number | null
          confidence_label: string | null
          counter_arguments: Json | null
          created_at: string
          id: string
          motion_rankings: Json | null
          next_actions: Json | null
          perspective: string
          risk_score: number | null
          summary: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          anticipated_opposing?: Json | null
          case_id: string
          case_strength_score?: number | null
          confidence_label?: string | null
          counter_arguments?: Json | null
          created_at?: string
          id?: string
          motion_rankings?: Json | null
          next_actions?: Json | null
          perspective?: string
          risk_score?: number | null
          summary?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          anticipated_opposing?: Json | null
          case_id?: string
          case_strength_score?: number | null
          confidence_label?: string | null
          counter_arguments?: Json | null
          created_at?: string
          id?: string
          motion_rankings?: Json | null
          next_actions?: Json | null
          perspective?: string
          risk_score?: number | null
          summary?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_strategy_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_strategy_center: {
        Row: {
          biggest_evidentiary_gap: Json | null
          biggest_trial_risk: Json | null
          biggest_weakness: Json | null
          case_id: string
          created_at: string
          expected_defense: Json | null
          generated_at: string | null
          lead_counsel_assessment: string | null
          most_dangerous_witness: Json | null
          primary_trial_theme: Json | null
          recommended_counter_strategy: string | null
          settlement_leverage: Json | null
          updated_at: string
          user_id: string
          weekly_priorities: Json | null
          winning_the_case_dashboard: Json | null
        }
        Insert: {
          biggest_evidentiary_gap?: Json | null
          biggest_trial_risk?: Json | null
          biggest_weakness?: Json | null
          case_id: string
          created_at?: string
          expected_defense?: Json | null
          generated_at?: string | null
          lead_counsel_assessment?: string | null
          most_dangerous_witness?: Json | null
          primary_trial_theme?: Json | null
          recommended_counter_strategy?: string | null
          settlement_leverage?: Json | null
          updated_at?: string
          user_id: string
          weekly_priorities?: Json | null
          winning_the_case_dashboard?: Json | null
        }
        Update: {
          biggest_evidentiary_gap?: Json | null
          biggest_trial_risk?: Json | null
          biggest_weakness?: Json | null
          case_id?: string
          created_at?: string
          expected_defense?: Json | null
          generated_at?: string | null
          lead_counsel_assessment?: string | null
          most_dangerous_witness?: Json | null
          primary_trial_theme?: Json | null
          recommended_counter_strategy?: string | null
          settlement_leverage?: Json | null
          updated_at?: string
          user_id?: string
          weekly_priorities?: Json | null
          winning_the_case_dashboard?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "case_strategy_center_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_tasks: {
        Row: {
          assignee_hint: string | null
          case_id: string
          created_at: string
          description: string | null
          due_date: string | null
          id: string
          priority: string
          reminder_channels: string[]
          reminder_enabled: boolean
          reminder_fired_at: string | null
          reminder_lead_minutes: number
          status: string
          template_key: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assignee_hint?: string | null
          case_id: string
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          priority?: string
          reminder_channels?: string[]
          reminder_enabled?: boolean
          reminder_fired_at?: string | null
          reminder_lead_minutes?: number
          status?: string
          template_key?: string | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          assignee_hint?: string | null
          case_id?: string
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          priority?: string
          reminder_channels?: string[]
          reminder_enabled?: boolean
          reminder_fired_at?: string | null
          reminder_lead_minutes?: number
          status?: string
          template_key?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_tasks_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_theories: {
        Row: {
          case_id: string
          citations: Json | null
          confidence: number | null
          contradicting_evidence: Json | null
          created_at: string
          execution_id: string | null
          finding_type: string | null
          id: string
          key_assumptions: Json | null
          missing_evidence: Json | null
          narrative: string
          risk: string | null
          supporting_evidence: Json | null
          theory_name: string | null
          theory_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          case_id: string
          citations?: Json | null
          confidence?: number | null
          contradicting_evidence?: Json | null
          created_at?: string
          execution_id?: string | null
          finding_type?: string | null
          id?: string
          key_assumptions?: Json | null
          missing_evidence?: Json | null
          narrative: string
          risk?: string | null
          supporting_evidence?: Json | null
          theory_name?: string | null
          theory_type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          case_id?: string
          citations?: Json | null
          confidence?: number | null
          contradicting_evidence?: Json | null
          created_at?: string
          execution_id?: string | null
          finding_type?: string | null
          id?: string
          key_assumptions?: Json | null
          missing_evidence?: Json | null
          narrative?: string
          risk?: string | null
          supporting_evidence?: Json | null
          theory_name?: string | null
          theory_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_theories_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_timeline_events: {
        Row: {
          canonical_id: string
          case_id: string
          created_at: string
          description: string | null
          event_date: string | null
          event_type: string
          id: string
          source_document_id: string | null
          source_page: number | null
          source_quote: string | null
          superseded_by: string | null
          updated_at: string
        }
        Insert: {
          canonical_id: string
          case_id: string
          created_at?: string
          description?: string | null
          event_date?: string | null
          event_type?: string
          id?: string
          source_document_id?: string | null
          source_page?: number | null
          source_quote?: string | null
          superseded_by?: string | null
          updated_at?: string
        }
        Update: {
          canonical_id?: string
          case_id?: string
          created_at?: string
          description?: string | null
          event_date?: string | null
          event_type?: string
          id?: string
          source_document_id?: string | null
          source_page?: number | null
          source_quote?: string | null
          superseded_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_timeline_events_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_timeline_events_source_document_id_fkey"
            columns: ["source_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_timeline_events_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "case_timeline_events"
            referencedColumns: ["id"]
          },
        ]
      }
      case_trial_prep: {
        Row: {
          case_id: string
          case_type: string | null
          civil_metrics: Json | null
          closing_themes: Json | null
          created_at: string
          exhibit_order: Json | null
          jury_acquittal_pct: number | null
          jury_appeal_pct: number | null
          jury_concerns: Json | null
          jury_conviction_pct: number | null
          jury_settlement_pct: number | null
          likely_objections: Json | null
          most_damaging_evidence: Json | null
          most_persuasive_evidence: Json | null
          opening_themes: Json | null
          penal_metrics: Json | null
          trial_risks: Json | null
          trial_strengths: Json | null
          updated_at: string
          user_id: string
          witness_order: Json | null
        }
        Insert: {
          case_id: string
          case_type?: string | null
          civil_metrics?: Json | null
          closing_themes?: Json | null
          created_at?: string
          exhibit_order?: Json | null
          jury_acquittal_pct?: number | null
          jury_appeal_pct?: number | null
          jury_concerns?: Json | null
          jury_conviction_pct?: number | null
          jury_settlement_pct?: number | null
          likely_objections?: Json | null
          most_damaging_evidence?: Json | null
          most_persuasive_evidence?: Json | null
          opening_themes?: Json | null
          penal_metrics?: Json | null
          trial_risks?: Json | null
          trial_strengths?: Json | null
          updated_at?: string
          user_id: string
          witness_order?: Json | null
        }
        Update: {
          case_id?: string
          case_type?: string | null
          civil_metrics?: Json | null
          closing_themes?: Json | null
          created_at?: string
          exhibit_order?: Json | null
          jury_acquittal_pct?: number | null
          jury_appeal_pct?: number | null
          jury_concerns?: Json | null
          jury_conviction_pct?: number | null
          jury_settlement_pct?: number | null
          likely_objections?: Json | null
          most_damaging_evidence?: Json | null
          most_persuasive_evidence?: Json | null
          opening_themes?: Json | null
          penal_metrics?: Json | null
          trial_risks?: Json | null
          trial_strengths?: Json | null
          updated_at?: string
          user_id?: string
          witness_order?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "case_trial_prep_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_witnesses: {
        Row: {
          bias: number | null
          case_id: string
          citations: Json | null
          consistency: number | null
          corroboration: number | null
          created_at: string
          credibility_risk: number | null
          cross_exam_questions: Json | null
          finding_type: string | null
          follow_up_questions: Json | null
          id: string
          impeachment_questions: Json | null
          name: string
          observation_opportunity: number | null
          rationale: Json | null
          reliability: number | null
          role: string | null
          source_doc_ids: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          bias?: number | null
          case_id: string
          citations?: Json | null
          consistency?: number | null
          corroboration?: number | null
          created_at?: string
          credibility_risk?: number | null
          cross_exam_questions?: Json | null
          finding_type?: string | null
          follow_up_questions?: Json | null
          id?: string
          impeachment_questions?: Json | null
          name: string
          observation_opportunity?: number | null
          rationale?: Json | null
          reliability?: number | null
          role?: string | null
          source_doc_ids?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          bias?: number | null
          case_id?: string
          citations?: Json | null
          consistency?: number | null
          corroboration?: number | null
          created_at?: string
          credibility_risk?: number | null
          cross_exam_questions?: Json | null
          finding_type?: string | null
          follow_up_questions?: Json | null
          id?: string
          impeachment_questions?: Json | null
          name?: string
          observation_opportunity?: number | null
          rationale?: Json | null
          reliability?: number | null
          role?: string | null
          source_doc_ids?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_witnesses_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      case_work_product: {
        Row: {
          body_markdown: string
          case_id: string
          cited_finding_ids: string[] | null
          created_at: string
          document_type: string
          error_message: string | null
          generation_failed: boolean
          id: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body_markdown: string
          case_id: string
          cited_finding_ids?: string[] | null
          created_at?: string
          document_type: string
          error_message?: string | null
          generation_failed?: boolean
          id?: string
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body_markdown?: string
          case_id?: string
          cited_finding_ids?: string[] | null
          created_at?: string
          document_type?: string
          error_message?: string | null
          generation_failed?: boolean
          id?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_work_product_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      cases: {
        Row: {
          additional_domains: string[]
          agents_at: string | null
          analysis_at: string | null
          analysis_mode: string
          archived_at: string | null
          attack_surface: Json
          cancel_requested: boolean
          case_analysis_mode: string
          case_language: string | null
          case_type: string | null
          case_type_source: string | null
          case_type_verification_status: string | null
          client_id: string | null
          completed_at: string | null
          contradiction_at: string | null
          created_at: string
          deleted_at: string | null
          description: string | null
          discovery_at: string | null
          error: string | null
          evidence_intel_at: string | null
          execution_id: string | null
          execution_started_at: string | null
          extracted_at: string | null
          extraction_report: Json | null
          firm_id: string | null
          hallucination_at: string | null
          hallucination_report: Json | null
          id: string
          jurisdiction: string | null
          jurisdiction_profile: Json | null
          legal_qa_report: Json | null
          lifecycle_status: string | null
          matter_metadata: Json | null
          name: string
          next_stage: string | null
          opportunities_at: string | null
          perspectives_at: string | null
          procedural_compliance: Json | null
          procedural_vehicle: string | null
          progress: number
          queued_at: string | null
          report_at: string | null
          report_checkpoint_count: number
          report_language: string
          scored_at: string | null
          shared_brief: Json | null
          shared_brief_at: string | null
          stall_auto_retry_count: number
          stall_reason: string | null
          status: Database["public"]["Enums"]["case_status"]
          status_message: string | null
          strategy_at: string | null
          strategy_center_at: string | null
          theories_at: string | null
          trial_prep_at: string | null
          underlying_materia: string | null
          updated_at: string
          user_id: string
          witnesses_at: string | null
          work_product_at: string | null
          worker_lease_until: string | null
        }
        Insert: {
          additional_domains?: string[]
          agents_at?: string | null
          analysis_at?: string | null
          analysis_mode: string
          archived_at?: string | null
          attack_surface?: Json
          cancel_requested?: boolean
          case_analysis_mode?: string
          case_language?: string | null
          case_type?: string | null
          case_type_source?: string | null
          case_type_verification_status?: string | null
          client_id?: string | null
          completed_at?: string | null
          contradiction_at?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          discovery_at?: string | null
          error?: string | null
          evidence_intel_at?: string | null
          execution_id?: string | null
          execution_started_at?: string | null
          extracted_at?: string | null
          extraction_report?: Json | null
          firm_id?: string | null
          hallucination_at?: string | null
          hallucination_report?: Json | null
          id?: string
          jurisdiction?: string | null
          jurisdiction_profile?: Json | null
          legal_qa_report?: Json | null
          lifecycle_status?: string | null
          matter_metadata?: Json | null
          name: string
          next_stage?: string | null
          opportunities_at?: string | null
          perspectives_at?: string | null
          procedural_compliance?: Json | null
          procedural_vehicle?: string | null
          progress?: number
          queued_at?: string | null
          report_at?: string | null
          report_checkpoint_count?: number
          report_language?: string
          scored_at?: string | null
          shared_brief?: Json | null
          shared_brief_at?: string | null
          stall_auto_retry_count?: number
          stall_reason?: string | null
          status?: Database["public"]["Enums"]["case_status"]
          status_message?: string | null
          strategy_at?: string | null
          strategy_center_at?: string | null
          theories_at?: string | null
          trial_prep_at?: string | null
          underlying_materia?: string | null
          updated_at?: string
          user_id: string
          witnesses_at?: string | null
          work_product_at?: string | null
          worker_lease_until?: string | null
        }
        Update: {
          additional_domains?: string[]
          agents_at?: string | null
          analysis_at?: string | null
          analysis_mode?: string
          archived_at?: string | null
          attack_surface?: Json
          cancel_requested?: boolean
          case_analysis_mode?: string
          case_language?: string | null
          case_type?: string | null
          case_type_source?: string | null
          case_type_verification_status?: string | null
          client_id?: string | null
          completed_at?: string | null
          contradiction_at?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          discovery_at?: string | null
          error?: string | null
          evidence_intel_at?: string | null
          execution_id?: string | null
          execution_started_at?: string | null
          extracted_at?: string | null
          extraction_report?: Json | null
          firm_id?: string | null
          hallucination_at?: string | null
          hallucination_report?: Json | null
          id?: string
          jurisdiction?: string | null
          jurisdiction_profile?: Json | null
          legal_qa_report?: Json | null
          lifecycle_status?: string | null
          matter_metadata?: Json | null
          name?: string
          next_stage?: string | null
          opportunities_at?: string | null
          perspectives_at?: string | null
          procedural_compliance?: Json | null
          procedural_vehicle?: string | null
          progress?: number
          queued_at?: string | null
          report_at?: string | null
          report_checkpoint_count?: number
          report_language?: string
          scored_at?: string | null
          shared_brief?: Json | null
          shared_brief_at?: string | null
          stall_auto_retry_count?: number
          stall_reason?: string | null
          status?: Database["public"]["Enums"]["case_status"]
          status_message?: string | null
          strategy_at?: string | null
          strategy_center_at?: string | null
          theories_at?: string | null
          trial_prep_at?: string | null
          underlying_materia?: string | null
          updated_at?: string
          user_id?: string
          witnesses_at?: string | null
          work_product_at?: string | null
          worker_lease_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cases_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cases_firm_id_fkey"
            columns: ["firm_id"]
            isOneToOne: false
            referencedRelation: "firms"
            referencedColumns: ["id"]
          },
        ]
      }
      citation_cache: {
        Row: {
          citation_text: string
          id: string
          last_checked_at: string
          resolved_article_id: string | null
          resolved_authority_id: string | null
          verification_status: Database["public"]["Enums"]["legal_verification_status"]
        }
        Insert: {
          citation_text: string
          id?: string
          last_checked_at?: string
          resolved_article_id?: string | null
          resolved_authority_id?: string | null
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Update: {
          citation_text?: string
          id?: string
          last_checked_at?: string
          resolved_article_id?: string | null
          resolved_authority_id?: string | null
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Relationships: [
          {
            foreignKeyName: "citation_cache_resolved_article_id_fkey"
            columns: ["resolved_article_id"]
            isOneToOne: false
            referencedRelation: "legal_articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "citation_cache_resolved_authority_id_fkey"
            columns: ["resolved_authority_id"]
            isOneToOne: false
            referencedRelation: "legal_authorities"
            referencedColumns: ["id"]
          },
        ]
      }
      client_assignments: {
        Row: {
          assigned_by: string | null
          client_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          assigned_by?: string | null
          client_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          assigned_by?: string | null
          client_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          address: string | null
          client_type: string
          created_at: string
          created_by: string
          display_name: string
          email: string | null
          id: string
          legal_name: string | null
          notes: string | null
          org_id: string | null
          phone: string | null
          reference_number: string | null
          responsible_attorney: string | null
          rfc: string | null
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          address?: string | null
          client_type?: string
          created_at?: string
          created_by: string
          display_name: string
          email?: string | null
          id?: string
          legal_name?: string | null
          notes?: string | null
          org_id?: string | null
          phone?: string | null
          reference_number?: string | null
          responsible_attorney?: string | null
          rfc?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          address?: string | null
          client_type?: string
          created_at?: string
          created_by?: string
          display_name?: string
          email?: string | null
          id?: string
          legal_name?: string | null
          notes?: string | null
          org_id?: string | null
          phone?: string | null
          reference_number?: string | null
          responsible_attorney?: string | null
          rfc?: string | null
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      closing_milestones: {
        Row: {
          case_id: string
          created_at: string
          id: string
          label_en: string
          label_es: string
          milestone_key: string
          percent_complete: number
          updated_at: string
          user_id: string
          weight: number
        }
        Insert: {
          case_id: string
          created_at?: string
          id?: string
          label_en: string
          label_es: string
          milestone_key: string
          percent_complete?: number
          updated_at?: string
          user_id: string
          weight?: number
        }
        Update: {
          case_id?: string
          created_at?: string
          id?: string
          label_en?: string
          label_es?: string
          milestone_key?: string
          percent_complete?: number
          updated_at?: string
          user_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "closing_milestones_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_activity_log: {
        Row: {
          action: string
          actor_id: string
          created_at: string
          id: string
          metadata: Json | null
          org_id: string | null
          resource_id: string | null
          resource_type: string
          user_id: string | null
        }
        Insert: {
          action: string
          actor_id: string
          created_at?: string
          id?: string
          metadata?: Json | null
          org_id?: string | null
          resource_id?: string | null
          resource_type: string
          user_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          org_id?: string | null
          resource_id?: string | null
          resource_type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_activity_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      cross_agent_audit: {
        Row: {
          case_id: string
          checks: Json
          conflicts: Json
          created_at: string
          id: string
          report_version: number | null
          status: string
          user_id: string
        }
        Insert: {
          case_id: string
          checks?: Json
          conflicts?: Json
          created_at?: string
          id?: string
          report_version?: number | null
          status?: string
          user_id: string
        }
        Update: {
          case_id?: string
          checks?: Json
          conflicts?: Json
          created_at?: string
          id?: string
          report_version?: number | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cross_agent_audit_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_case_documents: {
        Row: {
          created_at: string
          demo_case_id: string
          doc_type: string
          file_name: string
          file_size: number
          id: string
          sort_order: number
          storage_path: string
        }
        Insert: {
          created_at?: string
          demo_case_id: string
          doc_type: string
          file_name: string
          file_size?: number
          id?: string
          sort_order?: number
          storage_path: string
        }
        Update: {
          created_at?: string
          demo_case_id?: string
          doc_type?: string
          file_name?: string
          file_size?: number
          id?: string
          sort_order?: number
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "demo_case_documents_demo_case_id_fkey"
            columns: ["demo_case_id"]
            isOneToOne: false
            referencedRelation: "demo_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_cases: {
        Row: {
          case_type: string
          created_at: string
          description: string
          id: string
          name: string
          published: boolean
          slug: string
          sort_order: number
          summary: string
          thumbnail_path: string | null
          updated_at: string
        }
        Insert: {
          case_type: string
          created_at?: string
          description?: string
          id?: string
          name: string
          published?: boolean
          slug: string
          sort_order?: number
          summary?: string
          thumbnail_path?: string | null
          updated_at?: string
        }
        Update: {
          case_type?: string
          created_at?: string
          description?: string
          id?: string
          name?: string
          published?: boolean
          slug?: string
          sort_order?: number
          summary?: string
          thumbnail_path?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      document_pages: {
        Row: {
          case_id: string
          char_count: number
          created_at: string
          document_id: string
          id: string
          page: number
          text: string
          user_id: string
        }
        Insert: {
          case_id: string
          char_count?: number
          created_at?: string
          document_id: string
          id?: string
          page: number
          text?: string
          user_id: string
        }
        Update: {
          case_id?: string
          char_count?: number
          created_at?: string
          document_id?: string
          id?: string
          page?: number
          text?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_pages_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_pages_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      document_processing_jobs: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          document_id: string
          error: string | null
          id: string
          org_id: string
          payload: Json
          progress: number
          scheduled_at: string
          stage: string
          started_at: string | null
          status: Database["public"]["Enums"]["doc_processing_status"]
          updated_at: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          document_id: string
          error?: string | null
          id?: string
          org_id: string
          payload?: Json
          progress?: number
          scheduled_at?: string
          stage: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["doc_processing_status"]
          updated_at?: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          document_id?: string
          error?: string | null
          id?: string
          org_id?: string
          payload?: Json
          progress?: number
          scheduled_at?: string
          stage?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["doc_processing_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_processing_jobs_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "matter_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_processing_jobs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_versions: {
        Row: {
          checksum: string | null
          created_at: string
          document_id: string
          id: string
          mime_type: string | null
          notes: string | null
          org_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_by: string | null
          version: number
        }
        Insert: {
          checksum?: string | null
          created_at?: string
          document_id: string
          id?: string
          mime_type?: string | null
          notes?: string | null
          org_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_by?: string | null
          version: number
        }
        Update: {
          checksum?: string | null
          created_at?: string
          document_id?: string
          id?: string
          mime_type?: string | null
          notes?: string | null
          org_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_by?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "document_versions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "matter_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          archived_at: string | null
          case_id: string
          content_hash: string
          created_at: string
          entities: Json
          error: string | null
          evidence_scope: string
          extracted_text: string | null
          extraction_retry_count: number
          filename: string
          id: string
          last_extraction_attempt_at: string | null
          metadata: Json
          mime_type: string | null
          purpose: string | null
          size_bytes: number | null
          status: Database["public"]["Enums"]["doc_status"]
          storage_path: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          case_id: string
          content_hash: string
          created_at?: string
          entities?: Json
          error?: string | null
          evidence_scope?: string
          extracted_text?: string | null
          extraction_retry_count?: number
          filename: string
          id?: string
          last_extraction_attempt_at?: string | null
          metadata?: Json
          mime_type?: string | null
          purpose?: string | null
          size_bytes?: number | null
          status?: Database["public"]["Enums"]["doc_status"]
          storage_path?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          case_id?: string
          content_hash?: string
          created_at?: string
          entities?: Json
          error?: string | null
          evidence_scope?: string
          extracted_text?: string | null
          extraction_retry_count?: number
          filename?: string
          id?: string
          last_extraction_attempt_at?: string | null
          metadata?: Json
          mime_type?: string | null
          purpose?: string | null
          size_bytes?: number | null
          status?: Database["public"]["Enums"]["doc_status"]
          storage_path?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_classifications: {
        Row: {
          affected_party: string | null
          case_id: string
          citations: Json | null
          classification: string
          confidence: number | null
          confidence_label: string | null
          contradicts_finding_ids: Json
          created_at: string
          description: string | null
          document_id: string | null
          id: string
          linked_timeline_event_ids: Json
          linked_witness_ids: Json
          referenced_by_doc_ids: Json
          severity: string | null
          supports_finding_ids: Json
          title: string
          user_id: string
        }
        Insert: {
          affected_party?: string | null
          case_id: string
          citations?: Json | null
          classification: string
          confidence?: number | null
          confidence_label?: string | null
          contradicts_finding_ids?: Json
          created_at?: string
          description?: string | null
          document_id?: string | null
          id?: string
          linked_timeline_event_ids?: Json
          linked_witness_ids?: Json
          referenced_by_doc_ids?: Json
          severity?: string | null
          supports_finding_ids?: Json
          title: string
          user_id: string
        }
        Update: {
          affected_party?: string | null
          case_id?: string
          citations?: Json | null
          classification?: string
          confidence?: number | null
          confidence_label?: string | null
          contradicts_finding_ids?: Json
          created_at?: string
          description?: string | null
          document_id?: string | null
          id?: string
          linked_timeline_event_ids?: Json
          linked_witness_ids?: Json
          referenced_by_doc_ids?: Json
          severity?: string | null
          supports_finding_ids?: Json
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "evidence_classifications_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_classifications_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          description: string | null
          enabled: boolean
          key: string
          updated_at: string
        }
        Insert: {
          description?: string | null
          enabled?: boolean
          key: string
          updated_at?: string
        }
        Update: {
          description?: string | null
          enabled?: boolean
          key?: string
          updated_at?: string
        }
        Relationships: []
      }
      finding_version_snapshots: {
        Row: {
          canonical_finding_id: string | null
          case_id: string
          category: string
          confidence: number
          content_hash: string
          created_at: string
          finding_id: string
          id: string
          report_version: number
          severity: string
          title: string
        }
        Insert: {
          canonical_finding_id?: string | null
          case_id: string
          category: string
          confidence: number
          content_hash: string
          created_at?: string
          finding_id: string
          id?: string
          report_version: number
          severity: string
          title: string
        }
        Update: {
          canonical_finding_id?: string | null
          case_id?: string
          category?: string
          confidence?: number
          content_hash?: string
          created_at?: string
          finding_id?: string
          id?: string
          report_version?: number
          severity?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "finding_version_snapshots_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      firm_invites: {
        Row: {
          accepted_at: string | null
          email: string
          firm_id: string
          id: string
          invited_at: string
          invited_by: string
          redeemed_user_id: string | null
          role: string
          status: string
        }
        Insert: {
          accepted_at?: string | null
          email: string
          firm_id: string
          id?: string
          invited_at?: string
          invited_by: string
          redeemed_user_id?: string | null
          role?: string
          status?: string
        }
        Update: {
          accepted_at?: string | null
          email?: string
          firm_id?: string
          id?: string
          invited_at?: string
          invited_by?: string
          redeemed_user_id?: string | null
          role?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "firm_invites_firm_id_fkey"
            columns: ["firm_id"]
            isOneToOne: false
            referencedRelation: "firms"
            referencedColumns: ["id"]
          },
        ]
      }
      firms: {
        Row: {
          created_at: string
          domain: string | null
          id: string
          name: string
          owner_user_id: string | null
          plan_key: string | null
          seat_limit: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          domain?: string | null
          id?: string
          name: string
          owner_user_id?: string | null
          plan_key?: string | null
          seat_limit?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          domain?: string | null
          id?: string
          name?: string
          owner_user_id?: string | null
          plan_key?: string | null
          seat_limit?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      image_intelligence: {
        Row: {
          case_id: string
          confidence: number | null
          created_at: string
          document_id: string | null
          face_count: number | null
          id: string
          objects: Json
          ocr_text: string | null
          page_number: number | null
          source_model: string | null
          summary: string | null
          text_found: string | null
        }
        Insert: {
          case_id: string
          confidence?: number | null
          created_at?: string
          document_id?: string | null
          face_count?: number | null
          id?: string
          objects?: Json
          ocr_text?: string | null
          page_number?: number | null
          source_model?: string | null
          summary?: string | null
          text_found?: string | null
        }
        Update: {
          case_id?: string
          confidence?: number | null
          created_at?: string
          document_id?: string | null
          face_count?: number | null
          id?: string
          objects?: Json
          ocr_text?: string | null
          page_number?: number | null
          source_model?: string | null
          summary?: string | null
          text_found?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "image_intelligence_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "image_intelligence_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_improvement_proposals: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          deployed_version: number | null
          error_type: Database["public"]["Enums"]["intelligence_error_type"]
          historical_replay: Json | null
          id: string
          jurisdiction_country: string
          matter_type: string | null
          observed_failure: string
          problem: string
          proposed_escalate_at_tier: Database["public"]["Enums"]["intelligence_pattern_tier"]
          proposed_recommended_action: Database["public"]["Enums"]["intelligence_recommended_action"]
          regression_check: Json | null
          status: Database["public"]["Enums"]["intelligence_proposal_status"]
          supporting_pattern_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          deployed_version?: number | null
          error_type: Database["public"]["Enums"]["intelligence_error_type"]
          historical_replay?: Json | null
          id?: string
          jurisdiction_country?: string
          matter_type?: string | null
          observed_failure: string
          problem: string
          proposed_escalate_at_tier: Database["public"]["Enums"]["intelligence_pattern_tier"]
          proposed_recommended_action: Database["public"]["Enums"]["intelligence_recommended_action"]
          regression_check?: Json | null
          status?: Database["public"]["Enums"]["intelligence_proposal_status"]
          supporting_pattern_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          deployed_version?: number | null
          error_type?: Database["public"]["Enums"]["intelligence_error_type"]
          historical_replay?: Json | null
          id?: string
          jurisdiction_country?: string
          matter_type?: string | null
          observed_failure?: string
          problem?: string
          proposed_escalate_at_tier?: Database["public"]["Enums"]["intelligence_pattern_tier"]
          proposed_recommended_action?: Database["public"]["Enums"]["intelligence_recommended_action"]
          regression_check?: Json | null
          status?: Database["public"]["Enums"]["intelligence_proposal_status"]
          supporting_pattern_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_improvement_proposals_supporting_pattern_id_fkey"
            columns: ["supporting_pattern_id"]
            isOneToOne: false
            referencedRelation: "intelligence_patterns"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_lessons: {
        Row: {
          authority_refs: Json
          canonical_finding_id: string | null
          case_id: string
          confidence: number | null
          corrected_claim: string | null
          created_at: string
          error_type:
            | Database["public"]["Enums"]["intelligence_error_type"]
            | null
          evidence_refs: Json
          finding_id: string | null
          id: string
          jurisdiction_country: string
          jurisdiction_state: string | null
          matter_type: string | null
          original_claim: string
          reason: string
          source_patch_id: string
          times_rejected: number
          times_retrieved: number
          times_successful: number
          updated_at: string
          user_id: string
          validation_status: Database["public"]["Enums"]["lesson_validation_status"]
        }
        Insert: {
          authority_refs?: Json
          canonical_finding_id?: string | null
          case_id: string
          confidence?: number | null
          corrected_claim?: string | null
          created_at?: string
          error_type?:
            | Database["public"]["Enums"]["intelligence_error_type"]
            | null
          evidence_refs?: Json
          finding_id?: string | null
          id?: string
          jurisdiction_country?: string
          jurisdiction_state?: string | null
          matter_type?: string | null
          original_claim: string
          reason: string
          source_patch_id: string
          times_rejected?: number
          times_retrieved?: number
          times_successful?: number
          updated_at?: string
          user_id: string
          validation_status?: Database["public"]["Enums"]["lesson_validation_status"]
        }
        Update: {
          authority_refs?: Json
          canonical_finding_id?: string | null
          case_id?: string
          confidence?: number | null
          corrected_claim?: string | null
          created_at?: string
          error_type?:
            | Database["public"]["Enums"]["intelligence_error_type"]
            | null
          evidence_refs?: Json
          finding_id?: string | null
          id?: string
          jurisdiction_country?: string
          jurisdiction_state?: string | null
          matter_type?: string | null
          original_claim?: string
          reason?: string
          source_patch_id?: string
          times_rejected?: number
          times_retrieved?: number
          times_successful?: number
          updated_at?: string
          user_id?: string
          validation_status?: Database["public"]["Enums"]["lesson_validation_status"]
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_lessons_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_lessons_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "case_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_lessons_source_patch_id_fkey"
            columns: ["source_patch_id"]
            isOneToOne: false
            referencedRelation: "case_finding_patches"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_patterns: {
        Row: {
          category_samples: string[]
          confidence: number | null
          created_at: string
          error_type: Database["public"]["Enums"]["intelligence_error_type"]
          id: string
          jurisdiction_country: string
          jurisdiction_state: string | null
          last_recomputed_at: string
          matter_type: string | null
          pattern_description: string
          rejected_count: number
          sample_size: number
          status: Database["public"]["Enums"]["intelligence_pattern_status"]
          success_count: number
          supporting_lesson_ids: string[]
          tier: Database["public"]["Enums"]["intelligence_pattern_tier"]
          updated_at: string
          user_id: string
          verified_count: number
        }
        Insert: {
          category_samples?: string[]
          confidence?: number | null
          created_at?: string
          error_type: Database["public"]["Enums"]["intelligence_error_type"]
          id?: string
          jurisdiction_country?: string
          jurisdiction_state?: string | null
          last_recomputed_at?: string
          matter_type?: string | null
          pattern_description: string
          rejected_count?: number
          sample_size?: number
          status?: Database["public"]["Enums"]["intelligence_pattern_status"]
          success_count?: number
          supporting_lesson_ids?: string[]
          tier?: Database["public"]["Enums"]["intelligence_pattern_tier"]
          updated_at?: string
          user_id: string
          verified_count?: number
        }
        Update: {
          category_samples?: string[]
          confidence?: number | null
          created_at?: string
          error_type?: Database["public"]["Enums"]["intelligence_error_type"]
          id?: string
          jurisdiction_country?: string
          jurisdiction_state?: string | null
          last_recomputed_at?: string
          matter_type?: string | null
          pattern_description?: string
          rejected_count?: number
          sample_size?: number
          status?: Database["public"]["Enums"]["intelligence_pattern_status"]
          success_count?: number
          supporting_lesson_ids?: string[]
          tier?: Database["public"]["Enums"]["intelligence_pattern_tier"]
          updated_at?: string
          user_id?: string
          verified_count?: number
        }
        Relationships: []
      }
      intelligence_runs: {
        Row: {
          completed_at: string | null
          cost_cents: number | null
          created_at: string
          engine: Database["public"]["Enums"]["intelligence_engine"]
          error: string | null
          id: string
          input: Json
          matter_id: string | null
          model: string | null
          org_id: string
          output: Json
          requested_by: string | null
          started_at: string | null
          status: string
          tokens_used: number | null
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          cost_cents?: number | null
          created_at?: string
          engine: Database["public"]["Enums"]["intelligence_engine"]
          error?: string | null
          id?: string
          input?: Json
          matter_id?: string | null
          model?: string | null
          org_id: string
          output?: Json
          requested_by?: string | null
          started_at?: string | null
          status?: string
          tokens_used?: number | null
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          cost_cents?: number | null
          created_at?: string
          engine?: Database["public"]["Enums"]["intelligence_engine"]
          error?: string | null
          id?: string
          input?: Json
          matter_id?: string | null
          model?: string | null
          org_id?: string
          output?: Json
          requested_by?: string | null
          started_at?: string | null
          status?: string
          tokens_used?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_validation_rules: {
        Row: {
          created_at: string
          error_type: Database["public"]["Enums"]["intelligence_error_type"]
          escalate_at_tier: Database["public"]["Enums"]["intelligence_pattern_tier"]
          id: string
          is_active: boolean
          jurisdiction_country: string
          matter_type: string | null
          recommended_action: Database["public"]["Enums"]["intelligence_recommended_action"]
          source_proposal_id: string | null
          superseded_by_rule_id: string | null
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          created_at?: string
          error_type: Database["public"]["Enums"]["intelligence_error_type"]
          escalate_at_tier: Database["public"]["Enums"]["intelligence_pattern_tier"]
          id?: string
          is_active?: boolean
          jurisdiction_country?: string
          matter_type?: string | null
          recommended_action: Database["public"]["Enums"]["intelligence_recommended_action"]
          source_proposal_id?: string | null
          superseded_by_rule_id?: string | null
          updated_at?: string
          user_id: string
          version: number
        }
        Update: {
          created_at?: string
          error_type?: Database["public"]["Enums"]["intelligence_error_type"]
          escalate_at_tier?: Database["public"]["Enums"]["intelligence_pattern_tier"]
          id?: string
          is_active?: boolean
          jurisdiction_country?: string
          matter_type?: string | null
          recommended_action?: Database["public"]["Enums"]["intelligence_recommended_action"]
          source_proposal_id?: string | null
          superseded_by_rule_id?: string | null
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_validation_rules_superseded_by_rule_id_fkey"
            columns: ["superseded_by_rule_id"]
            isOneToOne: false
            referencedRelation: "intelligence_validation_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_versions: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          changes: Json
          created_at: string
          deployment_status: Database["public"]["Enums"]["intelligence_version_deployment_status"]
          id: string
          proposal_id: string | null
          rollback_reference: string | null
          supporting_lesson_ids: string[]
          supporting_pattern_ids: string[]
          user_id: string
          version: number
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          changes: Json
          created_at?: string
          deployment_status?: Database["public"]["Enums"]["intelligence_version_deployment_status"]
          id?: string
          proposal_id?: string | null
          rollback_reference?: string | null
          supporting_lesson_ids?: string[]
          supporting_pattern_ids?: string[]
          user_id: string
          version: number
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          changes?: Json
          created_at?: string
          deployment_status?: Database["public"]["Enums"]["intelligence_version_deployment_status"]
          id?: string
          proposal_id?: string | null
          rollback_reference?: string | null
          supporting_lesson_ids?: string[]
          supporting_pattern_ids?: string[]
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_versions_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "intelligence_improvement_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_versions_rollback_reference_fkey"
            columns: ["rollback_reference"]
            isOneToOne: false
            referencedRelation: "intelligence_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_relationships: {
        Row: {
          created_at: string
          data: Json
          id: string
          matter_id: string
          object_id: string
          org_id: string
          relation: string
          source_run_id: string | null
          subject_id: string
          updated_at: string
          weight: number | null
        }
        Insert: {
          created_at?: string
          data?: Json
          id?: string
          matter_id: string
          object_id: string
          org_id: string
          relation: string
          source_run_id?: string | null
          subject_id: string
          updated_at?: string
          weight?: number | null
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          matter_id?: string
          object_id?: string
          org_id?: string
          relation?: string
          source_run_id?: string | null
          subject_id?: string
          updated_at?: string
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_relationships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_relationships_source_run_id_fkey"
            columns: ["source_run_id"]
            isOneToOne: false
            referencedRelation: "intelligence_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_amendments: {
        Row: {
          amendment_type: string
          article_id: string
          created_at: string
          decree_reference: string | null
          effective_at: string | null
          id: string
          new_body: string
          previous_body: string | null
          source_url: string | null
        }
        Insert: {
          amendment_type?: string
          article_id: string
          created_at?: string
          decree_reference?: string | null
          effective_at?: string | null
          id?: string
          new_body: string
          previous_body?: string | null
          source_url?: string | null
        }
        Update: {
          amendment_type?: string
          article_id?: string
          created_at?: string
          decree_reference?: string | null
          effective_at?: string | null
          id?: string
          new_body?: string
          previous_body?: string | null
          source_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "legal_amendments_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "legal_articles"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_articles: {
        Row: {
          article_number: string
          authority_id: string
          body: string
          created_at: string
          effective_at: string | null
          heading: string | null
          id: string
          repealed_at: string | null
          source_url: string | null
          updated_at: string
          verification_status: Database["public"]["Enums"]["legal_verification_status"]
        }
        Insert: {
          article_number: string
          authority_id: string
          body: string
          created_at?: string
          effective_at?: string | null
          heading?: string | null
          id?: string
          repealed_at?: string | null
          source_url?: string | null
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Update: {
          article_number?: string
          authority_id?: string
          body?: string
          created_at?: string
          effective_at?: string | null
          heading?: string | null
          id?: string
          repealed_at?: string | null
          source_url?: string | null
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Relationships: [
          {
            foreignKeyName: "legal_articles_authority_id_fkey"
            columns: ["authority_id"]
            isOneToOne: false
            referencedRelation: "legal_authorities"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_authorities: {
        Row: {
          authority_level: number | null
          body: string | null
          citation: string | null
          connector_code: string | null
          content_hash: string | null
          created_at: string
          effective_at: string | null
          id: string
          issuer: string | null
          jurisdiction: string | null
          kind: string
          metadata: Json
          published_at: string | null
          repealed_at: string | null
          short_title: string | null
          source_url: string | null
          superseded_by_id: string | null
          title: string
          updated_at: string
          verification_status: Database["public"]["Enums"]["legal_verification_status"]
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          authority_level?: number | null
          body?: string | null
          citation?: string | null
          connector_code?: string | null
          content_hash?: string | null
          created_at?: string
          effective_at?: string | null
          id?: string
          issuer?: string | null
          jurisdiction?: string | null
          kind: string
          metadata?: Json
          published_at?: string | null
          repealed_at?: string | null
          short_title?: string | null
          source_url?: string | null
          superseded_by_id?: string | null
          title: string
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          authority_level?: number | null
          body?: string | null
          citation?: string | null
          connector_code?: string | null
          content_hash?: string | null
          created_at?: string
          effective_at?: string | null
          id?: string
          issuer?: string | null
          jurisdiction?: string | null
          kind?: string
          metadata?: Json
          published_at?: string | null
          repealed_at?: string | null
          short_title?: string | null
          source_url?: string | null
          superseded_by_id?: string | null
          title?: string
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "legal_authorities_superseded_by_id_fkey"
            columns: ["superseded_by_id"]
            isOneToOne: false
            referencedRelation: "legal_authorities"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_authority_versions: {
        Row: {
          archived_at: string
          authority_id: string
          body: string | null
          content_hash: string | null
          id: string
          metadata: Json
        }
        Insert: {
          archived_at?: string
          authority_id: string
          body?: string | null
          content_hash?: string | null
          id?: string
          metadata?: Json
        }
        Update: {
          archived_at?: string
          authority_id?: string
          body?: string | null
          content_hash?: string | null
          id?: string
          metadata?: Json
        }
        Relationships: [
          {
            foreignKeyName: "legal_authority_versions_authority_id_fkey"
            columns: ["authority_id"]
            isOneToOne: false
            referencedRelation: "legal_authorities"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_citations: {
        Row: {
          authority_id: string
          citation_text: string
          cited_authority_id: string | null
          context: string | null
          created_at: string
          id: string
        }
        Insert: {
          authority_id: string
          citation_text: string
          cited_authority_id?: string | null
          context?: string | null
          created_at?: string
          id?: string
        }
        Update: {
          authority_id?: string
          citation_text?: string
          cited_authority_id?: string | null
          context?: string | null
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_citations_authority_id_fkey"
            columns: ["authority_id"]
            isOneToOne: false
            referencedRelation: "legal_authorities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legal_citations_cited_authority_id_fkey"
            columns: ["cited_authority_id"]
            isOneToOne: false
            referencedRelation: "legal_authorities"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_document_versions: {
        Row: {
          created_at: string
          created_by: string | null
          document_hash: string
          document_type: string
          effective_date: string
          id: string
          is_active: boolean
          language: string
          source_url: string | null
          summary: string | null
          updated_at: string
          version: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          document_hash: string
          document_type: string
          effective_date?: string
          id?: string
          is_active?: boolean
          language?: string
          source_url?: string | null
          summary?: string | null
          updated_at?: string
          version: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          document_hash?: string
          document_type?: string
          effective_date?: string
          id?: string
          is_active?: boolean
          language?: string
          source_url?: string | null
          summary?: string | null
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      legal_ingest_runs: {
        Row: {
          connector_code: string
          created_at: string
          documents_fetched: number
          documents_stored: number
          documents_versioned: number
          ended_at: string | null
          errors: Json
          id: string
          started_at: string
          status: string
        }
        Insert: {
          connector_code: string
          created_at?: string
          documents_fetched?: number
          documents_stored?: number
          documents_versioned?: number
          ended_at?: string | null
          errors?: Json
          id?: string
          started_at: string
          status: string
        }
        Update: {
          connector_code?: string
          created_at?: string
          documents_fetched?: number
          documents_stored?: number
          documents_versioned?: number
          ended_at?: string | null
          errors?: Json
          id?: string
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      legal_jurisprudencia: {
        Row: {
          binding: boolean
          body: string
          created_at: string
          epoca: string | null
          formation_method: string | null
          id: string
          issuing_body: string | null
          published_at: string | null
          registry_number: string | null
          source_url: string | null
          title: string
          updated_at: string
          verification_status: Database["public"]["Enums"]["legal_verification_status"]
        }
        Insert: {
          binding?: boolean
          body: string
          created_at?: string
          epoca?: string | null
          formation_method?: string | null
          id?: string
          issuing_body?: string | null
          published_at?: string | null
          registry_number?: string | null
          source_url?: string | null
          title: string
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Update: {
          binding?: boolean
          body?: string
          created_at?: string
          epoca?: string | null
          formation_method?: string | null
          id?: string
          issuing_body?: string | null
          published_at?: string | null
          registry_number?: string | null
          source_url?: string | null
          title?: string
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Relationships: []
      }
      legal_keyword_links: {
        Row: {
          entity_id: string
          entity_type: string
          id: string
          keyword_id: string
        }
        Insert: {
          entity_id: string
          entity_type: string
          id?: string
          keyword_id: string
        }
        Update: {
          entity_id?: string
          entity_type?: string
          id?: string
          keyword_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_keyword_links_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "legal_keywords"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_keywords: {
        Row: {
          created_at: string
          id: string
          term: string
        }
        Insert: {
          created_at?: string
          id?: string
          term: string
        }
        Update: {
          created_at?: string
          id?: string
          term?: string
        }
        Relationships: []
      }
      legal_precedents: {
        Row: {
          authority_id: string | null
          binding: boolean
          case_number: string | null
          court: string
          created_at: string
          decision_date: string | null
          full_text: string | null
          id: string
          jurisdiction: string | null
          source_url: string | null
          summary: string | null
          updated_at: string
          verification_status: Database["public"]["Enums"]["legal_verification_status"]
        }
        Insert: {
          authority_id?: string | null
          binding?: boolean
          case_number?: string | null
          court: string
          created_at?: string
          decision_date?: string | null
          full_text?: string | null
          id?: string
          jurisdiction?: string | null
          source_url?: string | null
          summary?: string | null
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Update: {
          authority_id?: string | null
          binding?: boolean
          case_number?: string | null
          court?: string
          created_at?: string
          decision_date?: string | null
          full_text?: string | null
          id?: string
          jurisdiction?: string | null
          source_url?: string | null
          summary?: string | null
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Relationships: [
          {
            foreignKeyName: "legal_precedents_authority_id_fkey"
            columns: ["authority_id"]
            isOneToOne: false
            referencedRelation: "legal_authorities"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_profiles: {
        Row: {
          code: string
          country: string
          created_at: string
          id: string
          jurisdictions: Json
          language: string
          legal_system: string
          metadata: Json
          name: string
          practice_areas: Json
          primary_sources: Json
          prompt_lock: string | null
          updated_at: string
        }
        Insert: {
          code: string
          country: string
          created_at?: string
          id?: string
          jurisdictions?: Json
          language?: string
          legal_system: string
          metadata?: Json
          name: string
          practice_areas?: Json
          primary_sources?: Json
          prompt_lock?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          country?: string
          created_at?: string
          id?: string
          jurisdictions?: Json
          language?: string
          legal_system?: string
          metadata?: Json
          name?: string
          practice_areas?: Json
          primary_sources?: Json
          prompt_lock?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      legal_regulations: {
        Row: {
          body: string | null
          created_at: string
          effective_at: string | null
          id: string
          implements_authority_id: string | null
          issuer: string | null
          jurisdiction: string | null
          published_at: string | null
          source_url: string | null
          title: string
          updated_at: string
          verification_status: Database["public"]["Enums"]["legal_verification_status"]
        }
        Insert: {
          body?: string | null
          created_at?: string
          effective_at?: string | null
          id?: string
          implements_authority_id?: string | null
          issuer?: string | null
          jurisdiction?: string | null
          published_at?: string | null
          source_url?: string | null
          title: string
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Update: {
          body?: string | null
          created_at?: string
          effective_at?: string | null
          id?: string
          implements_authority_id?: string | null
          issuer?: string | null
          jurisdiction?: string | null
          published_at?: string | null
          source_url?: string | null
          title?: string
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Relationships: [
          {
            foreignKeyName: "legal_regulations_implements_authority_id_fkey"
            columns: ["implements_authority_id"]
            isOneToOne: false
            referencedRelation: "legal_authorities"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_source_connectors: {
        Row: {
          base_url: string | null
          code: string
          config: Json
          created_at: string
          description: string | null
          id: string
          last_sync_at: string | null
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          base_url?: string | null
          code: string
          config?: Json
          created_at?: string
          description?: string | null
          id?: string
          last_sync_at?: string | null
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          base_url?: string | null
          code?: string
          config?: Json
          created_at?: string
          description?: string | null
          id?: string
          last_sync_at?: string | null
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      legal_theses: {
        Row: {
          body: string
          created_at: string
          epoca: string | null
          id: string
          issuing_body: string | null
          published_at: string | null
          registry_number: string | null
          source_url: string | null
          title: string
          updated_at: string
          verification_status: Database["public"]["Enums"]["legal_verification_status"]
        }
        Insert: {
          body: string
          created_at?: string
          epoca?: string | null
          id?: string
          issuing_body?: string | null
          published_at?: string | null
          registry_number?: string | null
          source_url?: string | null
          title: string
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Update: {
          body?: string
          created_at?: string
          epoca?: string | null
          id?: string
          issuing_body?: string | null
          published_at?: string | null
          registry_number?: string | null
          source_url?: string | null
          title?: string
          updated_at?: string
          verification_status?: Database["public"]["Enums"]["legal_verification_status"]
        }
        Relationships: []
      }
      legal_topic_links: {
        Row: {
          entity_id: string
          entity_type: string
          id: string
          topic_id: string
        }
        Insert: {
          entity_id: string
          entity_type: string
          id?: string
          topic_id: string
        }
        Update: {
          entity_id?: string
          entity_type?: string
          id?: string
          topic_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_topic_links_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "legal_topics"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_topics: {
        Row: {
          created_at: string
          id: string
          name: string
          parent_topic_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          parent_topic_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          parent_topic_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "legal_topics_parent_topic_id_fkey"
            columns: ["parent_topic_id"]
            isOneToOne: false
            referencedRelation: "legal_topics"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_documents: {
        Row: {
          checksum: string | null
          classification: Json
          created_at: string
          current_version: number
          deleted_at: string | null
          doc_type: string | null
          id: string
          language: string | null
          matter_id: string
          media_kind: string | null
          metadata: Json
          mime_type: string | null
          org_id: string
          page_count: number | null
          processing_error: string | null
          processing_status: Database["public"]["Enums"]["doc_processing_status"]
          size_bytes: number | null
          storage_path: string | null
          text_content: string | null
          title: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          checksum?: string | null
          classification?: Json
          created_at?: string
          current_version?: number
          deleted_at?: string | null
          doc_type?: string | null
          id?: string
          language?: string | null
          matter_id: string
          media_kind?: string | null
          metadata?: Json
          mime_type?: string | null
          org_id: string
          page_count?: number | null
          processing_error?: string | null
          processing_status?: Database["public"]["Enums"]["doc_processing_status"]
          size_bytes?: number | null
          storage_path?: string | null
          text_content?: string | null
          title: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          checksum?: string | null
          classification?: Json
          created_at?: string
          current_version?: number
          deleted_at?: string | null
          doc_type?: string | null
          id?: string
          language?: string | null
          matter_id?: string
          media_kind?: string | null
          metadata?: Json
          mime_type?: string | null
          org_id?: string
          page_count?: number | null
          processing_error?: string | null
          processing_status?: Database["public"]["Enums"]["doc_processing_status"]
          size_bytes?: number | null
          storage_path?: string | null
          text_content?: string | null
          title?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matter_documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_parties: {
        Row: {
          contact: Json
          created_at: string
          deleted_at: string | null
          id: string
          matter_id: string
          name: string
          org_id: string
          party_type: string
          role_description: string | null
          updated_at: string
        }
        Insert: {
          contact?: Json
          created_at?: string
          deleted_at?: string | null
          id?: string
          matter_id: string
          name: string
          org_id: string
          party_type: string
          role_description?: string | null
          updated_at?: string
        }
        Update: {
          contact?: Json
          created_at?: string
          deleted_at?: string | null
          id?: string
          matter_id?: string
          name?: string
          org_id?: string
          party_type?: string
          role_description?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "matter_parties_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_memberships: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          invited_by: string | null
          org_id: string
          role_in_org: Database["public"]["Enums"]["org_role"]
          status: Database["public"]["Enums"]["membership_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          invited_by?: string | null
          org_id: string
          role_in_org?: Database["public"]["Enums"]["org_role"]
          status?: Database["public"]["Enums"]["membership_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          invited_by?: string | null
          org_id?: string
          role_in_org?: Database["public"]["Enums"]["org_role"]
          status?: Database["public"]["Enums"]["membership_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_memberships_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_role_permissions: {
        Row: {
          created_at: string
          granted: boolean
          id: string
          org_id: string
          permission_code: string
          role: Database["public"]["Enums"]["org_role"]
        }
        Insert: {
          created_at?: string
          granted?: boolean
          id?: string
          org_id: string
          permission_code: string
          role: Database["public"]["Enums"]["org_role"]
        }
        Update: {
          created_at?: string
          granted?: boolean
          id?: string
          org_id?: string
          permission_code?: string
          role?: Database["public"]["Enums"]["org_role"]
        }
        Relationships: [
          {
            foreignKeyName: "org_role_permissions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_role_permissions_permission_code_fkey"
            columns: ["permission_code"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["code"]
          },
        ]
      }
      org_subscriptions: {
        Row: {
          billing_interval: string
          cancel_at: string | null
          cancel_at_period_end: boolean
          cancelled_at: string | null
          created_at: string
          currency: string | null
          current_period_end: string | null
          current_period_start: string | null
          grace_period_ends_at: string | null
          id: string
          metadata: Json
          org_id: string
          plan_id: string
          primary_subscription: boolean
          provider: string
          provider_customer_id: string | null
          provider_subscription_id: string | null
          status: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          billing_interval?: string
          cancel_at?: string | null
          cancel_at_period_end?: boolean
          cancelled_at?: string | null
          created_at?: string
          currency?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          grace_period_ends_at?: string | null
          id?: string
          metadata?: Json
          org_id: string
          plan_id: string
          primary_subscription?: boolean
          provider?: string
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          status?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          billing_interval?: string
          cancel_at?: string | null
          cancel_at_period_end?: boolean
          cancelled_at?: string | null
          created_at?: string
          currency?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          grace_period_ends_at?: string | null
          id?: string
          metadata?: Json
          org_id?: string
          plan_id?: string
          primary_subscription?: boolean
          provider?: string
          provider_customer_id?: string | null
          provider_subscription_id?: string | null
          status?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_subscriptions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_entitlements: {
        Row: {
          ai_requests_monthly: number | null
          byok_allowed: boolean
          case_limit: number | null
          employee_seats: number
          feature_flags: Json
          max_upload_size_bytes: number | null
          monthly_document_pages: number | null
          org_id: string
          owner_seats: number
          plan_id: string
          status: string
          storage_limit_bytes: number | null
          subscription_id: string | null
          talk_to_case_monthly: number | null
          total_user_limit: number
          updated_at: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          ai_requests_monthly?: number | null
          byok_allowed?: boolean
          case_limit?: number | null
          employee_seats?: number
          feature_flags?: Json
          max_upload_size_bytes?: number | null
          monthly_document_pages?: number | null
          org_id: string
          owner_seats?: number
          plan_id: string
          status?: string
          storage_limit_bytes?: number | null
          subscription_id?: string | null
          talk_to_case_monthly?: number | null
          total_user_limit?: number
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          ai_requests_monthly?: number | null
          byok_allowed?: boolean
          case_limit?: number | null
          employee_seats?: number
          feature_flags?: Json
          max_upload_size_bytes?: number | null
          monthly_document_pages?: number | null
          org_id?: string
          owner_seats?: number
          plan_id?: string
          status?: string
          storage_limit_bytes?: number | null
          subscription_id?: string | null
          talk_to_case_monthly?: number | null
          total_user_limit?: number
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_entitlements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_entitlements_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_entitlements_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "org_subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          email: string
          expires_at: string
          id: string
          invited_at: string
          invited_by: string
          invitee_name: string | null
          invitee_title: string | null
          org_id: string
          revoked_at: string | null
          role: string
          status: string
          token_hash: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          email: string
          expires_at?: string
          id?: string
          invited_at?: string
          invited_by: string
          invitee_name?: string | null
          invitee_title?: string | null
          org_id: string
          revoked_at?: string | null
          role: string
          status?: string
          token_hash: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          email?: string
          expires_at?: string
          id?: string
          invited_at?: string
          invited_by?: string
          invitee_name?: string | null
          invitee_title?: string | null
          org_id?: string
          revoked_at?: string | null
          role?: string
          status?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_usage_events: {
        Row: {
          id: string
          idempotency_key: string | null
          metadata: Json
          model: string | null
          occurred_at: string
          org_id: string
          provider: string | null
          quantity: number
          social_case_id: string | null
          usage_type: string
          user_id: string | null
        }
        Insert: {
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          model?: string | null
          occurred_at?: string
          org_id: string
          provider?: string | null
          quantity?: number
          social_case_id?: string | null
          usage_type: string
          user_id?: string | null
        }
        Update: {
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          model?: string | null
          occurred_at?: string
          org_id?: string
          provider?: string | null
          quantity?: number
          social_case_id?: string | null
          usage_type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_usage_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_usage_events_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_usage_periods: {
        Row: {
          ai_requests_used: number
          created_at: string
          document_pages_used: number
          id: string
          org_id: string
          period_end: string
          period_start: string
          storage_bytes_used: number
          subscription_id: string | null
          talk_to_case_used: number
          updated_at: string
        }
        Insert: {
          ai_requests_used?: number
          created_at?: string
          document_pages_used?: number
          id?: string
          org_id: string
          period_end: string
          period_start: string
          storage_bytes_used?: number
          subscription_id?: string | null
          talk_to_case_used?: number
          updated_at?: string
        }
        Update: {
          ai_requests_used?: number
          created_at?: string
          document_pages_used?: number
          id?: string
          org_id?: string
          period_end?: string
          period_start?: string
          storage_bytes_used?: number
          subscription_id?: string | null
          talk_to_case_used?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_usage_periods_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_usage_periods_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "org_subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          edition: string
          id: string
          legal_profile_code: string
          name: string
          plan: string
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          edition?: string
          id?: string
          legal_profile_code?: string
          name: string
          plan?: string
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          edition?: string
          id?: string
          legal_profile_code?: string
          name?: string
          plan?: string
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      permissions: {
        Row: {
          action: string
          code: string
          created_at: string
          description: string | null
          id: string
          resource: string
        }
        Insert: {
          action: string
          code: string
          created_at?: string
          description?: string | null
          id?: string
          resource: string
        }
        Update: {
          action?: string
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          resource?: string
        }
        Relationships: []
      }
      pipeline_engine_runs: {
        Row: {
          accepted: number
          blocking_engines: string[] | null
          case_id: string
          cost_usd: number
          created_at: string
          db_write_confirmed: boolean | null
          dependency_status: string | null
          ended_at: string | null
          engine: string
          error: string | null
          execution_id: string | null
          generated: number
          id: string
          meta: Json
          model: string | null
          parent_engine: string | null
          prompt_version: string | null
          provider: string | null
          rejected: number
          retry_count: number
          rows_written: number | null
          runtime_ms: number | null
          skipped_reason: string | null
          started_at: string | null
          status: string
          suppressed_ess: number
          suppressed_validator: number
          tokens_in: number
          tokens_out: number
          updated_at: string
          user_id: string
        }
        Insert: {
          accepted?: number
          blocking_engines?: string[] | null
          case_id: string
          cost_usd?: number
          created_at?: string
          db_write_confirmed?: boolean | null
          dependency_status?: string | null
          ended_at?: string | null
          engine: string
          error?: string | null
          execution_id?: string | null
          generated?: number
          id?: string
          meta?: Json
          model?: string | null
          parent_engine?: string | null
          prompt_version?: string | null
          provider?: string | null
          rejected?: number
          retry_count?: number
          rows_written?: number | null
          runtime_ms?: number | null
          skipped_reason?: string | null
          started_at?: string | null
          status: string
          suppressed_ess?: number
          suppressed_validator?: number
          tokens_in?: number
          tokens_out?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          accepted?: number
          blocking_engines?: string[] | null
          case_id?: string
          cost_usd?: number
          created_at?: string
          db_write_confirmed?: boolean | null
          dependency_status?: string | null
          ended_at?: string | null
          engine?: string
          error?: string | null
          execution_id?: string | null
          generated?: number
          id?: string
          meta?: Json
          model?: string | null
          parent_engine?: string | null
          prompt_version?: string | null
          provider?: string | null
          rejected?: number
          retry_count?: number
          rows_written?: number | null
          runtime_ms?: number | null
          skipped_reason?: string | null
          started_at?: string | null
          status?: string
          suppressed_ess?: number
          suppressed_validator?: number
          tokens_in?: number
          tokens_out?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_engine_runs_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_events: {
        Row: {
          case_id: string
          created_at: string
          id: string
          level: string
          message: string
          meta: Json
          stage: string
        }
        Insert: {
          case_id: string
          created_at?: string
          id?: string
          level?: string
          message: string
          meta?: Json
          stage: string
        }
        Update: {
          case_id?: string
          created_at?: string
          id?: string
          level?: string
          message?: string
          meta?: Json
          stage?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_events_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_trace: {
        Row: {
          attempt: number | null
          case_id: string
          correlation_id: string | null
          created_at: string
          detail: Json
          duration_ms: number | null
          error: string | null
          id: number
          level: string
          model: string | null
          phase: string
          provider: string | null
          status: string
          step: string
          user_id: string | null
        }
        Insert: {
          attempt?: number | null
          case_id: string
          correlation_id?: string | null
          created_at?: string
          detail?: Json
          duration_ms?: number | null
          error?: string | null
          id?: number
          level?: string
          model?: string | null
          phase: string
          provider?: string | null
          status?: string
          step: string
          user_id?: string | null
        }
        Update: {
          attempt?: number | null
          case_id?: string
          correlation_id?: string | null
          created_at?: string
          detail?: Json
          duration_ms?: number | null
          error?: string | null
          id?: number
          level?: string
          model?: string | null
          phase?: string
          provider?: string | null
          status?: string
          step?: string
          user_id?: string | null
        }
        Relationships: []
      }
      plan_entitlements: {
        Row: {
          id: string
          permission_code: string
          plan_id: string
          quota: number | null
        }
        Insert: {
          id?: string
          permission_code: string
          plan_id: string
          quota?: number | null
        }
        Update: {
          id?: string
          permission_code?: string
          plan_id?: string
          quota?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "plan_entitlements_permission_code_fkey"
            columns: ["permission_code"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "plan_entitlements_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          default_org_id: string | null
          deleted_at: string | null
          display_name: string | null
          email: string | null
          full_name: string | null
          id: string
          is_blocked: boolean
          locale: string
          preferred_language: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          default_org_id?: string | null
          deleted_at?: string | null
          display_name?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          is_blocked?: boolean
          locale?: string
          preferred_language?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          default_org_id?: string | null
          deleted_at?: string | null
          display_name?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          is_blocked?: boolean
          locale?: string
          preferred_language?: string
          updated_at?: string
        }
        Relationships: []
      }
      property_records: {
        Row: {
          address: string | null
          buyer_name: string | null
          case_id: string
          catastro_id: string | null
          closing_date: string | null
          country: string
          created_at: string
          cuenta_predial: string | null
          fideicomiso: boolean
          folio_real: string | null
          foreign_buyer: boolean
          municipality: string | null
          notary: string | null
          property_type: string | null
          purchase_price: number | null
          seller_name: string | null
          state: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          address?: string | null
          buyer_name?: string | null
          case_id: string
          catastro_id?: string | null
          closing_date?: string | null
          country?: string
          created_at?: string
          cuenta_predial?: string | null
          fideicomiso?: boolean
          folio_real?: string | null
          foreign_buyer?: boolean
          municipality?: string | null
          notary?: string | null
          property_type?: string | null
          purchase_price?: number | null
          seller_name?: string | null
          state?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          address?: string | null
          buyer_name?: string | null
          case_id?: string
          catastro_id?: string | null
          closing_date?: string | null
          country?: string
          created_at?: string
          cuenta_predial?: string | null
          fideicomiso?: boolean
          folio_real?: string | null
          foreign_buyer?: boolean
          municipality?: string | null
          notary?: string | null
          property_type?: string | null
          purchase_price?: number | null
          seller_name?: string | null
          state?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_records_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      report_chunk_caches: {
        Row: {
          case_id: string
          chunks: Json
          execution_id: string
          updated_at: string
        }
        Insert: {
          case_id: string
          chunks?: Json
          execution_id: string
          updated_at?: string
        }
        Update: {
          case_id?: string
          chunks?: Json
          execution_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_chunk_caches_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      report_versions: {
        Row: {
          canonical_version: number | null
          case_id: string
          change_log: Json | null
          contradiction_count: number | null
          created_at: string
          document_count: number | null
          ess: number | null
          findings_count: number | null
          id: string
          score: number | null
          snapshot: Json
          user_id: string | null
          version: number
        }
        Insert: {
          canonical_version?: number | null
          case_id: string
          change_log?: Json | null
          contradiction_count?: number | null
          created_at?: string
          document_count?: number | null
          ess?: number | null
          findings_count?: number | null
          id?: string
          score?: number | null
          snapshot: Json
          user_id?: string | null
          version: number
        }
        Update: {
          canonical_version?: number | null
          case_id?: string
          change_log?: Json | null
          contradiction_count?: number | null
          created_at?: string
          document_count?: number | null
          ess?: number | null
          findings_count?: number | null
          id?: string
          score?: number | null
          snapshot?: Json
          user_id?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "report_versions_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          adaptive_intelligence_version: number | null
          alternative_theory_report: string | null
          appendix_sources: string | null
          attorney_summary: string | null
          canonical_version: number | null
          case_id: string
          case_overview: string | null
          case_strength_score: number | null
          change_log: Json | null
          citations: Json
          constitutional_issues: string | null
          constitutional_issues_struct: Json
          contradiction_report: string | null
          contradictions_struct: Json | null
          created_at: string
          cross_examination: Json
          defense_theory_report: string | null
          discovery_analysis: string | null
          engines_summary: Json | null
          evidence_index: Json
          evidence_summary: string | null
          execution_id: string | null
          executive_summary: string | null
          facts: string | null
          findings_count: number | null
          full_report: Json
          generated_language: string
          id: string
          intelligence_version: string | null
          investigator_summary: string | null
          item_flags: Json
          missing_evidence_report: Json | null
          missing_evidence_struct: Json | null
          motion_opportunities: Json
          motions_suppressed: boolean
          next_actions: Json
          procedural_issues_report: string | null
          prosecution_theory_report: string | null
          quality_block_reasons: Json | null
          quality_blocked: boolean
          recommendations: string | null
          report_chunk_cache: Json
          report_mode: string | null
          risk_analysis: string | null
          risk_score: number | null
          score_breakdown: string | null
          scores_suppressed: boolean
          strategy_recommendations: Json
          timeline_summary: string | null
          updated_at: string
          user_id: string | null
          version: number
          witness_analysis: string | null
        }
        Insert: {
          adaptive_intelligence_version?: number | null
          alternative_theory_report?: string | null
          appendix_sources?: string | null
          attorney_summary?: string | null
          canonical_version?: number | null
          case_id: string
          case_overview?: string | null
          case_strength_score?: number | null
          change_log?: Json | null
          citations?: Json
          constitutional_issues?: string | null
          constitutional_issues_struct?: Json
          contradiction_report?: string | null
          contradictions_struct?: Json | null
          created_at?: string
          cross_examination?: Json
          defense_theory_report?: string | null
          discovery_analysis?: string | null
          engines_summary?: Json | null
          evidence_index?: Json
          evidence_summary?: string | null
          execution_id?: string | null
          executive_summary?: string | null
          facts?: string | null
          findings_count?: number | null
          full_report?: Json
          generated_language?: string
          id?: string
          intelligence_version?: string | null
          investigator_summary?: string | null
          item_flags?: Json
          missing_evidence_report?: Json | null
          missing_evidence_struct?: Json | null
          motion_opportunities?: Json
          motions_suppressed?: boolean
          next_actions?: Json
          procedural_issues_report?: string | null
          prosecution_theory_report?: string | null
          quality_block_reasons?: Json | null
          quality_blocked?: boolean
          recommendations?: string | null
          report_chunk_cache?: Json
          report_mode?: string | null
          risk_analysis?: string | null
          risk_score?: number | null
          score_breakdown?: string | null
          scores_suppressed?: boolean
          strategy_recommendations?: Json
          timeline_summary?: string | null
          updated_at?: string
          user_id?: string | null
          version?: number
          witness_analysis?: string | null
        }
        Update: {
          adaptive_intelligence_version?: number | null
          alternative_theory_report?: string | null
          appendix_sources?: string | null
          attorney_summary?: string | null
          canonical_version?: number | null
          case_id?: string
          case_overview?: string | null
          case_strength_score?: number | null
          change_log?: Json | null
          citations?: Json
          constitutional_issues?: string | null
          constitutional_issues_struct?: Json
          contradiction_report?: string | null
          contradictions_struct?: Json | null
          created_at?: string
          cross_examination?: Json
          defense_theory_report?: string | null
          discovery_analysis?: string | null
          engines_summary?: Json | null
          evidence_index?: Json
          evidence_summary?: string | null
          execution_id?: string | null
          executive_summary?: string | null
          facts?: string | null
          findings_count?: number | null
          full_report?: Json
          generated_language?: string
          id?: string
          intelligence_version?: string | null
          investigator_summary?: string | null
          item_flags?: Json
          missing_evidence_report?: Json | null
          missing_evidence_struct?: Json | null
          motion_opportunities?: Json
          motions_suppressed?: boolean
          next_actions?: Json
          procedural_issues_report?: string | null
          prosecution_theory_report?: string | null
          quality_block_reasons?: Json | null
          quality_blocked?: boolean
          recommendations?: string | null
          report_chunk_cache?: Json
          report_mode?: string | null
          risk_analysis?: string | null
          risk_score?: number | null
          score_breakdown?: string | null
          scores_suppressed?: boolean
          strategy_recommendations?: Json
          timeline_summary?: string | null
          updated_at?: string
          user_id?: string | null
          version?: number
          witness_analysis?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reports_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: true
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_contact_refresh_runs: {
        Row: {
          detail: string | null
          ended_at: string | null
          fields_updated: string[]
          id: string
          institution_id: string | null
          slug: string
          source_url: string | null
          started_at: string
          status: string
        }
        Insert: {
          detail?: string | null
          ended_at?: string | null
          fields_updated?: string[]
          id?: string
          institution_id?: string | null
          slug: string
          source_url?: string | null
          started_at?: string
          status: string
        }
        Update: {
          detail?: string | null
          ended_at?: string | null
          fields_updated?: string[]
          id?: string
          institution_id?: string | null
          slug?: string
          source_url?: string | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "resource_contact_refresh_runs_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "social_institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_corrections: {
        Row: {
          created_at: string
          field_name: string | null
          id: string
          institution_id: string
          org_id: string | null
          reason: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_by: string
          suggested_value: string | null
        }
        Insert: {
          created_at?: string
          field_name?: string | null
          id?: string
          institution_id: string
          org_id?: string | null
          reason: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_by: string
          suggested_value?: string | null
        }
        Update: {
          created_at?: string
          field_name?: string | null
          id?: string
          institution_id?: string
          org_id?: string | null
          reason?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_by?: string
          suggested_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "resource_corrections_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "social_institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resource_corrections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_internal_experiences: {
        Row: {
          accessibility_notes: string | null
          created_at: string
          created_by: string
          id: string
          institution_id: string
          org_id: string
          outcome: string | null
          staff_notes: string
          updated_at: string
          wait_time_notes: string | null
        }
        Insert: {
          accessibility_notes?: string | null
          created_at?: string
          created_by: string
          id?: string
          institution_id: string
          org_id: string
          outcome?: string | null
          staff_notes: string
          updated_at?: string
          wait_time_notes?: string | null
        }
        Update: {
          accessibility_notes?: string | null
          created_at?: string
          created_by?: string
          id?: string
          institution_id?: string
          org_id?: string
          outcome?: string | null
          staff_notes?: string
          updated_at?: string
          wait_time_notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "resource_internal_experiences_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "social_institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resource_internal_experiences_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_knowledge_case_actions: {
        Row: {
          action_type: string
          created_at: string
          created_by: string
          details: Json
          id: string
          knowledge_id: string
          org_id: string
          social_case_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          created_by: string
          details?: Json
          id?: string
          knowledge_id: string
          org_id: string
          social_case_id: string
        }
        Update: {
          action_type?: string
          created_at?: string
          created_by?: string
          details?: Json
          id?: string
          knowledge_id?: string
          org_id?: string
          social_case_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "resource_knowledge_case_actions_knowledge_id_fkey"
            columns: ["knowledge_id"]
            isOneToOne: false
            referencedRelation: "resource_knowledge_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resource_knowledge_case_actions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resource_knowledge_case_actions_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_knowledge_corrections: {
        Row: {
          created_at: string
          id: string
          knowledge_id: string
          org_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_by: string
          suggestion: string
        }
        Insert: {
          created_at?: string
          id?: string
          knowledge_id: string
          org_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_by: string
          suggestion: string
        }
        Update: {
          created_at?: string
          id?: string
          knowledge_id?: string
          org_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_by?: string
          suggestion?: string
        }
        Relationships: [
          {
            foreignKeyName: "resource_knowledge_corrections_knowledge_id_fkey"
            columns: ["knowledge_id"]
            isOneToOne: false
            referencedRelation: "resource_knowledge_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resource_knowledge_corrections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_knowledge_records: {
        Row: {
          applicable_programs: string[]
          approval_status: string
          approved_at: string | null
          approved_by: string | null
          archived_at: string | null
          audience: string
          authority: string | null
          content_en: string | null
          content_es: string | null
          created_at: string
          created_by: string | null
          document_path: string | null
          effective_at: string | null
          file_type: string | null
          id: string
          internal_only: boolean
          knowledge_type: string
          language_codes: string[]
          last_verified_at: string | null
          municipality: string | null
          official_sources: Json
          org_id: string | null
          owner_id: string | null
          population_tags: string[]
          purpose: string | null
          related_forms: string[]
          related_resources: string[]
          required_steps: Json
          review_due_at: string | null
          service_categories: string[]
          source_url: string | null
          state_codes: string[]
          summary_en: string | null
          summary_es: string | null
          title_en: string
          title_es: string
          updated_at: string
          version: number
          when_to_use: string | null
        }
        Insert: {
          applicable_programs?: string[]
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          audience?: string
          authority?: string | null
          content_en?: string | null
          content_es?: string | null
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          effective_at?: string | null
          file_type?: string | null
          id?: string
          internal_only?: boolean
          knowledge_type: string
          language_codes?: string[]
          last_verified_at?: string | null
          municipality?: string | null
          official_sources?: Json
          org_id?: string | null
          owner_id?: string | null
          population_tags?: string[]
          purpose?: string | null
          related_forms?: string[]
          related_resources?: string[]
          required_steps?: Json
          review_due_at?: string | null
          service_categories?: string[]
          source_url?: string | null
          state_codes?: string[]
          summary_en?: string | null
          summary_es?: string | null
          title_en: string
          title_es: string
          updated_at?: string
          version?: number
          when_to_use?: string | null
        }
        Update: {
          applicable_programs?: string[]
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          archived_at?: string | null
          audience?: string
          authority?: string | null
          content_en?: string | null
          content_es?: string | null
          created_at?: string
          created_by?: string | null
          document_path?: string | null
          effective_at?: string | null
          file_type?: string | null
          id?: string
          internal_only?: boolean
          knowledge_type?: string
          language_codes?: string[]
          last_verified_at?: string | null
          municipality?: string | null
          official_sources?: Json
          org_id?: string | null
          owner_id?: string | null
          population_tags?: string[]
          purpose?: string | null
          related_forms?: string[]
          related_resources?: string[]
          required_steps?: Json
          review_due_at?: string | null
          service_categories?: string[]
          source_url?: string | null
          state_codes?: string[]
          summary_en?: string | null
          summary_es?: string | null
          title_en?: string
          title_es?: string
          updated_at?: string
          version?: number
          when_to_use?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "resource_knowledge_records_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_knowledge_usage: {
        Row: {
          action: string
          actor_id: string
          created_at: string
          id: string
          knowledge_id: string
          org_id: string | null
          social_case_id: string | null
        }
        Insert: {
          action: string
          actor_id: string
          created_at?: string
          id?: string
          knowledge_id: string
          org_id?: string | null
          social_case_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string
          created_at?: string
          id?: string
          knowledge_id?: string
          org_id?: string | null
          social_case_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "resource_knowledge_usage_knowledge_id_fkey"
            columns: ["knowledge_id"]
            isOneToOne: false
            referencedRelation: "resource_knowledge_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resource_knowledge_usage_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resource_knowledge_usage_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_knowledge_versions: {
        Row: {
          change_summary: string
          created_at: string
          created_by: string
          id: string
          knowledge_id: string
          snapshot: Json
          version: number
        }
        Insert: {
          change_summary: string
          created_at?: string
          created_by: string
          id?: string
          knowledge_id: string
          snapshot: Json
          version: number
        }
        Update: {
          change_summary?: string
          created_at?: string
          created_by?: string
          id?: string
          knowledge_id?: string
          snapshot?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "resource_knowledge_versions_knowledge_id_fkey"
            columns: ["knowledge_id"]
            isOneToOne: false
            referencedRelation: "resource_knowledge_records"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_official_sources: {
        Row: {
          active: boolean
          allowed_domains: string[]
          coverage_levels: string[]
          created_at: string
          id: string
          institution_type: string
          jurisdiction_level: string
          official_name: string
          populations: string[]
          refresh_interval_days: number
          services: string[]
          slug: string
          source_type: string
          source_urls: string[]
          state_code: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          active?: boolean
          allowed_domains?: string[]
          coverage_levels?: string[]
          created_at?: string
          id?: string
          institution_type: string
          jurisdiction_level?: string
          official_name: string
          populations?: string[]
          refresh_interval_days?: number
          services?: string[]
          slug: string
          source_type?: string
          source_urls: string[]
          state_code?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          active?: boolean
          allowed_domains?: string[]
          coverage_levels?: string[]
          created_at?: string
          id?: string
          institution_type?: string
          jurisdiction_level?: string
          official_name?: string
          populations?: string[]
          refresh_interval_days?: number
          services?: string[]
          slug?: string
          source_type?: string
          source_urls?: string[]
          state_code?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: []
      }
      resource_service_categories: {
        Row: {
          active: boolean
          code: string
          created_at: string
          description_en: string | null
          description_es: string | null
          id: string
          name_en: string
          name_es: string
          org_id: string | null
          sort_order: number
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          description_en?: string | null
          description_es?: string | null
          id?: string
          name_en: string
          name_es: string
          org_id?: string | null
          sort_order?: number
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          description_en?: string | null
          description_es?: string | null
          id?: string
          name_en?: string
          name_es?: string
          org_id?: string | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "resource_service_categories_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_verifications: {
        Row: {
          created_at: string
          evidence_url: string | null
          id: string
          institution_id: string
          next_verification_at: string | null
          notes: string | null
          org_id: string | null
          source: string
          status: string
          verified_at: string
          verified_by: string
        }
        Insert: {
          created_at?: string
          evidence_url?: string | null
          id?: string
          institution_id: string
          next_verification_at?: string | null
          notes?: string | null
          org_id?: string | null
          source: string
          status: string
          verified_at?: string
          verified_by: string
        }
        Update: {
          created_at?: string
          evidence_url?: string | null
          id?: string
          institution_id?: string
          next_verification_at?: string | null
          notes?: string | null
          org_id?: string | null
          source?: string
          status?: string
          verified_at?: string
          verified_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "resource_verifications_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "social_institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resource_verifications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          created_at: string
          id: string
          permission_code: string
          role: Database["public"]["Enums"]["org_role"]
        }
        Insert: {
          created_at?: string
          id?: string
          permission_code: string
          role: Database["public"]["Enums"]["org_role"]
        }
        Update: {
          created_at?: string
          id?: string
          permission_code?: string
          role?: Database["public"]["Enums"]["org_role"]
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_code_fkey"
            columns: ["permission_code"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["code"]
          },
        ]
      }
      security_incidents: {
        Row: {
          affected_systems: string[]
          category: string
          containment_notes: string | null
          containment_status: string
          created_at: string
          created_by: string | null
          description: string | null
          discovered_at: string
          id: string
          investigation_notes: string | null
          investigation_status: string
          notification_notes: string | null
          notification_required: boolean
          notification_status: string
          potentially_affected_user_ids: string[]
          potentially_affected_users: number | null
          reference: string
          reported_at: string | null
          resolved_at: string | null
          severity: Database["public"]["Enums"]["security_incident_severity"]
          status: Database["public"]["Enums"]["security_incident_status"]
          title: string
          updated_at: string
        }
        Insert: {
          affected_systems?: string[]
          category?: string
          containment_notes?: string | null
          containment_status?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          discovered_at?: string
          id?: string
          investigation_notes?: string | null
          investigation_status?: string
          notification_notes?: string | null
          notification_required?: boolean
          notification_status?: string
          potentially_affected_user_ids?: string[]
          potentially_affected_users?: number | null
          reference?: string
          reported_at?: string | null
          resolved_at?: string | null
          severity?: Database["public"]["Enums"]["security_incident_severity"]
          status?: Database["public"]["Enums"]["security_incident_status"]
          title: string
          updated_at?: string
        }
        Update: {
          affected_systems?: string[]
          category?: string
          containment_notes?: string | null
          containment_status?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          discovered_at?: string
          id?: string
          investigation_notes?: string | null
          investigation_status?: string
          notification_notes?: string | null
          notification_required?: boolean
          notification_status?: string
          potentially_affected_user_ids?: string[]
          potentially_affected_users?: number | null
          reference?: string
          reported_at?: string | null
          resolved_at?: string | null
          severity?: Database["public"]["Enums"]["security_incident_severity"]
          status?: Database["public"]["Enums"]["security_incident_status"]
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      social_activity_events: {
        Row: {
          actor_id: string | null
          entity_id: string | null
          entity_type: string
          event_type: string
          id: string
          metadata: Json
          occurred_at: string
          org_id: string
          social_case_id: string | null
        }
        Insert: {
          actor_id?: string | null
          entity_id?: string | null
          entity_type: string
          event_type: string
          id?: string
          metadata?: Json
          occurred_at?: string
          org_id: string
          social_case_id?: string | null
        }
        Update: {
          actor_id?: string | null
          entity_id?: string | null
          entity_type?: string
          event_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string
          org_id?: string
          social_case_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_activity_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_activity_events_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_alerts: {
        Row: {
          acknowledged_at: string | null
          alert_type: string
          assigned_to: string | null
          created_at: string
          due_at: string | null
          id: string
          metadata: Json
          org_id: string
          resolved_at: string | null
          severity: string
          social_case_id: string | null
          title_en: string
          title_es: string
        }
        Insert: {
          acknowledged_at?: string | null
          alert_type: string
          assigned_to?: string | null
          created_at?: string
          due_at?: string | null
          id?: string
          metadata?: Json
          org_id: string
          resolved_at?: string | null
          severity?: string
          social_case_id?: string | null
          title_en: string
          title_es: string
        }
        Update: {
          acknowledged_at?: string | null
          alert_type?: string
          assigned_to?: string | null
          created_at?: string
          due_at?: string | null
          id?: string
          metadata?: Json
          org_id?: string
          resolved_at?: string | null
          severity?: string
          social_case_id?: string | null
          title_en?: string
          title_es?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_alerts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_alerts_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_appointments: {
        Row: {
          created_at: string
          created_by: string
          duration_minutes: number | null
          id: string
          location_method: string | null
          missed_reason: string | null
          org_id: string
          person_id: string | null
          professional_id: string | null
          scheduled_at: string
          social_case_id: string
          status: string
          title: string
        }
        Insert: {
          created_at?: string
          created_by: string
          duration_minutes?: number | null
          id?: string
          location_method?: string | null
          missed_reason?: string | null
          org_id: string
          person_id?: string | null
          professional_id?: string | null
          scheduled_at: string
          social_case_id: string
          status?: string
          title: string
        }
        Update: {
          created_at?: string
          created_by?: string
          duration_minutes?: number | null
          id?: string
          location_method?: string | null
          missed_reason?: string | null
          org_id?: string
          person_id?: string | null
          professional_id?: string | null
          scheduled_at?: string
          social_case_id?: string
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_appointments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_appointments_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "social_people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_appointments_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_assessment_templates: {
        Row: {
          active: boolean
          code: string
          created_at: string
          created_by: string | null
          id: string
          name_en: string
          name_es: string
          org_id: string | null
          schema: Json
          version: number
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          created_by?: string | null
          id?: string
          name_en: string
          name_es: string
          org_id?: string | null
          schema: Json
          version?: number
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name_en?: string
          name_es?: string
          org_id?: string | null
          schema?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "social_assessment_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_assessment_versions: {
        Row: {
          answers: Json
          assessment_id: string
          created_at: string
          created_by: string
          evidence_observations: string | null
          id: string
          immediate_actions: string | null
          org_id: string
          protective_factors: string | null
          reason: string
          required_follow_up: string | null
          risk_level: string
          version: number
        }
        Insert: {
          answers?: Json
          assessment_id: string
          created_at?: string
          created_by: string
          evidence_observations?: string | null
          id?: string
          immediate_actions?: string | null
          org_id: string
          protective_factors?: string | null
          reason: string
          required_follow_up?: string | null
          risk_level: string
          version: number
        }
        Update: {
          answers?: Json
          assessment_id?: string
          created_at?: string
          created_by?: string
          evidence_observations?: string | null
          id?: string
          immediate_actions?: string | null
          org_id?: string
          protective_factors?: string | null
          reason?: string
          required_follow_up?: string | null
          risk_level?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "social_assessment_versions_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "social_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_assessment_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_assessments: {
        Row: {
          assessment_date: string
          assessor_id: string
          created_at: string
          current_version: number
          id: string
          next_review_date: string | null
          org_id: string
          override_explanation: string | null
          professional_override: boolean
          risk_level: string
          social_case_id: string
          template_id: string | null
        }
        Insert: {
          assessment_date?: string
          assessor_id: string
          created_at?: string
          current_version?: number
          id?: string
          next_review_date?: string | null
          org_id: string
          override_explanation?: string | null
          professional_override?: boolean
          risk_level?: string
          social_case_id: string
          template_id?: string | null
        }
        Update: {
          assessment_date?: string
          assessor_id?: string
          created_at?: string
          current_version?: number
          id?: string
          next_review_date?: string | null
          org_id?: string
          override_explanation?: string | null
          professional_override?: boolean
          risk_level?: string
          social_case_id?: string
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_assessments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_assessments_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_assessments_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "social_assessment_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      social_care_action_proposals: {
        Row: {
          action_type: string
          assistant_run_id: string | null
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          id: string
          org_id: string
          preview: Json
          proposed_by: string
          social_case_id: string
          status: string
        }
        Insert: {
          action_type: string
          assistant_run_id?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          org_id: string
          preview: Json
          proposed_by: string
          social_case_id: string
          status?: string
        }
        Update: {
          action_type?: string
          assistant_run_id?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          id?: string
          org_id?: string
          preview?: Json
          proposed_by?: string
          social_case_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_care_action_proposals_assistant_run_id_fkey"
            columns: ["assistant_run_id"]
            isOneToOne: false
            referencedRelation: "social_care_assistant_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_care_action_proposals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_care_action_proposals_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_care_assistant_runs: {
        Row: {
          actor_id: string
          created_at: string
          health_check: boolean
          id: string
          language: string
          org_id: string
          question: string
          response: Json
          retrieval_manifest: Json
          social_case_id: string
        }
        Insert: {
          actor_id: string
          created_at?: string
          health_check?: boolean
          id?: string
          language?: string
          org_id: string
          question: string
          response: Json
          retrieval_manifest?: Json
          social_case_id: string
        }
        Update: {
          actor_id?: string
          created_at?: string
          health_check?: boolean
          id?: string
          language?: string
          org_id?: string
          question?: string
          response?: Json
          retrieval_manifest?: Json
          social_case_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_care_assistant_runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_care_assistant_runs_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_care_plan_goals: {
        Row: {
          care_plan_version_id: string
          completion_evidence: string | null
          created_at: string
          expected_outcome: string | null
          external_institution_id: string | null
          goal: string
          id: string
          identified_need: string
          org_id: string
          planned_action: string
          priority: string
          required_consent: string | null
          responsible_person: string | null
          responsible_service_area: string | null
          review_date: string | null
          status: string
          target_date: string | null
        }
        Insert: {
          care_plan_version_id: string
          completion_evidence?: string | null
          created_at?: string
          expected_outcome?: string | null
          external_institution_id?: string | null
          goal: string
          id?: string
          identified_need: string
          org_id: string
          planned_action: string
          priority?: string
          required_consent?: string | null
          responsible_person?: string | null
          responsible_service_area?: string | null
          review_date?: string | null
          status?: string
          target_date?: string | null
        }
        Update: {
          care_plan_version_id?: string
          completion_evidence?: string | null
          created_at?: string
          expected_outcome?: string | null
          external_institution_id?: string | null
          goal?: string
          id?: string
          identified_need?: string
          org_id?: string
          planned_action?: string
          priority?: string
          required_consent?: string | null
          responsible_person?: string | null
          responsible_service_area?: string | null
          review_date?: string | null
          status?: string
          target_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_care_plan_goals_care_plan_version_id_fkey"
            columns: ["care_plan_version_id"]
            isOneToOne: false
            referencedRelation: "social_care_plan_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_care_plan_goals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_care_plan_versions: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          care_plan_id: string
          created_at: string
          id: string
          org_id: string
          status: string
          submitted_by: string
          summary: string | null
          version: number
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          care_plan_id: string
          created_at?: string
          id?: string
          org_id: string
          status: string
          submitted_by: string
          summary?: string | null
          version: number
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          care_plan_id?: string
          created_at?: string
          id?: string
          org_id?: string
          status?: string
          submitted_by?: string
          summary?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "social_care_plan_versions_care_plan_id_fkey"
            columns: ["care_plan_id"]
            isOneToOne: false
            referencedRelation: "social_care_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_care_plan_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_care_plans: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          created_by: string
          current_version: number
          family_id: string | null
          id: string
          org_id: string
          social_case_id: string
          status: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by: string
          current_version?: number
          family_id?: string | null
          id?: string
          org_id: string
          social_case_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          created_by?: string
          current_version?: number
          family_id?: string | null
          id?: string
          org_id?: string
          social_case_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_care_plans_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "social_families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_care_plans_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_care_plans_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_case_assignments: {
        Row: {
          active: boolean
          assigned_at: string
          assigned_by: string
          assignment_role: string
          ended_at: string | null
          id: string
          org_id: string
          social_case_id: string
          user_id: string
        }
        Insert: {
          active?: boolean
          assigned_at?: string
          assigned_by: string
          assignment_role: string
          ended_at?: string | null
          id?: string
          org_id: string
          social_case_id: string
          user_id: string
        }
        Update: {
          active?: boolean
          assigned_at?: string
          assigned_by?: string
          assignment_role?: string
          ended_at?: string | null
          id?: string
          org_id?: string
          social_case_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_case_assignments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_assignments_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_case_closures: {
        Row: {
          client_notification: string | null
          closing_professional: string
          closure_date: string | null
          closure_reason: string
          closure_version: number
          created_at: string
          document_disposition: string | null
          final_risk_level: string
          goals_completed: string | null
          goals_incomplete: string | null
          id: string
          org_id: string
          outstanding_deadlines: string | null
          pending_referrals: string | null
          referrals_completed: string | null
          reopen_reason: string | null
          reopened_at: string | null
          reopened_by: string | null
          retention_status: string | null
          social_case_id: string
          supervisor_approval_by: string | null
          supervisor_approved_at: string | null
        }
        Insert: {
          client_notification?: string | null
          closing_professional: string
          closure_date?: string | null
          closure_reason: string
          closure_version?: number
          created_at?: string
          document_disposition?: string | null
          final_risk_level: string
          goals_completed?: string | null
          goals_incomplete?: string | null
          id?: string
          org_id: string
          outstanding_deadlines?: string | null
          pending_referrals?: string | null
          referrals_completed?: string | null
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          retention_status?: string | null
          social_case_id: string
          supervisor_approval_by?: string | null
          supervisor_approved_at?: string | null
        }
        Update: {
          client_notification?: string | null
          closing_professional?: string
          closure_date?: string | null
          closure_reason?: string
          closure_version?: number
          created_at?: string
          document_disposition?: string | null
          final_risk_level?: string
          goals_completed?: string | null
          goals_incomplete?: string | null
          id?: string
          org_id?: string
          outstanding_deadlines?: string | null
          pending_referrals?: string | null
          referrals_completed?: string | null
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          retention_status?: string | null
          social_case_id?: string
          supervisor_approval_by?: string | null
          supervisor_approved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_case_closures_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_closures_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_case_document_requirements: {
        Row: {
          created_at: string
          created_by: string
          document_type: string
          due_at: string | null
          id: string
          notes: string | null
          org_id: string
          social_case_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          document_type: string
          due_at?: string | null
          id?: string
          notes?: string | null
          org_id: string
          social_case_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          document_type?: string
          due_at?: string | null
          id?: string
          notes?: string | null
          org_id?: string
          social_case_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_case_document_requirements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_document_requirements_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_case_number_counters: {
        Row: {
          calendar_year: number
          last_number: number
          org_id: string
          program_id: string
        }
        Insert: {
          calendar_year: number
          last_number?: number
          org_id: string
          program_id: string
        }
        Update: {
          calendar_year?: number
          last_number?: number
          org_id?: string
          program_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_case_number_counters_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_number_counters_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "social_programs"
            referencedColumns: ["id"]
          },
        ]
      }
      social_case_status_history: {
        Row: {
          change_kind: string
          changed_at: string
          changed_by: string
          from_priority: string | null
          from_status: string | null
          id: string
          org_id: string
          reason: string
          social_case_id: string
          to_priority: string | null
          to_status: string
        }
        Insert: {
          change_kind?: string
          changed_at?: string
          changed_by: string
          from_priority?: string | null
          from_status?: string | null
          id?: string
          org_id: string
          reason: string
          social_case_id: string
          to_priority?: string | null
          to_status: string
        }
        Update: {
          change_kind?: string
          changed_at?: string
          changed_by?: string
          from_priority?: string | null
          from_status?: string | null
          id?: string
          org_id?: string
          reason?: string
          social_case_id?: string
          to_priority?: string | null
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_case_status_history_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_status_history_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_case_transfer_items: {
        Row: {
          created_at: string
          created_by: string
          description: string | null
          exclusion_reason: string | null
          id: string
          included: boolean
          item_id: string | null
          item_type: string
          org_id: string
          record_type: string
          transfer_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string | null
          exclusion_reason?: string | null
          id?: string
          included?: boolean
          item_id?: string | null
          item_type: string
          org_id: string
          record_type?: string
          transfer_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string | null
          exclusion_reason?: string | null
          id?: string
          included?: boolean
          item_id?: string | null
          item_type?: string
          org_id?: string
          record_type?: string
          transfer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_case_transfer_items_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_transfer_items_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: false
            referencedRelation: "social_case_transfers"
            referencedColumns: ["id"]
          },
        ]
      }
      social_case_transfers: {
        Row: {
          consent_id: string | null
          created_at: string
          created_by: string
          deadlines: Json
          from_office_id: string | null
          from_user_id: string | null
          id: string
          org_id: string
          received_at: string | null
          received_by: string | null
          receiving_org_id: string | null
          restricted_information: Json
          selected_information: Json
          sent_at: string | null
          social_case_id: string
          status: string
          to_office_id: string | null
          to_user_id: string | null
          transfer_summary: string
          transfer_type: string
        }
        Insert: {
          consent_id?: string | null
          created_at?: string
          created_by: string
          deadlines?: Json
          from_office_id?: string | null
          from_user_id?: string | null
          id?: string
          org_id: string
          received_at?: string | null
          received_by?: string | null
          receiving_org_id?: string | null
          restricted_information?: Json
          selected_information?: Json
          sent_at?: string | null
          social_case_id: string
          status?: string
          to_office_id?: string | null
          to_user_id?: string | null
          transfer_summary: string
          transfer_type: string
        }
        Update: {
          consent_id?: string | null
          created_at?: string
          created_by?: string
          deadlines?: Json
          from_office_id?: string | null
          from_user_id?: string | null
          id?: string
          org_id?: string
          received_at?: string | null
          received_by?: string | null
          receiving_org_id?: string | null
          restricted_information?: Json
          selected_information?: Json
          sent_at?: string | null
          social_case_id?: string
          status?: string
          to_office_id?: string | null
          to_user_id?: string | null
          transfer_summary?: string
          transfer_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_case_transfers_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "social_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_transfers_from_office_id_fkey"
            columns: ["from_office_id"]
            isOneToOne: false
            referencedRelation: "social_offices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_transfers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_transfers_receiving_org_id_fkey"
            columns: ["receiving_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_transfers_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_case_transfers_to_office_id_fkey"
            columns: ["to_office_id"]
            isOneToOne: false
            referencedRelation: "social_offices"
            referencedColumns: ["id"]
          },
        ]
      }
      social_cases: {
        Row: {
          assigned_case_manager: string | null
          case_number: string
          case_type: string
          closure_date: string | null
          confidentiality_level: string
          consent_status: string
          created_at: string
          created_by: string
          deleted_at: string | null
          deleted_by: string | null
          deletion_reason: string | null
          family_id: string | null
          id: string
          intake_date: string
          last_activity_at: string
          next_required_action: string | null
          office_id: string | null
          opened_at: string
          org_id: string
          person_id: string | null
          priority: string
          program_id: string
          referral_source: string | null
          risk_level: string
          service_areas: string[]
          status: string
          supervising_manager: string | null
          tags: string[]
          transfer_date: string | null
          updated_at: string
        }
        Insert: {
          assigned_case_manager?: string | null
          case_number: string
          case_type: string
          closure_date?: string | null
          confidentiality_level?: string
          consent_status?: string
          created_at?: string
          created_by: string
          deleted_at?: string | null
          deleted_by?: string | null
          deletion_reason?: string | null
          family_id?: string | null
          id?: string
          intake_date?: string
          last_activity_at?: string
          next_required_action?: string | null
          office_id?: string | null
          opened_at?: string
          org_id: string
          person_id?: string | null
          priority?: string
          program_id: string
          referral_source?: string | null
          risk_level?: string
          service_areas?: string[]
          status?: string
          supervising_manager?: string | null
          tags?: string[]
          transfer_date?: string | null
          updated_at?: string
        }
        Update: {
          assigned_case_manager?: string | null
          case_number?: string
          case_type?: string
          closure_date?: string | null
          confidentiality_level?: string
          consent_status?: string
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deleted_by?: string | null
          deletion_reason?: string | null
          family_id?: string | null
          id?: string
          intake_date?: string
          last_activity_at?: string
          next_required_action?: string | null
          office_id?: string | null
          opened_at?: string
          org_id?: string
          person_id?: string | null
          priority?: string
          program_id?: string
          referral_source?: string | null
          risk_level?: string
          service_areas?: string[]
          status?: string
          supervising_manager?: string | null
          tags?: string[]
          transfer_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_cases_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "social_families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_cases_office_id_fkey"
            columns: ["office_id"]
            isOneToOne: false
            referencedRelation: "social_offices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_cases_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_cases_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "social_people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_cases_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "social_programs"
            referencedColumns: ["id"]
          },
        ]
      }
      social_consent_versions: {
        Row: {
          confirmation: Json
          consent_id: string
          consented_by_name: string
          created_at: string
          created_by: string
          guardian_representative: string | null
          id: string
          language: string
          org_id: string
          permitted_information: string[]
          permitted_purpose: string[]
          permitted_recipients: string[]
          restrictions: string | null
          version: number
        }
        Insert: {
          confirmation?: Json
          consent_id: string
          consented_by_name: string
          created_at?: string
          created_by: string
          guardian_representative?: string | null
          id?: string
          language?: string
          org_id: string
          permitted_information?: string[]
          permitted_purpose?: string[]
          permitted_recipients?: string[]
          restrictions?: string | null
          version: number
        }
        Update: {
          confirmation?: Json
          consent_id?: string
          consented_by_name?: string
          created_at?: string
          created_by?: string
          guardian_representative?: string | null
          id?: string
          language?: string
          org_id?: string
          permitted_information?: string[]
          permitted_purpose?: string[]
          permitted_recipients?: string[]
          restrictions?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "social_consent_versions_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "social_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_consent_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_consents: {
        Row: {
          consent_type: string
          created_at: string
          created_by: string
          current_version: number
          expires_at: string | null
          family_id: string | null
          id: string
          org_id: string
          person_id: string | null
          revoked_at: string | null
          status: string
          valid_from: string
        }
        Insert: {
          consent_type: string
          created_at?: string
          created_by: string
          current_version?: number
          expires_at?: string | null
          family_id?: string | null
          id?: string
          org_id: string
          person_id?: string | null
          revoked_at?: string | null
          status?: string
          valid_from?: string
        }
        Update: {
          consent_type?: string
          created_at?: string
          created_by?: string
          current_version?: number
          expires_at?: string | null
          family_id?: string | null
          id?: string
          org_id?: string
          person_id?: string | null
          revoked_at?: string | null
          status?: string
          valid_from?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_consents_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "social_families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_consents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_consents_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "social_people"
            referencedColumns: ["id"]
          },
        ]
      }
      social_document_access_events: {
        Row: {
          action: string
          actor_id: string
          document_id: string
          id: string
          occurred_at: string
          org_id: string
          reason: string | null
          social_case_id: string
          version: number
        }
        Insert: {
          action: string
          actor_id: string
          document_id: string
          id?: string
          occurred_at?: string
          org_id: string
          reason?: string | null
          social_case_id: string
          version: number
        }
        Update: {
          action?: string
          actor_id?: string
          document_id?: string
          id?: string
          occurred_at?: string
          org_id?: string
          reason?: string | null
          social_case_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "social_document_access_events_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "social_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_document_access_events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_document_access_events_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_document_shares: {
        Row: {
          consent_id: string
          created_at: string
          created_by: string
          document_id: string
          expires_at: string | null
          id: string
          org_id: string
          purpose: string
          receiving_org_id: string
          revoked_at: string | null
        }
        Insert: {
          consent_id: string
          created_at?: string
          created_by: string
          document_id: string
          expires_at?: string | null
          id?: string
          org_id: string
          purpose: string
          receiving_org_id: string
          revoked_at?: string | null
        }
        Update: {
          consent_id?: string
          created_at?: string
          created_by?: string
          document_id?: string
          expires_at?: string | null
          id?: string
          org_id?: string
          purpose?: string
          receiving_org_id?: string
          revoked_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_document_shares_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "social_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_document_shares_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "social_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_document_shares_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_document_shares_receiving_org_id_fkey"
            columns: ["receiving_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_document_versions: {
        Row: {
          checksum: string
          created_at: string
          document_id: string
          id: string
          mime_type: string | null
          notes: string | null
          org_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_by: string
          version: number
        }
        Insert: {
          checksum: string
          created_at?: string
          document_id: string
          id?: string
          mime_type?: string | null
          notes?: string | null
          org_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_by: string
          version: number
        }
        Update: {
          checksum?: string
          created_at?: string
          document_id?: string
          id?: string
          mime_type?: string | null
          notes?: string | null
          org_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_by?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "social_document_versions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "social_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_document_versions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_documents: {
        Row: {
          checksum: string | null
          classification_status: string
          consent_id: string | null
          created_at: string
          current_version: number
          deleted_at: string | null
          description: string | null
          document_status: string
          document_type: string | null
          expires_at: string | null
          external_shareable: boolean
          extracted_text: string | null
          extraction_authorized: boolean
          family_id: string | null
          id: string
          linked_entities: Json
          mime_type: string | null
          org_id: string
          person_id: string | null
          record_type: string
          sensitivity: string
          size_bytes: number | null
          social_case_id: string
          storage_path: string
          superseded_by: string | null
          tags: string[]
          title: string
          updated_at: string
          uploaded_by: string
        }
        Insert: {
          checksum?: string | null
          classification_status?: string
          consent_id?: string | null
          created_at?: string
          current_version?: number
          deleted_at?: string | null
          description?: string | null
          document_status?: string
          document_type?: string | null
          expires_at?: string | null
          external_shareable?: boolean
          extracted_text?: string | null
          extraction_authorized?: boolean
          family_id?: string | null
          id?: string
          linked_entities?: Json
          mime_type?: string | null
          org_id: string
          person_id?: string | null
          record_type?: string
          sensitivity?: string
          size_bytes?: number | null
          social_case_id: string
          storage_path: string
          superseded_by?: string | null
          tags?: string[]
          title: string
          updated_at?: string
          uploaded_by: string
        }
        Update: {
          checksum?: string | null
          classification_status?: string
          consent_id?: string | null
          created_at?: string
          current_version?: number
          deleted_at?: string | null
          description?: string | null
          document_status?: string
          document_type?: string | null
          expires_at?: string | null
          external_shareable?: boolean
          extracted_text?: string | null
          extraction_authorized?: boolean
          family_id?: string | null
          id?: string
          linked_entities?: Json
          mime_type?: string | null
          org_id?: string
          person_id?: string | null
          record_type?: string
          sensitivity?: string
          size_bytes?: number | null
          social_case_id?: string
          storage_path?: string
          superseded_by?: string | null
          tags?: string[]
          title?: string
          updated_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_documents_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "social_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_documents_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "social_families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_documents_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "social_people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_documents_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_documents_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "social_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      social_families: {
        Row: {
          assigned_case_manager: string | null
          created_at: string
          created_by: string
          current_location: Json
          data_sharing_permissions: Json
          deleted_at: string | null
          family_name: string
          family_number: string
          id: string
          office_id: string | null
          org_id: string
          primary_contact_person_id: string | null
          shared_needs: Json
          shared_risks: Json
          updated_at: string
        }
        Insert: {
          assigned_case_manager?: string | null
          created_at?: string
          created_by: string
          current_location?: Json
          data_sharing_permissions?: Json
          deleted_at?: string | null
          family_name: string
          family_number: string
          id?: string
          office_id?: string | null
          org_id: string
          primary_contact_person_id?: string | null
          shared_needs?: Json
          shared_risks?: Json
          updated_at?: string
        }
        Update: {
          assigned_case_manager?: string | null
          created_at?: string
          created_by?: string
          current_location?: Json
          data_sharing_permissions?: Json
          deleted_at?: string | null
          family_name?: string
          family_number?: string
          id?: string
          office_id?: string | null
          org_id?: string
          primary_contact_person_id?: string | null
          shared_needs?: Json
          shared_risks?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_families_office_id_fkey"
            columns: ["office_id"]
            isOneToOne: false
            referencedRelation: "social_offices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_families_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_families_primary_contact_person_id_fkey"
            columns: ["primary_contact_person_id"]
            isOneToOne: false
            referencedRelation: "social_people"
            referencedColumns: ["id"]
          },
        ]
      }
      social_family_members: {
        Row: {
          family_id: string
          id: string
          is_child: boolean
          is_dependent: boolean
          is_guardian: boolean
          joined_at: string
          left_at: string | null
          org_id: string
          person_id: string
          relationship: string | null
        }
        Insert: {
          family_id: string
          id?: string
          is_child?: boolean
          is_dependent?: boolean
          is_guardian?: boolean
          joined_at?: string
          left_at?: string | null
          org_id: string
          person_id: string
          relationship?: string | null
        }
        Update: {
          family_id?: string
          id?: string
          is_child?: boolean
          is_dependent?: boolean
          is_guardian?: boolean
          joined_at?: string
          left_at?: string | null
          org_id?: string
          person_id?: string
          relationship?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_family_members_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "social_families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_family_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_family_members_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "social_people"
            referencedColumns: ["id"]
          },
        ]
      }
      social_identifier_counters: {
        Row: {
          calendar_year: number
          entity_type: string
          last_number: number
          org_id: string
        }
        Insert: {
          calendar_year: number
          entity_type: string
          last_number?: number
          org_id: string
        }
        Update: {
          calendar_year?: number
          entity_type?: string
          last_number?: number
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_identifier_counters_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_immigration_links: {
        Row: {
          consent_id: string
          created_at: string
          created_by: string
          detention_deportation_risk: boolean
          id: string
          immigration_case_id: string
          non_refoulement_concern: boolean
          org_id: string
          permitted_status_fields: string[]
          revoked_at: string | null
          shared_document_ids: string[]
          shared_social_fields: string[]
          social_case_id: string
        }
        Insert: {
          consent_id: string
          created_at?: string
          created_by: string
          detention_deportation_risk?: boolean
          id?: string
          immigration_case_id: string
          non_refoulement_concern?: boolean
          org_id: string
          permitted_status_fields?: string[]
          revoked_at?: string | null
          shared_document_ids?: string[]
          shared_social_fields?: string[]
          social_case_id: string
        }
        Update: {
          consent_id?: string
          created_at?: string
          created_by?: string
          detention_deportation_risk?: boolean
          id?: string
          immigration_case_id?: string
          non_refoulement_concern?: boolean
          org_id?: string
          permitted_status_fields?: string[]
          revoked_at?: string | null
          shared_document_ids?: string[]
          shared_social_fields?: string[]
          social_case_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_immigration_links_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "social_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_immigration_links_immigration_case_id_fkey"
            columns: ["immigration_case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_immigration_links_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_immigration_links_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_indicator_definitions: {
        Row: {
          active: boolean
          aggregation: string
          code: string
          created_at: string
          created_by: string | null
          denominator_filter: Json | null
          description_en: string | null
          description_es: string | null
          id: string
          name_en: string
          name_es: string
          numerator_filter: Json
          org_id: string | null
          small_group_threshold: number
          source_entity: string
        }
        Insert: {
          active?: boolean
          aggregation: string
          code: string
          created_at?: string
          created_by?: string | null
          denominator_filter?: Json | null
          description_en?: string | null
          description_es?: string | null
          id?: string
          name_en: string
          name_es: string
          numerator_filter?: Json
          org_id?: string | null
          small_group_threshold?: number
          source_entity: string
        }
        Update: {
          active?: boolean
          aggregation?: string
          code?: string
          created_at?: string
          created_by?: string | null
          denominator_filter?: Json | null
          description_en?: string | null
          description_es?: string | null
          id?: string
          name_en?: string
          name_es?: string
          numerator_filter?: Json
          org_id?: string | null
          small_group_threshold?: number
          source_entity?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_indicator_definitions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_indicator_snapshots: {
        Row: {
          definition_id: string | null
          filters: Json
          generated_at: string
          id: string
          indicator_code: string
          office_id: string | null
          org_id: string
          period_end: string
          period_start: string
          program_id: string | null
          suppressed: boolean
          suppression_reason: string | null
          value: number
        }
        Insert: {
          definition_id?: string | null
          filters?: Json
          generated_at?: string
          id?: string
          indicator_code: string
          office_id?: string | null
          org_id: string
          period_end: string
          period_start: string
          program_id?: string | null
          suppressed?: boolean
          suppression_reason?: string | null
          value: number
        }
        Update: {
          definition_id?: string | null
          filters?: Json
          generated_at?: string
          id?: string
          indicator_code?: string
          office_id?: string | null
          org_id?: string
          period_end?: string
          period_start?: string
          program_id?: string | null
          suppressed?: boolean
          suppression_reason?: string | null
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "social_indicator_snapshots_definition_id_fkey"
            columns: ["definition_id"]
            isOneToOne: false
            referencedRelation: "social_indicator_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_indicator_snapshots_office_id_fkey"
            columns: ["office_id"]
            isOneToOne: false
            referencedRelation: "social_offices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_indicator_snapshots_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_indicator_snapshots_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "social_programs"
            referencedColumns: ["id"]
          },
        ]
      }
      social_institutions: {
        Row: {
          accessibility: string[]
          active: boolean
          address: string | null
          admin_locked_fields: string[]
          appointment_required: boolean
          approved_at: string | null
          approved_by: string | null
          capacity_status: string
          confidentiality_level: string
          contact: Json
          contact_person: string | null
          contact_verification: string
          cost_notes: string | null
          cost_type: string
          coverage_levels: string[]
          coverage_municipalities: string[]
          coverage_states: string[]
          created_at: string
          description: string | null
          eligibility: string | null
          email: string | null
          emergency_available: boolean
          hours: Json
          id: string
          institution_type: string
          internal_notes: string | null
          jurisdiction_level: string | null
          languages: string[]
          last_checked_at: string | null
          latitude: number | null
          location_confidential: boolean
          longitude: number | null
          municipality: string | null
          name: string
          next_verification_at: string | null
          official_name: string | null
          org_id: string | null
          phone: string | null
          populations: string[]
          public_notes: string | null
          referral_methods: string[]
          remote_available: boolean
          required_documents: string[]
          services: string[]
          source_slug: string | null
          source_type: string | null
          source_url: string | null
          source_verified_fields: string[]
          state_code: string | null
          status: string
          updated_at: string
          verification_evidence_url: string | null
          verification_source: string | null
          verification_status: string
          verified_at: string | null
          verified_by: string | null
          walk_in_available: boolean
          website: string | null
          whatsapp: string | null
        }
        Insert: {
          accessibility?: string[]
          active?: boolean
          address?: string | null
          admin_locked_fields?: string[]
          appointment_required?: boolean
          approved_at?: string | null
          approved_by?: string | null
          capacity_status?: string
          confidentiality_level?: string
          contact?: Json
          contact_person?: string | null
          contact_verification?: string
          cost_notes?: string | null
          cost_type?: string
          coverage_levels?: string[]
          coverage_municipalities?: string[]
          coverage_states?: string[]
          created_at?: string
          description?: string | null
          eligibility?: string | null
          email?: string | null
          emergency_available?: boolean
          hours?: Json
          id?: string
          institution_type: string
          internal_notes?: string | null
          jurisdiction_level?: string | null
          languages?: string[]
          last_checked_at?: string | null
          latitude?: number | null
          location_confidential?: boolean
          longitude?: number | null
          municipality?: string | null
          name: string
          next_verification_at?: string | null
          official_name?: string | null
          org_id?: string | null
          phone?: string | null
          populations?: string[]
          public_notes?: string | null
          referral_methods?: string[]
          remote_available?: boolean
          required_documents?: string[]
          services?: string[]
          source_slug?: string | null
          source_type?: string | null
          source_url?: string | null
          source_verified_fields?: string[]
          state_code?: string | null
          status?: string
          updated_at?: string
          verification_evidence_url?: string | null
          verification_source?: string | null
          verification_status?: string
          verified_at?: string | null
          verified_by?: string | null
          walk_in_available?: boolean
          website?: string | null
          whatsapp?: string | null
        }
        Update: {
          accessibility?: string[]
          active?: boolean
          address?: string | null
          admin_locked_fields?: string[]
          appointment_required?: boolean
          approved_at?: string | null
          approved_by?: string | null
          capacity_status?: string
          confidentiality_level?: string
          contact?: Json
          contact_person?: string | null
          contact_verification?: string
          cost_notes?: string | null
          cost_type?: string
          coverage_levels?: string[]
          coverage_municipalities?: string[]
          coverage_states?: string[]
          created_at?: string
          description?: string | null
          eligibility?: string | null
          email?: string | null
          emergency_available?: boolean
          hours?: Json
          id?: string
          institution_type?: string
          internal_notes?: string | null
          jurisdiction_level?: string | null
          languages?: string[]
          last_checked_at?: string | null
          latitude?: number | null
          location_confidential?: boolean
          longitude?: number | null
          municipality?: string | null
          name?: string
          next_verification_at?: string | null
          official_name?: string | null
          org_id?: string | null
          phone?: string | null
          populations?: string[]
          public_notes?: string | null
          referral_methods?: string[]
          remote_available?: boolean
          required_documents?: string[]
          services?: string[]
          source_slug?: string | null
          source_type?: string | null
          source_url?: string | null
          source_verified_fields?: string[]
          state_code?: string | null
          status?: string
          updated_at?: string
          verification_evidence_url?: string | null
          verification_source?: string | null
          verification_status?: string
          verified_at?: string | null
          verified_by?: string | null
          walk_in_available?: boolean
          website?: string | null
          whatsapp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_institutions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_intake_number_counters: {
        Row: {
          intake_year: number
          next_value: number
          org_id: string
        }
        Insert: {
          intake_year: number
          next_value?: number
          org_id: string
        }
        Update: {
          intake_year?: number
          next_value?: number
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_intake_number_counters_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_intakes: {
        Row: {
          assigned_to: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string
          disposition: string
          disposition_reason: string | null
          duplicate_check_completed_at: string | null
          duplicate_check_completed_by: string | null
          family_id: string | null
          id: string
          intake_number: string
          org_id: string
          person_id: string
          presenting_needs: string[]
          program_id: string
          social_case_id: string | null
          source: string
          status: string
          summary: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by: string
          disposition?: string
          disposition_reason?: string | null
          duplicate_check_completed_at?: string | null
          duplicate_check_completed_by?: string | null
          family_id?: string | null
          id?: string
          intake_number: string
          org_id: string
          person_id: string
          presenting_needs?: string[]
          program_id: string
          social_case_id?: string | null
          source?: string
          status?: string
          summary: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string
          disposition?: string
          disposition_reason?: string | null
          duplicate_check_completed_at?: string | null
          duplicate_check_completed_by?: string | null
          family_id?: string | null
          id?: string
          intake_number?: string
          org_id?: string
          person_id?: string
          presenting_needs?: string[]
          program_id?: string
          social_case_id?: string | null
          source?: string
          status?: string
          summary?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_intakes_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "social_families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_intakes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_intakes_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "social_people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_intakes_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "social_programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_intakes_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_interventions: {
        Row: {
          actions_taken: string
          care_plan_goal_id: string | null
          confidentiality_level: string
          created_at: string
          family_id: string | null
          follow_up_required: boolean
          id: string
          location_method: string | null
          next_appointment: string | null
          occurred_at: string
          org_id: string
          outcome: string | null
          person_id: string | null
          professional_id: string
          reason: string
          record_type: string
          service_type: string
          social_case_id: string
        }
        Insert: {
          actions_taken: string
          care_plan_goal_id?: string | null
          confidentiality_level?: string
          created_at?: string
          family_id?: string | null
          follow_up_required?: boolean
          id?: string
          location_method?: string | null
          next_appointment?: string | null
          occurred_at: string
          org_id: string
          outcome?: string | null
          person_id?: string | null
          professional_id: string
          reason: string
          record_type?: string
          service_type: string
          social_case_id: string
        }
        Update: {
          actions_taken?: string
          care_plan_goal_id?: string | null
          confidentiality_level?: string
          created_at?: string
          family_id?: string | null
          follow_up_required?: boolean
          id?: string
          location_method?: string | null
          next_appointment?: string | null
          occurred_at?: string
          org_id?: string
          outcome?: string | null
          person_id?: string | null
          professional_id?: string
          reason?: string
          record_type?: string
          service_type?: string
          social_case_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_interventions_care_plan_goal_id_fkey"
            columns: ["care_plan_goal_id"]
            isOneToOne: false
            referencedRelation: "social_care_plan_goals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_interventions_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "social_families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_interventions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_interventions_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "social_people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_interventions_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_offices: {
        Row: {
          active: boolean
          address: Json
          code: string
          created_at: string
          id: string
          name: string
          org_id: string
          program_id: string | null
        }
        Insert: {
          active?: boolean
          address?: Json
          code: string
          created_at?: string
          id?: string
          name: string
          org_id: string
          program_id?: string | null
        }
        Update: {
          active?: boolean
          address?: Json
          code?: string
          created_at?: string
          id?: string
          name?: string
          org_id?: string
          program_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_offices_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_offices_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "social_programs"
            referencedColumns: ["id"]
          },
        ]
      }
      social_people: {
        Row: {
          accessibility_needs: string | null
          aliases: string[]
          approximate_age: number | null
          assigned_case_manager: string | null
          consent_status: string
          country_of_origin: string | null
          created_at: string
          created_by: string
          current_location: Json
          data_sharing_restrictions: string | null
          date_of_birth: string | null
          deleted_at: string | null
          email: string | null
          emergency_contact: Json
          gender_identity: string | null
          id: string
          identity_documents: Json
          immigration_identifiers: Json
          interpreter_required: boolean
          is_minor: boolean | null
          languages: string[]
          legal_name: string
          nationality: string | null
          office_id: string | null
          org_id: string
          person_number: string
          place_of_origin: string | null
          preferred_name: string | null
          record_status: string
          safety_restrictions: string | null
          separated_minor: boolean
          sex: string | null
          telephone: string | null
          unaccompanied_minor: boolean
          updated_at: string
        }
        Insert: {
          accessibility_needs?: string | null
          aliases?: string[]
          approximate_age?: number | null
          assigned_case_manager?: string | null
          consent_status?: string
          country_of_origin?: string | null
          created_at?: string
          created_by: string
          current_location?: Json
          data_sharing_restrictions?: string | null
          date_of_birth?: string | null
          deleted_at?: string | null
          email?: string | null
          emergency_contact?: Json
          gender_identity?: string | null
          id?: string
          identity_documents?: Json
          immigration_identifiers?: Json
          interpreter_required?: boolean
          is_minor?: boolean | null
          languages?: string[]
          legal_name: string
          nationality?: string | null
          office_id?: string | null
          org_id: string
          person_number: string
          place_of_origin?: string | null
          preferred_name?: string | null
          record_status?: string
          safety_restrictions?: string | null
          separated_minor?: boolean
          sex?: string | null
          telephone?: string | null
          unaccompanied_minor?: boolean
          updated_at?: string
        }
        Update: {
          accessibility_needs?: string | null
          aliases?: string[]
          approximate_age?: number | null
          assigned_case_manager?: string | null
          consent_status?: string
          country_of_origin?: string | null
          created_at?: string
          created_by?: string
          current_location?: Json
          data_sharing_restrictions?: string | null
          date_of_birth?: string | null
          deleted_at?: string | null
          email?: string | null
          emergency_contact?: Json
          gender_identity?: string | null
          id?: string
          identity_documents?: Json
          immigration_identifiers?: Json
          interpreter_required?: boolean
          is_minor?: boolean | null
          languages?: string[]
          legal_name?: string
          nationality?: string | null
          office_id?: string | null
          org_id?: string
          person_number?: string
          place_of_origin?: string | null
          preferred_name?: string | null
          record_status?: string
          safety_restrictions?: string | null
          separated_minor?: boolean
          sex?: string | null
          telephone?: string | null
          unaccompanied_minor?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_people_office_id_fkey"
            columns: ["office_id"]
            isOneToOne: false
            referencedRelation: "social_offices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_people_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_programs: {
        Row: {
          active: boolean
          case_prefix: string
          code: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          name_en: string
          name_es: string
          org_id: string
          settings: Json
          updated_at: string
        }
        Insert: {
          active?: boolean
          case_prefix?: string
          code: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          name_en: string
          name_es: string
          org_id: string
          settings?: Json
          updated_at?: string
        }
        Update: {
          active?: boolean
          case_prefix?: string
          code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          name_en?: string
          name_es?: string
          org_id?: string
          settings?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_programs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_record_grants: {
        Row: {
          can_read: boolean
          can_write: boolean
          created_at: string
          expires_at: string | null
          granted_by: string
          id: string
          org_id: string
          reason: string
          record_type: string
          revoked_at: string | null
          social_case_id: string
          team_role: string | null
          user_id: string | null
        }
        Insert: {
          can_read?: boolean
          can_write?: boolean
          created_at?: string
          expires_at?: string | null
          granted_by: string
          id?: string
          org_id: string
          reason: string
          record_type: string
          revoked_at?: string | null
          social_case_id: string
          team_role?: string | null
          user_id?: string | null
        }
        Update: {
          can_read?: boolean
          can_write?: boolean
          created_at?: string
          expires_at?: string | null
          granted_by?: string
          id?: string
          org_id?: string
          reason?: string
          record_type?: string
          revoked_at?: string | null
          social_case_id?: string
          team_role?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_record_grants_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_record_grants_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_referral_shared_packets: {
        Row: {
          consent_id: string
          created_at: string
          created_by: string
          expires_at: string | null
          id: string
          org_id: string
          purpose: string
          receiving_org_id: string
          referral_id: string
          revoked_at: string | null
          shared_fields: Json
        }
        Insert: {
          consent_id: string
          created_at?: string
          created_by: string
          expires_at?: string | null
          id?: string
          org_id: string
          purpose: string
          receiving_org_id: string
          referral_id: string
          revoked_at?: string | null
          shared_fields?: Json
        }
        Update: {
          consent_id?: string
          created_at?: string
          created_by?: string
          expires_at?: string | null
          id?: string
          org_id?: string
          purpose?: string
          receiving_org_id?: string
          referral_id?: string
          revoked_at?: string | null
          shared_fields?: Json
        }
        Relationships: [
          {
            foreignKeyName: "social_referral_shared_packets_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "social_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referral_shared_packets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referral_shared_packets_receiving_org_id_fkey"
            columns: ["receiving_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referral_shared_packets_referral_id_fkey"
            columns: ["referral_id"]
            isOneToOne: false
            referencedRelation: "social_referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      social_referral_updates: {
        Row: {
          created_at: string
          created_by: string
          id: string
          note: string | null
          org_id: string
          referral_id: string
          status: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          note?: string | null
          org_id: string
          referral_id: string
          status: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          note?: string | null
          org_id?: string
          referral_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_referral_updates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referral_updates_referral_id_fkey"
            columns: ["referral_id"]
            isOneToOne: false
            referencedRelation: "social_referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      social_referrals: {
        Row: {
          appointment_at: string | null
          authorized_document_ids: string[]
          authorized_information: string[]
          closure_reason: string | null
          consent_id: string | null
          contact_person: string | null
          created_at: string
          created_by: string
          family_id: string | null
          follow_up_date: string | null
          id: string
          notes: string | null
          org_id: string
          person_id: string | null
          reason: string
          receiving_institution_id: string
          receiving_org_id: string | null
          referral_date: string | null
          referral_number: string
          response: string | null
          result: string | null
          result_verified_at: string | null
          result_verified_by: string | null
          service_requested: string
          social_case_id: string
          status: string
          updated_at: string
          urgency: string
        }
        Insert: {
          appointment_at?: string | null
          authorized_document_ids?: string[]
          authorized_information?: string[]
          closure_reason?: string | null
          consent_id?: string | null
          contact_person?: string | null
          created_at?: string
          created_by: string
          family_id?: string | null
          follow_up_date?: string | null
          id?: string
          notes?: string | null
          org_id: string
          person_id?: string | null
          reason: string
          receiving_institution_id: string
          receiving_org_id?: string | null
          referral_date?: string | null
          referral_number: string
          response?: string | null
          result?: string | null
          result_verified_at?: string | null
          result_verified_by?: string | null
          service_requested: string
          social_case_id: string
          status?: string
          updated_at?: string
          urgency?: string
        }
        Update: {
          appointment_at?: string | null
          authorized_document_ids?: string[]
          authorized_information?: string[]
          closure_reason?: string | null
          consent_id?: string | null
          contact_person?: string | null
          created_at?: string
          created_by?: string
          family_id?: string | null
          follow_up_date?: string | null
          id?: string
          notes?: string | null
          org_id?: string
          person_id?: string | null
          reason?: string
          receiving_institution_id?: string
          receiving_org_id?: string | null
          referral_date?: string | null
          referral_number?: string
          response?: string | null
          result?: string | null
          result_verified_at?: string | null
          result_verified_by?: string | null
          service_requested?: string
          social_case_id?: string
          status?: string
          updated_at?: string
          urgency?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_referrals_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "social_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referrals_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "social_families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referrals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referrals_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "social_people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referrals_receiving_institution_id_fkey"
            columns: ["receiving_institution_id"]
            isOneToOne: false
            referencedRelation: "social_institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referrals_receiving_org_id_fkey"
            columns: ["receiving_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_referrals_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_resource_communications: {
        Row: {
          communication_type: string
          consent_id: string | null
          created_at: string
          delivery_detail: string | null
          document_ids: string[]
          id: string
          institution_id: string
          message: string | null
          org_id: string
          recipient: string
          referral_id: string | null
          sender_id: string
          sent_at: string | null
          social_case_id: string
          status: string
          subject: string
        }
        Insert: {
          communication_type: string
          consent_id?: string | null
          created_at?: string
          delivery_detail?: string | null
          document_ids?: string[]
          id?: string
          institution_id: string
          message?: string | null
          org_id: string
          recipient: string
          referral_id?: string | null
          sender_id: string
          sent_at?: string | null
          social_case_id: string
          status?: string
          subject: string
        }
        Update: {
          communication_type?: string
          consent_id?: string | null
          created_at?: string
          delivery_detail?: string | null
          document_ids?: string[]
          id?: string
          institution_id?: string
          message?: string | null
          org_id?: string
          recipient?: string
          referral_id?: string | null
          sender_id?: string
          sent_at?: string | null
          social_case_id?: string
          status?: string
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_resource_communications_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "social_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_resource_communications_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "social_institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_resource_communications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_resource_communications_referral_id_fkey"
            columns: ["referral_id"]
            isOneToOne: false
            referencedRelation: "social_referrals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_resource_communications_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_retention_actions: {
        Row: {
          action_type: string
          approved_at: string | null
          approved_by: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          id: string
          manifest: Json
          org_id: string
          reason: string
          requested_by: string
          retention_until: string | null
          social_case_id: string
        }
        Insert: {
          action_type: string
          approved_at?: string | null
          approved_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          manifest?: Json
          org_id: string
          reason: string
          requested_by: string
          retention_until?: string | null
          social_case_id: string
        }
        Update: {
          action_type?: string
          approved_at?: string | null
          approved_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          manifest?: Json
          org_id?: string
          reason?: string
          requested_by?: string
          retention_until?: string | null
          social_case_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_retention_actions_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_retention_actions_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      social_role_assignments: {
        Row: {
          active: boolean
          assigned_by: string | null
          created_at: string
          ends_at: string | null
          id: string
          org_id: string
          role: string
          scope_id: string | null
          scope_type: string
          starts_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          assigned_by?: string | null
          created_at?: string
          ends_at?: string | null
          id?: string
          org_id: string
          role: string
          scope_id?: string | null
          scope_type?: string
          starts_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          assigned_by?: string | null
          created_at?: string
          ends_at?: string | null
          id?: string
          org_id?: string
          role?: string
          scope_id?: string | null
          scope_type?: string
          starts_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_role_assignments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_role_capabilities: {
        Row: {
          capability: string
          created_at: string
          role: string
        }
        Insert: {
          capability: string
          created_at?: string
          role: string
        }
        Update: {
          capability?: string
          created_at?: string
          role?: string
        }
        Relationships: []
      }
      social_support_access_grants: {
        Row: {
          approved_by: string
          created_at: string
          expires_at: string
          id: string
          org_id: string
          reason: string
          record_types: string[]
          revoked_at: string | null
          social_case_ids: string[]
          starts_at: string
          support_user_id: string
        }
        Insert: {
          approved_by: string
          created_at?: string
          expires_at: string
          id?: string
          org_id: string
          reason: string
          record_types?: string[]
          revoked_at?: string | null
          social_case_ids: string[]
          starts_at?: string
          support_user_id: string
        }
        Update: {
          approved_by?: string
          created_at?: string
          expires_at?: string
          id?: string
          org_id?: string
          reason?: string
          record_types?: string[]
          revoked_at?: string | null
          social_case_ids?: string[]
          starts_at?: string
          support_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_support_access_grants_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_tasks: {
        Row: {
          assignee_id: string | null
          completed_at: string | null
          created_at: string
          created_by: string
          description: string | null
          due_at: string | null
          id: string
          org_id: string
          priority: string
          recurrence: Json | null
          reminder_at: string | null
          social_case_id: string
          status: string
          supervisor_escalation_at: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          due_at?: string | null
          id?: string
          org_id: string
          priority?: string
          recurrence?: Json | null
          reminder_at?: string | null
          social_case_id: string
          status?: string
          supervisor_escalation_at?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          due_at?: string | null
          id?: string
          org_id?: string
          priority?: string
          recurrence?: Json | null
          reminder_at?: string | null
          social_case_id?: string
          status?: string
          supervisor_escalation_at?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_tasks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_tasks_social_case_id_fkey"
            columns: ["social_case_id"]
            isOneToOne: false
            referencedRelation: "social_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          beta_granted_at: string | null
          beta_granted_by: string | null
          beta_note: string | null
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          free_case_case_id: string | null
          free_case_used: boolean
          is_beta_tester: boolean
          mercadopago_payer_email: string | null
          mercadopago_payer_id: string | null
          mercadopago_preapproval_id: string | null
          plan: string | null
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          beta_granted_at?: string | null
          beta_granted_by?: string | null
          beta_note?: string | null
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          free_case_case_id?: string | null
          free_case_used?: boolean
          is_beta_tester?: boolean
          mercadopago_payer_email?: string | null
          mercadopago_payer_id?: string | null
          mercadopago_preapproval_id?: string | null
          plan?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          beta_granted_at?: string | null
          beta_granted_by?: string | null
          beta_note?: string | null
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          free_case_case_id?: string | null
          free_case_used?: boolean
          is_beta_tester?: boolean
          mercadopago_payer_email?: string | null
          mercadopago_payer_id?: string | null
          mercadopago_preapproval_id?: string | null
          plan?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_free_case_case_id_fkey"
            columns: ["free_case_case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      support_messages: {
        Row: {
          body: string
          created_at: string
          id: string
          sender: string
          sender_user_id: string | null
          thread_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          sender: string
          sender_user_id?: string | null
          thread_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          sender?: string
          sender_user_id?: string | null
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "support_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      support_threads: {
        Row: {
          case_id: string | null
          category: string
          created_at: string
          email: string | null
          id: string
          last_message_at: string
          page_path: string | null
          severity: string
          status: string
          unread_by_admin: boolean
          unread_by_user: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          case_id?: string | null
          category?: string
          created_at?: string
          email?: string | null
          id?: string
          last_message_at?: string
          page_path?: string | null
          severity?: string
          status?: string
          unread_by_admin?: boolean
          unread_by_user?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          case_id?: string | null
          category?: string
          created_at?: string
          email?: string | null
          id?: string
          last_message_at?: string
          page_path?: string | null
          severity?: string
          status?: string
          unread_by_admin?: boolean
          unread_by_user?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      usage_counters: {
        Row: {
          ai_requests_used: number
          created_at: string
          period_month: string
          reports_generated: number
          talk_to_case_used: number
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_requests_used?: number
          created_at?: string
          period_month: string
          reports_generated?: number
          talk_to_case_used?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_requests_used?: number
          created_at?: string
          period_month?: string
          reports_generated?: number
          talk_to_case_used?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      usage_events: {
        Row: {
          case_id: string | null
          created_at: string
          feature: string
          id: string
          kind: string
          source: string
          user_id: string
        }
        Insert: {
          case_id?: string | null
          created_at?: string
          feature: string
          id?: string
          kind: string
          source?: string
          user_id: string
        }
        Update: {
          case_id?: string | null
          created_at?: string
          feature?: string
          id?: string
          kind?: string
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_events_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
        ]
      }
      user_ai_keys: {
        Row: {
          calls_month: number
          calls_today: number
          created_at: string
          encrypted_key: string
          id: string
          is_active: boolean
          key_fingerprint: string
          label: string | null
          last_test_error: string | null
          last_test_latency_ms: number | null
          last_test_ok: boolean | null
          last_used_at: string | null
          priority: number | null
          provider: Database["public"]["Enums"]["ai_provider"]
          tokens_month: number
          tokens_today: number
          updated_at: string
          usage_date: string | null
          usage_month: string | null
          user_id: string
        }
        Insert: {
          calls_month?: number
          calls_today?: number
          created_at?: string
          encrypted_key: string
          id?: string
          is_active?: boolean
          key_fingerprint: string
          label?: string | null
          last_test_error?: string | null
          last_test_latency_ms?: number | null
          last_test_ok?: boolean | null
          last_used_at?: string | null
          priority?: number | null
          provider: Database["public"]["Enums"]["ai_provider"]
          tokens_month?: number
          tokens_today?: number
          updated_at?: string
          usage_date?: string | null
          usage_month?: string | null
          user_id: string
        }
        Update: {
          calls_month?: number
          calls_today?: number
          created_at?: string
          encrypted_key?: string
          id?: string
          is_active?: boolean
          key_fingerprint?: string
          label?: string | null
          last_test_error?: string | null
          last_test_latency_ms?: number | null
          last_test_ok?: boolean | null
          last_used_at?: string | null
          priority?: number | null
          provider?: Database["public"]["Enums"]["ai_provider"]
          tokens_month?: number
          tokens_today?: number
          updated_at?: string
          usage_date?: string | null
          usage_month?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_consents: {
        Row: {
          consent_type: string
          created_at: string
          document_hash: string | null
          document_type: string
          document_version: string
          granted_at: string
          id: string
          language: string
          organization_id: string | null
          purpose: string | null
          source: string | null
          updated_at: string
          user_id: string
          withdrawn_at: string | null
        }
        Insert: {
          consent_type?: string
          created_at?: string
          document_hash?: string | null
          document_type: string
          document_version: string
          granted_at?: string
          id?: string
          language?: string
          organization_id?: string | null
          purpose?: string | null
          source?: string | null
          updated_at?: string
          user_id: string
          withdrawn_at?: string | null
        }
        Update: {
          consent_type?: string
          created_at?: string
          document_hash?: string | null
          document_type?: string
          document_version?: string
          granted_at?: string
          id?: string
          language?: string
          organization_id?: string | null
          purpose?: string | null
          source?: string | null
          updated_at?: string
          user_id?: string
          withdrawn_at?: string | null
        }
        Relationships: []
      }
      user_feedback: {
        Row: {
          admin_note: string | null
          case_id: string | null
          category: string
          created_at: string
          email: string | null
          id: string
          message: string
          page_path: string | null
          severity: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          admin_note?: string | null
          case_id?: string | null
          category?: string
          created_at?: string
          email?: string | null
          id?: string
          message: string
          page_path?: string | null
          severity?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          admin_note?: string | null
          case_id?: string | null
          category?: string
          created_at?: string
          email?: string | null
          id?: string
          message?: string
          page_path?: string | null
          severity?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_groq_keys: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          key_value: string
          label: string
          last_error: string | null
          last_error_at: string | null
          last_used_at: string | null
          priority: number | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          key_value: string
          label?: string
          last_error?: string | null
          last_error_at?: string | null
          last_used_at?: string | null
          priority?: number | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          key_value?: string
          label?: string
          last_error?: string | null
          last_error_at?: string | null
          last_used_at?: string | null
          priority?: number | null
          user_id?: string
        }
        Relationships: []
      }
      user_intelligence_features: {
        Row: {
          created_at: string
          feature_key: string
          id: string
          mode: string
          provider: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          feature_key: string
          id?: string
          mode?: string
          provider?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          feature_key?: string
          id?: string
          mode?: string
          provider?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_provider_order: {
        Row: {
          created_at: string
          id: string
          order_index: number
          provider: Database["public"]["Enums"]["ai_provider"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          order_index: number
          provider: Database["public"]["Enums"]["ai_provider"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          order_index?: number
          provider?: Database["public"]["Enums"]["ai_provider"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          ai_default_mode: string
          ai_max_response_chars: number
          ai_response_style: string
          avatar_url: string | null
          cedula_profesional: string | null
          created_at: string
          display_name: string | null
          firm_id: string | null
          firm_name: string | null
          gemini_api_key: string | null
          notify_email: boolean
          notify_new_evidence: boolean
          notify_pipeline_complete: boolean
          notify_pipeline_failed: boolean
          phone: string | null
          practice_focus: string | null
          profile_completed_at: string | null
          state_practice: string | null
          title: string | null
          updated_at: string
          user_id: string
          voice_accent: string
          voice_autoplay: boolean
          voice_continuous: boolean
          voice_gender: string
          voice_id: string
          voice_muted: boolean
          voice_pitch: string
          voice_speed: number
          years_experience: string | null
        }
        Insert: {
          ai_default_mode?: string
          ai_max_response_chars?: number
          ai_response_style?: string
          avatar_url?: string | null
          cedula_profesional?: string | null
          created_at?: string
          display_name?: string | null
          firm_id?: string | null
          firm_name?: string | null
          gemini_api_key?: string | null
          notify_email?: boolean
          notify_new_evidence?: boolean
          notify_pipeline_complete?: boolean
          notify_pipeline_failed?: boolean
          phone?: string | null
          practice_focus?: string | null
          profile_completed_at?: string | null
          state_practice?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
          voice_accent?: string
          voice_autoplay?: boolean
          voice_continuous?: boolean
          voice_gender?: string
          voice_id?: string
          voice_muted?: boolean
          voice_pitch?: string
          voice_speed?: number
          years_experience?: string | null
        }
        Update: {
          ai_default_mode?: string
          ai_max_response_chars?: number
          ai_response_style?: string
          avatar_url?: string | null
          cedula_profesional?: string | null
          created_at?: string
          display_name?: string | null
          firm_id?: string | null
          firm_name?: string | null
          gemini_api_key?: string | null
          notify_email?: boolean
          notify_new_evidence?: boolean
          notify_pipeline_complete?: boolean
          notify_pipeline_failed?: boolean
          phone?: string | null
          practice_focus?: string | null
          profile_completed_at?: string | null
          state_practice?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
          voice_accent?: string
          voice_autoplay?: boolean
          voice_continuous?: boolean
          voice_gender?: string
          voice_id?: string
          voice_muted?: boolean
          voice_pitch?: string
          voice_speed?: number
          years_experience?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_settings_firm_id_fkey"
            columns: ["firm_id"]
            isOneToOne: false
            referencedRelation: "firms"
            referencedColumns: ["id"]
          },
        ]
      }
      user_social_profiles: {
        Row: {
          created_at: string
          discord_url: string | null
          facebook_url: string | null
          linkedin_url: string | null
          public_visible: boolean
          twitter_url: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          discord_url?: string | null
          facebook_url?: string | null
          linkedin_url?: string | null
          public_visible?: boolean
          twitter_url?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          discord_url?: string | null
          facebook_url?: string | null
          linkedin_url?: string | null
          public_visible?: boolean
          twitter_url?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      verification_items: {
        Row: {
          case_id: string
          category: Database["public"]["Enums"]["verification_category"]
          created_at: string
          evidence_document_id: string | null
          id: string
          notes: string | null
          status: Database["public"]["Enums"]["verification_status"]
          updated_at: string
          user_id: string
          verification_mode: Database["public"]["Enums"]["verification_mode"]
        }
        Insert: {
          case_id: string
          category: Database["public"]["Enums"]["verification_category"]
          created_at?: string
          evidence_document_id?: string | null
          id?: string
          notes?: string | null
          status?: Database["public"]["Enums"]["verification_status"]
          updated_at?: string
          user_id: string
          verification_mode?: Database["public"]["Enums"]["verification_mode"]
        }
        Update: {
          case_id?: string
          category?: Database["public"]["Enums"]["verification_category"]
          created_at?: string
          evidence_document_id?: string | null
          id?: string
          notes?: string | null
          status?: Database["public"]["Enums"]["verification_status"]
          updated_at?: string
          user_id?: string
          verification_mode?: Database["public"]["Enums"]["verification_mode"]
        }
        Relationships: [
          {
            foreignKeyName: "verification_items_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_items_evidence_document_id_fkey"
            columns: ["evidence_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_events: {
        Row: {
          created_at: string
          detail: string | null
          event_type: string
          id: string
          mp_event_id: string | null
          provider: string
          status: string
          stripe_event_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          detail?: string | null
          event_type: string
          id?: string
          mp_event_id?: string | null
          provider?: string
          status: string
          stripe_event_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          detail?: string | null
          event_type?: string
          id?: string
          mp_event_id?: string | null
          provider?: string
          status?: string
          stripe_event_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      worker_secrets: {
        Row: {
          created_at: string
          name: string
          secret: string
        }
        Insert: {
          created_at?: string
          name: string
          secret: string
        }
        Update: {
          created_at?: string
          name?: string
          secret?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_matching_social_organization_invitations: {
        Args: never
        Returns: Json
      }
      accept_social_organization_invitation: {
        Args: { p_token: string }
        Returns: Json
      }
      accept_social_transfer: {
        Args: { p_transfer: string }
        Returns: undefined
      }
      activate_existing_social_invitee: {
        Args: { p_invitation: string }
        Returns: Json
      }
      add_social_document_version: {
        Args: {
          p_checksum: string
          p_document: string
          p_mime: string
          p_notes: string
          p_size: number
          p_storage_path: string
        }
        Returns: number
      }
      admin_factory_reset_case_data: {
        Args: {
          p_actor_id?: string
          p_include_ai_usage?: boolean
          p_include_audit?: boolean
          p_include_demo?: boolean
        }
        Returns: Json
      }
      admin_get_user_id_by_email: { Args: { _email: string }; Returns: string }
      admin_grant_beta_access: {
        Args: { _email: string; _note?: string }
        Returns: Json
      }
      admin_list_firms_with_seats: {
        Args: never
        Returns: {
          domain: string
          firm_id: string
          name: string
          owner_user_id: string
          plan_key: string
          seat_limit: number
          seats_used: number
        }[]
      }
      admin_list_pending_beta_invites: {
        Args: never
        Returns: {
          email: string
          invited_at: string
          note: string
        }[]
      }
      admin_list_users_with_subscriptions: {
        Args: never
        Returns: {
          beta_granted_at: string
          beta_note: string
          current_period_end: string
          email: string
          free_case_used: boolean
          is_beta_tester: boolean
          mercadopago_preapproval_id: string
          plan: string
          status: string
          stripe_customer_id: string
          user_created_at: string
          user_id: string
        }[]
      }
      advance_social_transfer: {
        Args: { p_action: string; p_transfer: string }
        Returns: undefined
      }
      approve_social_care_plan: {
        Args: { p_plan: string; p_version: number }
        Returns: undefined
      }
      assign_social_case_manager: {
        Args: { p_case: string; p_role?: string; p_user: string }
        Returns: undefined
      }
      can_access_case: {
        Args: { _case_id: string; _user_id: string }
        Returns: boolean
      }
      can_access_client: {
        Args: { _client_id: string; _user_id: string }
        Returns: boolean
      }
      can_contribute_org: {
        Args: { _org: string; _user: string }
        Returns: boolean
      }
      can_manage_org: {
        Args: { _org: string; _user: string }
        Returns: boolean
      }
      claim_case_for_execution: {
        Args: { p_case_id: string; p_lease_ms?: number; p_worker_id?: string }
        Returns: {
          case_id: string
          claimed: boolean
          execution_id: string
          next_stage: string
          user_id: string
        }[]
      }
      claim_engine_run: {
        Args: {
          _case_id: string
          _engine: string
          _meta?: Json
          _user_id: string
        }
        Returns: string
      }
      claim_next_queued_case: {
        Args: { p_lease_ms?: number; p_worker_id?: string }
        Returns: {
          case_id: string
          claimed: boolean
          execution_id: string
          next_stage: string
          user_id: string
        }[]
      }
      close_social_case: {
        Args: {
          p_case: string
          p_final_risk: string
          p_reason: string
          p_summary: Json
        }
        Returns: string
      }
      closing_readiness: { Args: { p_case_id: string }; Returns: number }
      complete_social_intake: {
        Args: { p_disposition: string; p_intake: string; p_reason: string }
        Returns: Json
      }
      consume_usage: {
        Args: {
          p_amount?: number
          p_kind: string
          p_limit: number
          p_user_id: string
        }
        Returns: {
          allowed: boolean
          limit: number
          used: number
        }[]
      }
      create_account_organization: {
        Args: { p_name: string; p_prefix?: string; p_slug: string }
        Returns: Json
      }
      create_and_assign_care_case: {
        Args: {
          p_assigned_user?: string
          p_case_type: string
          p_client_name: string
          p_family: string
          p_org: string
          p_person: string
          p_priority: string
          p_program: string
        }
        Returns: Json
      }
      create_social_assessment_initial: {
        Args: {
          p_actions: string
          p_answers: Json
          p_case: string
          p_evidence: string
          p_follow_up: string
          p_override: boolean
          p_override_explanation: string
          p_protective: string
          p_reason: string
          p_review: string
          p_risk: string
          p_template: string
        }
        Returns: string
      }
      create_social_care_plan: {
        Args: {
          p_case: string
          p_goals: Json
          p_status: string
          p_summary: string
        }
        Returns: string
      }
      create_social_case: {
        Args: {
          p_case_type: string
          p_confidentiality_level?: string
          p_family: string
          p_org: string
          p_person: string
          p_priority?: string
          p_program: string
          p_referral_source?: string
          p_risk_level?: string
          p_service_areas?: string[]
          p_tags?: string[]
        }
        Returns: {
          assigned_case_manager: string | null
          case_number: string
          case_type: string
          closure_date: string | null
          confidentiality_level: string
          consent_status: string
          created_at: string
          created_by: string
          deleted_at: string | null
          deleted_by: string | null
          deletion_reason: string | null
          family_id: string | null
          id: string
          intake_date: string
          last_activity_at: string
          next_required_action: string | null
          office_id: string | null
          opened_at: string
          org_id: string
          person_id: string | null
          priority: string
          program_id: string
          referral_source: string | null
          risk_level: string
          service_areas: string[]
          status: string
          supervising_manager: string | null
          tags: string[]
          transfer_date: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "social_cases"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_social_consent: {
        Args: {
          p_confirmation: Json
          p_consented_by: string
          p_expires: string
          p_family: string
          p_guardian: string
          p_information: string[]
          p_language: string
          p_org: string
          p_person: string
          p_purposes: string[]
          p_recipients: string[]
          p_restrictions: string
          p_type: string
        }
        Returns: string
      }
      create_social_family: {
        Args: {
          p_location: Json
          p_members: string[]
          p_name: string
          p_org: string
          p_primary: string
        }
        Returns: {
          assigned_case_manager: string | null
          created_at: string
          created_by: string
          current_location: Json
          data_sharing_permissions: Json
          deleted_at: string | null
          family_name: string
          family_number: string
          id: string
          office_id: string | null
          org_id: string
          primary_contact_person_id: string | null
          shared_needs: Json
          shared_risks: Json
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "social_families"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_social_intake: {
        Args: {
          p_assigned_user?: string
          p_family: string
          p_org: string
          p_person: string
          p_presenting_needs: string[]
          p_program: string
          p_source: string
          p_summary: string
        }
        Returns: Json
      }
      create_social_person: {
        Args: {
          p_aliases?: string[]
          p_approximate_age?: number
          p_current_location?: Json
          p_date_of_birth?: string
          p_email?: string
          p_immigration_identifiers?: Json
          p_is_minor?: boolean
          p_languages?: string[]
          p_legal_name: string
          p_nationality?: string
          p_org: string
          p_preferred_name?: string
          p_separated_minor?: boolean
          p_telephone?: string
          p_unaccompanied_minor?: boolean
        }
        Returns: {
          accessibility_needs: string | null
          aliases: string[]
          approximate_age: number | null
          assigned_case_manager: string | null
          consent_status: string
          country_of_origin: string | null
          created_at: string
          created_by: string
          current_location: Json
          data_sharing_restrictions: string | null
          date_of_birth: string | null
          deleted_at: string | null
          email: string | null
          emergency_contact: Json
          gender_identity: string | null
          id: string
          identity_documents: Json
          immigration_identifiers: Json
          interpreter_required: boolean
          is_minor: boolean | null
          languages: string[]
          legal_name: string
          nationality: string | null
          office_id: string | null
          org_id: string
          person_number: string
          place_of_origin: string | null
          preferred_name: string | null
          record_status: string
          safety_restrictions: string | null
          separated_minor: boolean
          sex: string | null
          telephone: string | null
          unaccompanied_minor: boolean
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "social_people"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      delete_social_case_by_assigning_manager: {
        Args: { p_case: string; p_reason: string }
        Returns: Json
      }
      ensure_social_program_for_org: {
        Args: {
          p_name_en?: string
          p_name_es?: string
          p_org: string
          p_prefix?: string
        }
        Returns: {
          active: boolean
          case_prefix: string
          code: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          name_en: string
          name_es: string
          org_id: string
          settings: Json
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "social_programs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finalize_report_release: {
        Args: {
          p_case_id: string
          p_errors: Json
          p_execution_id: string
          p_expected_full_report: Json
          p_full_report: Json
          p_released: boolean
          p_report_id: string
          p_status_message: string
        }
        Returns: undefined
      }
      find_possible_social_people: {
        Args: {
          p_date_of_birth?: string
          p_email?: string
          p_limit?: number
          p_name: string
          p_org: string
          p_phone?: string
        }
        Returns: {
          date_of_birth: string
          display_name: string
          match_reasons: string[]
          person_id: string
          person_number: string
        }[]
      }
      firm_seat_usage: {
        Args: { _firm_id: string }
        Returns: {
          plan_key: string
          seat_limit: number
          seats_used: number
        }[]
      }
      get_social_case_core: { Args: { p_case: string }; Returns: Json }
      get_social_organization_account: {
        Args: { p_org: string }
        Returns: Json
      }
      global_legal_search: {
        Args: { _limit?: number; _query: string; _user_id?: string }
        Returns: Json
      }
      has_permission: {
        Args: { _org: string; _perm: string; _user: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      increment_reports_generated: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      invite_social_organization_member:
        | {
            Args: { p_email: string; p_org: string; p_role: string }
            Returns: Json
          }
        | {
            Args: {
              p_email: string
              p_name: string
              p_org: string
              p_role: string
              p_title: string
            }
            Returns: Json
          }
      is_active_org_member: { Args: { check_org_id: string }; Returns: boolean }
      is_admin_tier: { Args: { _user_id: string }; Returns: boolean }
      is_case_manager: { Args: { _user_id: string }; Returns: boolean }
      is_member_of_firm: {
        Args: { _firm: string; _user: string }
        Returns: boolean
      }
      is_org_member: { Args: { _org: string; _user: string }; Returns: boolean }
      is_org_support_admin: { Args: { check_org_id: string }; Returns: boolean }
      is_primary_subscriber: {
        Args: { check_org_id: string }
        Returns: boolean
      }
      is_super_admin: { Args: { _user_id: string }; Returns: boolean }
      list_public_billing_plans: {
        Args: never
        Returns: {
          ai_requests_monthly: number
          byok_allowed: boolean
          case_limit: number
          contact_url: string
          currency: string
          features: Json
          included_seats: number
          interval: string
          key: string
          label: string
          per_seat_price_cents: number
          price_cents: number
          self_serve: boolean
          sort_order: number
          storage_gb_limit: number
          tagline: string
          talk_to_case_monthly: number
          team_member_limit: number
        }[]
      }
      move_social_document: {
        Args: {
          p_checksum: string
          p_document: string
          p_mime: string
          p_new_storage_path: string
          p_reason: string
          p_size: number
          p_target_case: string
        }
        Returns: undefined
      }
      normalize_mx_search: { Args: { value: string }; Returns: string }
      normalize_social_search: { Args: { value: string }; Returns: string }
      open_care_case_from_intake: {
        Args: {
          p_assigned_user?: string
          p_case_type: string
          p_intake: string
          p_priority: string
        }
        Returns: Json
      }
      org_role_of: {
        Args: { _org: string; _user: string }
        Returns: Database["public"]["Enums"]["org_role"]
      }
      plan_seat_limit: { Args: { _plan: string }; Returns: number }
      project_case_findings: {
        Args: { p_case_id: string; p_rows: Json }
        Returns: number
      }
      provision_organization_subscription_from_webhook: {
        Args: {
          p_billing_interval?: string
          p_event_type: string
          p_org_id: string
          p_payload_hash?: string
          p_period_end?: string
          p_period_start?: string
          p_plan_key: string
          p_provider: string
          p_provider_customer_id: string
          p_provider_event_id: string
          p_provider_subscription_id: string
          p_status: string
          p_user_id: string
        }
        Returns: Json
      }
      record_social_assessment: {
        Args: {
          p_answers: Json
          p_assessment: string
          p_evidence: string
          p_immediate_actions: string
          p_next_review: string
          p_override?: boolean
          p_override_explanation?: string
          p_protective_factors: string
          p_reason: string
          p_required_follow_up: string
          p_risk_level: string
        }
        Returns: number
      }
      refresh_social_case_alerts: { Args: { p_case: string }; Returns: number }
      register_social_document: {
        Args: {
          p_case: string
          p_checksum: string
          p_consent: string
          p_document_type: string
          p_extraction_authorized: boolean
          p_family: string
          p_mime: string
          p_person: string
          p_record_type: string
          p_sensitivity: string
          p_size: number
          p_storage_path: string
          p_title: string
        }
        Returns: string
      }
      renew_execution_lease: {
        Args: { p_case_id: string; p_execution_id: string; p_lease_ms?: number }
        Returns: boolean
      }
      reopen_social_case: {
        Args: { p_case: string; p_reason: string }
        Returns: undefined
      }
      resolve_firm_for_email: { Args: { _email: string }; Returns: string }
      resource_search_document: {
        Args: { p_description: string; p_name: string; p_services: string[] }
        Returns: unknown
      }
      same_firm: { Args: { _a: string; _b: string }; Returns: boolean }
      search_immigration_cases: {
        Args: { p_limit?: number; p_query: string }
        Returns: {
          case_id: string
          case_name: string
          client_name: string
          immigration_subtype: string
          internal_matter_number: string
          matched_document_filename: string
          matter_status: string
          nationality: string
          passport_masked: string
          responsible_authority: string
          updated_at: string
        }[]
      }
      search_resource_network: {
        Args: {
          p_availability?: string
          p_cost_type?: string
          p_language?: string
          p_latitude?: number
          p_limit?: number
          p_longitude?: number
          p_municipality?: string
          p_population?: string
          p_query?: string
          p_radius_km?: number
          p_service?: string
          p_state?: string
          p_urgency?: string
        }
        Returns: {
          address: string
          appointment_required: boolean
          capacity_status: string
          contact_verification: string
          cost_type: string
          coverage_levels: string[]
          description: string
          distance_km: number
          eligibility: string
          email: string
          emergency_available: boolean
          hours: Json
          id: string
          institution_type: string
          languages: string[]
          last_checked_at: string
          latitude: number
          longitude: number
          match_explanation: string[]
          match_score: number
          municipality: string
          next_verification_at: string
          official_name: string
          phone: string
          populations: string[]
          referral_methods: string[]
          remote_available: boolean
          required_documents: string[]
          services: string[]
          source_type: string
          source_url: string
          state_code: string
          status: string
          verification_status: string
          verified_at: string
          walk_in_available: boolean
          website: string
          whatsapp: string
        }[]
      }
      search_social_case_management: {
        Args: {
          p_assignee?: string
          p_limit?: number
          p_org: string
          p_query?: string
          p_risk?: string
          p_status?: string
        }
        Returns: {
          assigned_case_manager: string
          display_name: string
          entity_id: string
          entity_type: string
          reference_number: string
          risk_level: string
          status: string
          updated_at: string
        }[]
      }
      send_social_referral: {
        Args: {
          p_expires?: string
          p_purpose: string
          p_referral: string
          p_shared_fields: Json
        }
        Returns: undefined
      }
      set_social_organization_member: {
        Args: {
          p_org: string
          p_role: string
          p_status: string
          p_user: string
        }
        Returns: Json
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      social_activity_entity_visible: {
        Args: {
          p_entity_id: string
          p_entity_type: string
          p_org: string
          p_user: string
        }
        Returns: boolean
      }
      social_can_access_case: {
        Args: {
          p_case: string
          p_record_type?: string
          p_user?: string
          p_write?: boolean
        }
        Returns: boolean
      }
      social_can_access_person: {
        Args: { p_person: string; p_user?: string }
        Returns: boolean
      }
      social_can_contribute_org: {
        Args: { p_org: string; p_user?: string }
        Returns: boolean
      }
      social_can_manage_org: {
        Args: { p_org: string; p_user?: string }
        Returns: boolean
      }
      social_consent_covers: {
        Args: {
          p_consent: string
          p_information: string[]
          p_purpose: string
          p_recipient: string
        }
        Returns: boolean
      }
      social_document_inventory: {
        Args: { p_case: string }
        Returns: {
          checksum: string
          classification_status: string
          content_access: boolean
          created_at: string
          current_version: number
          description: string
          document_status: string
          document_type: string
          expires_at: string
          external_shareable: boolean
          id: string
          linked_entities: Json
          mime_type: string
          record_type: string
          restricted_metadata: boolean
          sensitivity: string
          size_bytes: number
          tags: string[]
          title: string
          updated_at: string
          uploaded_by: string
        }[]
      }
      social_has_capability: {
        Args: { p_capability: string; p_org: string; p_user?: string }
        Returns: boolean
      }
      social_indicator_summary:
        | {
            Args: { p_from: string; p_org: string; p_to: string }
            Returns: {
              dimension: string
              indicator_code: string
              suppressed: boolean
              value: number
            }[]
          }
        | {
            Args: {
              p_from: string
              p_office: string
              p_org: string
              p_program: string
              p_to: string
            }
            Returns: {
              dimension: string
              indicator_code: string
              suppressed: boolean
              value: number
            }[]
          }
      social_is_org_member: {
        Args: { p_org: string; p_user?: string }
        Returns: boolean
      }
      social_is_platform_admin: { Args: { p_user?: string }; Returns: boolean }
      social_media_upload_allowed: {
        Args: { p_case: string; p_mime: string; p_user?: string }
        Returns: boolean
      }
      social_org_employee_seat_limit: {
        Args: { p_org: string }
        Returns: number
      }
      social_org_employee_seats_used: {
        Args: { p_org: string }
        Returns: number
      }
      social_org_role_to_care_role: {
        Args: { p_role: string }
        Returns: string
      }
      social_org_seat_limit: { Args: { p_org: string }; Returns: number }
      social_org_seats_used: { Args: { p_org: string }; Returns: number }
      social_org_subscription_active: {
        Args: { p_org: string }
        Returns: boolean
      }
      social_org_unlimited_seats: { Args: { p_org: string }; Returns: boolean }
      social_people_search_document: {
        Args: {
          p_aliases: string[]
          p_legal_name: string
          p_preferred_name: string
        }
        Returns: unknown
      }
      social_sales_demo_any_owner_allows: {
        Args: { p_id: string; p_user?: string }
        Returns: boolean
      }
      social_sales_demo_owner_allows: {
        Args: { p_id: string; p_table: string; p_user?: string }
        Returns: boolean
      }
      social_support_access_active: {
        Args: { p_case: string; p_record_type: string; p_user?: string }
        Returns: boolean
      }
      update_care_case_state: {
        Args: {
          p_case: string
          p_priority: string
          p_reason: string
          p_status: string
        }
        Returns: Json
      }
      update_social_document_metadata: {
        Args: {
          p_classification_status: string
          p_description: string
          p_document: string
          p_document_type: string
          p_expires_at: string
          p_external_shareable: boolean
          p_linked_entities: Json
          p_record_type: string
          p_sensitivity: string
          p_status: string
          p_tags: string[]
          p_title: string
        }
        Returns: undefined
      }
      verify_resource: {
        Args: {
          p_evidence_url?: string
          p_institution: string
          p_next_verification?: string
          p_notes?: string
          p_source: string
          p_status: string
        }
        Returns: string
      }
      verify_social_referral_result: {
        Args: {
          p_closure_reason?: string
          p_referral: string
          p_response: string
          p_result: string
        }
        Returns: undefined
      }
    }
    Enums: {
      ai_provider: "groq" | "openai" | "gemini" | "anthropic" | "openrouter"
      app_role:
        | "admin"
        | "moderator"
        | "user"
        | "super_admin"
        | "platform_admin"
        | "firm_admin"
        | "case_manager"
      arco_request_status:
        | "received"
        | "identity_pending"
        | "in_review"
        | "awaiting_information"
        | "resolved"
        | "rejected"
        | "withdrawn"
      arco_request_type:
        | "acceso"
        | "rectificacion"
        | "cancelacion"
        | "oposicion"
        | "revocacion"
      canonical_status: "orchestrating" | "completed" | "failed" | "validated"
      case_status:
        | "uploaded"
        | "extracting"
        | "analyzing"
        | "scoring"
        | "reporting"
        | "complete"
        | "failed"
        | "intelligence_running"
        | "intelligence_complete"
        | "cancelled"
        | "queued"
        | "released"
        | "needs_revision"
        | "stalled"
        | "extracted"
        | "analyzed"
        | "agents_running"
        | "agents_complete"
        | "scored"
      doc_processing_status:
        | "pending"
        | "uploading"
        | "uploaded"
        | "extracting"
        | "extracted"
        | "classifying"
        | "classified"
        | "analyzing"
        | "analyzed"
        | "failed"
      doc_status:
        | "pending"
        | "extracting"
        | "extracted"
        | "failed"
        | "skipped_duplicate"
      intelligence_engine:
        | "legal"
        | "case"
        | "evidence"
        | "witness"
        | "timeline"
        | "litigation"
        | "contract"
        | "research"
        | "work_product"
      intelligence_error_type:
        | "unsupported_claim"
        | "bad_evidence_link"
        | "wrong_evidence_interpretation"
        | "duplicate_finding"
        | "contradiction_misclassification"
        | "wrong_legal_authority"
        | "wrong_procedural_rule"
        | "wrong_severity"
        | "wrong_confidence"
        | "missing_finding"
        | "false_positive"
        | "false_negative"
        | "temporal_error"
        | "source_classification_error"
        | "report_rendering_error"
        | "other"
      intelligence_pattern_status: "active" | "monitoring" | "retired"
      intelligence_pattern_tier:
        | "insufficient_sample"
        | "emerging"
        | "candidate"
        | "strong"
        | "significant"
      intelligence_proposal_status:
        | "proposed"
        | "testing"
        | "passed"
        | "failed"
        | "approved"
        | "deployed"
        | "rolled_back"
      intelligence_recommended_action:
        | "require_additional_evidence"
        | "require_second_source"
        | "require_authority_verification"
        | "require_procedural_posture_verification"
        | "lower_confidence"
        | "send_to_critic"
        | "require_human_review"
      intelligence_version_deployment_status: "deployed" | "rolled_back"
      legal_verification_status:
        | "verified"
        | "pending"
        | "deprecated"
        | "superseded"
        | "failed_verification"
      lesson_validation_status:
        | "unverified"
        | "ai_supported"
        | "evidence_verified"
        | "multi_source_verified"
        | "human_confirmed"
      matter_priority: "low" | "normal" | "high" | "urgent"
      matter_status: "intake" | "active" | "on_hold" | "closed" | "archived"
      matter_type:
        | "litigation"
        | "criminal"
        | "civil"
        | "commercial"
        | "labor"
        | "family"
        | "constitutional"
        | "administrative"
        | "corporate"
        | "tax"
        | "immigration"
        | "contract"
        | "advisory"
        | "compliance"
        | "transaction"
      membership_status: "active" | "invited" | "suspended" | "removed"
      org_role:
        | "owner"
        | "admin"
        | "lawyer"
        | "paralegal"
        | "viewer"
        | "firm_administrator"
        | "attorney"
        | "associate_attorney"
        | "legal_assistant"
        | "client"
        | "read_only"
        | "firm_manager"
        | "supervisor"
        | "case_worker"
        | "legal_provider"
        | "psychosocial_provider"
      security_incident_severity: "low" | "medium" | "high" | "critical"
      security_incident_status:
        | "open"
        | "triage"
        | "contained"
        | "investigating"
        | "resolved"
        | "closed"
      task_status: "todo" | "in_progress" | "blocked" | "done" | "cancelled"
      verification_category:
        | "ownership"
        | "registry"
        | "catastro"
        | "predial"
        | "water"
        | "cfe"
        | "hoa"
        | "mortgage"
        | "permits"
        | "corporate_authority"
        | "environmental"
      verification_mode: "connected" | "document" | "manual"
      verification_status: "verified" | "pending" | "missing" | "issue_found"
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
    Enums: {
      ai_provider: ["groq", "openai", "gemini", "anthropic", "openrouter"],
      app_role: [
        "admin",
        "moderator",
        "user",
        "super_admin",
        "platform_admin",
        "firm_admin",
        "case_manager",
      ],
      arco_request_status: [
        "received",
        "identity_pending",
        "in_review",
        "awaiting_information",
        "resolved",
        "rejected",
        "withdrawn",
      ],
      arco_request_type: [
        "acceso",
        "rectificacion",
        "cancelacion",
        "oposicion",
        "revocacion",
      ],
      canonical_status: ["orchestrating", "completed", "failed", "validated"],
      case_status: [
        "uploaded",
        "extracting",
        "analyzing",
        "scoring",
        "reporting",
        "complete",
        "failed",
        "intelligence_running",
        "intelligence_complete",
        "cancelled",
        "queued",
        "released",
        "needs_revision",
        "stalled",
        "extracted",
        "analyzed",
        "agents_running",
        "agents_complete",
        "scored",
      ],
      doc_processing_status: [
        "pending",
        "uploading",
        "uploaded",
        "extracting",
        "extracted",
        "classifying",
        "classified",
        "analyzing",
        "analyzed",
        "failed",
      ],
      doc_status: [
        "pending",
        "extracting",
        "extracted",
        "failed",
        "skipped_duplicate",
      ],
      intelligence_engine: [
        "legal",
        "case",
        "evidence",
        "witness",
        "timeline",
        "litigation",
        "contract",
        "research",
        "work_product",
      ],
      intelligence_error_type: [
        "unsupported_claim",
        "bad_evidence_link",
        "wrong_evidence_interpretation",
        "duplicate_finding",
        "contradiction_misclassification",
        "wrong_legal_authority",
        "wrong_procedural_rule",
        "wrong_severity",
        "wrong_confidence",
        "missing_finding",
        "false_positive",
        "false_negative",
        "temporal_error",
        "source_classification_error",
        "report_rendering_error",
        "other",
      ],
      intelligence_pattern_status: ["active", "monitoring", "retired"],
      intelligence_pattern_tier: [
        "insufficient_sample",
        "emerging",
        "candidate",
        "strong",
        "significant",
      ],
      intelligence_proposal_status: [
        "proposed",
        "testing",
        "passed",
        "failed",
        "approved",
        "deployed",
        "rolled_back",
      ],
      intelligence_recommended_action: [
        "require_additional_evidence",
        "require_second_source",
        "require_authority_verification",
        "require_procedural_posture_verification",
        "lower_confidence",
        "send_to_critic",
        "require_human_review",
      ],
      intelligence_version_deployment_status: ["deployed", "rolled_back"],
      legal_verification_status: [
        "verified",
        "pending",
        "deprecated",
        "superseded",
        "failed_verification",
      ],
      lesson_validation_status: [
        "unverified",
        "ai_supported",
        "evidence_verified",
        "multi_source_verified",
        "human_confirmed",
      ],
      matter_priority: ["low", "normal", "high", "urgent"],
      matter_status: ["intake", "active", "on_hold", "closed", "archived"],
      matter_type: [
        "litigation",
        "criminal",
        "civil",
        "commercial",
        "labor",
        "family",
        "constitutional",
        "administrative",
        "corporate",
        "tax",
        "immigration",
        "contract",
        "advisory",
        "compliance",
        "transaction",
      ],
      membership_status: ["active", "invited", "suspended", "removed"],
      org_role: [
        "owner",
        "admin",
        "lawyer",
        "paralegal",
        "viewer",
        "firm_administrator",
        "attorney",
        "associate_attorney",
        "legal_assistant",
        "client",
        "read_only",
        "firm_manager",
        "supervisor",
        "case_worker",
        "legal_provider",
        "psychosocial_provider",
      ],
      security_incident_severity: ["low", "medium", "high", "critical"],
      security_incident_status: [
        "open",
        "triage",
        "contained",
        "investigating",
        "resolved",
        "closed",
      ],
      task_status: ["todo", "in_progress", "blocked", "done", "cancelled"],
      verification_category: [
        "ownership",
        "registry",
        "catastro",
        "predial",
        "water",
        "cfe",
        "hoa",
        "mortgage",
        "permits",
        "corporate_authority",
        "environmental",
      ],
      verification_mode: ["connected", "document", "manual"],
      verification_status: ["verified", "pending", "missing", "issue_found"],
    },
  },
} as const
