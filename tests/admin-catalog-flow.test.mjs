import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";

test("管理员发布动作模板后，普通用户能在广场使用并在作品库查看结果", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "playbox-admin-catalog-"));
  const dir = join(parent, ".data");
  const instance = await createApp({ dataDir: dir, startWorker: true, jobDuration: 80 });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  t.after(async () => {
    await new Promise((done) => server.close(done));
    instance.close();
    await rm(parent, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, { method = "GET", cookie, body, key, range } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(range ? { Range: range } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      headers: response.headers,
      data: response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.arrayBuffer(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function upload(path, cookie, field, bytes, mime, name) {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type: mime }), name);
    const response = await fetch(base + path, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    return { status: response.status, data: await response.json() };
  }
  const admin = await request("/auth/login", {
    method: "POST",
    body: {
      email: "admin@playbox.local",
      password: "PlayboxAdmin2026!",
    },
  });
  const user = await request("/auth/login", {
    method: "POST",
    body: {
      email: "demo@playbox.local",
      password: "PlayboxDemo2026!",
    },
  });
  const movie = await readFile(new URL("../public/media/sample.mp4", import.meta.url));
  const reference = await upload(
    "/template-videos",
    admin.cookie,
    "video",
    movie,
    "video/mp4",
    "action.mp4",
  );
  const preview = await upload(
    "/admin/catalog-preview-uploads",
    admin.cookie,
    "video",
    movie,
    "video/mp4",
    "preview.mp4",
  );
  assert.equal(reference.status, 201);
  assert.equal(preview.status, 201);
  const reusable = await request("/admin/catalog-uploads", { cookie: admin.cookie });
  assert.equal(reusable.status, 200);
  assert.equal(reusable.data.references[0].id, reference.data.id);
  assert.equal(reusable.data.previews[0].id, preview.data.id);
  assert.equal((await request("/admin/catalog-uploads", { cookie: user.cookie })).status, 403);
  assert.equal(
    (
      await upload(
        "/admin/catalog-preview-uploads",
        user.cookie,
        "video",
        movie,
        "video/mp4",
        "forbidden.mp4",
      )
    ).status,
    403,
  );
  const body = {
    title: "双人动作模板",
    description: "测试发布链路",
    category: "双人",
    referenceVideoIds: [reference.data.id],
    previewVideoId: preview.data.id,
    inputSlots: [
      {
        key: "person_a",
        kind: "person",
        label: "人物 A",
        required: true,
        referenceRole: "左侧人物",
      },
      {
        key: "person_b",
        kind: "person",
        label: "人物 B",
        required: true,
        referenceRole: "右侧人物",
      },
    ],
    promptRecipe: "Follow the saved reference motion.",
    outputOptions: {
      default: { duration: 4, resolution: "720p" },
      allowedDurations: [4],
      allowedResolutions: ["720p"],
      allowUserPrompt: false,
    },
  };
  assert.equal(
    (
      await request("/admin/catalog-templates", {
        method: "POST",
        cookie: user.cookie,
        key: "published-demo-template",
        body,
      })
    ).status,
    403,
  );
  const published = await request("/admin/catalog-templates", {
    method: "POST",
    cookie: admin.cookie,
    key: "published-demo-template",
    body,
  });
  assert.equal(published.status, 201);
  const template = published.data.template;
  assert.ok(template.versionId);
  assert.ok(template.previewAssetId);
  assert.ok(template.publishedAt);
  assert.equal(
    (
      await request("/admin/catalog-templates", {
        method: "POST",
        cookie: admin.cookie,
        key: "published-demo-template",
        body,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/admin/catalog-templates", {
        method: "POST",
        cookie: admin.cookie,
        key: "published-demo-template",
        body: { ...body, title: "other" },
      })
    ).status,
    409,
  );
  const gallery = await request("/templates", { cookie: user.cookie });
  assert.equal(
    gallery.data.templates.some((item) => item.id === template.id),
    true,
  );
  assert.equal(
    gallery.data.templates.some((item) => item.id === "coast"),
    false,
  );
  assert.equal((await request(`/templates/${template.id}/preview-video`)).status, 200);
  assert.equal(
    (
      await request("/quote", {
        method: "POST",
        cookie: user.cookie,
        body: {
          templateId: template.id,
          duration: 8,
          resolution: "720p",
        },
      })
    ).status,
    400,
  );
  const previewRange = await request(`/templates/${template.id}/preview-video`, {
    range: "bytes=0-31",
  });
  assert.equal(previewRange.status, 206);
  assert.match(previewRange.headers.get("content-type"), /video\/mp4/);
  assert.deepEqual(Buffer.from(previewRange.data), movie.subarray(0, 32));
  assert.equal(
    (
      await request(
        `/admin/catalog-templates/${template.id}/reference-videos/${reference.data.id}`,
        { cookie: admin.cookie },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/admin/catalog-templates/${template.id}/reference-videos/${reference.data.id}`,
        { cookie: user.cookie },
      )
    ).status,
    403,
  );
  const pixels = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#aaccdd" },
  })
    .jpeg()
    .toBuffer();
  const a = await upload("/uploads", user.cookie, "image", pixels, "image/jpeg", "a.jpg");
  const b = await upload("/uploads", user.cookie, "image", pixels, "image/jpeg", "b.jpg");
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const job = await request("/jobs", {
    method: "POST",
    cookie: user.cookie,
    key: "published-template-job",
    body: {
      templateId: template.id,
      templateVersionId: template.versionId,
      uploadIds: { person_a: a.data.id, person_b: b.data.id },
      resolution: "720p",
      duration: 4,
      prompt: "",
    },
  });
  assert.equal(job.status, 201);
  assert.deepEqual(job.data.job.template.motionVideoIds, [reference.data.id]);
  assert.deepEqual(job.data.job.input_assets, { person_a: a.data.id, person_b: b.data.id });
  const deadline = Date.now() + 8000;
  let result;
  do {
    if (Date.now() > deadline) throw new Error("生成任务未完成");
    await new Promise((done) => setTimeout(done, 50));
    result = await request(`/jobs/${job.data.job.id}/detail`, { cookie: user.cookie });
  } while (result.data.job.status !== "completed");
  const creations = await request("/creations", { cookie: user.cookie });
  assert.equal(creations.data.creations.length, 1);
  assert.equal(creations.data.creations[0].template_version_id, template.versionId);
  assert.equal(creations.data.creations[0].job_id, job.data.job.id);
  const outputPath = `/creations/${creations.data.creations[0].id}/video`;
  const output = await request(outputPath, { cookie: user.cookie, range: "bytes=0-31" });
  assert.equal(output.status, 206);
  assert.deepEqual(Buffer.from(output.data), movie.subarray(0, 32));
  assert.equal((await request(outputPath)).status, 401);
  assert.equal((await request(outputPath, { cookie: admin.cookie })).status, 404);
  const download = await request(outputPath + "?download=1", { cookie: user.cookie });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.deepEqual(Buffer.from(download.data), movie);
  assert.equal(
    (await request(`/jobs/${job.data.job.id}/video`, { cookie: user.cookie })).status,
    404,
  );

  const editPath = `/admin/catalog-templates/${template.id}`;
  assert.equal(
    (
      await request(editPath, {
        method: "PATCH",
        cookie: user.cookie,
        body: { expectedUpdatedAt: template.updatedAt, status: "private" },
      })
    ).status,
    403,
  );
  const edited = await request(editPath, {
    method: "PATCH",
    cookie: admin.cookie,
    body: {
      expectedUpdatedAt: template.updatedAt,
      title: "修正角色后的模板",
      inputSlots: body.inputSlots.map((slot, i) => ({
        ...slot,
        referenceRole: i ? "右侧回应的人" : "左侧挥手的人",
      })),
      previewVideoId: preview.data.id,
    },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.template.version, 2);
  assert.notEqual(edited.data.template.versionId, template.versionId);
  assert.equal(edited.data.template.inputSlots[0].referenceRole, "左侧挥手的人");
  const original = await request(`/jobs/${job.data.job.id}/detail`, { cookie: user.cookie });
  assert.equal(original.data.job.template.versionId, template.versionId);
  assert.equal(original.data.job.template.inputSlots[0].referenceRole, "左侧人物");
  assert.equal(
    (
      await request(editPath, {
        method: "PATCH",
        cookie: admin.cookie,
        body: { expectedUpdatedAt: template.updatedAt, title: "过期修改" },
      })
    ).status,
    409,
  );
  const hidden = await request(editPath, {
    method: "PATCH",
    cookie: admin.cookie,
    body: { expectedUpdatedAt: edited.data.template.updatedAt, status: "private" },
  });
  assert.equal(hidden.status, 200);
  assert.equal(
    (await request("/templates")).data.templates.some((item) => item.id === template.id),
    false,
  );
  assert.equal((await request(`/templates/${template.id}/preview-video`)).status, 404);
  assert.equal(
    (
      await request("/quote", {
        method: "POST",
        cookie: user.cookie,
        body: { templateId: template.id, duration: 4, resolution: "720p" },
      })
    ).status,
    404,
  );
  assert.equal((await request(outputPath, { cookie: user.cookie })).status, 200);
  const restored = await request(editPath, {
    method: "PATCH",
    cookie: admin.cookie,
    body: { expectedUpdatedAt: hidden.data.template.updatedAt, status: "public" },
  });
  assert.equal(restored.status, 200);
  assert.equal(
    (await request("/templates")).data.templates.some((item) => item.id === template.id),
    true,
  );

  assert.equal((await request("/admin/catalog-templates", { cookie: user.cookie })).status, 403);
  assert.equal((await request(editPath, { cookie: user.cookie })).status, 403);
  assert.equal(
    (await request("/admin/catalog-templates?page=0", { cookie: admin.cookie })).status,
    400,
  );
  const found = await request("/admin/catalog-templates?q=" + encodeURIComponent("修正角色"), {
    cookie: admin.cookie,
  });
  assert.equal(found.data.total, 1);
  assert.equal(found.data.templates[0].jobCount, 1);
  assert.equal(
    (
      await request(editPath, {
        method: "DELETE",
        cookie: user.cookie,
        body: { expectedUpdatedAt: restored.data.template.updatedAt },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(editPath, {
        method: "DELETE",
        cookie: admin.cookie,
        body: { expectedUpdatedAt: template.updatedAt },
      })
    ).status,
    409,
  );
  const deleted = await request(editPath, {
    method: "DELETE",
    cookie: admin.cookie,
    body: { expectedUpdatedAt: restored.data.template.updatedAt },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.template.status, "deleted");
  for (const cookie of [user.cookie, admin.cookie])
    assert.equal(
      (
        await request("/quote", {
          method: "POST",
          cookie,
          body: { templateId: template.id, duration: 4, resolution: "720p" },
        })
      ).status,
      404,
    );
  assert.equal((await request(outputPath, { cookie: user.cookie })).status, 200);
  const detailAfterDelete = await request(`/jobs/${job.data.job.id}/detail`, {
    cookie: user.cookie,
  });
  assert.equal(detailAfterDelete.data.job.template.versionId, template.versionId);
  assert.equal(
    (await request(editPath + "/restore", { method: "POST", cookie: admin.cookie, body: {} }))
      .status,
    404,
  );
  const creationPath = `/creations/${creations.data.creations[0].id}`;
  const balanceBefore = (await request("/me", { cookie: user.cookie })).data.user;
  assert.equal(
    (await request(creationPath, { method: "DELETE", cookie: admin.cookie })).status,
    404,
  );
  assert.equal(
    (await request(creationPath, { method: "DELETE", cookie: user.cookie })).status,
    200,
  );
  assert.equal(
    (await request(creationPath, { method: "DELETE", cookie: user.cookie })).status,
    200,
  );
  assert.equal((await request(outputPath, { cookie: user.cookie })).status, 404);
  assert.equal((await request(outputPath + "?download=1", { cookie: user.cookie })).status, 404);
  assert.equal(
    (await request(`/jobs/${job.data.job.id}/video`, { cookie: user.cookie })).status,
    404,
  );
  const collectionAfter = (await request("/collection", { cookie: user.cookie })).data;
  assert.equal(collectionAfter.totalCreations, 0);
  assert.equal(
    collectionAfter.jobs.some((j) => j.id === job.data.job.id),
    false,
  );
  const trace = (await request(`/jobs/${job.data.job.id}/detail`, { cookie: user.cookie })).data
    .job;
  assert.equal(trace.status, "completed");
  assert.equal(trace.output_url, null);
  assert.deepEqual((await request("/me", { cookie: user.cookie })).data.user, balanceBefore);
});
