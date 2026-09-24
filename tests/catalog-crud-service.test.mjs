import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/database.mjs";
import { createAssetService } from "../server/asset-service.mjs";
import { createCatalogService } from "../server/catalog-service.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "catalog-crud-"));
  const db = openDatabase(dir);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const id of ["admin", "other"])
    db.prepare(
      "INSERT INTO users(id,email,name,password,role,credits,created_at) VALUES (?,?,?,?,?,100,1)",
    ).run(id, `${id}@test.local`, id, "unused", id === "admin" ? "admin" : "user");
  const assets = createAssetService(db, dir);
  for (const [id, ownerId] of [
    ["ref-a", "admin"],
    ["ref-b", "admin"],
    ["foreign-ref", "other"],
  ])
    assets.upload({ id, ownerId, kind: "reference", bytes: Buffer.from("video") });
  assets.upload({ id: "preview", ownerId: "admin", kind: "preview", bytes: Buffer.from("video") });
  const service = createCatalogService(db, assets);
  const body = {
    title: "测试动作",
    description: "挥手动作",
    category: "动作",
    referenceVideoIds: ["ref-a"],
    previewVideoId: "preview",
    promptRecipe: "Wave gently.",
    inputSlots: [
      { key: "person", kind: "person", label: "人物", required: true, referenceRole: "挥手的人" },
    ],
    outputOptions: {
      default: { duration: 4, resolution: "720p" },
      allowedDurations: [4],
      allowedResolutions: ["720p"],
      allowUserPrompt: false,
    },
  };
  return {
    db,
    service,
    body,
    create: (key, changes = {}) =>
      service.createCurated("admin", key, { ...body, ...changes }).template,
  };
}
const rejects = (fn, status) => assert.throws(fn, (error) => error.status === status);

test("发布模板校验素材归属和必填配置，失败后可用原请求标识更正发布", (t) => {
  const { db, service, body } = fixture(t);
  const key = "catalog-invalid-then-valid";
  for (const change of [
    { referenceVideoIds: [] },
    { referenceVideoIds: ["foreign-ref"] },
    { previewVideoId: "foreign-ref" },
    { inputSlots: [] },
    { outputOptions: { ...body.outputOptions, allowedDurations: [] } },
  ]) {
    rejects(() => service.createCurated("admin", key, { ...body, ...change }), 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM templates").get().n, 0);
  }
  const template = service.createCurated("admin", key, body).template;
  assert.equal(template.status, "public");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM templates").get().n, 1);
});

test("目录查询支持组合筛选、稳定分页和无结果，拒绝非法条件", (t) => {
  const { service, create } = fixture(t);
  const a = create("create-a-001");
  create("create-b-001", { title: "场景测试", category: "场景" });
  assert.equal(service.queryAdmin({ q: "挥手", category: "动作" }).templates[0].id, a.id);
  const p1 = service.queryAdmin({ page: "1", pageSize: "1" });
  const p2 = service.queryAdmin({ page: "2", pageSize: "1" });
  assert.equal(p1.total, 2);
  assert.notEqual(p1.templates[0].id, p2.templates[0].id);
  assert.equal(service.queryAdmin({ q: "不存在" }).total, 0);
  assert.equal(service.queryAdmin({ q: "%" }).total, 0);
  for (const query of [{ page: "0" }, { pageSize: "101" }, { status: "bad" }, { q: [] }])
    rejects(() => service.queryAdmin(query), 400);
  rejects(() => service.detailAdmin("missing"), 404);
});

test("模板支持多个自定义标签，标签可搜索、编辑且输入受校验", (t) => {
  const { service, create } = fixture(t);
  const created = create("create-tags-001", { tags: ["海边", "双人"] });
  assert.deepEqual(created.tags, ["海边", "双人"]);
  assert.deepEqual(service.listPublic(null)[0].tags, ["海边", "双人"]);
  assert.equal(service.queryAdmin({ q: "海边" }).templates[0].id, created.id);
  const updated = service.updateCurated("admin", created.id, {
    expectedUpdatedAt: created.updatedAt,
    tags: ["旅行", "慢镜头"],
  });
  assert.deepEqual(updated.tags, ["旅行", "慢镜头"]);
  assert.equal(service.queryAdmin({ q: "海边" }).total, 0);
  assert.equal(service.queryAdmin({ q: "慢镜头" }).total, 1);
  for (const tags of [["重复", "重复"], [""], Array(13).fill("太多")])
    rejects(() => create(`bad-tags-${tags.length}`, { tags }), 400);
});

test("已有目录升级后将原分类保留为可搜索标签", (t) => {
  const { db, create } = fixture(t);
  const original = create("create-migrate-001", { category: "复古" });
  db.exec("ALTER TABLE templates DROP COLUMN tags");
  db.exec("ALTER TABLE jobs DROP COLUMN accepted_at");
  db.exec("PRAGMA user_version=100");
  const reopened = openDatabase(db.prepare("PRAGMA database_list").get().file.replace(/\/playbox\.sqlite$/, ""));
  t.after(() => reopened.close());
  const migratedService = createCatalogService(reopened, null);
  const migrated = migratedService.detailAdmin(original.id);
  assert.deepEqual(migrated.tags, ["复古"]);
  assert.equal(migratedService.queryAdmin({ q: "复古" }).templates[0].id, original.id);
  assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 102);
});

test("完整编辑创建新版本，历史快照与原始版本不变，并发修改和非法配置不落库", (t) => {
  const { db, service, create, body } = fixture(t);
  const original = create("create-edit-001");
  const oldVersion = db
    .prepare("SELECT * FROM template_versions WHERE id=?")
    .get(original.versionId);
  db.prepare(`INSERT INTO jobs(id,user_id,template_id,template_version_id,prompt,resolution,duration,cost,status,request_key,created_at,template_snapshot,quote_snapshot,input_assets_snapshot,billing_state,scenario)
    VALUES ('job','other',?,?,'','720p',4,12,'queued','job-key',1,?,'{}','{}','held','normal')`).run(
    original.id,
    original.versionId,
    JSON.stringify(original),
  );
  const change = {
    expectedUpdatedAt: original.updatedAt,
    referenceVideoIds: ["ref-b"],
    promptRecipe: "New motion.",
    inputSlots: [
      ...body.inputSlots,
      { key: "scene", kind: "scene", label: "场景", required: true },
    ],
    outputOptions: {
      default: { duration: 8, resolution: "1080p" },
      allowedDurations: [8],
      allowedResolutions: ["1080p"],
      allowUserPrompt: true,
    },
  };
  for (const patch of [
    { referenceVideoIds: ["foreign-ref"] },
    { referenceVideoIds: [] },
    { inputSlots: null },
    { outputOptions: null },
    { title: null },
    { promptRecipe: null },
    { inputSlots: [body.inputSlots[0], body.inputSlots[0]] },
    { outputOptions: { ...body.outputOptions, allowedDurations: [] } },
  ]) {
    rejects(() => service.updateCurated("admin", original.id, { ...change, ...patch }), 400);
    assert.equal(service.detailAdmin(original.id).version, 1);
  }
  const edited = service.updateCurated("admin", original.id, change);
  assert.equal(edited.version, 2);
  assert.equal(edited.jobCount, 1);
  assert.deepEqual(edited.motionVideoIds, ["ref-b"]);
  assert.equal(edited.inputSlots.length, 2);
  assert.equal(edited.outputOptions.default.duration, 8);
  assert.equal(edited.previewAssetId, original.previewAssetId);
  assert.deepEqual(
    db.prepare("SELECT * FROM template_versions WHERE id=?").get(original.versionId),
    oldVersion,
  );
  assert.deepEqual(
    JSON.parse(
      db.prepare("SELECT template_snapshot FROM jobs WHERE id='job'").get().template_snapshot,
    ),
    original,
  );
  rejects(() => service.updateCurated("admin", original.id, change), 409);
  const metadata = service.updateCurated("admin", original.id, {
    expectedUpdatedAt: edited.updatedAt,
    title: "改名",
  });
  assert.equal(metadata.versionId, edited.versionId);
});

test("删除可重复执行，阻止所有人新生成，保留历史关联，历史引用保留但不可恢复", (t) => {
  const { db, service, create } = fixture(t);
  const original = create("create-delete-001");
  db.prepare(`INSERT INTO jobs(id,user_id,template_id,template_version_id,prompt,resolution,duration,cost,status,request_key,created_at,template_snapshot,quote_snapshot,input_assets_snapshot,billing_state,scenario)
    VALUES ('job','other',?,?,'','720p',4,12,'completed','job-key',1,?,'{}','{}','held','normal')`).run(
    original.id,
    original.versionId,
    JSON.stringify(original),
  );
  rejects(() => service.remove(original.id, original.updatedAt - 1), 409);
  const deleted = service.remove(original.id, original.updatedAt);
  assert.equal(deleted.status, "deleted");
  assert.equal(service.remove(original.id, original.updatedAt).updatedAt, deleted.updatedAt);
  assert.equal(service.queryAdmin().total, 0);
  assert.equal(service.queryAdmin({ status: "deleted" }).templates[0].id, original.id);
  for (const user of [undefined, { id: "other", role: "user" }, { id: "admin", role: "admin" }])
    assert.equal(service.available(original.id, user), null);
  assert.equal(service.listPublic().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM template_versions").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM template_version_assets").get().n, 1);
  rejects(
    () =>
      service.updateCurated("admin", original.id, {
        expectedUpdatedAt: deleted.updatedAt,
        title: "不能改",
      }),
    409,
  );
});
