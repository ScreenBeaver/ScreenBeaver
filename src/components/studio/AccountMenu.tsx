import { UserRound } from "lucide-react";
import { playClick } from "@/lib/studio/sounds";
import { useAccount } from "@/lib/account/AccountProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AccountMenu() {
  const { loading, signedIn, me, planName, signIn, signOut, upgrade, openAccount } =
    useAccount();

  const badge = signedIn ? planName || "Free" : "Guest";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded px-2 py-1.5 text-muted-foreground transition-colors hover:bg-panel-raised hover:text-foreground"
          title="Account"
          onClick={() => playClick()}
        >
          <UserRound className="h-[15px] w-[15px]" />
          <span className="hidden max-w-[72px] truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-ember sm:inline">
            {loading ? "…" : badge}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          {signedIn && me ? (
            <div className="space-y-0.5">
              <p className="text-[12px] font-semibold text-foreground">{me.user.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">{me.user.email}</p>
              {me.user.username ? (
                <p className="font-mono text-[10px] text-muted-foreground">
                  {me.user.username}.screenbeaver.com
                </p>
              ) : null}
            </div>
          ) : (
            <span className="text-[12px]">Not signed in</span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!signedIn ? (
          <DropdownMenuItem
            onClick={() => {
              playClick();
              void signIn();
            }}
          >
            Sign in
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem
              onClick={() => {
                playClick();
                void openAccount();
              }}
            >
              Open dashboard
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                playClick();
                void upgrade();
              }}
            >
              Billing
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                playClick();
                void signOut();
              }}
            >
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
