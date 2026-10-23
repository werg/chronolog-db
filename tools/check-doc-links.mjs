#!/usr/bin/env node
/* global process, console */
// Verifies that every relative Markdown link in the repository resolves to an
// existing file or directory and that `#fragment` anchors match a heading in the
// target Markdown file. External (scheme-qualified) links are not fetched.
//
// Also checks `docs/...md#anchor` policy pointers embedded in JSON documents
// under docs/ (for example the compatibility ledger).
//
// Usage: node tools/check-doc-links.mjs [root]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "artifacts",
  ".chaos",
  ".chronolog",
  ".claude",
  ".cache",
]);

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Remove fenced code blocks and inline code spans, preserving line numbers. */
function stripCode(text) {
  const lines = text.split("\n");
  let fence = null;
  const kept = lines.map((line) => {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (match) {
        fence = match[1][0];
        return "";
      }
      return line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
    }
    if (match && match[1][0] === fence) fence = null;
    return "";
  });
  return kept;
}

function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

const anchorCache = new Map();
function anchorsOf(file) {
  let anchors = anchorCache.get(file);
  if (anchors) return anchors;
  anchors = new Set();
  const seen = new Map();
  for (const line of stripCode(readFileSync(file, "utf8"))) {
    const match = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = slugify(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

const problems = [];
const display = (file) => relative(root, file).split(sep).join("/");

function checkTarget(fromFile, lineNo, rawTarget, label = display(fromFile), baseDir = dirname(fromFile)) {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  if (target === "" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//")) return;
  const hashAt = target.indexOf("#");
  const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : decodeURIComponent(target.slice(hashAt + 1));
  const resolved = pathPart === "" ? fromFile : resolve(baseDir, decodeURIComponent(pathPart));
  if (!resolved.startsWith(root) || !existsSync(resolved)) {
    problems.push(`${label}:${lineNo}: broken link target "${rawTarget}"`);
    return;
  }
  if (fragment !== "" && statSync(resolved).isFile() && resolved.endsWith(".md")) {
    if (!anchorsOf(resolved).has(fragment.toLowerCase())) {
      problems.push(`${label}:${lineNo}: missing anchor "#${fragment}" in ${display(resolved)}`);
    }
  }
}

const files = walk(root, []);
for (const file of files) {
  const lines = stripCode(readFileSync(file, "utf8"));
  const definitions = new Map();
  lines.forEach((line, index) => {
    const def = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/.exec(line);
    if (def) {
      definitions.set(def[1].toLowerCase(), def[2]);
      checkTarget(file, index + 1, def[2]);
    }
  });
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/!?\[(?:[^\]]|\[[^\]]*\])*\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/g)) {
      checkTarget(file, index + 1, match[1]);
    }
    for (const match of line.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const key = (match[2] || match[1]).toLowerCase();
      if (!definitions.has(key)) {
        problems.push(`${display(file)}:${index + 1}: undefined link reference "${match[0]}"`);
      }
    }
  });
}

// Markdown pointers embedded in JSON documents under docs/.
const docsDir = join(root, "docs");
if (existsSync(docsDir)) {
  for (const entry of readdirSync(docsDir)) {
    if (!entry.endsWith(".json")) continue;
    const file = join(docsDir, entry);
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/"((?:docs|\.)\/[^"\s]*\.md)(#[^"\s]*)?"/g)) {
        checkTarget(file, index + 1, match[1] + (match[2] ?? ""), display(file), root);
      }
    });
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} documentation link problem(s) in ${files.length} Markdown file(s).`);
  process.exit(1);
}
console.log(`Documentation links OK (${files.length} Markdown files checked).`);
