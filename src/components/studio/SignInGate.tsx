import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useAccount } from "@/lib/account/AccountProvider";
import { ACCOUNT_API_BASE } from "@/lib/account/client";
import { isTauri } from "@/lib/studio/nativeBridge";
import { playClick } from "@/lib/studio/sounds";

async function openExternal(url: string) {
  try {
    if (isTauri()) {
      const { openCaptureUrl } = await import("@/lib/studio/nativeTake");
      await openCaptureUrl(url);
      return;
    }
  } catch {
    /* fall through */
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Unity Hub–style gate: form column + full-bleed motion-blur art.
 * Blocks the studio until the user completes browser sign-in.
 */
export function SignInGate() {
  const { loading, signIn } = useAccount();
  const [waiting, setWaiting] = useState(false);

  const onSignIn = async () => {
    playClick();
    setWaiting(true);
    try {
      await signIn();
    } catch {
      setWaiting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex bg-[#0a0c10] text-white">
      <aside className="relative z-10 flex w-full max-w-[440px] shrink-0 flex-col justify-between border-r border-white/[0.08] bg-[#11151c] px-10 py-10 sm:px-12">
        <div>
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt=""
              className="h-9 w-9 rounded-lg object-contain"
            />
            <div>
              <p className="text-[15px] font-semibold tracking-tight text-white">
                Screen Beaver
              </p>
              <p className="text-[11px] text-white/45">Desktop studio</p>
            </div>
          </div>

          <h1 className="mt-14 text-[28px] leading-tight font-semibold tracking-tight text-white">
            Sign in to continue
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-white/55">
            Sign in with your Screen Beaver account. We&apos;ll open the browser —
            once you&apos;re done, this app unlocks.
          </p>

          <button
            type="button"
            disabled={loading || waiting}
            onClick={() => void onSignIn()}
            className="mt-10 flex w-full items-center justify-center gap-2 rounded-lg bg-[#3b82f6] px-4 py-3 text-[14px] font-semibold text-white transition hover:bg-[#2563eb] disabled:opacity-60"
          >
            {loading || waiting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="h-4 w-4" />
            )}
            {waiting ? "Waiting for browser…" : "Sign in with browser"}
          </button>

          <button
            type="button"
            disabled={waiting}
            onClick={() => {
              playClick();
              void openExternal(`${ACCOUNT_API_BASE}/?auth=signup`);
            }}
            className="mt-3 flex w-full items-center justify-center rounded-lg border border-white/12 bg-transparent px-4 py-3 text-[13px] font-medium text-white/80 transition hover:border-white/25 hover:bg-white/5 disabled:opacity-50"
          >
            Create an account
          </button>

          {waiting ? (
            <p className="mt-6 text-[12px] leading-relaxed text-[#93c5fd]">
              Finish signing in in the browser. Keep this app open — it unlocks
              when you&apos;re done.
            </p>
          ) : (
            <p className="mt-6 text-[12px] leading-relaxed text-white/40">
              Billing and plans are managed at screenbeaver.com.
            </p>
          )}
        </div>

        <p className="text-[11px] text-white/30">
          Free · Pro · Team
        </p>
      </aside>

      <div className="relative hidden min-w-0 flex-1 overflow-hidden md:block">
        <img
          src="/auth-motion-blur.png"
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#11151c] via-transparent to-transparent opacity-80" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0a0c10]/70 via-transparent to-[#0a0c10]/25" />
        <div className="absolute right-10 bottom-10 left-10 max-w-md">
          <p className="mt-2 text-[20px] leading-snug font-semibold text-white/90">
            Record, edit, and export product videos.
          </p>
        </div>
      </div>
    </div>
  );
}
