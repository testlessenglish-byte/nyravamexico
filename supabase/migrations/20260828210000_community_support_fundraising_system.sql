-- 20260828210000_community_support_fundraising_system.sql
-- Subscriber-controlled Community Support, Fundraising, and Public Campaign System for Comprehensive Care

CREATE TABLE IF NOT EXISTS public.social_community_fundraising_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'organization' CHECK (account_type IN ('individual', 'organization')),
  rfc TEXT,
  country TEXT NOT NULL DEFAULT 'MX',
  state TEXT,
  responsible_admin_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  external_fundraising_provider TEXT DEFAULT 'gofundme' CHECK (external_fundraising_provider IN ('gofundme', 'other')),
  external_campaign_url TEXT,
  identity_verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (identity_verification_status IN ('unverified', 'rfc_submitted', 'rfc_verified')),
  tax_deductible_status TEXT NOT NULL DEFAULT 'not_verified' CHECK (tax_deductible_status IN ('not_verified', 'not_tax_deductible', 'donataria_autorizada_claimed', 'donataria_autorizada_verified')),
  verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_social_fundraising_org UNIQUE (org_id)
);

CREATE TABLE IF NOT EXISTS public.social_community_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  social_case_id UUID REFERENCES public.social_cases(id) ON DELETE CASCADE,
  campaign_scope TEXT NOT NULL DEFAULT 'individual_case' CHECK (campaign_scope IN ('individual_case', 'organization_wide')),
  public_slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  public_description TEXT NOT NULL,
  internal_need_details TEXT,
  support_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high', 'critical')),
  public_identity_mode TEXT NOT NULL DEFAULT 'anonymous' CHECK (public_identity_mode IN ('anonymous', 'first_name_only', 'family_description', 'full_name')),
  public_display_name TEXT,
  location_display TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle_status IN ('draft', 'pending_approval', 'approved', 'published', 'paused', 'closed', 'rejected')),
  financial_fundraiser_provider TEXT DEFAULT 'gofundme',
  financial_fundraiser_url TEXT,
  financial_target_amount NUMERIC(12, 2),
  financial_currency TEXT NOT NULL DEFAULT 'MXN',
  financial_beneficiary_type TEXT DEFAULT 'organization' CHECK (financial_beneficiary_type IN ('organization', 'client_external')),
  requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.social_community_support_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.social_community_campaigns(id) ON DELETE CASCADE,
  offer_type TEXT NOT NULL CHECK (offer_type IN ('goods', 'service', 'financial_pledge', 'other')),
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_description TEXT NOT NULL,
  quantity TEXT,
  donor_name TEXT NOT NULL,
  donor_email TEXT,
  donor_phone TEXT,
  delivery_method TEXT NOT NULL DEFAULT 'dropoff_organization' CHECK (delivery_method IN ('dropoff_organization', 'collection_point', 'arrange_pickup', 'contact_to_coordinate')),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'reviewed', 'accepted', 'scheduled', 'received', 'cancelled')),
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for fast query resolution
CREATE INDEX IF NOT EXISTS idx_social_campaigns_case ON public.social_community_campaigns(social_case_id);
CREATE INDEX IF NOT EXISTS idx_social_campaigns_org ON public.social_community_campaigns(org_id);
CREATE INDEX IF NOT EXISTS idx_social_campaigns_status ON public.social_community_campaigns(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_social_campaigns_slug ON public.social_community_campaigns(public_slug);
CREATE INDEX IF NOT EXISTS idx_social_offers_campaign ON public.social_community_support_offers(campaign_id);

-- Enable RLS
ALTER TABLE public.social_community_fundraising_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_community_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_community_support_offers ENABLE ROW LEVEL SECURITY;

-- RLS Policies for Fundraising Profiles (Organization Admins & Subscribers only)
CREATE POLICY "Users can view fundraising profiles in their org"
  ON public.social_community_fundraising_profiles
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM public.social_organization_members
      WHERE user_id = auth.uid() AND status = 'active'
    )
  );

CREATE POLICY "Organization owners and admins can update fundraising profiles"
  ON public.social_community_fundraising_profiles
  FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM public.social_organization_members
      WHERE user_id = auth.uid() AND status = 'active' AND role::text IN ('owner', 'admin', 'organization_owner', 'program_director', 'case_management_supervisor')
    )
  );

-- RLS Policies for Campaigns
CREATE POLICY "Authenticated users can view campaigns in their org"
  ON public.social_community_campaigns
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM public.social_organization_members
      WHERE user_id = auth.uid() AND status = 'active'
    )
  );

CREATE POLICY "Public can view published campaigns"
  ON public.social_community_campaigns
  FOR SELECT
  TO anon, authenticated
  USING (lifecycle_status = 'published');

CREATE POLICY "Staff can insert draft campaign requests"
  ON public.social_community_campaigns
  FOR INSERT
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM public.social_organization_members
      WHERE user_id = auth.uid() AND status = 'active'
    )
  );

CREATE POLICY "Organization admins can manage campaigns"
  ON public.social_community_campaigns
  FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM public.social_organization_members
      WHERE user_id = auth.uid() AND status = 'active' AND role::text IN ('owner', 'admin', 'organization_owner', 'program_director', 'case_management_supervisor')
    )
  );

-- RLS Policies for Support Offers
CREATE POLICY "Public can insert support offers"
  ON public.social_community_support_offers
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Staff can view support offers for their org campaigns"
  ON public.social_community_support_offers
  FOR SELECT
  USING (
    campaign_id IN (
      SELECT id FROM public.social_community_campaigns
      WHERE org_id IN (
        SELECT org_id FROM public.social_organization_members
        WHERE user_id = auth.uid() AND status = 'active'
      )
    )
  );

CREATE POLICY "Staff can update support offers for their org campaigns"
  ON public.social_community_support_offers
  FOR UPDATE
  USING (
    campaign_id IN (
      SELECT id FROM public.social_community_campaigns
      WHERE org_id IN (
        SELECT org_id FROM public.social_organization_members
        WHERE user_id = auth.uid() AND status = 'active'
      )
    )
  );
