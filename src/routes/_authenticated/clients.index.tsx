import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useMemo } from "react";
import { listClients } from "@/lib/clients.functions";
import { Search, Plus, Users, Building2, User } from "lucide-react";
import { ClientCard } from "@/components/crm/ClientCard";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/clients/")({
  head: () => ({ meta: [{ title: "Clientes — Nyrava" }] }),
  component: ClientsPage,
});

function ClientsPage() {
  const fetchClients = useServerFn(listClients);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [isNewClientOpen, setIsNewClientOpen] = useState(false);

  const { data: clients, isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: () => fetchClients(),
    refetchInterval: 10000,
  });

  const filtered = useMemo(() => {
    let arr = (clients ?? []);
    
    if (statusFilter !== "all") {
      arr = arr.filter((c) => c.status === statusFilter);
    }
    
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      arr = arr.filter((c) => 
        c.display_name.toLowerCase().includes(q) || 
        c.email?.toLowerCase().includes(q)
      );
    }
    
    return arr.sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [clients, query, statusFilter]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-10">
      <div className="mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold sm:text-3xl text-foreground flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            Directorio de Clientes
          </h1>
          <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
            Administra tus clientes y contactos
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Dialog open={isNewClientOpen} onOpenChange={setIsNewClientOpen}>
            <DialogTrigger asChild>
              <Button className="bg-primary text-primary-foreground hover:opacity-90">
                <Plus className="mr-2 h-4 w-4" />
                Nuevo Cliente
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Agregar Nuevo Cliente</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                {/* Form placeholder - real implementation would use Zod + react-hook-form */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Nombre / Razón Social</label>
                  <Input placeholder="Ej. Juan Pérez o Empresa S.A." />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Tipo de Cliente</label>
                  <select className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                    <option value="individual">Persona Física</option>
                    <option value="company">Persona Moral</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Correo Electrónico</label>
                  <Input type="email" placeholder="correo@ejemplo.com" />
                </div>
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={() => setIsNewClientOpen(false)}>Cancelar</Button>
                  <Button onClick={() => setIsNewClientOpen(false)}>Guardar</Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre, correo..."
            className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none transition-shadow"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none sm:w-48"
        >
          <option value="all">Todos los estados</option>
          <option value="active">Activos</option>
          <option value="inactive">Inactivos</option>
          <option value="archived">Archivados</option>
        </select>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">Cargando clientes...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <Users className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <h2 className="mt-4 text-lg font-medium text-foreground">
            {clients && clients.length > 0 ? "No se encontraron resultados" : "No tienes clientes aún"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {clients && clients.length > 0 ? "Intenta con otros términos de búsqueda." : "Agrega tu primer cliente para comenzar."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((client) => (
            <ClientCard
              key={client.id}
              id={client.id}
              displayName={client.display_name}
              clientType={client.client_type as "individual" | "company"}
              caseCount={client.case_count || 0}
              email={client.email}
              status={client.status as "active" | "inactive" | "archived"}
            />
          ))}
        </div>
      )}
    </div>
  );
}
