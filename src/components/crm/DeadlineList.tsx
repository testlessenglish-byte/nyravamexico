import { Clock, Calendar, CheckCircle2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";

export interface Deadline {
  id: string;
  title: string;
  due_date: string;
  priority: "low" | "normal" | "high" | "urgent";
  case_title?: string;
  completed: boolean;
}

interface DeadlineListProps {
  deadlines: Deadline[];
  onToggleComplete?: (id: string, completed: boolean) => void;
}

export function DeadlineList({ deadlines, onToggleComplete }: DeadlineListProps) {
  if (!deadlines || deadlines.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        No hay vencimientos próximos.
      </div>
    );
  }

  const today = new Date().toISOString().split("T")[0];

  return (
    <ul className="space-y-2">
      {deadlines.map((deadline) => {
        const isOverdue = deadline.due_date < today && !deadline.completed;
        const isToday = deadline.due_date === today && !deadline.completed;

        let priorityColor = "border-border text-muted-foreground bg-muted/50";
        let priorityLabel = "Normal";
        
        switch (deadline.priority) {
          case "urgent":
             priorityColor = "border-destructive/30 text-destructive bg-destructive/10";
             priorityLabel = "Urgente";
             break;
          case "high":
             priorityColor = "border-warning/30 text-warning bg-warning/10";
             priorityLabel = "Alta";
             break;
          case "low":
             priorityColor = "border-border text-muted-foreground bg-muted/20";
             priorityLabel = "Baja";
             break;
        }

        return (
          <li
            key={deadline.id}
            className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
              deadline.completed
                ? "border-border bg-card/40 opacity-75"
                : isOverdue
                ? "border-destructive/30 bg-destructive/5"
                : isToday
                ? "border-warning/30 bg-warning/5"
                : "border-border bg-card/60 hover:bg-accent/5"
            }`}
          >
            <div className="mt-0.5">
              <Checkbox
                checked={deadline.completed}
                onCheckedChange={(checked) => onToggleComplete?.(deadline.id, checked === true)}
              />
            </div>
            
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <h4 className={`truncate text-sm font-medium ${deadline.completed ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                  {deadline.title}
                </h4>
                <Badge variant="outline" className={`shrink-0 text-[10px] ${priorityColor}`}>
                  {priorityLabel}
                </Badge>
              </div>
              
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className={`flex items-center gap-1 ${isOverdue && !deadline.completed ? 'text-destructive font-medium' : isToday && !deadline.completed ? 'text-warning font-medium' : ''}`}>
                  <Calendar className="h-3.5 w-3.5" />
                  {new Date(`${deadline.due_date}T12:00:00`).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {isOverdue && !deadline.completed && " (Vencido)"}
                  {isToday && !deadline.completed && " (Hoy)"}
                </span>
                
                {deadline.case_title && (
                  <span className="truncate border-l border-border pl-3">
                    {deadline.case_title}
                  </span>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
