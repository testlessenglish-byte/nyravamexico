-- Migration: Expand can_access_client to include case workers & ensure edit/update/delete authorization
-- Model: Creator/Owner + Explicit Client Assignment + Case Assignment (works on client's cases)

BEGIN;

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
        OR EXISTS (
          SELECT 1 FROM public.cases cs
          LEFT JOIN public.case_assignments ca ON ca.case_id = cs.id
          WHERE cs.client_id = _client_id
            AND (cs.user_id = _user_id OR ca.user_id = _user_id)
        )
      )
  );
$$;

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
  USING (public.can_access_client(auth.uid(), id))
  WITH CHECK (public.can_access_client(auth.uid(), id));

CREATE POLICY clients_delete_policy ON public.clients
  FOR DELETE TO authenticated
  USING (
    user_id = auth.uid() 
    OR created_by = auth.uid() 
    OR public.can_access_client(auth.uid(), id)
  );

COMMIT;
