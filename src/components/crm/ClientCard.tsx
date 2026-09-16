import { Link } from "@tanstack/react-router";
import { User, Building2, Briefcase, Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface ClientCardProps {
  id: string;
  displayName: string;
  clientType: "individual" | "company";
  caseCount: number;
  email?: string;
  status: "active" | "inactive" | "archived";
}

export function ClientCard({ id, displayName, clientType, caseCount, email, status }: ClientCardProps) {
  return (
    <Link
      to="/clients/$clientId"
      params={{ clientId: id }}
      className="panel block p-5 hover:border-primary/40 hover:shadow-glow-cyan transition-all"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            {clientType === "company" ? (
              <Building2 className="h-5 w-5" />
            ) : (
              <User className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-foreground">
              {displayName}
            </h3>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal uppercase tracking-wider text-primary border-primary/20 bg-primary/5">
                {clientType === "company" ? "Empresa" : "Física"}
              </Badge>
              {status === "active" ? (
                <span className="flex items-center gap-1 text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success"></span>
                  Activo
                </span>
              ) : status === "inactive" ? (
                 <span className="flex items-center gap-1 text-warning">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning"></span>
                  Inactivo
                </span>
              ) : (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground"></span>
                  Archivado
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
      
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5 truncate">
          <Mail className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{email || "Sin email"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Briefcase className="h-3.5 w-3.5 shrink-0" />
          <span>{caseCount} {caseCount === 1 ? 'Expediente' : 'Expedientes'}</span>
        </div>
      </div>
    </Link>
  );
}
