import { setupCatalog } from "./fixtures/catalog.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";

test("全栈接口与账务一致性", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "playbox-test-"));
  let instance, server, base;
  async function start() {
    instance = await createApp({
      dataDir: directory,
      seed: false,
      jobDuration: 200,
      startWorker: true,
    });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    instance.close();
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  async function request(url, { cookie, method = "GET", body, key, headers = {} } = {}) {
    const response = await fetch(base + "/api" + url, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
        ...headers,
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : await response.arrayBuffer();
    return {
      status: response.status,
      data,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      headers: response.headers,
    };
  }
  async function register(name = "Creator") {
    const email = `${randomUUID()}@example.test`;
    const result = await request("/auth/register", {
      method: "POST",
      body: { email, password: "DemoPassword123!", name, role: "admin", credits: 9999 },
    });
    assert.equal(result.status, 200);
    return { ...result, email };
  }
  async function waitForJobs() {
    const deadline = Date.now() + 7000;
    while (
      instance.db
        .prepare(
          "SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ('completed','failed','cancelled')",
        )
        .get().n
    ) {
      if (Date.now() > deadline) throw new Error("Job did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const alice = await register("Alice");
  const bob = await register("Bob");
  const domain = setupCatalog(instance.db, directory, alice.data.user.id);
  const jobBody = {
    ...domain.jobBody,
    prompt: "A gentle camera movement",
    resolution: "720p",
    duration: 4,
  };
  let completedId;
  await t.test("注册由服务端分配角色和积分；会话使用 HttpOnly", async () => {
    assert.equal(alice.data.user.credits, 300);
    assert.equal(alice.data.user.role, "user");
    assert.match(alice.headers.get("set-cookie"), /HttpOnly/);
    assert.equal((await request("/me", { cookie: alice.cookie })).data.user.name, "Alice");
    assert.equal((await request("/jobs")).status, 401);
    assert.equal(
      (
        await request("/auth/login", {
          method: "POST",
          body: { email: alice.email, password: "incorrect" },
        })
      ).status,
      401,
    );
  });
  await t.test("普通用户无法访问管理员接口", async () => {
    assert.equal((await request("/admin", { cookie: alice.cookie })).status, 403);
    instance.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(bob.data.user.id);
    assert.equal((await request("/admin", { cookie: bob.cookie })).status, 200);
  });
  await t.test("缺失或错误类型的模板 ID 返回明确错误，不创建任务", async () => {
    const before = instance.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
    for (const templateId of [undefined, null, [], {}]) {
      const body = { templateId, resolution: "720p", duration: 4 };
      assert.equal(
        (await request("/quote", { cookie: alice.cookie, method: "POST", body })).status,
        400,
      );
      assert.equal(
        (await request("/jobs", { cookie: alice.cookie, method: "POST", body, key: randomUUID() }))
          .status,
        400,
      );
    }
    assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, before);
  });
  await t.test("重复提交只产生一个任务、扣费一次；不同参数复用请求键被拒绝", async () => {
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        request("/jobs", { cookie: alice.cookie, method: "POST", body: jobBody, key }),
      ),
    );
    assert.equal(new Set(responses.map((r) => r.data.job.id)).size, 1);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 200, 201]);
    completedId = responses[0].data.job.id;
    assert.equal((await request("/me", { cookie: alice.cookie })).data.user.credits, 288);
    assert.equal(
      (
        await request("/jobs", {
          cookie: alice.cookie,
          method: "POST",
          body: { ...jobBody, duration: 8 },
          key,
        })
      ).status,
      409,
    );
  });
  await t.test("任务在后台完成，媒体需要所有者权限；可下载样片", async () => {
    await waitForJobs();
    const jobs = (await request("/jobs", { cookie: alice.cookie })).data.jobs;
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].progress, 100);
    assert.equal(
      (await request(`/creations/${completedId}/video`, { cookie: bob.cookie })).status,
      404,
    );
    assert.equal((await request(`/creations/${completedId}/video`)).status, 401);
    const result = await request(`/creations/${completedId}/video?download=1`, {
      cookie: alice.cookie,
    });
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-disposition"), /attachment/);
    assert.ok(result.data.byteLength > 1000);
  });
  await t.test("失败任务自动退款且不会重复退款", async () => {
    const before = (await request("/me", { cookie: alice.cookie })).data.user.credits;
    const result = await request("/jobs", {
      cookie: alice.cookie,
      method: "POST",
      body: { ...jobBody, scenario: "provider_fail" },
      key: randomUUID(),
    });
    assert.equal(result.status, 201);
    await waitForJobs();
    assert.equal((await request("/me", { cookie: alice.cookie })).data.user.credits, before);
    const jobs = (await request("/jobs", { cookie: alice.cookie })).data.jobs;
    assert.equal(jobs.find((j) => j.id === result.data.job.id).status, "failed");
    assert.equal(
      (
        await request(`/jobs/${result.data.job.id}/cancel`, {
          cookie: alice.cookie,
          method: "POST",
          body: {},
        })
      ).status,
      409,
    );
    const ledger = (await request("/ledger", { cookie: alice.cookie })).data.ledger;
    assert.equal(
      ledger.filter((row) => row.job_id === result.data.job.id && row.kind === "release").length,
      1,
    );
  });
  await t.test("取消可以安全重试且只退回一次积分", async () => {
    const result = await request("/jobs", {
      cookie: alice.cookie,
      method: "POST",
      body: jobBody,
      key: randomUUID(),
    });
    assert.equal(result.status, 201);
    const id = result.data.job.id;
    assert.equal(
      (await request(`/jobs/${id}/cancel`, { cookie: bob.cookie, method: "POST", body: {} }))
        .status,
      404,
    );
    const first = await request(`/jobs/${id}/cancel`, {
      cookie: alice.cookie,
      method: "POST",
      body: {},
    });
    const second = await request(`/jobs/${id}/cancel`, {
      cookie: alice.cookie,
      method: "POST",
      body: {},
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.data.user.credits, second.data.user.credits);
    assert.equal(second.data.job.status, "cancelled");
  });
  await t.test("上传验证图片内容，并防止其他账户读取或引用", async () => {
    const image = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#abcdef" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("image", new Blob([image], { type: "image/png" }), "reference.png");
    const result = await request("/uploads", { cookie: alice.cookie, method: "POST", body: form });
    assert.equal(result.status, 201);
    const served = await request(`/uploads/${result.data.id}`, { cookie: alice.cookie });
    assert.equal(served.status, 200);
    assert.match(served.headers.get("content-type"), /^image\/jpeg/);
    assert.equal((await sharp(Buffer.from(served.data)).metadata()).format, "jpeg");
    assert.equal((await request(`/uploads/${result.data.id}`, { cookie: bob.cookie })).status, 404);
    assert.equal(
      (
        await request("/jobs", {
          cookie: bob.cookie,
          method: "POST",
          body: { ...jobBody, uploadIds: { person: result.data.id } },
          key: randomUUID(),
        })
      ).status,
      400,
    );
    const fake = new FormData();
    fake.append("image", new Blob(["<script>bad()</script>"], { type: "image/png" }), "fake.png");
    assert.equal(
      (await request("/uploads", { cookie: alice.cookie, method: "POST", body: fake })).status,
      400,
    );
  });
  await t.test("收藏数据隔离并可持久化", async () => {
    assert.equal(
      (
        await request(`/favorites/${domain.template.id}`, {
          cookie: alice.cookie,
          method: "PUT",
          body: { favorite: true },
        })
      ).status,
      200,
    );
    assert.equal(
      instance.db
        .prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id=? AND template_id=?")
        .get(alice.data.user.id, domain.template.id).n,
      1,
    );
    assert.equal(
      instance.db
        .prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id=? AND template_id=?")
        .get(bob.data.user.id, domain.template.id).n,
      0,
    );
  });
  await t.test("拒绝跨站写入和非法生成规格", async () => {
    assert.equal(
      (
        await request("/jobs", {
          cookie: alice.cookie,
          method: "POST",
          body: jobBody,
          key: randomUUID(),
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/jobs", {
          cookie: alice.cookie,
          method: "POST",
          body: { ...jobBody, cost: 0, duration: -1 },
          key: randomUUID(),
        })
      ).status,
      400,
    );
  });
  await t.test("积分不足不会创建任务，也不会出现负余额", async () => {
    const poor = await register("Low balance");
    const poorDomain = setupCatalog(instance.db, directory, poor.data.user.id);
    instance.db.prepare("UPDATE users SET credits = 1 WHERE id = ?").run(poor.data.user.id);
    const result = await request("/jobs", {
      cookie: poor.cookie,
      method: "POST",
      body: poorDomain.jobBody,
      key: randomUUID(),
    });
    assert.equal(result.status, 402);
    assert.equal((await request("/jobs", { cookie: poor.cookie })).data.jobs.length, 0);
    assert.equal((await request("/me", { cookie: poor.cookie })).data.user.credits, 1);
  });
  await t.test("重启后用户、会话、作品、收藏、积分和流水仍存在", async () => {
    const before = (await request("/me", { cookie: alice.cookie })).data.user;
    await stop();
    await start();
    const after = (await request("/me", { cookie: alice.cookie })).data.user;
    assert.deepEqual(after, before);
    assert.ok(
      (await request("/jobs", { cookie: alice.cookie })).data.jobs.some(
        (j) => j.id === completedId,
      ),
    );
    assert.equal(
      instance.db
        .prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id=? AND template_id=?")
        .get(alice.data.user.id, domain.template.id).n,
      1,
    );
    const ledger = (await request("/ledger", { cookie: alice.cookie })).data.ledger;
    assert.equal(
      ledger.reduce((sum, entry) => sum + entry.amount, 0),
      after.credits,
    );
  });
  await t.test("登出立即撤销服务端会话", async () => {
    assert.equal(
      (await request("/auth/logout", { cookie: alice.cookie, method: "POST", body: {} })).status,
      200,
    );
    assert.equal((await request("/jobs", { cookie: alice.cookie })).status, 401);
  });
});
