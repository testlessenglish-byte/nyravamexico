import { createServerFn } from "@tanstack/react-start";
import { type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

type Db = SupabaseClient<Database>;

export type SearchResultCase = {
  id: string;
  title: string | null;
  case_number: string | null;
  client_name: string | null;
  matter_type: string | null;
  status: string | null;
  updated_at: string | null;
};

export type SearchResultClient = {
  id: string;
  display_name: string;
  client_type: string;
  email: string | null;
  status: string;
  reference_number: string | null;
  case_count: number;
};

export type SearchResultDocument = {
  id: string;
  filename: string;
  case_id: string;
  case_title: string | null;
  case_number: string | null;
};

export type SearchResults = {
  cases: SearchResultCase[];
  clients: SearchResultClient[];
  documents: SearchResultDocument[];
};

export const globalLegalSearch = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ query: z.string().min(1).max(200) }).parse(d),
  )
  .handler(async ({ data, context }): Promise<SearchResults> => {
    const ctx = context as { supabase: Db; userId: string };
    if (!ctx.userId) throw new Error("Not signed in.");

    const empty: SearchResults = { cases: [], clients: [], documents: [] };

    // Try calling the RPC. The function uses _query as first param name.
    const { data: searchResults, error } = await (ctx.supabase as any).rpc(
      "global_legal_search",
      { _query: data.query, _user_id: ctx.userId },
    );

    if (error) {
      // If the RPC doesn't exist yet (migration not applied), fall back gracefully
      console.warn("[crm-search] global_legal_search RPC failed, falling back:", error.message);
      return empty;
    }

    const result = searchResults as SearchResults | null;
    return result ?? empty;
  });
