/**
 * Cross-client compatibility (Claude, ChatGPT, Gemini, Cursor).
 *
 * - Gemini's function-calling API rejects `$schema` / `additionalProperties` / `const`
 *   in tool schemas — strip them on the wire (zod validation on our side is unchanged).
 * - ChatGPT and Gemini lean on the MCP `instructions` field for cross-tool workflow;
 *   Claude reads it too, so it stays short and agrees with the full guide.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type Json = unknown;

export function cleanSchema(node: Json): Json {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== "object") return node;
  const src = node as Record<string, Json>;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "$schema" || k === "additionalProperties" || k === "$id") continue;
    if (k === "const") {
      out.enum = [v];
      continue;
    }
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const props: Record<string, Json> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, Json>)) props[pk] = cleanSchema(pv);
      out.properties = props;
      continue;
    }
    out[k] = cleanSchema(v);
  }
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

/** Rewrites `tools/list` responses so every client accepts the schemas. */
export function withClientCompat<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const msg = message as { result?: { tools?: Array<Record<string, Json>> } };
    const tools = msg?.result?.tools;
    if (Array.isArray(tools)) {
      msg.result!.tools = tools.map((t) => ({
        ...t,
        inputSchema: cleanSchema(t.inputSchema ?? { type: "object", properties: {} }),
        ...(t.outputSchema ? { outputSchema: cleanSchema(t.outputSchema) } : {}),
      }));
    }
    return send(message, options);
  };
  return transport;
}

export const SERVER_INSTRUCTIONS = `Screen Beaver drives the user's Windows desktop (real cursor + keyboard) and its studio to make Screen Studio–style product demo videos. The user gives a short ask ("Canva Instagram post demo"); you do the whole job with these tools only (no shell, no files). The user clicks Export — never call export_mp4 unless asked.

Workflow for every product:
1. get_demo_skill({ product }) — read learned lessons + this product's proven playbook (it grows after every take). If a playbook exists, replay its steps.
2. make_product_tutorial({ topic }) — opens the product once (new tab, never a new window), waits until loaded, returns a screenshot AND screenText (OCR words with nx/ny centers). If you cannot view images, use screenText to find buttons.
3. Phase A (no recording): do the exact lesson with demo_click / demo_type / demo_wait (titleContains = product). After each step call peek_window and check screenText/screenshot. Never ask the user what is on screen.
4. Phase B: open_url (new tab) → start_capture({ titleContains: product }) → replay the same steps → stop_capture → regenerate_zooms → peek_studio.
5. save_product_skill({ product, steps, gotchas }) with what worked (steps are also auto-saved after a successful take) and remember_demo_lesson for general notes.

Rules: click a field before typing (typing zooms follow the caret); type ~150ms/key; wait 800–2500ms after clicks on heavy web apps; if a sign-in page appears, ask the user to sign in (never invent passwords). Reply to the user in ≤6 short lines.`;
