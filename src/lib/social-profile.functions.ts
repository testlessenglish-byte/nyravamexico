import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const optionalPlatformUrl = (hosts: string[]) =>
  z.union([
    z.literal(""),
    z.string().trim().url().max(500).refine((value) => {
      try {
        const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
        return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
      } catch {
        return false;
      }
    }, "Use an official profile URL for this network."),
  ]);

const SocialProfileSchema = z.object({
  linkedin_url: optionalPlatformUrl(["linkedin.com"]),
  discord_url: optionalPlatformUrl(["discord.com", "discord.gg"]),
  twitter_url: optionalPlatformUrl(["x.com", "twitter.com"]),
  facebook_url: optionalPlatformUrl(["facebook.com", "fb.com"]),
  public_visible: z.boolean(),
});

export type SocialProfileInput = z.infer<typeof SocialProfileSchema>;

export const getMySocialProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as any;
    const { data, error } = await ctx.supabase
      .from("user_social_profiles")
      .select("linkedin_url,discord_url,twitter_url,facebook_url,public_visible")
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? {
      linkedin_url: null,
      discord_url: null,
      twitter_url: null,
      facebook_url: null,
      public_visible: false,
    };
  });

export const updateMySocialProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => SocialProfileSchema.parse(value))
  .handler(async ({ data, context }) => {
    const ctx = context as any;
    const { data: isSuperAdmin, error: roleError } = await ctx.supabase.rpc("is_super_admin", {
      _user_id: ctx.userId,
    });
    if (roleError) throw new Error(roleError.message);

    const { error } = await ctx.supabase.from("user_social_profiles").upsert({
      user_id: ctx.userId,
      linkedin_url: data.linkedin_url || null,
      discord_url: data.discord_url || null,
      twitter_url: data.twitter_url || null,
      facebook_url: data.facebook_url || null,
      public_visible: Boolean(isSuperAdmin && data.public_visible),
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getPublicSuperAdminSocialProfile = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: roleRows, error: roleError } = await supabaseAdmin
      .from("user_roles")
      .select("user_id")
      .eq("role", "super_admin");
    if (roleError || !roleRows?.length) return null;

    const ids = roleRows.map((row) => row.user_id);
    const { data: social, error } = await supabaseAdmin
      .from("user_social_profiles")
      .select("user_id,linkedin_url,discord_url,twitter_url,facebook_url")
      .in("user_id", ids)
      .eq("public_visible", true)
      .limit(1)
      .maybeSingle();
    if (error || !social) return null;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("id", social.user_id)
      .maybeSingle();

    return {
      name: profile?.full_name || "Nyrava México",
      linkedin_url: social.linkedin_url,
      discord_url: social.discord_url,
      twitter_url: social.twitter_url,
      facebook_url: social.facebook_url,
    };
  } catch (error) {
    console.warn("[social-profile] Public social links unavailable:", error);
    return null;
  }
});