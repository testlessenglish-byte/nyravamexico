-- Fail-closed membership helpers backed by the real org_memberships table.
CREATE OR REPLACE FUNCTION public.is_active_org_member(check_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_memberships m
    WHERE m.org_id = check_org_id AND m.user_id = auth.uid()
      AND m.deleted_at IS NULL AND m.status = 'active'
  );
$$;
REVOKE ALL ON FUNCTION public.is_active_org_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_org_member(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_org_support_admin(check_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_memberships m
    WHERE m.org_id = check_org_id AND m.user_id = auth.uid()
      AND m.deleted_at IS NULL AND m.status = 'active'
      AND m.role_in_org::text IN ('owner','admin','organization_owner','program_director','case_management_supervisor')
  );
$$;
REVOKE ALL ON FUNCTION public.is_org_support_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_support_admin(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_primary_subscriber(check_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = check_org_id AND o.created_by = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.org_memberships m
    WHERE m.org_id = check_org_id AND m.user_id = auth.uid()
      AND m.deleted_at IS NULL AND m.status = 'active'
      AND m.role_in_org::text IN ('owner','organization_owner')
  );
$$;
REVOKE ALL ON FUNCTION public.is_primary_subscriber(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_primary_subscriber(UUID) TO authenticated, service_role;

DO $do$
BEGIN
  IF to_regclass('public.social_community_fundraising_profiles') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Users can view fundraising profiles in their org" ON public.social_community_fundraising_profiles;
    DROP POLICY IF EXISTS "Organization owners and admins can update fundraising profiles" ON public.social_community_fundraising_profiles;
    CREATE POLICY "Active members can view fundraising profiles"
      ON public.social_community_fundraising_profiles FOR SELECT TO authenticated
      USING (public.is_active_org_member(org_id));
    CREATE POLICY "Org admins manage fundraising profiles"
      ON public.social_community_fundraising_profiles FOR ALL TO authenticated
      USING (public.is_org_support_admin(org_id))
      WITH CHECK (public.is_org_support_admin(org_id));
  END IF;

  IF to_regclass('public.social_community_campaigns') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Authenticated users can view campaigns in their org" ON public.social_community_campaigns;
    DROP POLICY IF EXISTS "Staff can insert draft campaign requests" ON public.social_community_campaigns;
    DROP POLICY IF EXISTS "Organization admins can manage campaigns" ON public.social_community_campaigns;
    CREATE POLICY "Active members can view org campaigns"
      ON public.social_community_campaigns FOR SELECT TO authenticated
      USING (public.is_active_org_member(org_id));
    CREATE POLICY "Active members can insert draft campaigns"
      ON public.social_community_campaigns FOR INSERT TO authenticated
      WITH CHECK (public.is_active_org_member(org_id));
    CREATE POLICY "Org admins manage campaigns"
      ON public.social_community_campaigns FOR ALL TO authenticated
      USING (public.is_org_support_admin(org_id))
      WITH CHECK (public.is_org_support_admin(org_id));
  END IF;

  IF to_regclass('public.social_community_support_offers') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Public can insert support offers" ON public.social_community_support_offers;
    DROP POLICY IF EXISTS "Staff can view support offers for their org campaigns" ON public.social_community_support_offers;
    DROP POLICY IF EXISTS "Staff can update support offers for their org campaigns" ON public.social_community_support_offers;
    CREATE POLICY "Offers only for published campaigns"
      ON public.social_community_support_offers FOR INSERT TO anon, authenticated
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.social_community_campaigns c
        WHERE c.id = campaign_id AND c.lifecycle_status = 'published'
      ));
    CREATE POLICY "Active members view org support offers"
      ON public.social_community_support_offers FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.social_community_campaigns c
        WHERE c.id = campaign_id AND public.is_active_org_member(c.org_id)
      ));
    CREATE POLICY "Active members update org support offers"
      ON public.social_community_support_offers FOR UPDATE TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.social_community_campaigns c
        WHERE c.id = campaign_id AND public.is_active_org_member(c.org_id)
      ));
  END IF;
END
$do$;