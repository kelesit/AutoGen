import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../server/database.mjs";
import { setupCatalog } from "./fixtures/catalog.mjs";
import { createGenerationService } from "../server/generation-service.mjs";
import { createCollectionService } from "../server/collection-service.mjs";
import { createEngine } from "../server/engine.mjs";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "assets-life-"));
  const db = openDatabase(dir);
  db.prepare(
    "INSERT INTO users VALUES ('owner','owner@test','Owner','unused','admin',300,0,1)",
  ).run();
  const f = setupCatalog(db, dir, "owner");
  const engine = createEngine({ db, dataDir: dir, jobDuration: 0 });
  const generation = createGenerationService({
    db,
    catalog: f.catalog,
    assets: f.assets,
    event: engine.event,
  });
  const collection = createCollectionService(db);
  t.after(() => {
    engine.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function create(key = crypto.randomUUID()) {
    return generation.createJob({ id: "owner", role: "admin" }, f.jobBody, key).job;
  }
  async function drain(id) {
    for (let i = 0; i < 10; i++) {
      db.prepare("UPDATE work SET due_at=0").run();
      await engine.tick();
      if (db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status === "completed") return;
    }
    throw Error("not completed");
  }
  return { ...f, db, dir, engine, generation, collection, create, drain };
}
test("共享参考由两个当前模板保护，最后引用解除后才清理", (t) => {
  const f = fixture(t);
  const body = {
    title: "第二个模板",
    referenceVideoIds: [f.ref.id],
    previewVideoId: f.preview.id,
    inputSlots: f.template.inputSlots,
    promptRecipe: "test",
    outputOptions: f.template.outputOptions,
  };
  const second = f.catalog.createCurated("owner", "second-template", body).template;
  f.catalog.remove(f.template.id, f.template.updatedAt);
  f.assets.cleanup({ now: Date.now() + 48 * 3600000 });
  assert.equal(f.assets.get(f.ref.id).state, "ready");
  f.catalog.remove(second.id, second.updatedAt);
  f.assets.cleanup({ now: Date.now() + 48 * 3600000 });
  assert.equal(f.assets.get(f.ref.id).state, "deleted");
  assert.throws(
    () => f.catalog.createCurated("owner", "third-template", body),
    (e) => e.status === 400,
  );
  assert.equal(existsSync(join(f.assets.directory, f.ref.filename)), false);
});
test("模板换参考并删除后，排队任务仍固定旧参考；取消任务才允许清理", (t) => {
  const f = fixture(t),
    job = f.create();
  const nextRef = f.assets.upload({
    ownerId: "owner",
    kind: "reference",
    bytes: Buffer.from("new"),
  });
  const updated = f.catalog.updateCurated("owner", f.template.id, {
    expectedUpdatedAt: f.template.updatedAt,
    referenceVideoIds: [nextRef.id],
  });
  f.catalog.remove(updated.id, updated.updatedAt);
  f.assets.cleanup({ now: Date.now() + 48 * 3600000 });
  assert.equal(f.assets.get(f.ref.id).state, "ready");
  assert.equal(f.assets.get(f.image.id).state, "ready");
  assert.equal(
    f.db
      .prepare("SELECT asset_id FROM job_input_assets WHERE job_id=? AND role='reference'")
      .get(job.id).asset_id,
    f.ref.id,
  );
  f.engine.cancel(job.id, "owner");
  f.assets.cleanup({ now: Date.now() + 48 * 3600000 });
  assert.equal(f.assets.get(f.ref.id).state, "deleted");
});
test("作品删除立即撤销读取，账务与任务保留，文件删除失败可重试且不复活作品", async (t) => {
  const f = fixture(t),
    job = f.create();
  await f.drain(job.id);
  const creation = f.collection.findByJob(job.id),
    asset = f.assets.get(creation.asset_id);
  const before = f.db.prepare("SELECT credits,reserved FROM users").get();
  assert.throws(
    () => f.collection.remove(creation.id, "someone"),
    (e) => e.status === 404,
  );
  f.collection.remove(creation.id, "owner");
  f.collection.remove(creation.id, "owner");
  assert.throws(
    () => f.collection.requireOwned(creation.id, "owner"),
    (e) => e.status === 404,
  );
  assert.equal(f.collection.list("owner").length, 0);
  f.assets.cleanup({
    removeFile() {
      throw new Error("disk busy");
    },
  });
  assert.equal(f.assets.get(asset.id).state, "deleting");
  assert.match(f.assets.get(asset.id).cleanup_error, /disk busy/);
  assert.throws(
    () => f.assets.requireReady(asset.id),
    (e) => e.status === 400,
  );
  f.assets.cleanup();
  assert.equal(f.assets.get(asset.id).state, "deleted");
  assert.equal(existsSync(join(f.assets.directory, asset.filename)), false);
  f.engine.applyProviderEvent(job.id, { id: job.provider_id, status: "succeeded", costUnits: 8 });
  assert.ok(f.collection.findByJob(job.id).deleted_at);
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status, "completed");
  assert.deepEqual(f.db.prepare("SELECT credits,reserved FROM users").get(), before);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM ledger WHERE job_id=? AND kind='settle'").get(job.id).n,
    1,
  );
});
test("未引用的图片和模板视频到期清理，当前模板引用仍受保护", (t) => {
  const f = fixture(t);
  f.create();
  const orphanReference = f.assets.upload({
    ownerId: "owner", kind: "reference", bytes: Buffer.from("unused reference"),
  });
  const orphanPreview = f.assets.upload({
    ownerId: "owner", kind: "preview", bytes: Buffer.from("unused preview"),
  });
  const abandoned = f.assets.upload({
    ownerId: "owner",
    kind: "image",
    bytes: Buffer.from("unused"),
    mime: "image/jpeg",
  });
  f.assets.cleanup();
  assert.equal(f.assets.get(abandoned.id).state, "ready");
  f.assets.cleanup({ now: Date.now() + 48 * 3600000, limit: 20 });
  assert.equal(f.assets.get(abandoned.id).state, "deleted");
  assert.equal(f.assets.get(orphanReference.id).state, "deleted");
  assert.equal(f.assets.get(orphanPreview.id).state, "deleted");
  assert.equal(f.assets.get(f.image.id).state, "ready");
  assert.equal(f.assets.get(f.ref.id).state, "ready");
});
test("错误数据库基线拒绝启动，不迁移或清空旧数据", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "old-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, "playbox.sqlite"));
  db.exec("CREATE TABLE old_data(value TEXT); INSERT INTO old_data VALUES ('keep');");
  db.close();
  assert.throws(() => openDatabase(dir), /不迁移旧/);
  const old = new DatabaseSync(join(dir, "playbox.sqlite"));
  assert.equal(old.prepare("SELECT value FROM old_data").get().value, "keep");
  old.close();
});
