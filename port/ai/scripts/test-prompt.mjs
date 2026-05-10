// Smoke-test the prompt the runner sends to the agent. Builds the
// prompt, calls `claude --print`, validates the output. Doesn't run
// any eval - just checks the LLM produces something we can parse.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const aiRoot = resolve(here, "..");

const programMd = readFileSync(resolve(aiRoot, "program.md"), "utf8");
const currentProgram = readFileSync(resolve(aiRoot, "research_program.ts"), "utf8");

const prompt = [
  "# autoresearch loop iteration",
  "",
  "## program.md (the steering wheel)",
  programMd,
  "",
  "## research_log.jsonl (last 30 entries; oldest first)",
  "```jsonl",
  "(no prior iterations)",
  "```",
  "",
  "## current research_program.ts",
  "```typescript",
  currentProgram,
  "```",
  "",
  "## task",
  "Hypothesise ONE change to TRAINING_CONFIG. Edit research_program.ts ",
  "(only that file, only TRAINING_CONFIG and NOTES inside it). Update ",
  "NOTES to record what you changed and why. ",
  "",
  "Output: write the COMPLETE new contents of research_program.ts to ",
  "stdout, surrounded by a single ``` typescript code fence. Output ",
  "nothing else.",
].join("\n");

console.error(`[test-prompt] prompt length: ${prompt.length} chars`);
console.error(`[test-prompt] calling claude --print ...`);

const t0 = Date.now();
const result = spawnSync("claude", ["--print"], {
  input: prompt,
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
});
const dt = (Date.now() - t0) / 1000;

console.error(`[test-prompt] elapsed: ${dt.toFixed(1)}s status=${result.status}`);
if (result.status !== 0) {
  console.error("STDERR:", result.stderr);
  process.exit(1);
}

const out = result.stdout;
console.error(`[test-prompt] stdout length: ${out.length} chars`);

// Show the first 200 and last 200 chars to eyeball the format.
console.error("\n--- FIRST 200 chars ---");
console.error(out.slice(0, 200));
console.error("\n--- LAST 200 chars ---");
console.error(out.slice(-200));

// Try the runner's stripCodeFence logic.
const m = out.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)\n```/);
if (m) {
  console.error("\n[test-prompt] STRIP: code fence matched, inner length=", m[1].length);
  // Look for the required fields.
  const required = ["gridSize", "raySamples", "TRAINING_CONFIG", "NOTES"];
  for (const k of required) {
    console.error(`  ${k}: ${m[1].includes(k) ? "OK" : "MISSING"}`);
  }
} else {
  console.error("\n[test-prompt] STRIP: NO code fence found!");
  process.exit(2);
}
