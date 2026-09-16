import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getClient, deleteClientFn } from "@/lib/clients.functions";
import {
  User, Building2, Mail, Phone, MapPin, FileText,
  Briefcase, Edit, Archive, ChevronLeft, Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeadlineList } from "@/components/crm/DeadlineList";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
  head: () => ({ meta: [{ title: "Detalle de Cliente â€” Nyrava" }] }),
  component: ClientDetailPage,
});

function ClientDetailPage() {
  const { clientId } = Route.useParams();
  const fetchClient = useServerFn(getClient);
  const deleteClient = useServerFn(deleteClientFn);
  const navigate = useNavigate();

  const handleDelete = async () => {
    if (!window.confirm("¿Estás seguro de que deseas eliminar este cliente? Esta acción no se puede deshacer.")) return;
    try {
      await deleteClient({ data: { clientId } });
      toast.success("Cliente eliminado exitosamente");
      navigate({ to: "/clients" });
    } catch (error: any) {
      toast.error(error.message || "Error al eliminar el cliente");
    }
  };

  const { data: clientData, isLoading } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => fetchClient({ data: { clientId } }),
  });

  if (isLoading) {
    return <div className="p-8 text-center text-sm text-muted-foreground">Cargando detalles...</div>;
  }

  if (!clientData) {
    return <div className="p-8 text-center text-sm text-destructive">Cliente no encontrado.</div>;
  }

  // getClient returns a flat object with client fields + cases + upcoming_deadlines
  const client = clientData as Record<string, any>;
  const cases = (client.cases ?? []) as Array<{
    id: string; title: string; case_number: string; status: string; matter_type: string; updated_at: string;
  }>;
  const deadlines = (client.upcoming_deadlines ?? []) as Array<{
    id: string; title: string; due_date: string; priority: string; completed: boolean; case_id: string;
  }>;

  const activeCasesCount = cases.filter((c) => !["complete", "cancelled", "failed"].includes(c.status)).length;
  const closedCasesCount = cases.filter((c) => ["complete", "cancelled"].includes(c.status)).length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-10 space-y-6">
      <Link to="/clients" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary transition-colors">
        <ChevronLeft className="mr-1 h-4 w-4" />
        Volver a Clientes
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
                  {client.client_type === "company" ? "Persona Moral" : "Persona FÃ­sica"}
                </Badge>
                <span className={`text-sm font-medium ${client.status === "active" ? "text-green-600" : "text-muted-foreground"}`}>
                  {client.status === "active" ? "Activo" : client.status === "inactive" ? "Inactivo" : "Archivado"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm">
              <Edit className="mr-2 h-4 w-4" /> Editar
            </Button>
            <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10">
              <Archive className="mr-2 h-4 w-4" /> Archivar
            </Button>
          </div>
        </div>

        {/* Contact Info Grid */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-6 border-t border-border">
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> Correo ElectrÃ³nico</div>
            <div className="text-sm">{client.email || "â€”"}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> TelÃ©fono</div>
            <div className="text-sm">{client.phone || "â€”"}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" /> RFC</div>
            <div className="text-sm font-mono">{client.rfc || "â€”"}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> DirecciÃ³n</div>
            <div className="text-sm line-clamp-2">{client.address || "â€”"}</div>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="panel p-4 flex flex-col items-center justify-center text-center">
          <span className="text-3xl font-bold text-primary">{activeCasesCount}</span>
          <span className="text-xs uppercase tracking-wider text-muted-foreground mt-1">Expedientes Activos</span>
        </div>
        <div className="panel p-4 flex flex-col items-center justify-center text-center">
          <span className="text-3xl font-bold text-green-600">{closedCasesCount}</span>
          <span className="text-xs uppercase tracking-wider text-muted-foreground mt-1">Expedientes Cerrados</span>
        </div>
        <div className="panel p-4 flex flex-col items-center justify-center text-center">
          <span className="text-3xl font-bold text-amber-500">{deadlines.length}</span>
          <span className="text-xs uppercase tracking-wider text-muted-foreground mt-1">PrÃ³ximos Vencimientos</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Cases List */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Briefcase className="h-5 w-5 text-primary" /> Expedientes Relacionados
            </h2>
            <Link to="/new" search={{ clientId }} className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90">
              + Analizar Nuevo Caso
            </Link>
          </div>

          <div className="panel overflow-hidden">
            {cases.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No hay expedientes asociados a este cliente.
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
                        {c.case_number || c.title || "Sin tÃ­tulo"}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {c.matter_type || "General"} Â· Actualizado {new Date(c.updated_at).toLocaleDateString()}
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
          <h2 className="text-lg font-semibold">Vencimientos</h2>
          <div className="panel p-4">
            <DeadlineList deadlines={deadlines as any} />
          </div>
        </div>
      </div>
    </div>
  );
}


