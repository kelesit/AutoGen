import { randomUUID, createHash } from "node:crypto";
import { transact } from "./database.mjs";
import { createProvider } from "./provider.mjs";
import { createAssetService } from "./asset-service.mjs";
import { finishHeldCredits } from "./billing-service.mjs";
export const scenarios = [
  "normal",
  "accept_timeout",
  "unknown_no_lookup",
  "rate_limit",
  "download_once",
  "provider_fail",
];
export const terminal = ["completed", "failed", "cancelled"];
export const templateSnapshot = (template) => ({
  ...template,
  model: "mock-video-v1",
  preset: template.promptRecipe,
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (data) => createHash("sha256").update(data).digest("hex");
export function createEngine({
  db,
  dataDir,
  jobDuration = 14000,
  leaseMs = 5000,
  pollMs = 600,
  retryMs = 1500,
  maxRetries = 3,
  provider: adapter,
  afterSubmit,
  afterPersist,
} = {}) {
  const provider = adapter || createProvider(dataDir, jobDuration);
  const tx = (fn) => transact(db, fn);
  const assets = createAssetService(db, dataDir);
  const get = (id) => db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  const event = (id, kind, message) =>
    db
      .prepare("INSERT INTO job_events(job_id,kind,message,created_at) VALUES (?,?,?,?)")
      .run(id, kind, message, Date.now());
  const attempt = (id, phase, outcome, detail = "") =>
    db
      .prepare(
        "INSERT INTO provider_attempts(job_id,phase,outcome,detail,created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, phase, outcome, detail, Date.now());
  const runtime = (key) => db.prepare("SELECT value FROM runtime WHERE key=?").get(key).value;
  const setRuntime = (key, value) =>
    db.prepare("UPDATE runtime SET value=? WHERE key=?").run(value, key);
  const finishBilling = (job, settle) => finishHeldCredits(db, job, settle, event);
  function review(job, phase, message) {
    db.prepare("UPDATE jobs SET status='needs_review',review_phase=?,error=? WHERE id=?").run(
      phase,
      message,
      job.id,
    );
    db.prepare("DELETE FROM work WHERE job_id=?").run(job.id);
    event(job.id, "needs_review", message + "；保留冻结积分，等待核查");
  }
  function schedule(id, delay = 0) {
    db.prepare("UPDATE work SET due_at=?,lease_token=NULL,lease_until=0 WHERE job_id=?").run(
      Date.now() + delay,
      id,
    );
  }
  function retry(job, phase, message) {
    const retries = job.retries + 1;
    db.prepare("UPDATE jobs SET retries=?,error=? WHERE id=?").run(retries, message, job.id);
    if (retries >= maxRetries) {
      review(job, phase, "自动重试预算耗尽：" + message);
      return;
    }
    const delay = Math.min(30000, retryMs * 2 ** (retries - 1));
    schedule(job.id, delay);
    event(job.id, "retry", `${phase} 将在 ${delay} ms 后重试（${retries}/${maxRetries}）`);
  }
  // Caller must hold the app DB transaction. Terminal states never regress.
  function applyResult(job, result) {
    if (terminal.includes(job.status) || ["persisting", "needs_review"].includes(job.status))
      return false;
    if (result.id !== job.provider_id) throw fail(409, "供应商任务标识不匹配");
    if (result.status === "running") {
      if (job.status !== "running")
        db.prepare("UPDATE jobs SET status='running',progress=35 WHERE id=?").run(job.id);
      return true;
    }
    if (!["succeeded", "failed"].includes(result.status)) throw fail(400, "未知供应商事件");
    db.prepare(
      "INSERT OR IGNORE INTO provider_costs(job_id,provider_id,cost_units,created_at) VALUES (?,?,?,?)",
    ).run(job.id, result.id, result.costUnits, Date.now());
    if (result.status === "failed") {
      db.prepare(
        "UPDATE jobs SET status='failed',error='模拟供应商确认生成失败',completed_at=? WHERE id=?",
      ).run(Date.now(), job.id);
      finishBilling(job, false);
      db.prepare("DELETE FROM work WHERE job_id=?").run(job.id);
      event(job.id, "failed", "供应商确认失败；供应商模拟成本单独记录");
    } else {
      db.prepare(
        "UPDATE jobs SET status='persisting',progress=90,error=NULL,retries=0 WHERE id=?",
      ).run(job.id);
      event(job.id, "generated", "供应商生成成功，开始保存作品；暂不结算");
    }
    return true;
  }
  function claim() {
    return tx(() => {
      const now = Date.now();
      setRuntime("heartbeat", now);
      const rows = db
        .prepare(
          "SELECT jobs.* FROM work JOIN jobs ON jobs.id=work.job_id WHERE due_at<=? AND lease_until<=? ORDER BY CASE WHEN jobs.status='queued' THEN 1 ELSE 0 END,due_at,created_at LIMIT 50",
        )
        .all(now, now);
      for (const job of rows) {
        if (terminal.includes(job.status) || job.status === "needs_review") {
          db.prepare("DELETE FROM work WHERE job_id=?").run(job.id);
          continue;
        }
        if (job.status === "queued") {
          const occupied = db
            .prepare(
              "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('submitting','submission_unknown','running') OR (status='needs_review' AND review_phase IN ('lookup','poll'))",
            )
            .get().n;
          if (occupied >= 2 || runtime("paused_until") > now) continue;
          db.prepare("UPDATE jobs SET status='submitting',progress=5 WHERE id=?").run(job.id);
          event(job.id, "submitting", "占用供应商并发名额，准备提交（全局上限 2）");
        }
        const token = randomUUID();
        db.prepare("UPDATE work SET lease_token=?,lease_until=? WHERE job_id=?").run(
          token,
          now + leaseMs,
          job.id,
        );
        return { job: get(job.id), token, wasQueued: job.status === "queued" };
      }
      return null;
    });
  }
  async function tick() {
    assets.cleanup();
    const claimResult = claim();
    if (!claimResult) return false;
    const { job, token, wasQueued } = claimResult;
    const phase =
      job.status === "persisting"
        ? "download"
        : job.status === "running"
          ? "poll"
          : wasQueued
            ? "submit"
            : "lookup";
    let result, problem;
    try {
      if (phase === "submit") {
        const snapshot = JSON.parse(job.template_snapshot);
        const input = { slots: {}, motionVideos: [] };
        try {
          const refs = db
            .prepare("SELECT * FROM job_input_assets WHERE job_id=? ORDER BY slot_key")
            .all(job.id);
          for (const ref of refs) {
            const bytes = assets.read(ref.asset_id);
            const info = { bytes: bytes.length, sha256: digest(bytes) };
            if (ref.role === "image") input.slots[ref.slot_key] = info;
            else input.motionVideos.push({ id: ref.asset_id, ...info });
          }
          if (
            Object.keys(input.slots).length !== snapshot.inputSlots.length ||
            input.motionVideos.length !== snapshot.motionVideoIds.length
          )
            throw new Error("missing input relations");
        } catch {
          throw Object.assign(new Error("输入素材不可读取，尚未提交给供应商"), { code: "INPUT" });
        }
        // Mock receives the validated input digest; a real adapter must upload the
        // private file server-to-server or issue an expiring scoped object URL.
        result = await provider.submit(job, {
          model: snapshot.model,
          prompt: `${snapshot.preset}\n${job.prompt}`,
          resolution: job.resolution,
          duration: job.duration,
          input,
        });
        await afterSubmit?.(job, result); // crash harness hook, never enabled by the UI
      } else if (phase === "lookup") result = await provider.lookup(job);
      else if (phase === "poll") result = await provider.poll(job.provider_id);
      else {
        const bytes = await provider.download(job);
        if (
          bytes.length < 12 ||
          bytes.length > 20 * 1024 * 1024 ||
          bytes.toString("ascii", 4, 8) !== "ftyp"
        )
          throw Object.assign(new Error("输出类型或大小不符合视频保存要求"), { code: "STORAGE" });
        const asset = assets.stage({
          ownerId: job.user_id,
          kind: "output",
          bytes,
          id: `output-${job.id}`,
          jobId: job.id,
        });
        result = {
          assetId: asset.id,
          filename: asset.filename,
          bytes: asset.bytes,
          sha256: asset.sha256,
        };
        await afterPersist?.(job, result);
      }
    } catch (error) {
      problem = error;
    }
    return tx(() => {
      // Fencing: a slow worker cannot commit after another worker reclaimed it.
      const work = db.prepare("SELECT * FROM work WHERE job_id=?").get(job.id);
      if (!work || work.lease_token !== token || work.lease_until < Date.now()) return false;
      const latest = get(job.id);
      attempt(
        job.id,
        phase,
        problem ? "error" : "ok",
        problem?.message || (phase === "lookup" && !result ? "权威查询确认未接单" : ""),
      );
      if (problem) {
        if (phase === "submit" && problem.code === "INPUT") {
          db.prepare("UPDATE jobs SET status='failed',error=?,completed_at=? WHERE id=?").run(
            problem.message,
            Date.now(),
            job.id,
          );
          finishBilling(latest, false);
          db.prepare("DELETE FROM work WHERE job_id=?").run(job.id);
          event(job.id, "failed", problem.message);
        } else if (phase === "submit" && problem.code === "RATE_LIMIT") {
          db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(job.id);
          setRuntime("paused_until", Date.now() + retryMs);
          event(job.id, "rate_limit", "供应商限流；全局暂停新提交，已有任务继续查询");
          retry(latest, "submit", problem.message);
        } else if (phase === "submit") {
          db.prepare("UPDATE jobs SET status='submission_unknown',error=? WHERE id=?").run(
            problem.message,
            job.id,
          );
          event(job.id, "submission_unknown", "提交结果未知：先按业务单号查单，禁止直接重复生成");
          schedule(job.id, pollMs);
        } else if (problem.code === "UNSUPPORTED")
          review(latest, "lookup", "供应商不支持可靠查单，无法安全自动恢复");
        else {
          if (phase !== "download") {
            const count = runtime("consecutive_errors") + 1;
            setRuntime("consecutive_errors", count);
            if (count >= 3) {
              setRuntime("paused_until", Date.now() + 30000);
              event(job.id, "circuit_open", "连续外部错误，暂停新提交 30 秒");
            }
          }
          retry(latest, phase, problem.message);
        }
        return true;
      }
      setRuntime("consecutive_errors", 0);
      if (phase === "submit" || phase === "lookup") {
        if (!result) {
          // Only our simulator's authoritative lookup allows this transition.
          db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(job.id);
          event(job.id, "not_accepted", "模拟供应商权威查单确认未接单，允许按预算重新排队");
          retry(latest, "submit", "提交未成功且权威查单确认未接单");
        } else {
          const now = Date.now();
          const acceptedAt =
            Number.isSafeInteger(result.created_at) &&
            result.created_at >= job.created_at &&
            result.created_at <= now
              ? result.created_at
              : now;
          db.prepare(
            "UPDATE jobs SET provider_id=?,accepted_at=COALESCE(accepted_at,?),status='running',progress=35,error=NULL,retries=0 WHERE id=?",
          ).run(result.id, acceptedAt, job.id);
          event(
            job.id,
            phase === "lookup" ? "reconciled" : "accepted",
            `${phase === "lookup" ? "查单恢复" : "供应商接单"}：${result.id}`,
          );
          schedule(job.id, pollMs);
        }
      } else if (phase === "poll") {
        if (Date.now() - (job.accepted_at ?? job.created_at) > 180000 && result.status === "running")
          review(latest, "poll", "超过生成等待上限，供应商最终结果仍待核查");
        else {
          applyResult(latest, result);
          schedule(job.id, pollMs);
        }
      } else {
        const completedAt = Date.now();
        assets.ready(result.assetId);
        db.prepare(`INSERT INTO creations(id,job_id,user_id,asset_id,created_at)
          VALUES (?,?,?,?,?)`).run(job.id, job.id, job.user_id, result.assetId, completedAt);
        db.prepare(
          "UPDATE jobs SET status='completed',progress=100,completed_at=?,error=NULL,retries=0 WHERE id=?",
        ).run(completedAt, job.id);
        finishBilling(latest, true);
        event(
          job.id,
          "stored",
          `作品已持久保存 · ${result.bytes} bytes · SHA-256 ${result.sha256}`,
        );
        db.prepare("DELETE FROM work WHERE job_id=?").run(job.id);
      }
      return true;
    });
  }
  return {
    tick,
    event,
    cancel(id, userId) {
      return tx(() => {
        const job = get(id);
        if (!job || job.user_id !== userId) throw fail(404, "任务不存在。");
        if (job.status === "cancelled") return job;
        if (job.status !== "queued")
          throw fail(409, "供应商不支持可靠取消。任务已进入提交或处理阶段，暂不能取消或释放积分。");
        db.prepare(
          "UPDATE jobs SET status='cancelled',completed_at=?,error='排队阶段取消，冻结积分已释放' WHERE id=?",
        ).run(Date.now(), id);
        finishBilling(job, false);
        db.prepare("DELETE FROM work WHERE job_id=?").run(id);
        event(id, "cancelled", "用户取消尚未提交的任务");
        return get(id);
      });
    },
    applyProviderEvent(id, result) {
      return tx(() => {
        const job = get(id);
        if (!job) throw fail(404, "任务不存在");
        const applied = applyResult(job, result);
        event(
          id,
          applied ? "provider_event" : "ignored_event",
          applied ? "供应商事件已应用" : "重复或过期事件已忽略",
        );
        return applied;
      });
    },
    recover(id, actor) {
      return tx(() => {
        const job = get(id);
        if (!job || job.status !== "needs_review") throw fail(409, "只有待核查任务可以恢复。");
        if (job.scenario === "unknown_no_lookup")
          throw fail(409, "供应商仍不支持可靠查单。不能用重新提交代替核查。");
        const status = {
          lookup: "submission_unknown",
          poll: "running",
          download: "persisting",
          submit: "queued",
        }[job.review_phase];
        if (!status) throw fail(409, "没有可恢复的执行阶段");
        db.prepare("UPDATE jobs SET status=?,retries=0,error=NULL WHERE id=?").run(status, id);
        db.prepare("INSERT INTO work(job_id,due_at) VALUES (?,?)").run(id, Date.now());
        event(
          id,
          "admin_recover",
          `管理员 ${actor} 恢复 ${job.review_phase} 阶段；不创建新的生成任务`,
        );
        return get(id);
      });
    },
    detail(id) {
      return {
        events: db.prepare("SELECT * FROM job_events WHERE job_id=? ORDER BY id").all(id),
        attempts: db.prepare("SELECT * FROM provider_attempts WHERE job_id=? ORDER BY id").all(id),
        media:
          db
            .prepare(
              "SELECT a.* FROM assets a JOIN job_outputs o ON o.asset_id=a.id WHERE o.job_id=?",
            )
            .get(id) || null,
        supplier_cost: db.prepare("SELECT * FROM provider_costs WHERE job_id=?").get(id) || null,
        work: db.prepare("SELECT due_at,lease_until FROM work WHERE job_id=?").get(id) || null,
      };
    },
    health() {
      return {
        heartbeat: runtime("heartbeat"),
        worker_online: Date.now() - runtime("heartbeat") < 10000,
        paused_until: runtime("paused_until"),
        max_concurrency: 2,
        needs_review: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='needs_review'").get()
          .n,
      };
    },
    close: () => provider.close(),
  };
}
