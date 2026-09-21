import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getClient, deleteClientFn, updateClientFn, archiveClient } from "@/lib/clients.functions";
import {
  User, Building2, Mail, Phone, MapPin, FileText,
  Briefcase, Edit, Archive, ChevronLeft, Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DeadlineList } from "@/components/crm/DeadlineList";
import { toast } from "sonner";
import { useI18n } from "@/i18n";

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
  head: () => ({ meta: [{ title: "Detalle de Cliente — Nyrava" }] }),
  component: ClientDetailPage,
});

function ClientDetailPage() {
  const { t, locale } = useI18n();
  const { clientId } = Route.useParams();
  const fetchClient = useServerFn(getClient);
  const deleteClient = useServerFn(deleteClientFn);
  const updateClient = useServerFn(updateClientFn);
  const archiveClientFn = useServerFn(archiveClient);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [editForm, setEditForm] = useState({
    display_name: "",
    legal_name: "",
    client_type: "individual",
    rfc: "",
    email: "",
    phone: "",
    address: "",
    notes: "",
  });

  const { data: clientData, isLoading } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => fetchClient({ data: { clientId } }),
  });

  const handleOpenEdit = () => {
    if (!clientData) return;
    const client = clientData as Record<string, any>;
    setEditForm({
      display_name: client.display_name || "",
      legal_name: client.legal_name || "",
      client_type: client.client_type || "individual",
      rfc: client.rfc || "",
      email: client.email || "",
      phone: client.phone || "",
      address: client.address || "",
      notes: client.notes || "",
    });
    setIsEditOpen(true);
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editForm.display_name.trim()) {
      toast.error(locale === "es" ? "El nombre es requerido" : "Name is required");
      return;
    }
    setUpdating(true);
    try {
      await updateClient({
        data: {
          clientId,
          ...editForm,
        },
      });
      toast.success(locale === "es" ? "Cliente actualizado correctamente" : "Client updated successfully");
      setIsEditOpen(false);
      queryClient.invalidateQueries({ queryKey: ["client", clientId] });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
    } catch (error: any) {
      toast.error(error.message || (locale === "es" ? "Error al actualizar cliente" : "Error updating client"));
    } finally {
      setUpdating(false);
    }
  };

  const handleToggleArchive = async () => {
    if (!clientData) return;
    const client = clientData as Record<string, any>;
    const newStatus = client.status === "archived" ? "active" : "archived";
    setArchiving(true);
    try {
      if (newStatus === "archived") {
        await archiveClientFn({ data: { clientId } });
      } else {
        await updateClient({ data: { clientId, status: "active" } });
      }
      toast.success(
        newStatus === "archived"
          ? (locale === "es" ? "Cliente archivado" : "Client archived")
          : (locale === "es" ? "Cliente activado" : "Client activated"),
      );
      queryClient.invalidateQueries({ queryKey: ["client", clientId] });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
    } catch (error: any) {
      toast.error(error.message || (locale === "es" ? "Error al cambiar estado" : "Error changing status"));
    } finally {
      setArchiving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(locale === "es" ? "¿Estás seguro de que deseas eliminar este cliente? Esta acción no se puede deshacer." : "Are you sure you want to delete this client? This action cannot be undone.")) return;
    try {
      await deleteClient({ data: { clientId } });
      toast.success(locale === "es" ? "Cliente eliminado exitosamente" : "Client deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      navigate({ to: "/clients" });
    } catch (error: any) {
      toast.error(error.message || (locale === "es" ? "Error al eliminar el cliente" : "Error deleting client"));
    }
  };

  if (isLoading) {
    return <div className="p-8 text-center text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  if (!clientData) {
    return <div className="p-8 text-center text-sm text-destructive">{locale === "es" ? "Cliente no encontrado." : "Client not found."}</div>;
  }

  const client = clientData as Record<string, any>;
  const cases = (client.cases ?? []) as Array<{
    id: string; title: string; case_number: string; status: string; matter_type: string; updated_at: string;
  }>;
  const deadlines = (client.upcoming_deadlines ?? []) as Array<{
    id: string; title: string; due_date: string; priority: string; completed: boolean; case_id: string;
  }>;

  const CLOSED_STATUSES = ["complete", "released", "cancelled", "failed"];
  const activeCasesCount = cases.filter((c) => !CLOSED_STATUSES.includes(c.status)).length;
  const closedCasesCount = cases.filter((c) => CLOSED_STATUSES.includes(c.status)).length;

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
                  {client.client_type === "company"
                    ? t("clientDetail.type.company")
                    : client.client_type === "government"
                      ? t("clientDetail.type.government")
                      : client.client_type === "other"
                        ? t("clientDetail.type.other")
                        : t("clientDetail.type.individual")}
                </Badge>
                <span className={`text-sm font-medium ${client.status === "active" ? "text-green-600" : "text-muted-foreground"}`}>
                  {client.status === "active"
                    ? t("clientDetail.status.active")
                    : client.status === "inactive"
                      ? t("clientDetail.status.inactive")
                      : t("clientDetail.status.archived")}
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={handleOpenEdit}>
              <Edit className="mr-2 h-4 w-4" /> {t("clientDetail.actions.edit")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleToggleArchive} disabled={archiving} className="text-muted-foreground hover:bg-muted/10">
              <Archive className="mr-2 h-4 w-4" /> {client.status === "archived" ? (locale === "es" ? "Desarchivar" : "Unarchive") : t("clientDetail.actions.archive")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleDelete} className="text-destructive border-destructive/30 hover:bg-destructive/10">
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

      {/* Edit Client Modal */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{locale === "es" ? "Editar Cliente" : "Edit Client"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleUpdate} className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{locale === "es" ? "Nombre / Razón Social *" : "Display Name *"}</label>
              <Input
                value={editForm.display_name}
                onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">{locale === "es" ? "Tipo de Cliente" : "Client Type"}</label>
                <select
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs"
                  value={editForm.client_type}
                  onChange={(e) => setEditForm({ ...editForm, client_type: e.target.value })}
                >
                  <option value="individual">{locale === "es" ? "Persona Física" : "Individual"}</option>
                  <option value="company">{locale === "es" ? "Persona Moral" : "Company"}</option>
                  <option value="government">{locale === "es" ? "Entidad Gubernamental" : "Government"}</option>
                  <option value="other">{locale === "es" ? "Otro" : "Other"}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">RFC</label>
                <Input
                  value={editForm.rfc}
                  onChange={(e) => setEditForm({ ...editForm, rfc: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">{locale === "es" ? "Correo Electrónico" : "Email"}</label>
                <Input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">{locale === "es" ? "Teléfono" : "Phone"}</label>
                <Input
                  value={editForm.phone}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{locale === "es" ? "Dirección" : "Address"}</label>
              <Input
                value={editForm.address}
                onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => setIsEditOpen(false)} disabled={updating}>
                {locale === "es" ? "Cancelar" : "Cancel"}
              </Button>
              <Button type="submit" disabled={updating}>
                {updating ? (locale === "es" ? "Guardando..." : "Saving...") : (locale === "es" ? "Guardar Cambios" : "Save Changes")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

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
                {locale === "es" ? "No hay expedientes asociados a este cliente." : "No cases associated with this client."}
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
                        {c.case_number || c.title || (locale === "es" ? "Sin título" : "Untitled")}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {c.matter_type || "General"} · {t("clientDetail.cases.updated")} {new Date(c.updated_at).toLocaleDateString()}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                      {c.status === "released" ? t("clientDetail.caseStatus.released") : c.status}
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
    </div>
  );
}
