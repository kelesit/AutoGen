// Stateful test double for an external service. Its database is independent from
// the application transaction: acceptance can survive an application crash.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const sample = fileURLToPath(new URL("../public/media/sample.mp4", import.meta.url));
const error = (code, message) => Object.assign(new Error(message), { code });
export function createProvider(dataDir, duration = 14000) {
  const db = new DatabaseSync(path.join(dataDir, "provider.sqlite"));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,business_key TEXT UNIQUE NOT NULL,scenario TEXT NOT NULL,payload TEXT NOT NULL,ready_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS faults(key TEXT PRIMARY KEY);
 `);
  function once(key) {
    return db.prepare("INSERT OR IGNORE INTO faults VALUES (?)").run(key).changes > 0;
  }
  return {
    name: "stateful-mock",
    capabilities: { businessKeyLookup: true, idempotentSubmission: true, cancel: false },
    submit(job, payload) {
      if (job.scenario === "rate_limit" && once(`rate-${job.id}`))
        throw error("RATE_LIMIT", "模拟 HTTP 429，尚未接单");
      const existing = db.prepare("SELECT * FROM tasks WHERE business_key=?").get(job.id);
      if (existing) return existing;
      const task = {
        id: randomUUID(),
        business_key: job.id,
        scenario: job.scenario,
        payload: JSON.stringify(payload),
        ready_at: Date.now() + duration,
        created_at: Date.now(),
      };
      db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run(...Object.values(task));
      if (["accept_timeout", "unknown_no_lookup"].includes(job.scenario))
        throw error("UNKNOWN", "供应商已接单，但提交响应丢失");
      return task;
    },
    lookup(job) {
      if (job.scenario === "unknown_no_lookup")
        throw error("UNSUPPORTED", "该演示场景禁用供应商业务单号查询能力");
      // This simulator guarantees an authoritative, strongly consistent lookup.
      // A real eventually consistent "not found" must not authorize resubmission.
      return db.prepare("SELECT * FROM tasks WHERE business_key=?").get(job.id) || null;
    },
    poll(providerId) {
      const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(providerId);
      if (!task) throw error("UNKNOWN", "供应商记录暂不可查询");
      return {
        id: task.id,
        status:
          Date.now() < task.ready_at
            ? "running"
            : task.scenario === "provider_fail"
              ? "failed"
              : "succeeded",
        costUnits: task.scenario === "provider_fail" ? 2 : 8,
      };
    },
    download(job) {
      if (job.scenario === "download_once" && once(`download-${job.id}`))
        throw error("STORAGE", "首次获取输出失败，生成结果仍保留在供应商");
      return readFileSync(sample);
    },
    close: () => db.close(),
  };
}
