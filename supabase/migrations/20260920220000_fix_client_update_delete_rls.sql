-- Migration: Fix RLS policies for updating and deleting clients by subscriber owners/assignees
-- Ensures subscribers who created or are assigned to a client can UPDATE and DELETE their clients.

BEGIN;

DROP POLICY IF EXISTS clients_update_policy ON public.clients;
DROP POLICY IF EXISTS clients_delete_policy ON public.clients;

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
