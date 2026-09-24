import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";

test("预置模板有独立版本和预览，用户按版本报价与提交", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "playbox-catalog-"));
  const instance = await createApp({ dataDir: dir, startWorker: true, jobDuration: 100 });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  t.after(async () => {
    await new Promise((done) => server.close(done));
    instance.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, { method = "GET", cookie, body, key } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      data: response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.arrayBuffer(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const catalog = await request("/templates");
  const template = catalog.data.templates[0];
  assert.ok(template.id);
  assert.ok(template.versionId);
  assert.ok(template.previewAssetId);
  assert.notEqual(template.versionId, template.previewAssetId);
  assert.equal(template.motionVideoIds, undefined);
  assert.equal(template.promptRecipe, undefined);
  assert.equal((await request(`/templates/${template.id}/preview-video`)).status, 200);
  const login = await request("/auth/login", {
    method: "POST",
    body: {
      email: "demo@playbox.local",
      password: "PlayboxDemo2026!",
    },
  });
  const cookie = login.cookie;
  assert.equal(
    (
      await request(`/favorites/${template.id}`, {
        method: "PUT",
        cookie,
        body: { favorite: true },
      })
    ).status,
    200,
  );
  assert.equal((await request("/templates", { cookie })).data.templates[0].favorite, true);
  assert.equal(
    (
      await request("/quote", {
        method: "POST",
        cookie,
        body: {
          templateId: template.id,
          resolution: "720p",
          duration: 4,
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/quote", {
        method: "POST",
        cookie,
        body: {
          templateId: template.id,
          resolution: "720p",
          duration: 12,
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/jobs", {
        method: "POST",
        cookie,
        key: "catalog-version-check-1",
        body: {
          templateId: template.id,
          templateVersionId: "outdated",
          uploadIds: {},
          resolution: "720p",
          duration: 4,
        },
      })
    ).status,
    409,
  );
  const pixels = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#acc4d8" },
  })
    .jpeg()
    .toBuffer();
  const form = new FormData();
  form.append("image", new Blob([pixels], { type: "image/jpeg" }), "person.jpg");
  const uploadResponse = await fetch(`${base}/uploads`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  });
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json();
  const generated = await request("/jobs", {
    method: "POST",
    cookie,
    key: "catalog-generation-1",
    body: {
      templateId: template.id,
      templateVersionId: template.versionId,
      uploadIds: { person: upload.id },
      prompt: "",
      resolution: "720p",
      duration: 4,
    },
  });
  assert.equal(generated.status, 201);
  assert.equal(generated.data.job.template.versionId, template.versionId);
  assert.deepEqual(generated.data.job.input_assets, { person: upload.id });
  assert.equal(generated.data.job.template.motionVideoIds.length, 1);
  const deadline = Date.now() + 8000;
  let completed;
  do {
    if (Date.now() > deadline) throw new Error("预置模板任务未完成");
    await new Promise((done) => setTimeout(done, 50));
    completed = await request(`/jobs/${generated.data.job.id}/detail`, { cookie });
  } while (completed.data.job.status !== "completed");
  const creations = await request("/creations", { cookie });
  assert.equal(creations.data.creations.length, 1);
  assert.equal(creations.data.creations[0].job_id, generated.data.job.id);
  assert.equal(creations.data.creations[0].template_version_id, template.versionId);
  assert.equal(
    (await request(creations.data.creations[0].video_url.slice(4), { cookie })).status,
    200,
  );
  assert.equal(completed.data.job.creation_id, creations.data.creations[0].id);
  assert.equal(
    instance.db
      .prepare("SELECT COUNT(*) AS n FROM template_versions WHERE template_id=?")
      .get(template.id).n,
    1,
  );
  assert.equal(
    instance.db
      .prepare("SELECT COUNT(*) AS n FROM template_version_assets WHERE version_id=?")
      .get(template.versionId).n,
    1,
  );
});
