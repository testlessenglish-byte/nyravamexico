CREATE OR REPLACE FUNCTION public.renew_execution_lease(p_case_id uuid, p_execution_id uuid, p_lease_ms integer DEFAULT 180000)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INTEGER;
  v_lease_until TIMESTAMPTZ := now() + (GREATEST(30000, LEAST(p_lease_ms, 1200000)) || ' milliseconds')::INTERVAL;
BEGIN
  IF p_case_id IS NULL OR p_execution_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.cases
  SET
    worker_lease_until = v_lease_until,
    updated_at = now()
  WHERE id = p_case_id
    AND execution_id = p_execution_id
    -- Only an execution that still OWNS a live lease may extend it. A case
    -- handed back to the queue (lease cleared) or in a terminal state must
    -- never be re-locked by a late heartbeat.
    AND worker_lease_until IS NOT NULL
    AND worker_lease_until > now()
    AND status NOT IN ('queued', 'complete', 'released', 'failed', 'cancelled', 'needs_revision');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_execution_lease(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_execution_lease(uuid, uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.renew_execution_lease(uuid, uuid, integer) TO authenticated, service_role;