// The three prompts in prompts/ are code. They are never inlined here: every LLM call
// loads its system prompt through loadPrompt() so a prompt edit is a diffable file change.

const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;

const cache = new Map();

/** Strip the leading `<!-- prompt: ... | version: N | ... -->` header and read its version. */
export function parsePrompt(raw) {
  const m = /^﻿?\s*<!--([\s\S]*?)-->[ \t]*\r?\n?/.exec(raw);
  if (!m) return { text: raw.trim(), version: null };
  const v = /version:\s*(\d+)/i.exec(m[1]);
  return { text: raw.slice(m[0].length).trim(), version: v ? Number(v[1]) : null };
}

function urlFor(name) {
  return new URL(`../prompts/${name}.md`, import.meta.url);
}

async function readRaw(name) {
  const url = urlFor(name);
  if (IS_NODE) {
    const { readFile } = await import("node:fs/promises");
    return readFile(url, "utf8");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot load prompt ${name}: HTTP ${res.status}`);
  return res.text();
}

/** loadPrompt("extract") -> { text, version }. Cached per process/page. */
export async function loadPrompt(name) {
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`bad prompt name: ${name}`);
  if (cache.has(name)) return cache.get(name);
  let raw;
  try {
    raw = await readRaw(name);
  } catch (err) {
    throw new Error(`cannot load prompt "${name}": ${err.message}`);
  }
  const parsed = Object.freeze(parsePrompt(raw));
  if (!parsed.text) throw new Error(`prompt "${name}" is empty`);
  cache.set(name, parsed);
  return parsed;
}

/** Versions of all three prompts, for report meta. */
export async function promptVersions() {
  const [extract, probe_gen, judge] = await Promise.all([
    loadPrompt("extract"),
    loadPrompt("probe_gen"),
    loadPrompt("judge"),
  ]);
  return { extract: extract.version, probe_gen: probe_gen.version, judge: judge.version };
}
