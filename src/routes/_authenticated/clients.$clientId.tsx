import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  getClient,
  deleteClientFn,
  updateClientFn,
  archiveClient,
} from "@/lib/clients.functions";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  User, Building2, Mail, Phone, MapPin, FileText,
  Briefcase, Edit, Archive, ChevronLeft, Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeadlineList } from "@/components/crm/DeadlineList";
import { toast } from "sonner";
import { useI18n } from "@/i18n";

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
  head: () => ({ meta: [{ title: "Detalle de Cliente — Nyrava" }] }),
  component: ClientDetailPage,
});

// Case numbers live in matter_metadata; `cases` has no case_number column.
function caseNumberOf(c: { matter_metadata?: Record<string, any> | null }): string {
  const m = c.matter_metadata ?? {};
  const raw =
    m["case_number"] ??
    m["expediente"] ??
    m["case_identity"]?.["case_number"] ??
    m["case_identity"]?.["expediente"];
  return typeof raw === "string" ? raw : "";
}

function ClientDetailPage() {
  const { locale, t } = useI18n();
  const { clientId } = Route.useParams();
  const fetchClient = useServerFn(getClient);
  const deleteClient = useServerFn(deleteClientFn);
  const updateClient = useServerFn(updateClientFn);
  const archiveClientFn = useServerFn(archiveClient);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const handleDelete = async () => {
    if (!window.confirm(t("clientDetail.delete.confirm"))) return;
    try {
      await deleteClient({ data: { clientId } });
      toast.success(t("clientDetail.delete.success"));
      navigate({ to: "/clients" });
    } catch (error: any) {
      toast.error(error.message || t("clientDetail.delete.error"));
    }
  };

  const { data: clientData, isLoading } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => fetchClient({ data: { clientId } }),
  });

  const refreshClient = async () => {
    await queryClient.invalidateQueries({ queryKey: ["client", clientId] });
    await queryClient.invalidateQueries({ queryKey: ["clients"] });
  };

  const openEdit = (c: Record<string, any>) => {
    setForm({
      display_name: c.display_name ?? "",
      client_type: c.client_type ?? "individual",
      legal_name: c.legal_name ?? "",
      rfc: c.rfc ?? "",
      email: c.email ?? "",
      phone: c.phone ?? "",
      address: c.address ?? "",
      reference_number: c.reference_number ?? "",
      notes: c.notes ?? "",
    });
    setEditOpen(true);
  };

  const handleSave = async () => {
    if (!form["display_name"]?.trim()) {
      toast.error(t("clientDetail.validation.nameRequired"));
      return;
    }
    const email = (form["email"] ?? "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      toast.error(t("clientDetail.validation.emailInvalid"));
      return;
    }
    setSaving(true);
    try {
      await updateClient({
        data: {
          clientId,
          display_name: form["display_name"].trim(),
          client_type: form["client_type"] || "individual",
          legal_name: form["legal_name"] || undefined,
          rfc: form["rfc"] || undefined,
          email: form["email"] || "",
          phone: form["phone"] || undefined,
          address: form["address"] || undefined,
          reference_number: form["reference_number"] || undefined,
          notes: form["notes"] || undefined,
        },
      });
      await refreshClient();
      setEditOpen(false);
      toast.success(t("clientDetail.update.success"));
    } catch (error: any) {
      toast.error(error?.message || t("clientDetail.update.error"));
    } finally {
      setSaving(false);
    }
  };

  const handleArchiveToggle = async (currentStatus: string) => {
    try {
      if (currentStatus === "archived") {
        await updateClient({ data: { clientId, status: "active" } });
        toast.success(t("clientDetail.reactivate.success"));
      } else {
        await archiveClientFn({ data: { clientId } });
        toast.success(t("clientDetail.archive.success"));
      }
      await refreshClient();
    } catch (error: any) {
      toast.error(error?.message || t("clientDetail.status.error"));
    }
  };

  if (isLoading) {
    return <div className="p-8 text-center text-sm text-muted-foreground">{t("clientDetail.loading")}</div>;
  }

  if (!clientData) {
    return <div className="p-8 text-center text-sm text-destructive">{t("clientDetail.notFound")}</div>;
  }

  // getClient returns a flat object with client fields + cases + upcoming_deadlines
  const client = clientData as Record<string, any>;
  const cases = (client.cases ?? []) as Array<{
    id: string;
    name: string | null;
    status: string;
    lifecycle_status: string | null;
    case_type: string | null;
    underlying_materia: string | null;
    procedural_vehicle: string | null;
    jurisdiction: string | null;
    matter_metadata: Record<string, any> | null;
    created_at: string;
    updated_at: string;
  }>;
  const deadlines = (client.upcoming_deadlines ?? []) as Array<{
    id: string; title: string; due_date: string; priority: string; completed: boolean; case_id: string;
  }>;

  // Counters derive from the same canonical cases.client_id relation the list uses.
  const activeCasesCount = Number(client.active_case_count ?? 0);
  const closedCasesCount = Number(client.closed_case_count ?? 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-10 space-y-6">
      <Link to="/clients" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary transition-colors">
        <ChevronLeft className="mr-1 h-4 w-4" />
        {t("clientDetail.back")}
      </Link>

      {/* Header Profile */}
      <div className="panel p-6">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="grid h-16 w-16 place-items-center rounded-xl bg-primary/10 text-primary">
              {client.client_type === "company" ? (
                <Building2 className="h-8 w-8" />
              ) : (
                <User className="h-8 w-8" />
              )}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">{client.display_name}</h1>
              <div className="mt-2 flex items-center gap-3">
                <Badge variant="outline" className="text-primary border-primary/20 bg-primary/5">
                  {client.client_type === "company" ? t("clientDetail.type.company") : t("clientDetail.type.individual")}
                </Badge>
                <span className={`text-sm font-medium ${client.status === "active" ? "text-green-600" : "text-muted-foreground"}`}>
                  {client.status === "active" ? t("clientDetail.status.active") : client.status === "inactive" ? t("clientDetail.status.inactive") : t("clientDetail.status.archived")}
                </span>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openEdit(client)}>
              <Edit className="mr-2 h-4 w-4" /> {t("clientDetail.actions.edit")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => handleArchiveToggle(client.status)}
            >
              <Archive className="mr-2 h-4 w-4" />
              {client.status === "archived" ? t("clientDetail.actions.reactivate") : t("clientDetail.actions.archive")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={handleDelete}
            >
              <Trash2 className="mr-2 h-4 w-4" /> {t("clientDetail.actions.delete")}
            </Button>
          </div>
        </div>

        {/* Contact Info Grid */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-6 border-t border-border">
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> {t("clientDetail.fields.email")}</div>
            <div className="text-sm">{client.email || "—"}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> {t("clientDetail.fields.phone")}</div>
            <div className="text-sm">{client.phone || "—"}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" /> RFC</div>
            <div className="text-sm font-mono">{client.rfc || "—"}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> {t("clientDetail.fields.address")}</div>
            <div className="text-sm line-clamp-2">{client.address || "—"}</div>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="panel p-4 flex flex-col items-center justify-center text-center">
          <span className="text-3xl font-bold text-primary">{activeCasesCount}</span>
          <span className="text-xs uppercase tracking-wider text-muted-foreground mt-1">{t("clientDetail.stats.active")}</span>
        </div>
        <div className="panel p-4 flex flex-col items-center justify-center text-center">
          <span className="text-3xl font-bold text-green-600">{closedCasesCount}</span>
          <span className="text-xs uppercase tracking-wider text-muted-foreground mt-1">{t("clientDetail.stats.closed")}</span>
        </div>
        <div className="panel p-4 flex flex-col items-center justify-center text-center">
          <span className="text-3xl font-bold text-amber-500">{deadlines.length}</span>
          <span className="text-xs uppercase tracking-wider text-muted-foreground mt-1">{t("clientDetail.stats.upcoming")}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Cases List */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Briefcase className="h-5 w-5 text-primary" /> {t("clientDetail.cases.title")}
            </h2>
            <Link to="/new" search={{ clientId }} className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90">
              {t("clientDetail.cases.new")}
            </Link>
          </div>

          <div className="panel overflow-hidden">
            {cases.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {t("clientDetail.cases.empty")}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {cases.map((c) => (
                  <Link
                    key={c.id}
                    to="/cases/$caseId"
                    params={{ caseId: c.id }}
                    className="flex items-center justify-between p-4 hover:bg-accent/5 transition-colors"
                  >
                    <div className="min-w-0 pr-4">
                      <div className="font-medium text-foreground truncate">
                        {c.name || t("clientDetail.cases.unnamed")}
                      </div>
                      {caseNumberOf(c) ? (
                        <div className="mt-0.5 text-xs font-mono text-muted-foreground truncate">
                          {caseNumberOf(c)}
                        </div>
                      ) : null}
                      <div className="mt-1 text-xs text-muted-foreground truncate">
                        {[
                          c.underlying_materia || c.case_type,
                          c.procedural_vehicle,
                          c.jurisdiction,
                        ]
                          .filter(Boolean)
                          .join(" · ") || t("clientDetail.cases.matterUnknown")}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("clientDetail.cases.created")} {new Date(c.created_at).toLocaleDateString(locale === "es" ? "es-MX" : "en-US")} · {t("clientDetail.cases.updated")}{" "}
                        {new Date(c.updated_at).toLocaleDateString(locale === "es" ? "es-MX" : "en-US")}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                      {c.status}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Deadlines Sidebar */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">{t("clientDetail.deadlines.title")}</h2>
          <div className="panel p-4">
            <DeadlineList deadlines={deadlines as any} />
          </div>
        </div>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("clientDetail.edit.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Field label={t("clientDetail.fields.name")}>
              <Input
                value={form["display_name"] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
              />
            </Field>
            <Field label={t("clientDetail.fields.type")}>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form["client_type"] ?? "individual"}
                onChange={(e) => setForm((f) => ({ ...f, client_type: e.target.value }))}
              >
                <option value="individual">{t("clientDetail.type.individual")}</option>
                <option value="company">{t("clientDetail.type.company")}</option>
              </select>
            </Field>
            <Field label={t("clientDetail.fields.legalName")}>
              <Input
                value={form["legal_name"] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, legal_name: e.target.value }))}
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="RFC">
                <Input
                  value={form["rfc"] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, rfc: e.target.value }))}
                />
              </Field>
              <Field label={t("clientDetail.fields.reference")}>
                <Input
                  value={form["reference_number"] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, reference_number: e.target.value }))}
                />
              </Field>
              <Field label={t("clientDetail.fields.email")}>
                <Input
                  type="email"
                  value={form["email"] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
              </Field>
              <Field label={t("clientDetail.fields.phone")}>
                <Input
                  value={form["phone"] ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                />
              </Field>
            </div>
            <Field label={t("clientDetail.fields.address")}>
              <Textarea
                rows={2}
                value={form["address"] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              />
            </Field>
            <Field label={t("clientDetail.fields.notes")}>
              <Textarea
                rows={3}
                value={form["notes"] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>
              {t("clientDetail.actions.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t("clientDetail.actions.saving") : t("clientDetail.actions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}


