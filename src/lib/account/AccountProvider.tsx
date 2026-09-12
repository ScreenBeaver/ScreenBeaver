"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { isTauri, setMcpEntitled } from "@/lib/studio/nativeBridge";
import {
  type AccountMe,
  type PlanFeatures,
  completeDesktopLoginFromUrl,
  fetchMe,
  getStoredToken,
  openBillingPage,
  openDashboard,
  signOutDesktop,
  startDesktopLogin,
} from "@/lib/account/client";

type AccountState = {
  loading: boolean;
  me: AccountMe | null;
  signedIn: boolean;
  features: PlanFeatures;
  planSlug: string | null;
  planName: string | null;
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  upgrade: () => Promise<void>;
  openAccount: () => Promise<void>;
  requireFeature: (key: keyof PlanFeatures, label?: string) => boolean;
};

/** Open-source desktop: all studio features are free offline. */
const OPEN_FEATURES: PlanFeatures = {
  mcp: true,
  androidUsb: true,
  export4k: true,
  effects: true,
  watermarkFree: true,
  seats: 1,
  customDomains: true,
  shareLinks: true,
  maxShares: 50,
  voiceover: true,
  autoCaptions: true,
  translation: true,
};

const AccountContext = createContext<AccountState | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<AccountMe | null>(null);

  const refresh = useCallback(async () => {
    if (!getStoredToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      const next = await fetchMe();
      setMe(next);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let lastUrl = "";
    const consume = async (url: string) => {
      if (!url.includes("://auth") || url === lastUrl) return;
      lastUrl = url;
      try {
        const next = await completeDesktopLoginFromUrl(url);
        if (!cancelled) {
          setMe(next);
          toast.success(`Signed in as ${next.user.email}`);
        }
      } catch (err) {
        lastUrl = "";
        toast.error(err instanceof Error ? err.message : "Sign-in failed");
      }
    };
    const consumeAll = (payload: unknown) => {
      const urls = Array.isArray(payload)
        ? payload.filter((u): u is string => typeof u === "string")
        : typeof payload === "string"
          ? [payload]
          : [];
      for (const url of urls) void consume(url);
    };
    (async () => {
      try {
        const { onOpenUrl, getCurrent } = await import(
          "@tauri-apps/plugin-deep-link"
        );
        const existing = await getCurrent();
        if (existing) consumeAll(existing);
        unlisten = await onOpenUrl((urls) => consumeAll(urls));
      } catch {
        /* plugin unavailable in browser */
      }
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const u2 = await listen<unknown>("deep-link://new-url", (ev) => {
          consumeAll(ev.payload);
        });
        const prev = unlisten;
        unlisten = () => {
          prev?.();
          u2();
        };
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const signIn = useCallback(async () => {
    try {
      await startDesktopLogin();
      toast.message("Complete sign-in in your browser…");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open login");
    }
  }, []);

  const signOut = useCallback(async () => {
    await signOutDesktop();
    setMe(null);
    toast.success("Signed out");
  }, []);

  const upgrade = useCallback(async () => {
    await openBillingPage();
  }, []);

  const openAccount = useCallback(async () => {
    await openDashboard();
  }, []);

  const features = useMemo(() => {
    const raw = me?.plan.features;
    if (!raw) return OPEN_FEATURES;
    // Cloud account is optional; keep studio features unlocked in this OSS build.
    return {
      ...OPEN_FEATURES,
      ...raw,
      mcp: true,
      androidUsb: true,
      export4k: true,
      effects: true,
      watermarkFree: true,
      voiceover: true,
      autoCaptions: true,
      translation: true,
      shareLinks: true,
      customDomains: true,
      maxShares: Math.max(Number(raw.maxShares ?? 0) || 0, OPEN_FEATURES.maxShares),
      seats: Math.max(Number(raw.seats ?? 0) || 0, OPEN_FEATURES.seats),
    } satisfies PlanFeatures;
  }, [me]);

  useEffect(() => {
    void setMcpEntitled(features.mcp === true);
  }, [features.mcp]);

  const requireFeature = useCallback(
    (key: keyof PlanFeatures, _label?: string) => {
      const value = features[key];
      return typeof value === "boolean" ? value : Number(value) > 0;
    },
    [features],
  );

  const value = useMemo<AccountState>(
    () => ({
      loading,
      me,
      signedIn: Boolean(me),
      features,
      planSlug: me?.plan.slug ?? null,
      planName: me?.plan.name ?? null,
      refresh,
      signIn,
      signOut,
      upgrade,
      openAccount,
      requireFeature,
    }),
    [
      loading,
      me,
      features,
      refresh,
      signIn,
      signOut,
      upgrade,
      openAccount,
      requireFeature,
    ],
  );

  return (
    <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
  );
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) {
    throw new Error("useAccount must be used within AccountProvider");
  }
  return ctx;
}
