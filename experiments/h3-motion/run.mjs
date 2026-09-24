#!/usr/bin/env node
// Dry-run by default. --submit is the only path that spends MiniMax API credit.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { compileH3MotionRequest } from "./compile.mjs";

const configPath = process.argv[2];
const shouldSubmit = process.argv.includes("--submit");
if (!configPath || configPath.startsWith("--")) {
  console.error("Usage: node experiments/h3-motion/run.mjs <config.json> [--submit]");
  process.exit(2);
}

const config = JSON.parse(await readFile(resolve(configPath), "utf8"));
const { request, trace } = compileH3MotionRequest(config);
const outputDir = resolve(config.outputDir ?? "./experiments/h3-motion/output");
await mkdir(outputDir, { recursive: true });
const manifestPath = join(outputDir, "manifest.json");
let previous;
try {
  previous = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (previous && previous.status !== "prepared") {
  throw new Error(`Existing ${previous.status} run at ${manifestPath}; use a new outputDir for a new experiment`);
}
const manifest = {
  ...trace,
  model: request.model,
  resolution: request.resolution,
  duration: request.duration,
  ratio: request.ratio,
  compiledPrompt: request.content[0].text,
  status: "prepared",
  createdAt: new Date().toISOString(),
};
async function saveManifest() {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
}
const apiKey = process.env.MINIMAX_API_KEY;
if (shouldSubmit) {
  if (!apiKey) throw new Error("MINIMAX_API_KEY is required with --submit");
  // Keep this marker after crashes: an uncertain create response is never
  // automatically replayed, even when the manifest still says prepared.
  await writeFile(join(outputDir, "submission.lock"), new Date().toISOString(), {
    flag: "wx", mode: 0o600,
  });
}
await saveManifest();
if (!shouldSubmit) {
  console.log(`H3 request prepared: ${manifestPath}`);
  console.log("No provider call made. Pass --submit to create a billable task.");
  process.exit(0);
}

const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
const base = "https://api.minimax.io";
async function jsonResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`MiniMax ${response.status}: ${message}`);
  }
  return body;
}

try {
  // H3 does not expose a documented client idempotency key. An uncertain POST
  // result must be reconciled manually, never automatically submitted again.
  manifest.status = "submitting";
  await saveManifest();
  const created = await jsonResponse(await fetch(`${base}/v2/video_generation`, {
    method: "POST", headers, body: JSON.stringify(request), signal: AbortSignal.timeout(60000),
  }));
  if (!created.task_id) throw new Error("MiniMax response did not include task_id");
  manifest.taskId = created.task_id;
  manifest.status = "accepted";
  await saveManifest();
  console.log(`MiniMax task accepted: ${created.task_id}`);

  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 10000));
    const response = await jsonResponse(await fetch(
      `${base}/v2/query/video_generation/${encodeURIComponent(created.task_id)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000) },
    ));
    const task = response.task;
    if (!task || task.id !== created.task_id) throw new Error("Unexpected MiniMax task response");
    manifest.status = task.status;
    manifest.usage = task.usage ?? null;
    await saveManifest();
    if (task.status === "failed" || task.status === "cancelled")
      throw new Error(`MiniMax task ${task.status}: ${task.error?.message ?? "unknown reason"}`);
    if (task.status !== "succeeded") continue;
    if (!task.content?.url) throw new Error("Succeeded task has no output URL");
    const video = await fetch(task.content.url, { signal: AbortSignal.timeout(120000) });
    if (!video.ok) throw new Error(`Output download failed: HTTP ${video.status}`);
    const bytes = Buffer.from(await video.arrayBuffer());
    if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp")
      throw new Error("Downloaded output is not an MP4 file");
    const outputPath = join(outputDir, `${created.task_id}.mp4`);
    await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
    manifest.outputFile = outputPath;
    manifest.outputBytes = bytes.length;
    manifest.status = "stored";
    await saveManifest();
    console.log(`Video stored: ${outputPath}`);
    process.exit(0);
  }
  throw new Error("Polling timed out; query the recorded taskId before taking any further action");
} catch (error) {
  manifest.error = error.message;
  if (manifest.status === "submitting") manifest.status = "submission_unknown";
  await saveManifest();
  console.error(`${error.message}. Manifest: ${manifestPath}`);
  process.exit(1);
}
