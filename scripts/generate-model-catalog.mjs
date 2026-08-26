#!/usr/bin/env node
// Generate src/models/catalog.generated.json — CodeBuddy model list (CN + Intl)
// enriched with full specs from https://models.dev/api.json.
// Pattern follows badlogic/pi-mono scripts/generate-models.ts (build-time snapshot,
// narrow corrections over upstream metadata). Re-run whenever catalogs change:
//   bun scripts/generate-model-catalog.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---- CodeBuddy availability lists ----------------------------------------
// CN: copilot.tencent.com — dnwwdwd/converter.py:212 DEFAULT_MODELS + CLIProxyPlus executor extras
const CN_MODELS = [
  "auto",
  "glm-5.2", "glm-5.1", "glm-5v-turbo", "glm-5", "glm-4.7", "glm-4.6",
  "kimi-k2.7", "kimi-k2.6", "kimi-k2.5",
  "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3",
  "minimax-m3-pay", "minimax-m2.5",
  "hy3-preview-agent", "hy3",
  "hunyuan-2.0-instruct", "hunyuan-2.0-thinking", "hunyuan-turbos",
];
// Intl: www.codebuddy.ai — live GET /v3/config probe 2026-08-26 (35 raw)
const INTL_MODELS = [
  "default-model", "default-model-lite", "fast-model", "balanced-model", "primary-model", "deep-model",
  "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini",
  "gemini-3.1-pro", "gemini-3.0-flash", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-pro",
  "deepseek-v3-2-volc", "glm-5.0", "glm-5.2", "glm-5.3", "hy3", "kimi-k2.5", "kimi-k2.6", "kimi-k3", "minimax-m3",
  "gemini-3.0-pro-image", "gemini-3.1-flash-image", "gemini-2.5-flash-image",
  "hunyuan-image-v3.0", "hunyuan-image-v2.0-general-edit", "hunyuan-video-art",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

// ---- models.dev reference mapping ----------------------------------------
// [providerId, modelId] on models.dev; null => alias/no external spec.
const MODELSDEV_MAP = {
  // shared / CN+Intl
  "glm-5.2": ["zai", "glm-5.2"],
  "glm-5.3": ["zai", "glm-5.3"],
  "glm-5.1": ["zai", "glm-5.1"],
  "glm-5": ["zai", "glm-5"],
  "glm-5v-turbo": ["zai", "glm-5v-turbo"],
  "glm-4.7": ["zai", "glm-4.7"],
  "glm-4.6": ["zai", "glm-4.6"],
  "glm-5.0": ["zai", "glm-5"], // proxy naming; real window may differ
  "kimi-k2.5": ["moonshotai", "kimi-k2.5"],
  "kimi-k2.6": ["moonshotai", "kimi-k2.6"],
  "kimi-k3": ["moonshotai", "kimi-k3"],
  "kimi-k2.7": ["moonshotai", "kimi-k2.7-code"], // closest k2.7 entry
  "deepseek-v4-pro": ["deepseek", "deepseek-v4-pro"],
  "deepseek-v4-flash": ["deepseek", "deepseek-v4-flash"],
  "hy3": ["tencent-token-plan", "hy3"],
  "hy3-preview-agent": ["tencent-token-plan", "hy3"], // agent wrapper of hy3
  "hunyuan-2.0-instruct": ["tencent-coding-plan", "hunyuan-2.0-instruct"],
  "hunyuan-2.0-thinking": ["tencent-coding-plan", "hunyuan-2.0-thinking"],
  "hunyuan-turbos": ["tencent-coding-plan", "hunyuan-turbos"],
  "minimax-m3": ["minimax", "MiniMax-M3"],
  "minimax-m3-pay": ["minimax", "MiniMax-M3"],
  "minimax-m2.5": ["minimax", "MiniMax-M2.5"],
  // Intl western
  "gpt-5.5": ["openai", "gpt-5.5"],
  "gpt-5.4": ["openai", "gpt-5.4"],
  "gpt-5.3-codex": ["openai", "gpt-5.3-codex"],
  "gpt-5.1-codex": ["openai", "gpt-5.1"], // approximate
  "gpt-5.1-codex-mini": ["openai", "gpt-5-mini"], // approximate
  "gpt-5.6-sol": ["openai", "gpt-5.6-sol"],
  "gpt-5.6-terra": ["openai", "gpt-5.6-terra"],
  "gpt-5.6-luna": ["openai", "gpt-5.6-luna"],
  "gemini-3.1-pro": ["google", "gemini-3.1-pro-preview"],
  "gemini-3.5-flash": ["google", "gemini-3.5-flash"],
  "gemini-3.0-flash": ["google", "gemini-3-flash-preview"], // approximate
  "gemini-3.1-flash-lite": ["google", "gemini-3.1-flash-lite"],
  "gemini-2.5-flash": ["google", "gemini-2.5-flash"],
  "gemini-2.5-pro": ["google", "gemini-2.5-pro"],
  "gemini-3.0-pro-image": ["google", "gemini-3-pro-image"],
  "gemini-3.1-flash-image": ["google", "gemini-3.1-flash-image"],
  "gemini-2.5-flash-image": ["google", "gemini-2.5-flash-image"],
};

function specFrom(modelsDev, ref) {
  if (!ref) return null;
  const [prov, model] = ref;
  const entry = modelsDev?.[prov]?.models?.[model];
  if (!entry) return null;
  return {
    modelsDevRef: `${prov}/${model}`,
    name: entry.name ?? null,
    reasoning: entry.reasoning ?? false,
    toolCall: entry.tool_call ?? false,
    structuredOutput: entry.structured_output ?? false,
    temperature: entry.temperature ?? true,
    knowledge: entry.knowledge ?? null,
    releaseDate: entry.release_date ?? null,
    modalities: entry.modalities ?? null,
    limit: entry.limit ?? null,
    cost: entry.cost ?? null,
  };
}

async function main() {
  const res = await fetch("https://models.dev/api.json");
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
  const modelsDev = await res.json();

  const build = (ids, site) =>
    ids.map((id) => {
      const spec = specFrom(modelsDev, MODELSDEV_MAP[id] ?? null);
      return {
        id,
        sites: [site],
        status: spec ? "spec-ok" : "no-external-spec", // aliases & image/video may lack specs
        spec,
      };
    });

  const byId = new Map();
  for (const e of [...build(CN_MODELS, "cn"), ...build(INTL_MODELS, "intl")]) {
    const prev = byId.get(e.id);
    if (prev) {
      prev.sites = Array.from(new Set([...prev.sites, ...e.sites]));
      if (!prev.spec && e.spec) prev.spec = e.spec;
      if (prev.spec && e.spec) prev.status = "spec-ok";
    } else {
      byId.set(e.id, { ...e });
    }
  }

  const out = {
    generated: new Date().toISOString(),
    source: "https://models.dev/api.json + codebuddy v3/config probes (cn 2025-08 research, intl 2026-08-26)",
    note: "specs are proxied from models.dev refs — context/cost may differ from CodeBuddy actual billing",
    models: Array.from(byId.values()),
  };

  const dest = resolve(process.cwd(), "src/models/catalog.generated.json");
  // Idempotent: skip the write when only the generated timestamp would change.
  try {
    const prev = JSON.parse(readFileSync(dest, "utf8"));
    if (JSON.stringify(prev.models) === JSON.stringify(out.models)) {
      console.log(`unchanged: ${dest} (${out.models.length} models)`);
      return;
    }
  } catch {
    // first run or unreadable — fall through to write
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  const okSpec = out.models.filter((m) => m.spec).length;
  console.log(`wrote ${dest}: ${out.models.length} models (${okSpec} with models.dev spec, CN ${CN_MODELS.length}, Intl ${INTL_MODELS.length})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
