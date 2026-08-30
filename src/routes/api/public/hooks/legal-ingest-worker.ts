// Background legal-ingestion worker — Phase 20. Same security pattern as
// pipeline-worker.ts (worker-secret header, service-role admin client,
// lives under /api/public/* but requires the secret to do anything).
//
// Iterates every connector that's both enabled in public.legal_source_connectors
// (status = 'active') AND actually implemented in code
// (IMPLEMENTED_CONNECTORS in src/lib/legal-connectors/types.ts), runs an
// incremental sync for each, and records the result. Intended to be
// scheduled via pg_cron once pg_cron is enabled on this project — see the
// commented example at the bottom of this file.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getEnabledConnectors } from "@/lib/legal-connectors/registry.server";
import { runConnectorIngest, recordIngestRun } from "@/lib/legal-connectors/ingest-pipeline.server";

function workerTrace(event: string, extra: Record<string, unknown> = {}) {
  console.info(`[legal-ingest-worker] ${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}`);
}

export const Route = createFileRoute("/api/public/hooks/legal-ingest-worker")({
  server: {
    handlers: {
      GET: async () => new Response("Method Not Allowed", { status: 405 }),
      POST: async ({ request }) => {
        const provided = request.headers.get("x-worker-secret");
        if (!provided) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        const url = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !serviceKey) {
          return new Response(JSON.stringify({ error: "backend env unavailable" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const admin = createClient<Database>(url, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: sec, error: secErr } = await (admin as any)
          .from("worker_secrets")
          .select("secret")
          .eq("name", "legal_ingest_worker")
          .maybeSingle();
        if (secErr || !sec?.secret) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Constant-time compare — same reasoning as pipeline-worker.ts and
        // reminders-worker.ts: a plain `!==` on a secret leaks timing
        // information proportional to how many leading bytes match.
        {
          const a = new TextEncoder().encode(provided);
          const b = new TextEncoder().encode(sec.secret);
          let ok = a.length === b.length;
          for (let i = 0; i < Math.min(a.length, b.length); i++) ok = ok && a[i] === b[i];
          if (!ok) {
            return new Response(JSON.stringify({ error: "unauthorized" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        const connectors = await getEnabledConnectors(admin);
        if (connectors.length === 0) {
          workerTrace("worker.no_enabled_connectors");
          return new Response(JSON.stringify({ ran: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        const results = [];
        for (const connector of connectors) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: cfg } = await (admin as any)
            .from("legal_source_connectors")
            .select("last_sync_at")
            .eq("code", connector.code)
            .maybeSingle();
          const since = cfg?.last_sync_at ? new Date(cfg.last_sync_at) : null;
          workerTrace("worker.sync_start", { connector: connector.code, since });
          const result = await runConnectorIngest(admin, connector, since);
          await recordIngestRun(admin, result);
          workerTrace("worker.sync_done", { connector: connector.code, status: result.status, stored: result.documentsStored });
          results.push(result);
        }

        return new Response(JSON.stringify({ ran: results.length, results }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});

// Once pg_cron + pg_net are enabled (Database > Extensions in Supabase) and
// a legal_ingest_worker row exists in worker_secrets, schedule with:
//
//   SELECT cron.schedule('nyrava-legal-ingest-worker', '0 6 * * *', -- daily, 6am
//     format($cmd$ SELECT net.http_post(url := 'https://<your-mx-domain>/api/public/hooks/legal-ingest-worker',
//       headers := %L::jsonb, body := '{}'::jsonb); $cmd$,
//       jsonb_build_object('Content-Type','application/json','x-worker-secret',
//         (SELECT secret FROM public.worker_secrets WHERE name = 'legal_ingest_worker'))::text));
