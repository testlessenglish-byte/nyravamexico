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
      className="panel block min-w-0 max-w-full overflow-hidden p-5 transition-all hover:border-primary/40 hover:shadow-glow-cyan"
    >
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            {clientType === "company" ? (
              <Building2 className="h-5 w-5" />
            ) : (
              <User className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            <h3 className="line-clamp-2 max-w-full overflow-hidden break-words font-semibold leading-snug text-foreground">
              {displayName}
            </h3>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="h-5 shrink-0 border-primary/20 bg-primary/5 px-1.5 text-[10px] font-normal uppercase tracking-wider text-primary">
                {clientType === "company" ? "Empresa" : "Física"}
              </Badge>
              {status === "active" ? (
                <span className="flex shrink-0 items-center gap-1 text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success"></span>
                  Activo
                </span>
              ) : status === "inactive" ? (
                 <span className="flex shrink-0 items-center gap-1 text-warning">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning"></span>
                  Inactivo
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground"></span>
                  Archivado
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
      
      <div className="mt-4 grid min-w-0 grid-cols-2 gap-3 overflow-hidden text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <Mail className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{email || "Sin email"}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <Briefcase className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{caseCount} {caseCount === 1 ? 'Expediente' : 'Expedientes'}</span>
        </div>
      </div>
    </Link>
  );
}
