import { randomUUID } from "node:crypto";
import { transact } from "./database.mjs";
import { scenarios, templateSnapshot } from "./engine.mjs";
import { holdCredits } from "./billing-service.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
export const priceVersion = "demo-v1";

export function calculateQuote(template, resolution, duration) {
  const options = template.outputOptions;
  if (
    !options.allowedResolutions.includes(resolution) ||
    !options.allowedDurations.includes(duration)
  )
    throw fail(400, "生成规格无效。");
  return {
    cost: ((resolution === "1080p" ? 24 : 12) * duration) / 4,
    version: priceVersion,
    rule: "保存作品后结算；确认生成失败释放冻结积分",
  };
}

export function createGenerationService({ db, catalog, assets, event }) {
  function sameSubmission(previous, body, scenario) {
    body ||= {};
    const snapshot = JSON.parse(previous.template_snapshot);
    const slots = snapshot.inputSlots;
    const mapped =
      slots &&
      body.uploadIds &&
      typeof body.uploadIds === "object" &&
      !Array.isArray(body.uploadIds) &&
      Object.keys(body.uploadIds).length === slots.length
        ? Object.fromEntries(slots.map((slot) => [slot.key, body.uploadIds[slot.key]]))
        : null;
    return (
      previous.template_id === body.templateId &&
      snapshot.versionId === body.templateVersionId &&
      previous.input_assets_snapshot === (mapped ? JSON.stringify(mapped) : null) &&
      typeof (body.prompt ?? "") === "string" &&
      previous.prompt === (body.prompt ?? "").trim() &&
      previous.resolution === (body.resolution ?? "720p") &&
      previous.duration === (body.duration ?? 4) &&
      previous.scenario === scenario
    );
  }
  function quote(user, body) {
    const { templateId, resolution, duration } = body || {};
    if (typeof templateId !== "string" || !templateId.trim()) throw fail(400, "请选择有效模板。");
    const template = catalog.available(templateId, user);
    if (!template) throw fail(404, "模板不存在。");
    return calculateQuote(template, resolution, duration);
  }
  function createJob(user, body, key) {
    const {
      templateId,
      templateVersionId = null,
      uploadIds = null,
      prompt = "",
      resolution = "720p",
      duration = 4,
      scenario = "normal",
      expectedCost,
      priceVersion: clientPriceVersion,
    } = body || {};
    if (typeof key !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(key))
      throw fail(400, "缺少有效的请求标识。");
    if (typeof templateId !== "string" || !templateId.trim()) throw fail(400, "请选择有效模板。");
    // A retry must resolve the original task even if the catalog later changes.
    const earlier = db
      .prepare("SELECT * FROM jobs WHERE user_id=? AND request_key=?")
      .get(user.id, key);
    if (earlier) {
      if (!sameSubmission(earlier, body, scenario))
        throw fail(409, "同一请求标识不能用于不同任务。");
      return { job: earlier, existing: true };
    }
    return transact(db, () => {
      const previous = db
        .prepare("SELECT * FROM jobs WHERE user_id=? AND request_key=?")
        .get(user.id, key);
      if (previous) {
        if (!sameSubmission(previous, body, scenario))
          throw fail(409, "同一请求标识不能用于不同任务。");
        return { job: previous, existing: true };
      }
      const template = catalog.available(templateId, user);
      if (!template) throw fail(400, "请选择有效模板。");
      if (templateVersionId !== template.versionId)
        throw fail(409, "模板版本已变化，请刷新后重新提交。");
      const currentQuote = calculateQuote(template, resolution, duration);
      if (
        typeof prompt !== "string" ||
        prompt.length > 500 ||
        !scenarios.includes(scenario) ||
        (!template.outputOptions.allowUserPrompt && prompt.trim())
      )
        throw fail(400, "创意描述或演示场景无效。");

      if (
        !uploadIds ||
        typeof uploadIds !== "object" ||
        Array.isArray(uploadIds) ||
        Object.keys(uploadIds).length !== template.inputSlots.length
      )
        throw fail(400, "请按槽位上传全部图片。");
      const inputAssets = {};
      for (const slot of template.inputSlots) {
        assets.requireReady(uploadIds[slot.key], { ownerId: user.id, kind: "image" });
        inputAssets[slot.key] = uploadIds[slot.key];
      }
      template.motionVideoIds.forEach((id) => assets.requireReady(id, { kind: "reference" }));
      const inputSnapshot = JSON.stringify(inputAssets);

      if (
        (expectedCost !== undefined && expectedCost !== currentQuote.cost) ||
        (clientPriceVersion !== undefined && clientPriceVersion !== currentQuote.version)
      )
        throw fail(409, "报价已变化，请重新确认。");
      const active = db
        .prepare(
          "SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status NOT IN ('completed','failed','cancelled')",
        )
        .get(user.id).n;
      if (active >= 3) throw fail(429, "最多同时进行 3 个任务（包括待核查任务）。");
      const id = randomUUID(),
        now = Date.now();
      db.prepare(
        "INSERT INTO jobs(id,user_id,template_id,template_version_id,prompt,resolution,duration,cost,status,request_key,created_at,billing_state,scenario,template_snapshot,quote_snapshot,input_assets_snapshot) VALUES (?,?,?,?,?,?,?,?,'queued',?,?,'held',?,?,?,?)",
      ).run(
        id,
        user.id,
        templateId,
        template.versionId,
        prompt.trim(),
        resolution,
        duration,
        currentQuote.cost,
        key,
        now,
        scenario,
        JSON.stringify(templateSnapshot(template)),
        JSON.stringify({
          version: currentQuote.version,
          credits: currentQuote.cost,
          resolution,
          duration,
          settlement: "on_asset_saved",
          quoted_at: now,
        }),
        inputSnapshot,
      );
      for (const [slot, assetId] of Object.entries(inputAssets))
        db.prepare("INSERT INTO job_input_assets VALUES (?,?,?,'image')").run(id, assetId, slot);
      template.motionVideoIds.forEach((assetId, i) =>
        db
          .prepare("INSERT INTO job_input_assets VALUES (?,?,?,'reference')")
          .run(id, assetId, String(i)),
      );
      holdCredits(db, {
        userId: user.id,
        jobId: id,
        cost: currentQuote.cost,
        title: template.title,
        now,
      });
      db.prepare("INSERT INTO work(job_id,due_at) VALUES (?,?)").run(id, now + 1000);
      event(id, "created", "任务、执行记录、积分冻结已在同一事务内保存");
      return { job: db.prepare("SELECT * FROM jobs WHERE id=?").get(id), existing: false };
    });
  }
  return { quote, createJob };
}
