import { createClient } from "@supabase/supabase-js";

async function backfillCRM() {
  const url = process.env.SUPABASE_URL || "http://localhost:54321";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY, using placeholders or skipping");
    return;
  }

  const supabase = createClient(url, key);

  console.log("Starting CRM Backfill...");

  const { data: cases, error: fetchErr } = await supabase
    .from("cases")
    .select("id, name, client_name, user_id")
    .is("client_id", null);

  if (fetchErr) {
    console.error("Error fetching cases:", fetchErr);
    process.exit(1);
  }

  console.log(Found  cases needing backfill.);

  for (const c of cases) {
    let clientName = c.client_name || "Client Association Required";
    if (clientName === "Client Association Required" && c.name) {
       if (c.name.includes("—")) {
         clientName = c.name.split("—")[0].trim();
       } else if (c.name.includes("-")) {
         clientName = c.name.split("-")[0].trim();
       }
    }

    console.log(Processing case  (""). Assigned Client Name: "");

    const { data: existingClient } = await supabase
      .from("clients")
      .select("id")
      .eq("user_id", c.user_id)
      .eq("display_name", clientName)
      .limit(1)
      .maybeSingle();

    let clientId = existingClient?.id;

    if (!clientId) {
      const { data: newClient, error: createErr } = await supabase
        .from("clients")
        .insert({
          display_name: clientName,
          user_id: c.user_id,
          created_by: c.user_id,
          client_type: "individual",
          status: "active"
        })
        .select("id")
        .single();

      if (createErr || !newClient) {
        console.error(Error creating client "":, createErr);
        continue;
      }
      clientId = newClient.id;
      console.log(-> Created new CRM client: );
    } else {
      console.log(-> Found existing CRM client: );
    }

    const { error: updateErr } = await supabase
      .from("cases")
      .update({ client_id: clientId })
      .eq("id", c.id);

    if (updateErr) {
      console.error(Error updating case :, updateErr);
    } else {
      console.log(-> Successfully updated case  with client_id );
    }
  }

  console.log("Backfill complete.");
}

backfillCRM().catch(console.error);
