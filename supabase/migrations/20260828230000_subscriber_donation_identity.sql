-- 20260828230000_subscriber_donation_identity.sql
-- High-Security Subscriber Donation Identity & Financial Destination Setup
-- Strictly for Primary Subscription Owner / Original Subscriber

CREATE TABLE IF NOT EXISTS public.social_subscriber_donation_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  subscriber_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  subscriber_type TEXT NOT NULL DEFAULT 'organization' CHECK (subscriber_type IN ('individual', 'organization')),
  legal_name TEXT NOT NULL,
  razon_social TEXT,
  rfc TEXT NOT NULL,
  fiscal_postal_code TEXT NOT NULL,
  government_id_type TEXT NOT NULL DEFAULT 'ine' CHECK (government_id_type IN ('ine', 'passport_mx', 'passport_foreign', 'residence_card_mx')),
  government_id_masked TEXT,
  id_verification_status TEXT NOT NULL DEFAULT 'not_verified' CHECK (id_verification_status IN ('not_verified', 'pending', 'verified', 'mismatch', 'unable_to_verify')),
  id_verification_date TIMESTAMPTZ,
  id_verification_method TEXT,
  id_document_storage_path TEXT,
  rfc_verification_status TEXT NOT NULL DEFAULT 'not_verified' CHECK (rfc_verification_status IN ('not_verified', 'pending', 'verified', 'mismatch', 'unable_to_verify')),
  rfc_verification_method TEXT,
  rfc_verification_date TIMESTAMPTZ,
  constancia_storage_path TEXT,
  external_fundraising_provider TEXT DEFAULT 'gofundme' CHECK (external_fundraising_provider IN ('gofundme', 'other', 'none')),
  external_fundraising_url TEXT,
  direct_bank_enabled BOOLEAN NOT NULL DEFAULT false,
  bank_beneficiary_name TEXT,
  bank_name TEXT,
  bank_clabe_masked TEXT,
  bank_clabe_encrypted TEXT,
  privacy_notice_version TEXT NOT NULL DEFAULT 'v2026.1_mx_arco',
  privacy_notice_accepted_at TIMESTAMPTZ,
  privacy_notice_accepted_by UUID REFERENCES auth.users(id),
  financial_donations_readiness TEXT NOT NULL DEFAULT 'not_ready' CHECK (financial_donations_readiness IN ('not_ready', 'verified_and_ready')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_subscriber_donation_identity_org UNIQUE (org_id)
);

CREATE TABLE IF NOT EXISTS public.social_donation_identity_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'verification_started',
    'verification_completed',
    'verification_failed',
    'identity_document_replaced',
    'rfc_changed',
    'fundraiser_url_changed',
    'bank_destination_added',
    'bank_destination_changed',
    'financial_fundraising_enabled',
    'financial_fundraising_disabled'
  )),
  event_description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscriber_donation_identities_org ON public.social_subscriber_donation_identities(org_id);
CREATE INDEX IF NOT EXISTS idx_subscriber_donation_identities_user ON public.social_subscriber_donation_identities(subscriber_user_id);
CREATE INDEX IF NOT EXISTS idx_donation_identity_audit_org ON public.social_donation_identity_audit_events(org_id);

-- Enable RLS
ALTER TABLE public.social_subscriber_donation_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_donation_identity_audit_events ENABLE ROW LEVEL SECURITY;

-- Helper function to check primary subscriber status
CREATE OR REPLACE FUNCTION public.is_primary_subscriber(check_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = check_org_id AND o.created_by = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.org_memberships m
    WHERE m.org_id = check_org_id
      AND m.user_id = auth.uid()
      AND m.deleted_at IS NULL
      AND m.status = 'active'
      AND m.role_in_org::text IN ('owner', 'organization_owner')
  );
$$;

-- RLS: Only primary subscriber can view donation identity
DROP POLICY IF EXISTS "Primary subscriber only can select donation identity" ON public.social_subscriber_donation_identities;
CREATE POLICY "Primary subscriber only can select donation identity"
  ON public.social_subscriber_donation_identities
  FOR SELECT
  TO authenticated
  USING (public.is_primary_subscriber(org_id));

-- RLS: Only primary subscriber can insert donation identity
DROP POLICY IF EXISTS "Primary subscriber only can insert donation identity" ON public.social_subscriber_donation_identities;
CREATE POLICY "Primary subscriber only can insert donation identity"
  ON public.social_subscriber_donation_identities
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_primary_subscriber(org_id));

-- RLS: Only primary subscriber can update donation identity
DROP POLICY IF EXISTS "Primary subscriber only can update donation identity" ON public.social_subscriber_donation_identities;
CREATE POLICY "Primary subscriber only can update donation identity"
  ON public.social_subscriber_donation_identities
  FOR UPDATE
  TO authenticated
  USING (public.is_primary_subscriber(org_id))
  WITH CHECK (public.is_primary_subscriber(org_id));

-- RLS: Only primary subscriber can view audit events
DROP POLICY IF EXISTS "Primary subscriber only can select audit events" ON public.social_donation_identity_audit_events;
CREATE POLICY "Primary subscriber only can select audit events"
  ON public.social_donation_identity_audit_events
  FOR SELECT
  TO authenticated
  USING (public.is_primary_subscriber(org_id));

-- RLS: Primary subscriber can insert audit events
DROP POLICY IF EXISTS "Primary subscriber only can insert audit events" ON public.social_donation_identity_audit_events;
CREATE POLICY "Primary subscriber only can insert audit events"
  ON public.social_donation_identity_audit_events
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_primary_subscriber(org_id));
