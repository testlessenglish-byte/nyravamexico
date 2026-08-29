import { Link, useNavigate } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import {
  User,
  Sparkles,
  Settings,
  CreditCard,
  Gauge,
  Activity,
  HelpCircle,
  LogOut,
} from "lucide-react";

type Props = {
  initials: string;
  displayName: string;
  email: string;
  isAdmin?: boolean;
};

/**
 * Persistent user menu — profile, account, billing, API keys, preferences,
 * help, and sign out. Available on every page from the top-right of both
 * mobile and desktop headers.
 */
export function UserMenu({ initials, displayName, email, isAdmin }: Props) {
  const signOut = async () => {
    try {
      await supabase.auth.signOut({ scope: "global" });
    } catch {}
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {}
    if (typeof window !== "undefined") {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {}
      window.location.replace("/auth?logged_out=1");
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open user menu"
        className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-xs font-bold text-primary-foreground shadow-sm ring-1 ring-border transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-primary"
      >
        {initials}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="truncate text-sm font-semibold">{displayName || "Account"}</span>
            {email && (
              <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>
            )}
            {isAdmin && (
              <span className="mt-1 inline-flex w-fit rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                Administrator
              </span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account" className="flex items-center gap-2">
            <User className="h-4 w-4" /> Profile & Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/billing" className="flex items-center gap-2">
            <CreditCard className="h-4 w-4" /> Billing
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/usage" className="flex items-center gap-2">
            <Gauge className="h-4 w-4" /> Usage
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/ai-keys" className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> API Keys
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings" className="flex items-center gap-2">
            <Settings className="h-4 w-4" /> Preferences
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/health" className="flex items-center gap-2">
            <Activity className="h-4 w-4" /> System Health
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={isAdmin ? "/admin/messages" : "/messages"} className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4" /> Help & Support
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            void signOut();
          }}
          className="text-destructive focus:text-destructive"
        >
          <LogOut className="mr-2 h-4 w-4" /> Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
