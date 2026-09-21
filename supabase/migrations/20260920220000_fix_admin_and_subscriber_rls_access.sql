-- Migration: Fix Admin & Subscriber RLS Access for Cases and Clients
-- Ensures Platform Admins have full operational override, and subscribers/creators have proper RLS access.

BEGIN;

-- 1. Helper Function: can_access_client
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
        OR public.has_role(_user_id, 'admin')
      )
  );
$$;

-- 2. Helper Function: can_access_case
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
        OR public.has_role(_user_id, 'admin')
      )
  );
$$;

-- 3. Client Policies
DROP POLICY IF EXISTS clients_select_policy ON public.clients;
DROP POLICY IF EXISTS clients_insert_policy ON public.clients;
DROP POLICY IF EXISTS clients_update_policy ON public.clients;
DROP POLICY IF EXISTS clients_delete_policy ON public.clients;

CREATE POLICY clients_select_policy ON public.clients
  FOR SELECT TO authenticated
  USING (public.can_access_client(auth.uid(), id));

CREATE POLICY clients_insert_policy ON public.clients
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR created_by = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY clients_update_policy ON public.clients
  FOR UPDATE TO authenticated
  USING (public.can_access_client(auth.uid(), id));

CREATE POLICY clients_delete_policy ON public.clients
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR created_by = auth.uid() OR public.can_access_client(auth.uid(), id) OR public.has_role(auth.uid(), 'admin'));

-- 4. Case Policies
DROP POLICY IF EXISTS cases_select_policy ON public.cases;
DROP POLICY IF EXISTS cases_insert_policy ON public.cases;
DROP POLICY IF EXISTS cases_update_policy ON public.cases;
DROP POLICY IF EXISTS cases_delete_policy ON public.cases;

CREATE POLICY cases_select_policy ON public.cases
  FOR SELECT TO authenticated
  USING (public.can_access_case(auth.uid(), id));

CREATE POLICY cases_insert_policy ON public.cases
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY cases_update_policy ON public.cases
  FOR UPDATE TO authenticated
  USING (public.can_access_case(auth.uid(), id));

CREATE POLICY cases_delete_policy ON public.cases
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

COMMIT;
