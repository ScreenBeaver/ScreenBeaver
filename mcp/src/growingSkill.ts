/**
 * Hermes-style growing skill — lessons accumulate across demos and are
 * injected into the MCP harness (Claude / BetterClaw / Cursor) on every read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_LESSONS = 80;
const MAX_CHARS = 24_000;

export type DemoLesson = {
  at: string;
  product?: string;
  tags?: string[];
  lesson: string;
};

function skillDir(): string {
  return path.join(os.homedir(), ".screen-beaver");
}

export function growingSkillPath(): string {
  return path.join(skillDir(), "growing-skill.md");
}

export function lessonsJsonPath(): string {
  return path.join(skillDir(), "lessons.json");
}

function ensureDir() {
  fs.mkdirSync(skillDir(), { recursive: true });
}

export function loadLessons(): DemoLesson[] {
  try {
    const raw = fs.readFileSync(lessonsJsonPath(), "utf8");
    const parsed = JSON.parse(raw) as DemoLesson[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLessons(lessons: DemoLesson[]) {
  ensureDir();
  const trimmed = lessons.slice(-MAX_LESSONS);
  fs.writeFileSync(lessonsJsonPath(), JSON.stringify(trimmed, null, 2), "utf8");
  fs.writeFileSync(growingSkillPath(), renderGrowingMarkdown(trimmed), "utf8");
}

export function renderGrowingMarkdown(lessons: DemoLesson[] = loadLessons()): string {
  const header = `# Screen Beaver — growing demo skill

Lessons learned from real takes on this machine. Agents (Claude, BetterClaw, Cursor)
**must** call \`get_demo_skill\` at the start of a session and \`remember_demo_lesson\`
after each successful (or failed) record so this file keeps growing.

The user only gives **short** asks. Do **not** ask them to paste Phase A/B — it is already your job.

## Permanent: explore then record (every product)

Phase A = **dry-run the exact lesson** with \`demo_*\` (no capture). Phase B = \`open_url\` as a **new tab** (never a new window) → \`start_capture\` → same steps → \`stop_capture\` → \`regenerate_zooms\` (Screen Studio–style Auto zooms). Sheets may \`record_and_build\` after a ready-sheet scout. Blank PNG ⇒ wait/re-scout same window. Never scout Claude/Cursor chats. If autoZooms=0, re-do Phase B.

## Auto zoom (always)

1. **Typing (priority 1):** lock the field + caret — click the cell first, then type.
2. **Clicks (priority 2):** camera punches in **before** the click lands, then click.
3. After record: \`peek_studio\` → \`regenerate_zooms\` / \`update_zoom\` / \`patch_trim({ trimEndSlackSec: 0.25 })\`.

${productSkillIndex()}
## Learned lessons

`;
  if (!lessons.length) {
    return (
      header +
      "_No lessons yet. After your first demo, call `remember_demo_lesson` with what worked or failed._\n"
    );
  }
  const body = lessons
    .slice()
    .reverse()
    .map((l, i) => {
      const meta = [
        l.at.slice(0, 19),
        l.product ? `product=${l.product}` : null,
        l.tags?.length ? `tags=${l.tags.join(",")}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `### ${lessons.length - i}. ${meta}\n${l.lesson.trim()}\n`;
    })
    .join("\n");
  let out = header + body;
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS) + "\n\n…(older lessons truncated)\n";
  }
  return out;
}

/** Seed a starter file so the harness exists even before the first take. */
export function ensureGrowingSkillSeeded(): { path: string; count: number; seeded: boolean } {
  ensureDir();
  const existing = loadLessons();
  if (existing.length > 0 || fs.existsSync(growingSkillPath())) {
    return { path: growingSkillPath(), count: existing.length, seeded: false };
  }
  writeLessons([
    {
      at: new Date().toISOString(),
      product: "screen-beaver",
      tags: ["seed", "auto-zoom", "explore-first"],
      lesson:
        "Every product: Phase A explore (screenshots) then Phase B clean-start record. Sheets/Excel may record_and_build after a ready-sheet scout. Zoom before click; type ~150ms. After: peek_studio, patch_trim, remember_demo_lesson.",
    },
  ]);
  return { path: growingSkillPath(), count: 1, seeded: true };
}

export function rememberLesson(input: {
  lesson: string;
  product?: string;
  tags?: string[];
}): { ok: true; count: number; path: string } {
  ensureGrowingSkillSeeded();
  const lesson = input.lesson.trim();
  if (lesson.length < 8) {
    throw new Error("lesson must be at least 8 characters");
  }
  const lessons = loadLessons();
  // Dedupe near-identical recent lessons
  const norm = lesson.toLowerCase().replace(/\s+/g, " ");
  const dup = lessons
    .slice(-8)
    .some((l) => l.lesson.toLowerCase().replace(/\s+/g, " ") === norm);
  if (!dup) {
    lessons.push({
      at: new Date().toISOString(),
      product: input.product?.trim() || undefined,
      tags: input.tags?.map((t) => t.trim()).filter(Boolean),
      lesson,
    });
    writeLessons(lessons);
  }
  return { ok: true, count: loadLessons().length, path: growingSkillPath() };
}

export function fullHarnessGuide(baseGuide: string): string {
  return `${baseGuide}\n\n---\n\n${renderGrowingMarkdown()}\n`;
}

// ---------------------------------------------------------------------------
// Product skills (Hermes-style procedural memory): one playbook per product,
// written automatically after every recorded take and refined by the agent.
// ---------------------------------------------------------------------------

function productSkillIndex(): string {
  const skills = listProductSkills().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!skills.length) {
    return "## Product skills\n\n_None yet — one is saved automatically after the first recorded take of each product._\n";
  }
  const rows = skills
    .slice(0, 40)
    .map(
      (s) =>
        `- **${s.product}** — ${s.successes}/${s.takes} good takes, ${s.steps.length} proven steps (${s.stepsSource ?? "none"}). \`get_demo_skill({ product: "${s.product}" })\``,
    )
    .join("\n");
  return `## Product skills (proven playbooks on this PC)\n\n${rows}\n`;
}

/** Replayable step in `run_demo` shape (op + coords/text/ms). */
export type SkillStep = Record<string, unknown> & { op: string };

export type ProductSkill = {
  product: string;
  slug: string;
  url?: string;
  titleContains?: string;
  createdAt: string;
  updatedAt: string;
  takes: number;
  successes: number;
  /** "agent" = curated by the AI after a good take; "auto" = journaled demo_* calls. */
  stepsSource?: "agent" | "auto";
  steps: SkillStep[];
  gotchas: string[];
  history: { at: string; outcome: string; note?: string }[];
};

const MAX_SKILL_STEPS = 80;
const MAX_GOTCHAS = 30;
const MAX_HISTORY = 20;

function skillsDir(): string {
  return path.join(skillDir(), "skills");
}

export function productSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\.(com|app|io|so|co|net|org)\b.*$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "product"
  );
}

function skillPath(slug: string, ext: "json" | "md"): string {
  return path.join(skillsDir(), `${slug}.${ext}`);
}

export function listProductSkills(): ProductSkill[] {
  try {
    return fs
      .readdirSync(skillsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(skillsDir(), f), "utf8")) as ProductSkill;
        } catch {
          return null;
        }
      })
      .filter((s): s is ProductSkill => !!s && typeof s.slug === "string");
  } catch {
    return [];
  }
}

/** Exact slug first, then a skill whose slug/name appears in the query (e.g. "canva instagram post"). */
export function findProductSkill(query: string | undefined | null): ProductSkill | null {
  if (!query?.trim()) return null;
  const slug = productSlug(query);
  try {
    const exact = fs.readFileSync(skillPath(slug, "json"), "utf8");
    return JSON.parse(exact) as ProductSkill;
  } catch {
    /* fall through to fuzzy */
  }
  const q = query.toLowerCase();
  const all = listProductSkills().sort((a, b) => b.slug.length - a.slug.length);
  return (
    all.find((s) => q.includes(s.slug) || q.includes(s.product.toLowerCase())) ??
    all.find((s) => s.slug.includes(slug) || slug.includes(s.slug)) ??
    null
  );
}

export function renderProductSkill(s: ProductSkill): string {
  const steps = s.steps.length
    ? s.steps.map((st, i) => `${i + 1}. ${JSON.stringify(st)}`).join("\n")
    : "_No proven steps yet._";
  const gotchas = s.gotchas.length ? s.gotchas.map((g) => `- ${g}`).join("\n") : "_None yet._";
  const hist = s.history
    .slice(-6)
    .map((h) => `- ${h.at.slice(0, 16)} ${h.outcome}${h.note ? ` — ${h.note}` : ""}`)
    .join("\n");
  return `# Skill: ${s.product}

takes=${s.takes} · successes=${s.successes} · steps=${s.stepsSource ?? "none"} · updated ${s.updatedAt.slice(0, 16)}
${s.url ? `url: ${s.url}\n` : ""}${s.titleContains ? `titleContains: ${s.titleContains}\n` : ""}
## Proven steps (replay with run_demo, or one by one with demo_*)
${steps}

## Gotchas
${gotchas}

## Recent takes
${hist || "_none_"}
`;
}

export function saveProductSkill(input: {
  product: string;
  url?: string;
  titleContains?: string;
  steps?: SkillStep[];
  gotchas?: string[];
  outcome?: string;
  note?: string;
  source: "agent" | "auto";
}): ProductSkill {
  const product = input.product.trim();
  if (!product) throw new Error("product required");
  fs.mkdirSync(skillsDir(), { recursive: true });
  const slug = productSlug(product);
  const now = new Date().toISOString();
  const existing = findProductSkill(product);
  const skill: ProductSkill =
    existing && existing.slug === slug
      ? existing
      : {
          product,
          slug,
          createdAt: now,
          updatedAt: now,
          takes: 0,
          successes: 0,
          steps: [],
          gotchas: [],
          history: [],
        };

  if (input.url) skill.url = input.url;
  if (input.titleContains) skill.titleContains = input.titleContains;

  const steps = (input.steps ?? []).filter((s) => s && typeof s.op === "string");
  // Agent-curated steps win; auto journals only fill in or refresh other auto journals.
  if (steps.length && (input.source === "agent" || skill.stepsSource !== "agent")) {
    skill.steps = steps.slice(0, MAX_SKILL_STEPS);
    skill.stepsSource = input.source;
  }

  for (const g of input.gotchas ?? []) {
    const t = g.trim();
    if (t.length < 4) continue;
    const norm = t.toLowerCase();
    if (!skill.gotchas.some((x) => x.toLowerCase() === norm)) skill.gotchas.push(t);
  }
  skill.gotchas = skill.gotchas.slice(-MAX_GOTCHAS);

  if (input.outcome) {
    skill.takes += 1;
    const o = input.outcome.trim();
    if (/^(success|good|ok|worked)\b/i.test(o) && !/fail|autoZooms=0\b/i.test(o)) {
      skill.successes += 1;
    }
    skill.history.push({ at: now, outcome: input.outcome, note: input.note });
    skill.history = skill.history.slice(-MAX_HISTORY);
  }
  skill.updatedAt = now;

  fs.writeFileSync(skillPath(slug, "json"), JSON.stringify(skill, null, 2), "utf8");
  fs.writeFileSync(skillPath(slug, "md"), renderProductSkill(skill), "utf8");
  // Keep the shared markdown's product index fresh.
  fs.writeFileSync(growingSkillPath(), renderGrowingMarkdown(loadLessons()), "utf8");
  return skill;
}
