-- Migration: Platform-Wide Privacy & Authorization System Remediation
-- Model: Creator-Owner + Explicit-Assignment ONLY
-- Excludes: team member auto-access, workspace owner auto-access, platform admin master key

BEGIN;

-- 1. Create client_assignments junction table
CREATE TABLE IF NOT EXISTS public.client_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, user_id)
);

-- 2. Create case_assignments junction table
CREATE TABLE IF NOT EXISTS public.case_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_assignments TO authenticated;
GRANT ALL ON public.client_assignments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_assignments TO authenticated;
GRANT ALL ON public.case_assignments TO service_role;

ALTER TABLE public.client_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_assignments ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_client_assignments_client ON public.client_assignments(client_id);
CREATE INDEX IF NOT EXISTS idx_client_assignments_user ON public.client_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_case_assignments_case ON public.case_assignments(case_id);
CREATE INDEX IF NOT EXISTS idx_case_assignments_user ON public.case_assignments(user_id);

-- 3. Security Definer Helper Functions
CREATE OR REPLACE FUNCTION public.can_access_client(_user_id uuid, _client_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.clients c
    WHERE c.id = _client_id
      AND (
        c.created_by = _user_id
        OR c.user_id = _user_id
        OR c.responsible_attorney = _user_id
        OR EXISTS (
          SELECT 1 FROM public.client_assignments ca
          WHERE ca.client_id = _client_id AND ca.user_id = _user_id
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_case(_user_id uuid, _case_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.cases c
    WHERE c.id = _case_id
      AND (
        c.user_id = _user_id
        OR EXISTS (
          SELECT 1 FROM public.case_assignments ca
          WHERE ca.case_id = _case_id AND ca.user_id = _user_id
        )
        OR (
          c.client_id IS NOT NULL
          AND public.can_access_client(_user_id, c.client_id)
        )
      )
  );
$$;

-- 4. Client Policies
DROP POLICY IF EXISTS clients_select_policy ON public.clients;
DROP POLICY IF EXISTS clients_insert_policy ON public.clients;
DROP POLICY IF EXISTS clients_update_policy ON public.clients;
DROP POLICY IF EXISTS clients_delete_policy ON public.clients;

CREATE POLICY clients_select_policy ON public.clients
  FOR SELECT TO authenticated
  USING (public.can_access_client(auth.uid(), id));

CREATE POLICY clients_insert_policy ON public.clients
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR created_by = auth.uid());

CREATE POLICY clients_update_policy ON public.clients
  FOR UPDATE TO authenticated
  USING (public.can_access_client(auth.uid(), id));

CREATE POLICY clients_delete_policy ON public.clients
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR created_by = auth.uid());

-- RLS for client_assignments
DROP POLICY IF EXISTS client_assignments_select ON public.client_assignments;
DROP POLICY IF EXISTS client_assignments_write ON public.client_assignments;

CREATE POLICY client_assignments_select ON public.client_assignments
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_access_client(auth.uid(), client_id));

CREATE POLICY client_assignments_write ON public.client_assignments
  FOR ALL TO authenticated
  USING (public.can_access_client(auth.uid(), client_id))
  WITH CHECK (public.can_access_client(auth.uid(), client_id));

-- 5. Case Policies
DROP POLICY IF EXISTS "cases select" ON public.cases;
DROP POLICY IF EXISTS "cases insert" ON public.cases;
DROP POLICY IF EXISTS "cases update" ON public.cases;
DROP POLICY IF EXISTS "cases delete" ON public.cases;
DROP POLICY IF EXISTS cases_select_policy ON public.cases;
DROP POLICY IF EXISTS cases_update_policy ON public.cases;
DROP POLICY IF EXISTS cases_delete_policy ON public.cases;
DROP POLICY IF EXISTS cases_firm_admin_read ON public.cases;

CREATE POLICY cases_select_policy ON public.cases
  FOR SELECT TO authenticated
  USING (public.can_access_case(auth.uid(), id));

CREATE POLICY cases_insert_policy ON public.cases
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY cases_update_policy ON public.cases
  FOR UPDATE TO authenticated
  USING (public.can_access_case(auth.uid(), id));

CREATE POLICY cases_delete_policy ON public.cases
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- RLS for case_assignments
DROP POLICY IF EXISTS case_assignments_select ON public.case_assignments;
DROP POLICY IF EXISTS case_assignments_write ON public.case_assignments;

CREATE POLICY case_assignments_select ON public.case_assignments
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_access_case(auth.uid(), case_id));

CREATE POLICY case_assignments_write ON public.case_assignments
  FOR ALL TO authenticated
  USING (public.can_access_case(auth.uid(), case_id))
  WITH CHECK (public.can_access_case(auth.uid(), case_id));

-- 6. Document Policies
DROP POLICY IF EXISTS "docs all" ON public.documents;
DROP POLICY IF EXISTS docs_select_policy ON public.documents;
DROP POLICY IF EXISTS docs_all_policy ON public.documents;

CREATE POLICY docs_select_policy ON public.documents
  FOR SELECT TO authenticated
  USING (public.can_access_case(auth.uid(), case_id));

CREATE POLICY docs_all_policy ON public.documents
  FOR ALL TO authenticated
  USING (public.can_access_case(auth.uid(), case_id));

-- 7. Case Deadlines & Activity Log Policies
DROP POLICY IF EXISTS case_deadlines_all_policy ON public.case_deadlines;
CREATE POLICY case_deadlines_all_policy ON public.case_deadlines
  FOR ALL TO authenticated
  USING (public.can_access_case(auth.uid(), case_id));

DROP POLICY IF EXISTS crm_activity_log_select_policy ON public.crm_activity_log;
DROP POLICY IF EXISTS crm_activity_log_insert_policy ON public.crm_activity_log;

CREATE POLICY crm_activity_log_select_policy ON public.crm_activity_log
  FOR SELECT TO authenticated
  USING (actor_id = auth.uid() OR user_id = auth.uid());

CREATE POLICY crm_activity_log_insert_policy ON public.crm_activity_log
  FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());

-- 8. Global Search Function Rewrite
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
    WHERE public.can_access_case(_user_id, c.id)
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
           (SELECT count(*) FROM cases cs WHERE cs.client_id = cl.id AND public.can_access_case(_user_id, cs.id))::int as case_count
    FROM clients cl
    WHERE public.can_access_client(_user_id, cl.id)
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
    WHERE public.can_access_case(_user_id, c.id)
    AND d.filename ILIKE '%' || q || '%'
    ORDER BY d.created_at DESC
    LIMIT _limit
  ) r;

  RETURN jsonb_build_object('cases', cases_result, 'clients', clients_result, 'documents', documents_result);
END;
$$;

COMMIT;
