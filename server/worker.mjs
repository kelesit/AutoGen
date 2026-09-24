import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database.mjs";
import { createEngine } from "./engine.mjs";
const dataDir =
  process.env.DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data-v2");
const db = openDatabase(dataDir);
const engine = createEngine({ db, dataDir });
let stopped = false;
async function run() {
  if (stopped) return;
  try {
    await engine.tick();
  } catch (error) {
    console.error("Worker tick failed; lease will expire:", error);
  }
  setTimeout(run, 250);
}
run();
console.log(`Playbox durable worker ready (pid ${process.pid})`);
function stop() {
  stopped = true;
  engine.close();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
