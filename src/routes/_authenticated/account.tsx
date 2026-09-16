// Account Administration Panel — every signed-in user.
// Profile · Email · Password · Voice · Notifications · AI Companion · Activity
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import {
  getAccount, updateProfile, updateVoicePrefs, updateNotificationPrefs,
  updateAIPrefs, changePassword, changeEmail, getRecentActivity,
} from "@/lib/account.functions";
import { getSocialWorkspace, inviteSocialOrganizationMember, updateSocialOrganizationMember } from "@/lib/social.functions";
import { supabase } from "@/integrations/supabase/client";
import {
  User, Mail, Lock, Mic, Bell, Bot, History, Save, Loader2, Volume2, PlayCircle, Users, UserPlus, Trash2,
  Share2,
} from "lucide-react";
import { useI18n } from "@/i18n";
import { SubscriberDonationIdentitySection } from "@/components/account/SubscriberDonationIdentitySection";
import { getMySocialProfile, updateMySocialProfile } from "@/lib/social-profile.functions";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({ meta: [{ title: "Cuenta — Nyrava" }] }),
  component: AccountPage,
});

const VOICES: { id: string; label: string; accent: string; gender: "F" | "M" }[] = [
  { id: "nova",    label: "Nova",    accent: "American · Professional", gender: "F" },
  { id: "shimmer", label: "Shimmer", accent: "American · Warm",         gender: "F" },
  { id: "alloy",   label: "Alloy",   accent: "Neutral · Balanced",      gender: "F" },
  { id: "coral",   label: "Coral",   accent: "American · Bright",       gender: "F" },
  { id: "sage",    label: "Sage",    accent: "American · Calm",         gender: "F" },
  { id: "fable",   label: "Fable",   accent: "British · Refined",       gender: "F" },
  { id: "onyx",    label: "Onyx",    accent: "American · Deep",         gender: "M" },
  { id: "echo",    label: "Echo",    accent: "American · Clear",        gender: "M" },
  { id: "ash",     label: "Ash",     accent: "American · Authoritative",gender: "M" },
  { id: "ballad",  label: "Ballad",  accent: "British · Storyteller",   gender: "M" },
  { id: "verse",   label: "Verse",   accent: "Neutral · Expressive",    gender: "M" },
];

const ACCENT_IDS = ["us", "uk", "au", "ca", "es-mx", "es-es", "neutral"] as const;

function AccountPage() {
  const { t } = useI18n();
  const getAcc = useServerFn(getAccount);
  const getAct = useServerFn(getRecentActivity);
  const getWorkspace = useServerFn(getSocialWorkspace);
  const accQ = useQuery({ queryKey: ["account"], queryFn: () => getAcc() });
  const actQ = useQuery({ queryKey: ["account-activity"], queryFn: () => getAct() });
  const workspaceQ = useQuery({ queryKey: ["social-workspace"], queryFn: () => getWorkspace() });

  if (accQ.isLoading) {
    return <div className="p-10 text-center text-sm text-muted-foreground">{t("acct.loading")}</div>;
  }
  if (accQ.error || !accQ.data) {
    return <div className="p-10 text-center text-sm text-destructive">{t("acct.loadFailed")}</div>;
  }

  const acc = accQ.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground sm:text-3xl">{t("acct.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("acct.subtitle")}</p>
        {acc.roles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {acc.roles.map((r: string) => (
              <span key={r} className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">{r}</span>
            ))}
          </div>
        )}
      </header>

      <ProfileCard acc={acc} onSaved={() => accQ.refetch()} />
      <SocialProfilesCard isSuperAdmin={acc.roles.includes("super_admin")} />
      <OrganizationTeamCard workspace={workspaceQ.data} loading={workspaceQ.isLoading} />
      {workspaceQ.data?.organizations?.[0]?.id && (
        <SubscriberDonationIdentitySection
          orgId={workspaceQ.data.organizations[0].id}
          es={t("acct.title") !== "Account"}
        />
      )}
      <SecurityCard email={acc.email ?? ""} />
      <VoiceCard settings={acc.settings} onSaved={() => accQ.refetch()} />
      <NotificationCard settings={acc.settings} onSaved={() => accQ.refetch()} />
      <AICompanionCard settings={acc.settings} onSaved={() => accQ.refetch()} />
      <ActivityCard data={actQ.data} loading={actQ.isLoading} />
    </div>
  );
}

function SocialProfilesCard({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const getSocial = useServerFn(getMySocialProfile);
  const updateSocial = useServerFn(updateMySocialProfile);
  const query = useQuery({ queryKey: ["my-social-profile"], queryFn: () => getSocial() });
  const [draft, setDraft] = useState<null | {
    linkedin_url: string;
    discord_url: string;
    twitter_url: string;
    facebook_url: string;
    public_visible: boolean;
  }>(null);
  const form = draft ?? {
    linkedin_url: query.data?.linkedin_url ?? "",
    discord_url: query.data?.discord_url ?? "",
    twitter_url: query.data?.twitter_url ?? "",
    facebook_url: query.data?.facebook_url ?? "",
    public_visible: query.data?.public_visible ?? false,
  };
  const mutation = useMutation({
    mutationFn: () => updateSocial({ data: form }),
    onSuccess: () => {
      toast.success(t("acct.social.saved"));
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["my-social-profile"] });
      void queryClient.invalidateQueries({ queryKey: ["public-super-admin-social-profile"] });
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : t("acct.saveFailed")),
  });

  const set = (key: keyof typeof form, value: string | boolean) => setDraft({ ...form, [key]: value });
  return (
    <Card icon={<Share2 className="h-4 w-4" />} title={t("acct.social.title")}>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{t("acct.social.description")}</p>
      {query.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="LinkedIn" value={form.linkedin_url} onChange={(value) => set("linkedin_url", value)} />
            <Field label="Discord" value={form.discord_url} onChange={(value) => set("discord_url", value)} />
            <Field label="X / Twitter" value={form.twitter_url} onChange={(value) => set("twitter_url", value)} />
            <Field label="Facebook" value={form.facebook_url} onChange={(value) => set("facebook_url", value)} />
          </div>
          {isSuperAdmin && (
            <div className="mt-3">
              <Toggle label={t("acct.social.publicVisible")} checked={form.public_visible}
                onChange={(value) => set("public_visible", value)} />
              <p className="mt-1 text-[11px] text-muted-foreground">{t("acct.social.publicHint")}</p>
            </div>
          )}
          <SaveButton pending={mutation.isPending} onClick={() => mutation.mutate()} />
        </>
      )}
    </Card>
  );
}

const TEAM_ROLES=["firm_manager","supervisor","case_worker","legal_provider","psychosocial_provider","read_only"] as const;
const teamRoleLabel=(role:string,es:boolean)=>({
  firm_manager:["Gerente del despacho","Firm manager"],supervisor:["Supervisor","Supervisor"],case_worker:["Gestor del caso","Case worker"],
  legal_provider:["Profesional jurídico","Legal provider"],psychosocial_provider:["Profesional psicosocial","Psychosocial provider"],
  read_only:["Solo lectura","Read only"],owner:["Propietario","Owner"],admin:["Administrador","Administrator"],
} as Record<string,[string,string]>)[role]?.[es?0:1]??role.replaceAll("_"," ");

function OrganizationTeamCard({workspace,loading}:{workspace:any;loading:boolean}){
  const {locale}=useI18n();const es=locale==="es";const qc=useQueryClient();
  const inviteFn=useServerFn(inviteSocialOrganizationMember);
  const updateFn=useServerFn(updateSocialOrganizationMember);
  const org=workspace?.organizations?.[0];const account=workspace?.organizationAccounts?.find((x:any)=>x.orgId===org?.id);
  const [invite,setInvite]=useState({name:"",email:"",title:"",role:"case_worker"});
  const [link,setLink]=useState("");
  const inviteMutation=useMutation({
    mutationFn:()=>inviteFn({data:{orgId:org.id,...invite,role:invite.role as typeof TEAM_ROLES[number]}}),
    onSuccess:(result:any)=>{
      setLink(`${window.location.origin}/social?invite=${result.token}`);
      setInvite({...invite,name:"",email:"",title:""});
      const joined=result.memberActivated===true;
      if(result.emailSent===true){
        toast.success(joined
          ?(es?"Invitación enviada; la cuenta existente ya está activa":"Invitation sent; the existing account is now active")
          :(es?"Invitación creada y correo enviado":"Invitation created and email sent"));
      }else{
        toast.warning(joined
          ?(es?"La cuenta ya está activa; no se confirmó el correo. Copie el enlace seguro.":"The account is active; email delivery was not confirmed. Copy the secure link.")
          :(es?"Invitación creada; no se confirmó el correo. Copie el enlace seguro.":"Invitation created; email delivery was not confirmed. Copy the secure link."));
      }
      void qc.invalidateQueries({queryKey:["social-workspace"]});
    },
    onError:(e:any)=>toast.error(e?.message??String(e)),
  });
  const updateMutation=useMutation({
    mutationFn:(value:{userId:string;role:string;status:"active"|"suspended"|"removed"})=>updateFn({data:{orgId:org.id,userId:value.userId,role:value.role as typeof TEAM_ROLES[number],status:value.status}}),
    onSuccess:()=>{toast.success(es?"Miembro actualizado":"Team member updated");void qc.invalidateQueries({queryKey:["social-workspace"]});},
    onError:(e:any)=>toast.error(e?.message??String(e)),
  });
  return <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex gap-3"><div className="rounded-xl bg-primary/10 p-2 text-primary"><Users className="h-5 w-5"/></div><div><h2 className="font-semibold">{es?"Equipo de la organización":"Organization team"}</h2><p className="mt-1 text-sm text-muted-foreground">{es?"Invite empleados a la suscripción del despacho y defina su función. No compran otra suscripción.":"Invite employees under the firm subscription and define their role. They do not buy a separate subscription."}</p></div></div>{account&&<div className="rounded-lg border border-border px-3 py-2 text-sm"><strong>{account.seats_used??0}</strong> / {(account.seat_limit??1)>=100000?(es?"ilimitados":"unlimited"):(account.seat_limit??1)} {es?"asientos":"seats"}</div>}</div>
    {loading&&<p className="mt-4 text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>{es?"Cargando equipo…":"Loading team…"}</p>}
    {!loading&&!org&&<p className="mt-4 text-sm text-warning">{es?"La organización todavía no fue aprovisionada. Complete el perfil o revise el webhook de la suscripción.":"The organization has not been provisioned. Complete the profile or inspect the subscription webhook."}</p>}
    {account?.can_manage&&<div className="mt-5 grid gap-3 md:grid-cols-2"><label className="text-xs font-medium text-muted-foreground">{es?"Nombre":"Name"}<input value={invite.name} onChange={e=>setInvite({...invite,name:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"/></label><label className="text-xs font-medium text-muted-foreground">Email<input type="email" value={invite.email} onChange={e=>setInvite({...invite,email:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"/></label><label className="text-xs font-medium text-muted-foreground">{es?"Título / puesto":"Title"}<input value={invite.title} onChange={e=>setInvite({...invite,title:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"/></label><label className="text-xs font-medium text-muted-foreground">{es?"Función":"Role"}<select value={invite.role} onChange={e=>setInvite({...invite,role:e.target.value})} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">{TEAM_ROLES.map(role=><option key={role} value={role}>{teamRoleLabel(role,es)}</option>)}</select></label><button type="button" disabled={inviteMutation.isPending||!invite.name||!invite.email||!invite.title} onClick={()=>inviteMutation.mutate()} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50 md:col-span-2"><UserPlus className="mr-2 inline h-4 w-4"/>{es?"Invitar miembro del equipo":"Invite team member"}</button></div>}
    {link&&<div className="mt-4 rounded-lg border border-success/30 bg-success/10 p-3 text-xs"><p className="font-semibold">{es?"Enlace seguro de invitación":"Secure invitation link"}</p><div className="mt-2 flex gap-2"><input readOnly value={link} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"/><button type="button" onClick={()=>void navigator.clipboard.writeText(link)} className="rounded border border-border px-3">{es?"Copiar":"Copy"}</button></div></div>}
    {!!account?.members?.length&&<div className="mt-5 overflow-x-auto rounded-lg border border-border"><table className="w-full text-sm"><thead><tr className="bg-muted/50 text-left"><th className="px-3 py-2">{es?"Nombre":"Name"}</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">{es?"Título":"Title"}</th><th className="px-3 py-2">{es?"Función":"Role"}</th><th className="px-3 py-2">{es?"Casos":"Cases"}</th><th className="px-3 py-2"></th></tr></thead><tbody>{account.members.map((m:any)=><tr key={m.id} className="border-t border-border"><td className="px-3 py-2 font-medium">{m.name}</td><td className="px-3 py-2">{m.email??"—"}</td><td className="px-3 py-2">{m.title??"—"}</td><td className="px-3 py-2">{account.can_manage&&m.role!=="owner"?<select value={TEAM_ROLES.includes(m.role)?m.role:"read_only"} onChange={e=>updateMutation.mutate({userId:m.user_id,role:e.target.value,status:m.status==="suspended"?"suspended":"active"})} className="rounded border border-border bg-background px-2 py-1">{TEAM_ROLES.map(role=><option key={role} value={role}>{teamRoleLabel(role,es)}</option>)}</select>:teamRoleLabel(m.role,es)}</td><td className="px-3 py-2">{m.assigned_cases??0}</td><td className="px-3 py-2"><div className="flex items-center justify-end gap-3">{account.can_manage&&m.role!=="owner"&&<><button type="button" disabled={updateMutation.isPending} onClick={()=>updateMutation.mutate({userId:m.user_id,role:TEAM_ROLES.includes(m.role)?m.role:"read_only",status:m.status==="suspended"?"active":"suspended"})} className="text-xs text-primary underline disabled:opacity-50">{m.status==="suspended"?(es?"Reactivar":"Reactivate"):(es?"Suspender":"Suspend")}</button><button type="button" disabled={updateMutation.isPending||Number(m.assigned_cases??0)>0} title={Number(m.assigned_cases??0)>0?(es?"Reasigne primero los casos activos":"Reassign active cases first"):undefined} onClick={()=>{const confirmed=window.confirm(es?`¿Eliminar a ${m.name} del equipo? Perderá inmediatamente el acceso a la organización.`:`Remove ${m.name} from the team? They will immediately lose organization access.`);if(confirmed)updateMutation.mutate({userId:m.user_id,role:TEAM_ROLES.includes(m.role)?m.role:"read_only",status:"removed"});}} className="text-xs text-destructive underline disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="mr-1 inline h-3 w-3"/>{es?"Eliminar":"Remove"}</button></>}</div>{account.can_manage&&m.role!=="owner"&&Number(m.assigned_cases??0)>0&&<p className="mt-1 text-right text-[10px] text-muted-foreground">{es?"Reasigne los casos antes de eliminar":"Reassign cases before removal"}</p>}</td></tr>)}</tbody></table></div>}
  </section>;
}

// ============================================================ Profile

function ProfileCard({ acc, onSaved }: { acc: { profile: { full_name?: string | null; avatar_url?: string | null } | null; settings: Record<string, unknown> | null }; onSaved: () => void }) {
  const { t, locale } = useI18n();
  const es = locale === "es";
  const qc = useQueryClient();
  const update = useServerFn(updateProfile);
  const s = (acc.settings ?? {}) as Record<string, string | null>;
  const [form, setForm] = useState({
    full_name: acc.profile?.full_name ?? "",
    display_name: s.display_name ?? "",
    phone: s.phone ?? "",
    firm_name: s.firm_name ?? "",
    title: s.title ?? "",
    avatar_url: s.avatar_url ?? acc.profile?.avatar_url ?? "",
  });
  const m = useMutation({
    mutationFn: () => update({ data: form }),
    onSuccess: (result: { organizationCreated?: boolean }) => { toast.success(result.organizationCreated ? (es ? "Despacho y organización creados. Atención Integral está habilitada." : "Firm and organization created. Comprehensive Care is enabled.") : t("acct.profile.saved")); void qc.invalidateQueries({ queryKey: ["social-workspace"] }); void qc.invalidateQueries({ queryKey: ["memberships"] }); onSaved(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t("acct.saveFailed")),
  });
  return (
    <Card icon={<User className="h-4 w-4" />} title={t("acct.profile")}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("acct.profile.fullName")}    value={form.full_name}    onChange={(v) => setForm({ ...form, full_name: v })} />
        <Field label={t("acct.profile.displayName")} value={form.display_name} onChange={(v) => setForm({ ...form, display_name: v })} />
        <Field label={t("acct.profile.phone")}       value={form.phone}        onChange={(v) => setForm({ ...form, phone: v })} />
        <div><Field label={es ? "Despacho / organización" : "Firm / law firm / organization"} value={form.firm_name} onChange={(v) => setForm({ ...form, firm_name: v })} /><p className="mt-1 text-[11px] text-muted-foreground">{es ? "Al guardar su primer despacho se crea su organización y se habilita Atención Integral." : "Saving your first firm creates your organization and enables Comprehensive Care."}</p></div>
        <Field label={t("acct.profile.title")}       value={form.title}        onChange={(v) => setForm({ ...form, title: v })} />
        <Field label={t("acct.profile.avatar")}      value={form.avatar_url}   onChange={(v) => setForm({ ...form, avatar_url: v })} />
      </div>
      <SaveButton pending={m.isPending} onClick={() => m.mutate()} />
    </Card>
  );
}

// ============================================================ Security

function SecurityCard({ email }: { email: string }) {
  const { t } = useI18n();
  const setEmailFn = useServerFn(changeEmail);
  const setPwdFn = useServerFn(changePassword);
  const [newEmail, setNewEmail] = useState(email);
  const [newPwd, setNewPwd] = useState("");
  const emailM = useMutation({
    mutationFn: () => setEmailFn({ data: { newEmail } }),
    onSuccess: (r: { message?: string }) => toast.success(r.message ?? t("acct.security.emailRequested")),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t("acct.security.emailFailed")),
  });
  const pwdM = useMutation({
    mutationFn: () => setPwdFn({ data: { newPassword: newPwd } }),
    onSuccess: () => { toast.success(t("acct.security.pwdChanged")); setNewPwd(""); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t("acct.security.pwdFailed")),
  });
  return (
    <Card icon={<Lock className="h-4 w-4" />} title={t("acct.security")}>
      <div className="space-y-4">
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground/80"><Mail className="h-3 w-3" /> {t("acct.security.email")}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
              className="flex-1 rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground" />
            <button onClick={() => emailM.mutate()} disabled={emailM.isPending || !newEmail || newEmail === email}
              className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50">
              {emailM.isPending ? t("acct.security.sending") : t("acct.security.updateEmail")}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground/70">{t("acct.security.emailHint")}</p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-foreground/80">{t("acct.security.newPassword")}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder={t("acct.security.pwdPlaceholder")}
              className="flex-1 rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground" />
            <button onClick={() => pwdM.mutate()} disabled={pwdM.isPending || newPwd.length < 8}
              className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50">
              {pwdM.isPending ? t("acct.security.saving") : t("acct.security.changePassword")}
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ============================================================ Voice

function VoiceCard({ settings, onSaved }: { settings: Record<string, unknown> | null; onSaved: () => void }) {
  const { t } = useI18n();
  const update = useServerFn(updateVoicePrefs);
  const s = (settings ?? {}) as {
    voice_id?: string; voice_speed?: number; voice_muted?: boolean; voice_autoplay?: boolean;
    voice_continuous?: boolean; voice_pitch?: string; voice_accent?: string; voice_gender?: string;
  };
  const [voiceId, setVoiceId] = useState(s.voice_id ?? "alloy");
  const [speed, setSpeed]     = useState(Number(s.voice_speed ?? 1));
  const [muted, setMuted]     = useState(!!s.voice_muted);
  const [autoplay, setAuto]   = useState(s.voice_autoplay !== false);
  const [continuous, setCont] = useState(!!s.voice_continuous);
  const [pitch, setPitch]     = useState<"low" | "medium" | "high">((s.voice_pitch as "low" | "medium" | "high") ?? "medium");
  const [accent, setAccent]   = useState(s.voice_accent ?? "us");
  const [genderFilter, setGenderFilter] = useState<"all" | "F" | "M">((s.voice_gender === "male" ? "M" : s.voice_gender === "female" ? "F" : "all"));
  const [previewing, setPreview] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () => update({ data: {
      voice_id: voiceId, voice_speed: speed, voice_muted: muted, voice_autoplay: autoplay,
      voice_continuous: continuous, voice_pitch: pitch,
      voice_accent: accent as "us" | "uk" | "au" | "ca" | "es-mx" | "es-es" | "neutral",
      voice_gender: genderFilter === "M" ? "male" : genderFilter === "F" ? "female" : undefined,
    } }),
    onSuccess: () => { toast.success(t("acct.voice.saved")); onSaved(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t("acct.saveFailed")),
  });

  function instructionsFor(): string {
    const accentLabel = t(`acct.accent.${accent}`);
    const pitchPhrase = pitch === "low" ? "with a lower pitch" : pitch === "high" ? "with a higher pitch" : "with a natural pitch";
    return `Speak in ${accentLabel} ${pitchPhrase}, warm, clear, and professional.`;
  }

  async function previewVoice(id: string) {
    setPreview(id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const authToken = sessionData.session?.access_token;
      if (!authToken) throw new Error(t("acct.voice.signInRequired"));
      const res = await fetch("/api/voice/speak", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          text: t("acct.voice.previewText"),
          voice: id, speed, instructions: instructionsFor(),
        }),
      });
      if (!res.ok) throw new Error(await res.text().catch(() => t("acct.voice.previewFailed")));
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); await a.play();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("acct.voice.previewFailed"));
    } finally {
      setPreview(null);
    }
  }

  const filteredVoices = VOICES.filter((v) => genderFilter === "all" || v.gender === genderFilter);

  return (
    <Card icon={<Mic className="h-4 w-4" />} title={t("acct.voice")}>
      <p className="mb-3 text-xs text-muted-foreground">{t("acct.voice.intro")}</p>

      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select label={t("acct.voice.gender")} value={genderFilter} onChange={(v) => setGenderFilter(v as typeof genderFilter)}
          options={[
            { value: "all", label: t("acct.voice.gender.all") },
            { value: "F",   label: t("acct.voice.gender.female") },
            { value: "M",   label: t("acct.voice.gender.male") },
          ]} />
        <Select label={t("acct.voice.accent")} value={accent} onChange={setAccent}
          options={ACCENT_IDS.map((a) => ({ value: a as string, label: t(`acct.accent.${a}`) }))} />
        <Select label={t("acct.voice.pitch")} value={pitch} onChange={(v) => setPitch(v as typeof pitch)}
          options={[
            { value: "low",    label: t("acct.voice.pitch.low") },
            { value: "medium", label: t("acct.voice.pitch.medium") },
            { value: "high",   label: t("acct.voice.pitch.high") },
          ]} />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {filteredVoices.map((v) => (
          <label key={v.id}
            className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg border p-3 transition ${
              voiceId === v.id ? "border-primary/60 bg-primary/10" : "border-border bg-input hover:border-border/80"
            }`}>
            <div className="flex items-center gap-2">
              <input type="radio" name="voice" checked={voiceId === v.id} onChange={() => setVoiceId(v.id)} className="accent-primary" />
              <div>
                <div className="text-sm font-medium text-foreground">{v.label} <span className="ml-1 text-[10px] text-muted-foreground">({v.gender === "F" ? t("acct.voice.female") : t("acct.voice.male")})</span></div>
                <div className="text-[11px] text-muted-foreground">{v.accent}</div>
              </div>
            </div>
            <button onClick={(e) => { e.preventDefault(); previewVoice(v.id); }} disabled={previewing === v.id}
              className="flex items-center gap-1 rounded-md border border-border/80 px-2 py-1 text-[11px] text-foreground/90 hover:bg-secondary disabled:opacity-50">
              {previewing === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3 w-3" />} {t("acct.voice.preview")}
            </button>
          </label>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-foreground/80">{t("acct.voice.speed", { speed: speed.toFixed(2) })}</label>
          <input type="range" min={0.5} max={1.5} step={0.05} value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            className="mt-1 w-full accent-primary" />
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/70"><span>{t("acct.voice.slow")}</span><span>{t("acct.voice.normal")}</span><span>{t("acct.voice.fast")}</span></div>
        </div>
        <div className="space-y-2">
          <Toggle label={t("acct.voice.autoplay")}   checked={autoplay}   onChange={setAuto} />
          <Toggle label={t("acct.voice.continuous")} checked={continuous} onChange={setCont} />
          <Toggle label={t("acct.voice.mute")}       checked={muted}      onChange={setMuted} icon={<Volume2 className="h-3 w-3" />} />
        </div>
      </div>
      <SaveButton pending={m.isPending} onClick={() => m.mutate()} />
    </Card>
  );
}

// ============================================================ Notifications

function NotificationCard({ settings, onSaved }: { settings: Record<string, unknown> | null; onSaved: () => void }) {
  const { t } = useI18n();
  const update = useServerFn(updateNotificationPrefs);
  const s = (settings ?? {}) as Record<string, boolean | undefined>;
  const [form, setForm] = useState({
    notify_email: s.notify_email !== false,
    notify_pipeline_complete: s.notify_pipeline_complete !== false,
    notify_pipeline_failed: s.notify_pipeline_failed !== false,
    notify_new_evidence: !!s.notify_new_evidence,
  });
  const m = useMutation({
    mutationFn: () => update({ data: form }),
    onSuccess: () => { toast.success(t("acct.notif.saved")); onSaved(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t("acct.saveFailed")),
  });
  return (
    <Card icon={<Bell className="h-4 w-4" />} title={t("acct.notif")}>
      <div className="space-y-2">
        <Toggle label={t("acct.notif.email")}       checked={form.notify_email}             onChange={(v) => setForm({ ...form, notify_email: v })} />
        <Toggle label={t("acct.notif.complete")}    checked={form.notify_pipeline_complete} onChange={(v) => setForm({ ...form, notify_pipeline_complete: v })} />
        <Toggle label={t("acct.notif.failed")}      checked={form.notify_pipeline_failed}   onChange={(v) => setForm({ ...form, notify_pipeline_failed: v })} />
        <Toggle label={t("acct.notif.newEvidence")} checked={form.notify_new_evidence}      onChange={(v) => setForm({ ...form, notify_new_evidence: v })} />
      </div>
      <SaveButton pending={m.isPending} onClick={() => m.mutate()} />
    </Card>
  );
}

// ============================================================ AI Companion

function AICompanionCard({ settings, onSaved }: { settings: Record<string, unknown> | null; onSaved: () => void }) {
  const { t } = useI18n();
  const update = useServerFn(updateAIPrefs);
  const s = (settings ?? {}) as { ai_default_mode?: string; ai_response_style?: string; ai_max_response_chars?: number };
  const [mode, setMode] = useState((s.ai_default_mode as "evidence_grounded" | "exploratory" | "strategic") ?? "evidence_grounded");
  const [style, setStyle] = useState((s.ai_response_style as "professional" | "conversational" | "concise") ?? "professional");
  const [maxChars, setMaxChars] = useState(Number(s.ai_max_response_chars ?? 1500));
  const m = useMutation({
    mutationFn: () => update({ data: { ai_default_mode: mode, ai_response_style: style, ai_max_response_chars: maxChars } }),
    onSuccess: () => { toast.success(t("acct.ai.saved")); onSaved(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t("acct.saveFailed")),
  });
  return (
    <Card icon={<Bot className="h-4 w-4" />} title={t("acct.ai")}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select label={t("acct.ai.mode")} value={mode} onChange={(v) => setMode(v as typeof mode)}
          options={[
            { value: "evidence_grounded", label: t("acct.ai.mode.evidence") },
            { value: "exploratory",       label: t("acct.ai.mode.exploratory") },
            { value: "strategic",         label: t("acct.ai.mode.strategic") },
          ]} />
        <Select label={t("acct.ai.style")} value={style} onChange={(v) => setStyle(v as typeof style)}
          options={[
            { value: "professional",   label: t("acct.ai.style.professional") },
            { value: "conversational", label: t("acct.ai.style.conversational") },
            { value: "concise",        label: t("acct.ai.style.concise") },
          ]} />
        <div>
          <label className="block text-xs font-medium text-foreground/80">{t("acct.ai.maxChars", { n: maxChars })}</label>
          <input type="range" min={200} max={4000} step={100} value={maxChars}
            onChange={(e) => setMaxChars(parseInt(e.target.value))}
            className="mt-1 w-full accent-primary" />
        </div>
      </div>
      <SaveButton pending={m.isPending} onClick={() => m.mutate()} />
    </Card>
  );
}

// ============================================================ Activity

function ActivityCard({ data, loading }: {
  data: { cases: Array<{ id: string; name: string; status: string; created_at: string }>;
          runs: Array<{ id: string; engine: string; status: string; started_at: string | null; case_id: string }>;
          chats: Array<{ id: string; role: string; created_at: string; case_id: string }>; } | undefined;
  loading: boolean;
}) {
  const { t } = useI18n();
  return (
    <Card icon={<History className="h-4 w-4" />} title={t("acct.activity")}>
      {loading
        ? <p className="text-xs text-muted-foreground">{t("acct.activity.loading")}</p>
        : !data
          ? <p className="text-xs text-muted-foreground">{t("acct.activity.none")}</p>
          : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ActivityCol title={t("acct.activity.cases")}>
                {data.cases.length === 0 ? <Empty/> : data.cases.map((c) => (
                  <li key={c.id} className="truncate text-xs"><span className="text-foreground">{c.name}</span> <span className="text-muted-foreground/70">· {c.status}</span></li>
                ))}
              </ActivityCol>
              <ActivityCol title={t("acct.activity.runs")}>
                {data.runs.length === 0 ? <Empty/> : data.runs.map((r) => (
                  <li key={r.id} className="truncate text-xs"><span className="font-mono text-foreground/90">{r.engine}</span> <span className="text-muted-foreground/70">· {r.status}</span></li>
                ))}
              </ActivityCol>
              <ActivityCol title={t("acct.activity.chats")}>
                {data.chats.length === 0 ? <Empty/> : data.chats.map((c) => (
                  <li key={c.id} className="truncate text-xs"><span className="text-foreground/80">{c.role}</span> <span className="text-muted-foreground/70">· {new Date(c.created_at).toLocaleString()}</span></li>
                ))}
              </ActivityCol>
            </div>
          )}
    </Card>
  );
}
function ActivityCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-3">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}
function Empty() {
  const { t } = useI18n();
  return <li className="text-xs text-muted-foreground/70">{t("acct.activity.empty")}</li>;
}

// ============================================================ Primitives

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-background/60 p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-foreground">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-foreground/80">{label}</span>
      <input type="text" value={value ?? ""} onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60" />
    </label>
  );
}
function Toggle({ label, checked, onChange, icon }: { label: string; checked: boolean; onChange: (v: boolean) => void; icon?: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-md border border-border bg-card/60 px-3 py-2 text-sm text-foreground/90">
      <span className="flex items-center gap-2">{icon}{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-primary" />
    </label>
  );
}
function Select<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-foreground/80">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}
        className="mt-1 w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
function SaveButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mt-4 flex justify-end">
      <button onClick={onClick} disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/15 px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/25 disabled:opacity-50">
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        {t("acct.save")}
      </button>
    </div>
  );
}
