import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useMemo } from "react";
import { ChevronLeft, Search, Filter } from "lucide-react";
import { adminStats } from "@/lib/cases.functions";

export const Route = createFileRoute("/_authenticated/admin/subscriptions")({
  head: () => ({ meta: [{ title: "Subscriptions — Admin" }] }),
  component: AdminSubscriptionsPage,
});

function AdminSubscriptionsPage() {
  const fetchAdminStats = useServerFn(adminStats);
  const { data, isLoading } = useQuery({
    queryKey: ["adminStats"],
    queryFn: () => fetchAdminStats(),
  });

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.subscriptions.filter((sub) => {
      const u = data.users.find((u) => u.id === sub.user_id);
      
      const searchLower = search.toLowerCase();
      const matchesSearch = 
        !search || 
        u?.full_name?.toLowerCase().includes(searchLower) ||
        u?.email?.toLowerCase().includes(searchLower) ||
        sub.stripe_customer_id?.toLowerCase().includes(searchLower);
        
      const matchesStatus = statusFilter === "all" || sub.status === statusFilter;
      const matchesPlan = planFilter === "all" || sub.plan === planFilter;

      return matchesSearch && matchesStatus && matchesPlan;
    }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [data, search, statusFilter, planFilter]);

  if (isLoading) return <div className="p-10 text-muted-foreground">Loading…</div>;
  if (!data) return null;

  const uniquePlans = Array.from(new Set(data.subscriptions.map(s => s.plan).filter(Boolean)));

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-10">
      <div className="flex items-center gap-2">
        <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ChevronLeft className="h-4 w-4" /> Back to Admin
        </Link>
      </div>

      <div className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold">Subscribers</h1>
        <p className="text-sm text-muted-foreground">View and filter all customer subscriptions.</p>
      </div>

      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="text" placeholder="Search by name, email..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-4 text-sm" />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-md border border-border bg-background py-2 px-3 text-sm">
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="trialing">Trialing</option>
            <option value="past_due">Past Due</option>
            <option value="canceled">Canceled</option>
          </select>
          <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value)} className="rounded-md border border-border bg-background py-2 px-3 text-sm">
            <option value="all">All Plans</option>
            {uniquePlans.map(p => <option key={String(p)} value={String(p)}>{String(p)}</option>)}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 text-left font-medium">Customer</th>
              <th className="px-4 py-3 text-left font-medium">Plan</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Stripe ID</th>
              <th className="px-4 py-3 text-left font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((sub) => {
              const u = data.users.find((u) => u.id === sub.user_id);
              return (
                <tr key={sub.user_id} className="border-t border-border hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{u ? <><div className="truncate text-foreground">{u.full_name}</div><div className="text-xs text-muted-foreground">{u.email}</div></> : <span className="text-muted-foreground">Unknown user</span>}</td>
                  <td className="px-4 py-3">{sub.plan || "—"}</td>
                  <td className="px-4 py-3"><span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${sub.status === "active" ? "border border-success/40 bg-success/10 text-success" : sub.status === "trialing" ? "border border-accent/40 bg-accent/10 text-accent" : sub.status === "past_due" ? "border border-warning/40 bg-warning/10 text-warning" : "border border-destructive/40 bg-destructive/10 text-destructive"}`}>{sub.status}</span></td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{sub.stripe_customer_id || "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{new Date(sub.created_at).toLocaleDateString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
