BEGIN;

-- 1. Create `clients` table
CREATE TABLE IF NOT EXISTS public.clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid REFERENCES public.organizations(id),
  user_id       uuid NOT NULL REFERENCES auth.users(id),
  display_name  text NOT NULL,
  client_type   text NOT NULL DEFAULT 'individual' CHECK (client_type IN ('individual', 'company', 'government', 'other')),
  legal_name    text,
  rfc           text,
  email         text,
  phone         text,
  address       text,
  reference_number text,
  responsible_attorney uuid REFERENCES auth.users(id),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  notes         text,
  created_by    uuid NOT NULL REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 2. Create `case_deadlines` table
CREATE TABLE IF NOT EXISTS public.case_deadlines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  title       text NOT NULL,
  due_date    date NOT NULL,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_extracted', 'court_calendar')),
  priority    text DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  notes       text,
  completed   boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 3. Create `crm_activity_log` table
CREATE TABLE IF NOT EXISTS public.crm_activity_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES public.organizations(id),
  user_id     uuid REFERENCES auth.users(id),
  actor_id    uuid NOT NULL REFERENCES auth.users(id),
  action      text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  metadata    jsonb DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 4. Add `client_id` column to `cases`
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(id);

-- 5. Enable RLS and create policies
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_activity_log ENABLE ROW LEVEL SECURITY;

-- clients policies
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'clients_select_policy') THEN
        CREATE POLICY clients_select_policy ON public.clients FOR SELECT TO authenticated
        USING (user_id = auth.uid() OR (org_id IS NOT NULL AND public.is_org_member(auth.uid(), org_id)) OR public.is_admin_tier(auth.uid()));
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'clients_insert_policy') THEN
        CREATE POLICY clients_insert_policy ON public.clients FOR INSERT TO authenticated
        WITH CHECK (user_id = auth.uid());
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'clients_update_policy') THEN
        CREATE POLICY clients_update_policy ON public.clients FOR UPDATE TO authenticated
        USING (user_id = auth.uid() OR (org_id IS NOT NULL AND public.is_org_member(auth.uid(), org_id)) OR public.is_admin_tier(auth.uid()));
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'clients_delete_policy') THEN
        CREATE POLICY clients_delete_policy ON public.clients FOR DELETE TO authenticated
        USING (user_id = auth.uid() OR public.is_admin_tier(auth.uid()));
    END IF;
END $$;

-- case_deadlines policies
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'case_deadlines_all_policy') THEN
        CREATE POLICY case_deadlines_all_policy ON public.case_deadlines FOR ALL TO authenticated
        USING (EXISTS (SELECT 1 FROM public.cases c WHERE c.id = case_id AND (c.user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))));
    END IF;
END $$;

-- crm_activity_log policies
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_activity_log_select_policy') THEN
        CREATE POLICY crm_activity_log_select_policy ON public.crm_activity_log FOR SELECT TO authenticated
        USING (actor_id = auth.uid() OR (org_id IS NOT NULL AND public.is_org_member(auth.uid(), org_id)) OR public.is_admin_tier(auth.uid()));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'crm_activity_log_insert_policy') THEN
        CREATE POLICY crm_activity_log_insert_policy ON public.crm_activity_log FOR INSERT TO authenticated
        WITH CHECK (actor_id = auth.uid());
    END IF;
END $$;

-- 6. Create search indexes
CREATE INDEX IF NOT EXISTS idx_cases_fulltext_search ON public.cases
  USING gin(to_tsvector('spanish',
    coalesce(name, '') || ' ' || coalesce(jurisdiction, '') || ' ' || coalesce(description, '')
  ));

CREATE INDEX IF NOT EXISTS idx_clients_fulltext_search ON public.clients
  USING gin(to_tsvector('simple',
    coalesce(display_name, '') || ' ' || coalesce(legal_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(reference_number, '')
  ));

CREATE INDEX IF NOT EXISTS idx_clients_org ON public.clients(org_id);
CREATE INDEX IF NOT EXISTS idx_clients_user ON public.clients(user_id);
CREATE INDEX IF NOT EXISTS idx_case_deadlines_case ON public.case_deadlines(case_id);
CREATE INDEX IF NOT EXISTS idx_case_deadlines_due ON public.case_deadlines(due_date) WHERE NOT completed;
CREATE INDEX IF NOT EXISTS idx_cases_client_id ON public.cases(client_id) WHERE client_id IS NOT NULL;

-- 7. Create global_legal_search function
CREATE OR REPLACE FUNCTION public.global_legal_search(
  _query text,
  _user_id uuid DEFAULT auth.uid(),
  _limit int DEFAULT 25
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  q text;
  cases_result jsonb;
  clients_result jsonb;
  documents_result jsonb;
BEGIN
  q := trim(_query);
  IF length(q) < 1 THEN RETURN '{"cases":[],"clients":[],"documents":[]}'::jsonb; END IF;

  SELECT coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO cases_result
  FROM (
    SELECT c.id, c.name as title, c.jurisdiction, c.case_type::text as matter_type, c.status::text, c.updated_at
    FROM cases c
    WHERE (
      c.user_id = _user_id
      OR has_role(_user_id, 'admin')
      OR (c.firm_id IS NOT NULL AND EXISTS (SELECT 1 FROM firm_roles fr WHERE fr.firm_id = c.firm_id AND fr.user_id = _user_id))
    )
    AND (
      c.name ILIKE '%' || q || '%'
      OR c.jurisdiction ILIKE '%' || q || '%'
      OR c.description ILIKE '%' || q || '%'
    )
    ORDER BY c.updated_at DESC NULLS LAST
    LIMIT _limit
  ) r;

  SELECT coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO clients_result
  FROM (
    SELECT cl.id, cl.display_name, cl.client_type, cl.email, cl.status, cl.reference_number,
           (SELECT count(*) FROM cases cs WHERE cs.client_id = cl.id)::int as case_count
    FROM clients cl
    WHERE (
      cl.user_id = _user_id
      OR (cl.org_id IS NOT NULL AND is_org_member(_user_id, cl.org_id))
      OR is_admin_tier(_user_id)
    )
    AND (
      cl.display_name ILIKE '%' || q || '%'
      OR cl.legal_name ILIKE '%' || q || '%'
      OR cl.email ILIKE '%' || q || '%'
      OR cl.reference_number ILIKE '%' || q || '%'
      OR cl.rfc ILIKE '%' || q || '%'
    )
    ORDER BY cl.updated_at DESC NULLS LAST
    LIMIT _limit
  ) r;

  SELECT coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO documents_result
  FROM (
    SELECT d.id, d.filename, d.case_id, c.name as case_title
    FROM documents d
    JOIN cases c ON c.id = d.case_id
    WHERE (
      c.user_id = _user_id
      OR has_role(_user_id, 'admin')
      OR (c.firm_id IS NOT NULL AND EXISTS (SELECT 1 FROM firm_roles fr WHERE fr.firm_id = c.firm_id AND fr.user_id = _user_id))
    )
    AND d.filename ILIKE '%' || q || '%'
    ORDER BY d.created_at DESC
    LIMIT _limit
  ) r;

  RETURN jsonb_build_object('cases', cases_result, 'clients', clients_result, 'documents', documents_result);
END;
$$;

COMMIT;

