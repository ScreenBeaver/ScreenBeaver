/** Local home-screen activity + MCP logs (works for free / guest users). */

export type HomeActivityKind =
  | "create"
  | "record"
  | "open"
  | "save"
  | "export"
  | "mcp"
  | "note";

export type HomeActivityEntry = {
  id: string;
  kind: HomeActivityKind;
  label: string;
  detail?: string;
  at: number;
};

export type WeeklyActivityDay = {
  key: string;
  label: string;
  count: number;
  date: Date;
};

const ACTIVITY_KEY = "sw.home.activity.v1";
const MCP_KEY = "sw.home.mcp.v1";
const MAX = 80;

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function read(key: string): HomeActivityEntry[] {
  if (typeof window === "undefined") return [];
  return safeParse<HomeActivityEntry[]>(window.localStorage.getItem(key)) ?? [];
}

function write(key: string, entries: HomeActivityEntry[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(entries.slice(0, MAX)));
}

function push(key: string, entry: Omit<HomeActivityEntry, "id" | "at"> & { at?: number }) {
  const next: HomeActivityEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: entry.at ?? Date.now(),
    kind: entry.kind,
    label: entry.label,
    detail: entry.detail,
  };
  const list = [next, ...read(key).filter((e) => e.label !== entry.label || e.at < next.at - 1500)];
  write(key, list);
  return next;
}

export function listHomeActivity(): HomeActivityEntry[] {
  return read(ACTIVITY_KEY);
}

export function listMcpActivity(): HomeActivityEntry[] {
  return read(MCP_KEY);
}

export function logHomeActivity(
  kind: HomeActivityKind,
  label: string,
  detail?: string,
) {
  return push(ACTIVITY_KEY, { kind, label, detail });
}

export function logMcpActivity(label: string, detail?: string) {
  return push(MCP_KEY, { kind: "mcp", label, detail });
}

export function clearHomeActivity() {
  write(ACTIVITY_KEY, []);
}

export function clearMcpActivity() {
  write(MCP_KEY, []);
}

/** Real Sun→Sat counts from logged activity (includes today). */
export function getWeeklyActivity(entries?: HomeActivityEntry[]): WeeklyActivityDay[] {
  const source = entries ?? listHomeActivity();
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay()); // Sunday

  const labels = ["S", "M", "T", "W", "T", "F", "S"];
  return labels.map((label, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const dayStart = day.getTime();
    const dayEnd = dayStart + 86_400_000;
    const count = source.filter((e) => e.at >= dayStart && e.at < dayEnd).length;
    return {
      key: `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`,
      label,
      count,
      date: day,
    };
  });
}

export function weekActivityTotal(days: WeeklyActivityDay[]) {
  return days.reduce((n, d) => n + d.count, 0);
}
