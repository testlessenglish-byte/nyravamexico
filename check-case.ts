
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
const env = fs.readFileSync(".env", "utf8");
const url = env.match(/SUPABASE_URL=["']?([^\n\r"']+)/)[1];
const pubKey = env.match(/SUPABASE_PUBLISHABLE_KEY=["']?([^\n\r"']+)/)[1];
const supabase = createClient(url, pubKey); // Need service key? I will use pubKey first... wait, I need a user session or service key to read cases!

