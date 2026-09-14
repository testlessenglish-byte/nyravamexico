// Admin → Team & Seats. Firm-scoped (unlike /admin/users, which is the
// global platform-operator view). Firm Admins invite teammates by email up
// to their plan's seat limit; invited people just sign up normally and land
// in this firm with the assigned role — see team.functions.ts and
// supabase/migrations/20260723060000_firm_seats_and_invites.sql.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getFirmSeatSummary,
  listFirmMembers,
  listFirmInvites,
  inviteFirmMember,
  revokeFirmInvite,
  listFirmsWithSeats,
  adminSetFirmSeatLimit,
} from "@/lib/team.functions";
import { setUserRole, checkIsAdmin } from "@/lib/cases.functions";
import { supabase } from "@/integrations/supabase/client";
import {
  ShieldCheck,
  ChevronLeft,
  Loader2,
  Building2,
  Briefcase,
  User as UserIcon,
  Mail,
  X,
  Crown,
  Save,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/team")({
  head: () => ({ meta: [{ title: "Team & Seats — Nyrava" }] }),
  component: TeamPage,
});

type RoleKey = "firm_admin" | "case_manager" | "user";
const ROLES: { key: RoleKey; label: string; icon: typeof Building2; desc: string }[] = [
  {
    key: "firm_admin",
    label: "Firm Admin",
    icon: Building2,
    desc: "Firm-level access and configuration",
  },
  { key: "case_manager", label: "Case Manager", icon: Briefcase, desc: "Create and manage cases" },
  { key: "user", label: "Standard User", icon: UserIcon, desc: "Default access" },
];

function TeamPage() {
  const fetchAdmin = useServerFn(checkIsAdmin);
  const fetchSeats = useServerFn(getFirmSeatSummary);
  const fetchMembers = useServerFn(listFirmMembers);
  const fetchInvites = useServerFn(listFirmInvites);
  const inviteFn = useServerFn(inviteFirmMember);
  const revokeFn = useServerFn(revokeFirmInvite);
  const setRoleFn = useServerFn(setUserRole);
  const fetchAllFirms = useServerFn(listFirmsWithSeats);
  const setFirmSeatFn = useServerFn(adminSetFirmSeatLimit);
  const qc = useQueryClient();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleKey>("user");

  const { data: gate } = useQuery({ queryKey: ["isAdmin"], queryFn: () => fetchAdmin() });
  const canManage = Boolean(gate?.isFirmAdmin || gate?.isSuperAdmin || gate?.isAdmin);

  const { data: currentUserId } = useQuery({
    queryKey: ["authUserId"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
  });

  const seatsQ = useQuery({
    queryKey: ["firmSeatSummary"],
    queryFn: () => fetchSeats(),
    enabled: canManage,
  });
  const membersQ = useQuery({
    queryKey: ["firmMembers"],
    queryFn: () => fetchMembers(),
    enabled: canManage,
  });
  const invitesQ = useQuery({
    queryKey: ["firmInvites"],
    queryFn: () => fetchInvites(),
    enabled: canManage,
  });

  const invite = useMutation({
    mutationFn: (vars: { email: string; role: RoleKey }) => inviteFn({ data: vars }),
    onSuccess: () => {
      toast.success(
        "Invite sent — they'll join your firm the moment they sign up with that email.",
      );
      setEmail("");
      setRole("user");
      qc.invalidateQueries({ queryKey: ["firmInvites"] });
      qc.invalidateQueries({ queryKey: ["firmSeatSummary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: (vars: { inviteId: string }) => revokeFn({ data: vars }),
    onSuccess: () => {
      toast.success("Invite revoked");
      qc.invalidateQueries({ queryKey: ["firmInvites"] });
      qc.invalidateQueries({ queryKey: ["firmSeatSummary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleRole = useMutation({
    mutationFn: (vars: { targetUserId: string; role: RoleKey; grant: boolean }) =>
      setRoleFn({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firmMembers"] });
      toast.success("Role updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!canManage) {
    return (
      <div className="mx-auto max-w-2xl p-10">
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-6">
          <h2 className="text-lg font-semibold text-destructive">Firm Admin required</h2>
          <p className="mt-2 text-sm">Only Firm Admins and above can manage your team's seats.</p>
        </div>
      </div>
    );
  }

  const seats = seatsQ.data;
  const atLimit = seats ? seats.seatsAvailable <= 0 : false;

  function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    invite.mutate({ email: email.trim(), role });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-10">
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Link
          to="/admin"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> Admin
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-2xl font-semibold">Team & Seats</h1>
      </div>

      {/* Seat usage */}
      <div className="mb-6 rounded-xl border border-border bg-card p-5">
        {seatsQ.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading seat usage…</div>
        ) : seats ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium capitalize">
                  {seats.planKey ?? "Solo"} plan · {seats.seatsUsed} of {seats.seatLimit} seats used
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Seats include active members plus outstanding pending invites.
                </div>
              </div>
              {atLimit && (
                <Link
                  to="/billing"
                  className="rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20"
                >
                  Upgrade plan →
                </Link>
              )}
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${atLimit ? "bg-destructive" : "bg-primary"}`}
                style={{
                  width: `${Math.min(100, (seats.seatsUsed / Math.max(1, seats.seatLimit)) * 100)}%`,
                }}
              />
            </div>
          </>
        ) : (
          <div className="text-sm text-muted-foreground">No firm attached to your account yet.</div>
        )}
      </div>

      {/* Invite form */}
      <div className="mb-8 rounded-xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Mail className="h-4 w-4 text-accent" /> Invite a teammate
        </div>
        <form onSubmit={submitInvite} className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@yourfirm.com"
            className="min-w-[220px] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as RoleKey)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {ROLES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={invite.isPending || atLimit}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            title={atLimit ? "Seat limit reached — upgrade to invite more" : undefined}
          >
            {invite.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send invite"}
          </button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">
          They'll create their own account — no password to set up for them. The moment they sign up
          with this email, they land in your firm with the role you picked.
        </p>
      </div>

      {/* Pending invites */}
      {invitesQ.data && invitesQ.data.length > 0 && (
        <div className="mb-8 rounded-xl border border-border bg-card p-5">
          <div className="mb-3 text-sm font-semibold">Pending invites</div>
          <ul className="divide-y divide-border">
            {invitesQ.data.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <div className="text-sm">{inv.email}</div>
                  <div className="text-xs capitalize text-muted-foreground">
                    {inv.role.replace("_", " ")}
                  </div>
                </div>
                <button
                  onClick={() => revoke.mutate({ inviteId: inv.id })}
                  disabled={revoke.isPending}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-destructive/40 hover:text-destructive"
                >
                  <X className="h-3 w-3" /> Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Members + roles */}
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4 text-accent" /> Firm members
      </div>
      {membersQ.isLoading ? (
        <div className="p-10 text-muted-foreground">Loading members…</div>
      ) : membersQ.error ? (
        <div className="p-6 text-destructive">{(membersQ.error as Error).message}</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">User</th>
                {ROLES.map((r) => (
                  <th key={r.key} className="px-3 py-2 text-center">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(membersQ.data ?? []).map((u) => (
                <tr key={u.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium">{u.full_name || "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {u.email}{" "}
                      {u.id === currentUserId && <span className="text-primary">(you)</span>}
                    </div>
                  </td>
                  {ROLES.map((r) => {
                    const has = u.roles.includes(r.key);
                    const pending =
                      toggleRole.isPending &&
                      toggleRole.variables?.targetUserId === u.id &&
                      toggleRole.variables?.role === r.key;
                    return (
                      <td key={r.key} className="px-3 py-2 text-center">
                        <button
                          disabled={pending}
                          onClick={() =>
                            toggleRole.mutate({ targetUserId: u.id, role: r.key, grant: !has })
                          }
                          className={`inline-flex h-7 min-w-[3.25rem] items-center justify-center rounded-full border px-3 text-xs font-medium transition ${
                            has
                              ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                              : "border-border bg-background text-muted-foreground hover:border-accent/40"
                          }`}
                          title={has ? `Remove ${r.label}` : `Grant ${r.label}`}
                        >
                          {pending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : has ? (
                            "Yes"
                          ) : (
                            "No"
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {(membersQ.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={ROLES.length + 1} className="p-6 text-center text-muted-foreground">
                    No firm members yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {gate?.isSuperAdmin && (
        <SuperAdminSeatOverride
          fetchAllFirms={fetchAllFirms}
          setFirmSeatFn={setFirmSeatFn}
          qc={qc}
        />
      )}
    </div>
  );
}

function SuperAdminSeatOverride({
  fetchAllFirms,
  setFirmSeatFn,
  qc,
}: {
  fetchAllFirms: () => Promise<
    Array<{
      firm_id: string;
      name: string;
      domain: string | null;
      plan_key: string | null;
      seat_limit: number;
      seats_used: number;
    }>
  >;
  setFirmSeatFn: (args: { data: { firmId: string; seatLimit: number } }) => Promise<unknown>;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const firmsQ = useQuery({ queryKey: ["allFirmsWithSeats"], queryFn: () => fetchAllFirms() });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (vars: { firmId: string; seatLimit: number }) => setFirmSeatFn({ data: vars }),
    onSuccess: (_r, vars) => {
      toast.success("Seat limit updated");
      setDrafts((d) => {
        const next = { ...d };
        delete next[vars.firmId];
        return next;
      });
      qc.invalidateQueries({ queryKey: ["allFirmsWithSeats"] });
      qc.invalidateQueries({ queryKey: ["firmSeatSummary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mt-10 rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Crown className="h-4 w-4 text-amber-500" /> Super Admin · Manual seat overrides
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Every firm defaults to 1 seat (Solo) until you set them here. Use this to grant Firm (10)
        or Enterprise (50+) seat pools per contract. Stripe webhooks will overwrite these for
        firms that subscribe online.

      </p>
      {firmsQ.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading firms…</div>
      ) : firmsQ.error ? (
        <div className="text-sm text-destructive">{(firmsQ.error as Error).message}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Firm</th>
                <th className="px-3 py-2 text-left">Plan</th>
                <th className="px-3 py-2 text-center">Used</th>
                <th className="px-3 py-2 text-left">Seat limit</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(firmsQ.data ?? []).map((f) => {
                const draft = drafts[f.firm_id];
                const value = draft ?? String(f.seat_limit);
                const parsed = Number.parseInt(value, 10);
                const dirty =
                  draft !== undefined &&
                  parsed !== f.seat_limit &&
                  Number.isInteger(parsed) &&
                  parsed >= 1;
                const pending = save.isPending && save.variables?.firmId === f.firm_id;
                return (
                  <tr key={f.firm_id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="font-medium">{f.name}</div>
                      {f.domain && <div className="text-xs text-muted-foreground">{f.domain}</div>}
                    </td>
                    <td className="px-3 py-2 capitalize">{f.plan_key ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{f.seats_used}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          value={value}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [f.firm_id]: e.target.value }))
                          }
                          className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm"
                        />
                        <div className="flex gap-1 text-[10px]">
                          {[1, 10, 50].map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setDrafts((d) => ({ ...d, [f.firm_id]: String(n) }))}
                              className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:border-primary/40 hover:text-primary"
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        disabled={!dirty || pending}
                        onClick={() => save.mutate({ firmId: f.firm_id, seatLimit: parsed })}
                        className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                      >
                        {pending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Save className="h-3 w-3" />
                        )}
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
              {(firmsQ.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">
                    No firms yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
