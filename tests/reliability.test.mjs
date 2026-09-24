import { setupCatalog } from "./fixtures/catalog.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { createApp } from "../server/app.mjs";
import { openDatabase } from "../server/database.mjs";
import { createEngine } from "../server/engine.mjs";
import { createProvider } from "../server/provider.mjs";

async function fixture(t, { jobDuration = 0 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "playbox-reliability-"));
  const instance = await createApp({ dataDir, seed: false, jobDuration });
  const { db, engine } = instance;
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie;
  async function request(url, body, key) {
    const response = await fetch(base + url, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: cookie || "",
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    return { status: response.status, data: await response.json() };
  }
  const user = (
    await request("/auth/register", {
      email: `${randomUUID()}@example.test`,
      name: "Reliability",
      password: "LongPassword123",
    })
  ).data.user;
  const domain = setupCatalog(db, dataDir, user.id);
  async function create(scenario = "normal", extra = {}) {
    const key = randomUUID();
    const body = {
      ...domain.jobBody,
      resolution: "720p",
      duration: 4,
      prompt: "test",
      scenario,
      ...extra,
    };
    const response = await request("/jobs", body, key);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return { ...response.data.job, key, body };
  }
  const get = (id) => db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  const step = async (worker = engine) => {
    db.prepare("UPDATE work SET due_at=0").run();
    return worker.tick();
  };
  async function drain(id, worker = engine) {
    for (let i = 0; i < 25; i++) {
      if (["completed", "failed", "cancelled", "needs_review"].includes(get(id).status))
        return get(id);
      await step(worker);
    }
    throw new Error(`Failed to drain ${JSON.stringify(get(id))}`);
  }
  function invariant() {
    const account = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
    const sums = db
      .prepare(
        "SELECT SUM(amount) AS available,SUM(reserved_delta) AS frozen FROM ledger WHERE user_id=?",
      )
      .get(user.id);
    assert.equal(account.credits, sums.available);
    assert.equal(account.reserved, sums.frozen);
    assert.ok(account.credits >= 0 && account.reserved >= 0);
    const held = db
      .prepare(
        "SELECT COALESCE(SUM(cost),0) AS n FROM jobs WHERE user_id=? AND billing_state='held'",
      )
      .get(user.id).n;
    assert.equal(account.reserved, held);
    return account;
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    instance.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, db, engine, user, request, create, get, step, drain, invariant, ...domain };
}

test("接单后响应丢失：查回供应商任务，只提交一次且只结算一次", async (t) => {
  const f = await fixture(t),
    job = await f.create("accept_timeout");
  await f.step();
  assert.equal(f.get(job.id).status, "submission_unknown");
  assert.equal(f.invariant().reserved, 12);
  await f.step();
  assert.equal(f.get(job.id).status, "running");
  assert.ok(f.get(job.id).provider_id);
  assert.equal((await f.drain(job.id)).status, "completed");
  const attempts = f.engine.detail(job.id).attempts;
  assert.equal(attempts.filter((a) => a.phase === "submit").length, 1);
  assert.equal(attempts.filter((a) => a.phase === "lookup").length, 1);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE job_id=? AND kind='settle'").get(job.id).n,
    1,
  );
  assert.equal(f.invariant().credits, 288);
  assert.equal(f.invariant().reserved, 0);
});

test("缺少查单能力：停止自动执行、保留冻结、不盲目重做", async (t) => {
  const f = await fixture(t),
    job = await f.create("unknown_no_lookup");
  assert.equal((await f.drain(job.id)).status, "needs_review");
  assert.equal(f.invariant().reserved, 12);
  for (let i = 0; i < 5; i++) await f.step();
  assert.equal(f.engine.detail(job.id).attempts.filter((a) => a.phase === "submit").length, 1);
  assert.equal((await f.request(`/jobs/${job.id}/cancel`, {})).status, 409);
  f.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(f.user.id);
  assert.equal((await f.request(`/admin/jobs/${job.id}/recover`, {})).status, 409);
});

test("生成等待超限转人工核查，后台统计与冻结状态保持一致", async (t) => {
  const f = await fixture(t, { jobDuration: 200000 });
  const job = await f.create();
  await f.step();
  assert.equal(f.get(job.id).status, "running");
  f.db.prepare("UPDATE jobs SET accepted_at=? WHERE id=?").run(Date.now() - 181000, job.id);
  await f.step();
  assert.equal(f.get(job.id).status, "needs_review");
  assert.equal(f.get(job.id).review_phase, "poll");
  assert.equal(f.invariant().reserved, 12);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE job_id=?").get(job.id).n, 1);
  const collection = await f.request("/collection");
  assert.equal(collection.data.activeTasks, 1);
  assert.equal(collection.data.reviewTasks, 1);
  f.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(f.user.id);
  const admin = await f.request("/admin");
  assert.equal(admin.status, 200);
  assert.equal(admin.data.runtime.max_concurrency, 2);
  assert.equal(admin.data.runtime.worker_online, true);
  assert.equal(admin.data.runtime.needs_review, 1);
  assert.equal(admin.data.stats.active, 1);
  assert.equal(admin.data.jobs.find((item) => item.id === job.id).status, "needs_review");
});

test("排队超过生成等待上限后才接单，不会立即转人工核查", async (t) => {
  const f = await fixture(t, { jobDuration: 200000 });
  const job = await f.create();
  f.db.prepare("UPDATE jobs SET created_at=? WHERE id=?").run(Date.now() - 181000, job.id);
  await f.step();
  const accepted = f.get(job.id);
  assert.equal(accepted.status, "running");
  assert.ok(accepted.accepted_at > accepted.created_at + 180000);
  await f.step();
  assert.equal(f.get(job.id).status, "running");
  assert.equal(f.engine.detail(job.id).work !== null, true);
  f.invariant();
});

test("旧数据库升级后按已有接单记录回填生成等待起点", async (t) => {
  const f = await fixture(t, { jobDuration: 200000 });
  const job = await f.create();
  await f.step();
  const event = f.db.prepare("SELECT created_at FROM job_events WHERE job_id=? AND kind='accepted'").get(job.id);
  f.db.exec("ALTER TABLE jobs DROP COLUMN accepted_at");
  f.db.exec("PRAGMA user_version=101");
  const migrated = openDatabase(f.dataDir);
  t.after(() => migrated.close());
  assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 102);
  assert.equal(migrated.prepare("SELECT accepted_at FROM jobs WHERE id=?").get(job.id).accepted_at, event.created_at);
});

test("真实子进程在外部接单后退出：租约到期查单恢复，不重复调用生成", async (t) => {
  const f = await fixture(t),
    job = await f.create();
  f.db.prepare("UPDATE work SET due_at=0").run();
  const child = spawn(process.execPath, ["tests/fixtures/crash-worker.mjs", f.dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data));
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  assert.equal(code, 73, stderr);
  assert.equal(f.get(job.id).status, "submitting");
  assert.equal(f.get(job.id).provider_id, null);
  const external = new DatabaseSync(join(f.dataDir, "provider.sqlite"));
  assert.equal(external.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal((await f.drain(job.id)).status, "completed");
  assert.equal(external.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
  assert.ok(f.engine.detail(job.id).events.some((e) => e.kind === "reconciled"));
  external.close();
  f.invariant();
});

test("生成成功但首次保存失败：只重试下载，文件校验后结算", async (t) => {
  const f = await fixture(t),
    job = await f.create("download_once");
  await f.step();
  await f.step();
  assert.equal(f.get(job.id).status, "persisting");
  await f.step();
  assert.equal(f.get(job.id).status, "persisting");
  assert.equal(f.get(job.id).retries, 1);
  assert.equal(f.invariant().reserved, 12);
  assert.equal((await f.drain(job.id)).status, "completed");
  const detail = f.engine.detail(job.id);
  assert.equal(detail.attempts.filter((a) => a.phase === "submit").length, 1);
  assert.equal(detail.attempts.filter((a) => a.phase === "download").length, 2);
  const file = await readFile(join(f.dataDir, "assets", detail.media.filename));
  assert.equal(createHash("sha256").update(file).digest("hex"), detail.media.sha256);
  assert.equal(file.length, detail.media.bytes);
  f.invariant();
});

test("重复成功与晚到 running 事件不能重复结算或回退终态", async (t) => {
  const f = await fixture(t),
    job = await f.create();
  await f.drain(job.id);
  const before = f.invariant(),
    providerId = f.get(job.id).provider_id;
  for (const status of ["succeeded", "succeeded", "succeeded", "running"])
    assert.equal(
      f.engine.applyProviderEvent(job.id, { id: providerId, status, costUnits: 8 }),
      false,
    );
  assert.equal(f.get(job.id).status, "completed");
  assert.deepEqual(f.invariant(), before);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM provider_costs WHERE job_id=?").get(job.id).n,
    1,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE job_id=? AND kind='settle'").get(job.id).n,
    1,
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM creations WHERE job_id=?").get(job.id).n, 1);
});

test("生成失败时释放积分，但供应商已发生的成本保留", async (t) => {
  const f = await fixture(t),
    job = await f.create("provider_fail");
  assert.equal((await f.drain(job.id)).status, "failed");
  assert.equal(f.invariant().credits, 300);
  assert.equal(f.invariant().reserved, 0);
  assert.equal(f.engine.detail(job.id).supplier_cost.cost_units, 2);
});

test("429 设置全局冷却，冷却期间不提交新任务，之后安全重试", async (t) => {
  const f = await fixture(t),
    job = await f.create("rate_limit");
  await f.step();
  assert.equal(f.get(job.id).status, "queued");
  const other = await f.create();
  await f.step();
  assert.equal(f.get(other.id).status, "queued");
  assert.ok(f.engine.health().paused_until > Date.now());
  f.db.prepare("UPDATE runtime SET value=0 WHERE key='paused_until'").run();
  assert.equal((await f.drain(job.id)).status, "completed");
  assert.equal(f.engine.detail(job.id).attempts.filter((a) => a.phase === "submit").length, 2);
  f.invariant();
});

test("两个 Worker 共用供应商名额：最多两个已提交任务，其余仍排队", async (t) => {
  const f = await fixture(t);
  const a = await f.create(),
    b = await f.create(),
    c = await f.create();
  const db2 = openDatabase(f.dataDir),
    worker2 = createEngine({ db: db2, dataDir: f.dataDir, jobDuration: 60000 });
  t.after(() => {
    worker2.close();
    db2.close();
  });
  await f.step(worker2);
  f.db.prepare("UPDATE work SET due_at=? WHERE job_id=?").run(Date.now() + 60000, a.id);
  await worker2.tick();
  // Push the two running tasks into the future, leaving the third queued job due.
  f.db
    .prepare("UPDATE work SET due_at=? WHERE job_id IN (?,?)")
    .run(Date.now() + 60000, a.id, b.id);
  assert.equal(await f.engine.tick(), false);
  assert.equal(f.get(c.id).status, "queued");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='running'").get().n, 2);
  f.invariant();
});

test("持有租约的任务不能被另一个 Worker 同时执行", async (t) => {
  const f = await fixture(t),
    job = await f.create();
  f.db
    .prepare("UPDATE work SET lease_token=?,lease_until=?,due_at=0 WHERE job_id=?")
    .run("live-worker", Date.now() + 60000, job.id);
  assert.equal(await f.engine.tick(), false);
  assert.equal(f.get(job.id).status, "queued");
  assert.equal(f.engine.detail(job.id).attempts.length, 0);
});

test("保存重试耗尽转人工核查；管理员恢复原保存阶段，无需重新生成", async (t) => {
  const f = await fixture(t),
    job = await f.create();
  await f.step();
  await f.step();
  const db2 = openDatabase(f.dataDir),
    provider = createProvider(f.dataDir, 0);
  let offline = true;
  const download = provider.download;
  provider.download = (j) => {
    if (offline) throw new Error("storage offline");
    return download(j);
  };
  const worker = createEngine({ db: db2, dataDir: f.dataDir, provider, maxRetries: 3 });
  t.after(() => {
    worker.close();
    db2.close();
  });
  assert.equal((await f.drain(job.id, worker)).status, "needs_review");
  assert.equal(f.get(job.id).review_phase, "download");
  assert.equal(f.invariant().reserved, 12);
  assert.equal((await f.request(`/admin/jobs/${job.id}/recover`, {})).status, 403);
  f.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(f.user.id);
  offline = false;
  assert.equal((await f.request(`/admin/jobs/${job.id}/recover`, {})).status, 200);
  assert.equal((await f.drain(job.id, worker)).status, "completed");
  assert.equal(f.engine.detail(job.id).attempts.filter((a) => a.phase === "submit").length, 1);
  assert.ok(f.engine.detail(job.id).events.some((e) => e.kind === "admin_recover"));
  f.invariant();
});

test("输入缺失、多余槽位和无效描述拒绝受理，不创建任务或冻结积分", async (t) => {
  const f = await fixture(t);
  const invalidBodies = [
    { ...f.jobBody, uploadIds: {} },
    { ...f.jobBody, uploadIds: { ...f.jobBody.uploadIds, extra: f.image.id } },
    { ...f.jobBody, prompt: "x".repeat(501) },
  ];
  for (const body of invalidBodies) {
    assert.equal((await f.request("/jobs", body, randomUUID())).status, 400);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
    assert.equal(f.invariant().credits, 300);
    assert.equal(f.invariant().reserved, 0);
  }
  const updated = f.catalog.updateCurated(f.user.id, f.template.id, {
    expectedUpdatedAt: f.template.updatedAt,
    outputOptions: { ...f.template.outputOptions, allowUserPrompt: false },
  });
  const disabledPrompt = { ...f.jobBody, templateVersionId: updated.versionId, prompt: "test" };
  assert.equal((await f.request("/jobs", disabledPrompt, randomUUID())).status, 400);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  assert.equal(f.invariant().reserved, 0);
});

test("待核查任务也占未结束名额，超限拒绝不冻结，取消后可重新提交", async (t) => {
  const f = await fixture(t);
  const unknown = await f.create("unknown_no_lookup");
  assert.equal((await f.drain(unknown.id)).status, "needs_review");
  const firstQueued = await f.create();
  await f.create();
  assert.equal(f.invariant().credits, 264);
  assert.equal(f.invariant().reserved, 36);
  const key = randomUUID();
  const before = f.db.prepare("SELECT COUNT(*) AS n FROM ledger").get().n;
  const rejected = await f.request("/jobs", f.jobBody, key);
  assert.equal(rejected.status, 429);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 3);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ledger").get().n, before);
  assert.equal(f.invariant().reserved, 36);
  assert.equal((await f.request(`/jobs/${firstQueued.id}/cancel`, {})).status, 200);
  assert.equal(f.invariant().reserved, 24);
  const accepted = await f.request("/jobs", f.jobBody, key);
  assert.equal(accepted.status, 201);
  assert.equal(f.invariant().reserved, 36);
});

test("取消与执行同时发生时，只能释放或交付一次", async (t) => {
  const f = await fixture(t);
  const job = await f.create();
  const [, cancellation] = await Promise.all([
    f.step(),
    f.request(`/jobs/${job.id}/cancel`, {}),
  ]);
  assert.ok([200, 409].includes(cancellation.status));
  const final = await f.drain(job.id);
  const ledger = f.db.prepare("SELECT kind FROM ledger WHERE job_id=?").all(job.id);
  if (cancellation.status === 200) {
    assert.equal(final.status, "cancelled");
    assert.deepEqual(ledger.map((row) => row.kind).sort(), ["hold", "release"]);
    assert.equal(f.invariant().credits, 300);
  } else {
    assert.equal(final.status, "completed");
    assert.deepEqual(ledger.map((row) => row.kind).sort(), ["hold", "settle"]);
    assert.equal(f.invariant().credits, 288);
  }
  assert.equal(f.invariant().reserved, 0);
  assert.equal(f.engine.detail(job.id).attempts.filter((row) => row.phase === "submit").length,
    cancellation.status === 200 ? 0 : 1);
});

test("新任务必须确认有效的当前报价，拒绝时不创建任务、占用素材或冻结积分", async (t) => {
  const f = await fixture(t);
  const quote = await f.request("/quote", {
    templateId: f.template.id,
    resolution: "720p",
    duration: 4,
  });
  assert.equal(quote.status, 200);
  assert.equal(quote.data.cost, 12);
  assert.equal(quote.data.version, "demo-v1");
  const body = {
    ...f.jobBody,
    expectedCost: quote.data.cost,
    priceVersion: quote.data.version,
  };
  const key = randomUUID();
  const ledgerBefore = f.db.prepare("SELECT * FROM ledger ORDER BY id").all();
  const rejected = [
    ["缺少全部确认信息", { expectedCost: undefined, priceVersion: undefined }, 400],
    ["缺少金额", { expectedCost: undefined }, 400],
    ["缺少价格版本", { priceVersion: undefined }, 400],
    ["空金额", { expectedCost: null }, 400],
    ["字符串金额", { expectedCost: "12" }, 400],
    ["布尔金额", { expectedCost: true }, 400],
    ["数组金额", { expectedCost: [12] }, 400],
    ["负数金额", { expectedCost: -12 }, 400],
    ["非整数金额", { expectedCost: 12.5 }, 400],
    ["空价格版本", { priceVersion: null }, 400],
    ["数字价格版本", { priceVersion: 1 }, 400],
    ["数组价格版本", { priceVersion: [quote.data.version] }, 400],
    ["空字符串价格版本", { priceVersion: "" }, 400],
    ["空白价格版本", { priceVersion: " " }, 400],
    ["金额不匹配", { expectedCost: 0 }, 409],
    ["价格版本不匹配", { priceVersion: "outdated" }, 409],
    ["改变规格后沿用旧报价", { resolution: "1080p" }, 409],
  ];
  for (const [label, changes, status] of rejected) {
    const response = await f.request("/jobs", { ...body, ...changes }, key);
    assert.equal(response.status, status, label);
    assert.equal(
      response.data.error,
      status === 400 ? "请先获取有效报价并确认积分成本。" : "报价已变化，请重新确认。",
      label,
    );
    for (const table of ["jobs", "work", "job_input_assets"])
      assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, label);
    assert.deepEqual(f.db.prepare("SELECT * FROM ledger ORDER BY id").all(), ledgerBefore, label);
    const account = f.invariant();
    assert.equal(account.credits, 300, label);
    assert.equal(account.reserved, 0, label);
  }
  // Rejected submissions do not consume the request key; a confirmed retry may proceed.
  const accepted = await f.request("/jobs", body, key);
  assert.equal(accepted.status, 201);
  const job = f.get(accepted.data.job.id);
  assert.equal(job.cost, quote.data.cost);
  assert.equal(JSON.parse(job.quote_snapshot).version, quote.data.version);
  assert.equal(f.invariant().credits, 288);
  assert.equal(f.invariant().reserved, 12);
});

test("浏览器丢失响应后凭原请求键找回任务；报价和模板版本随任务固定", async (t) => {
  const f = await fixture(t),
    job = await f.create("normal", { expectedCost: 12, priceVersion: "demo-v1" });
  const recovered = await f.request(`/jobs/by-key/${job.key}`);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.job.id, job.id);
  const replay = await f.request("/jobs", job.body, job.key);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.job.id, job.id);
  assert.equal(JSON.parse(f.get(job.id).template_snapshot).version, 1);
  assert.equal(JSON.parse(f.get(job.id).quote_snapshot).credits, 12);
  assert.equal(
    (await f.request("/jobs", { ...job.body, expectedCost: 0 }, randomUUID())).status,
    409,
  );
  f.catalog.remove(f.template.id, f.template.updatedAt);
  for (const changes of [
    {},
    { expectedCost: undefined, priceVersion: undefined },
    { expectedCost: 0, priceVersion: "outdated" },
  ]) {
    const retry = await f.request("/jobs", { ...job.body, ...changes }, job.key);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.job.id, job.id);
    assert.equal(f.get(job.id).cost, 12);
    assert.equal(JSON.parse(f.get(job.id).quote_snapshot).version, "demo-v1");
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind='hold'").get().n, 1);
  assert.equal(f.invariant().reserved, 12);
});

test("文件已落盘但账务尚未提交时进程退出：恢复保存阶段并仅结算一次", async (t) => {
  const f = await fixture(t),
    job = await f.create();
  await f.step();
  await f.step();
  assert.equal(f.get(job.id).status, "persisting");
  f.db.prepare("UPDATE work SET due_at=0").run();
  const child = spawn(process.execPath, ["tests/fixtures/crash-worker.mjs", f.dataDir, "persist"], {
    stdio: "ignore",
  });
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  assert.equal(code, 73);
  assert.equal(f.engine.detail(job.id).media.state, "staging");
  assert.equal(f.invariant().reserved, 12);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal((await f.drain(job.id)).status, "completed");
  assert.equal(f.engine.detail(job.id).attempts.filter((a) => a.phase === "submit").length, 1);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE job_id=? AND kind='settle'").get(job.id).n,
    1,
  );
  assert.equal(f.invariant().reserved, 0);
});

test("待提交积压超过候选窗口时，已接单任务仍可查询并完成", async (t) => {
  const f = await fixture(t),
    job = await f.create();
  await f.step();
  // Inject a large durable backlog to test the scheduler independently of the
  // API per-user admission cap. Each synthetic task has its own account/hold.
  for (let i = 0; i < 60; i++) {
    const user = `backlog-${i}`,
      id = `queued-${i}`;
    f.db
      .prepare(
        "INSERT INTO users(id,email,name,password,role,credits,reserved,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(user, `${user}@example.test`, user, "unused", "user", 288, 12, 1);
    f.db
      .prepare(
        `INSERT INTO jobs(id,user_id,template_id,template_version_id,prompt,resolution,duration,cost,status,request_key,created_at,billing_state,scenario,template_snapshot,quote_snapshot,input_assets_snapshot)
         SELECT ?,?,template_id,template_version_id,prompt,resolution,duration,cost,'queued',?,1,'held',scenario,template_snapshot,quote_snapshot,input_assets_snapshot FROM jobs WHERE id=?`,
      )
      .run(id, user, id, job.id);
    f.db.prepare("INSERT INTO work(job_id,due_at) VALUES (?,0)").run(id);
  }
  f.db.prepare("UPDATE work SET due_at=1 WHERE job_id=?").run(job.id);
  await f.engine.tick();
  assert.equal(f.get(job.id).status, "persisting");
  f.db.prepare("UPDATE work SET due_at=1 WHERE job_id=?").run(job.id);
  await f.engine.tick();
  assert.equal(f.get(job.id).status, "completed");
  f.invariant();
});

test("私有输入文件丢失时确认未提交失败，释放积分而非循环重提", async (t) => {
  const f = await fixture(t);
  const job = await f.create();
  await unlink(join(f.assets.directory, f.image.filename));
  await f.step();
  assert.equal(f.get(job.id).status, "failed");
  assert.equal(f.invariant().credits, 300);
  assert.equal(f.engine.detail(job.id).supplier_cost, null);
  assert.equal(f.engine.detail(job.id).work, null);
});
