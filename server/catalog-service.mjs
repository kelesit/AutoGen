import { randomUUID } from "node:crypto";
import { transact } from "./database.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

function validateSlots(inputSlots) {
  if (
    !Array.isArray(inputSlots) ||
    inputSlots.length < 1 ||
    inputSlots.length > 4 ||
    !inputSlots.every(
      (slot) =>
        slot &&
        typeof slot.key === "string" &&
        /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(slot.key) &&
        ["person", "scene"].includes(slot.kind) &&
        typeof slot.label === "string" &&
        slot.label.trim().length > 0 &&
        slot.label.length <= 80 &&
        slot.required === true &&
        (slot.referenceRole === undefined ||
          (typeof slot.referenceRole === "string" && slot.referenceRole.length <= 200)),
    ) ||
    new Set(inputSlots.map((slot) => slot.key)).size !== inputSlots.length
  )
    throw fail(400, "图片槽位无效。");
}

function validateOptions(options) {
  if (!options || typeof options !== "object") throw fail(400, "输出参数无效。");
  if (
    !Array.isArray(options.allowedResolutions) ||
    !options.allowedResolutions.length ||
    !options.allowedResolutions.every((value) => ["720p", "1080p"].includes(value)) ||
    new Set(options.allowedResolutions).size !== options.allowedResolutions.length ||
    !Array.isArray(options.allowedDurations) ||
    !options.allowedDurations.length ||
    !options.allowedDurations.every((value) => [4, 8].includes(value)) ||
    new Set(options.allowedDurations).size !== options.allowedDurations.length ||
    typeof options.allowUserPrompt !== "boolean" ||
    !options.default ||
    !options.allowedDurations.includes(options.default.duration) ||
    !options.allowedResolutions.includes(options.default.resolution)
  )
    throw fail(400, "输出参数无效。");
}

function validateReferences(ids) {
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 3 ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => typeof id === "string" && id)
  )
    throw fail(400, "请选择 1–3 段动作参考视频。");
}

export const defaultOutputOptions = {
  default: { duration: 4, resolution: "720p" },
  allowedDurations: [4, 8],
  allowedResolutions: ["720p", "1080p"],
  allowUserPrompt: true,
};

const catalogSelect = `SELECT t.*,u.name AS creator_name,
  v.version AS active_version,v.input_schema,
  (SELECT json_group_array(asset_id) FROM (SELECT asset_id FROM template_version_assets WHERE version_id=v.id ORDER BY position)) AS reference_video_ids,
  v.prompt_recipe AS version_prompt_recipe,v.output_options
  FROM templates t JOIN users u ON u.id=t.owner_id
  JOIN template_versions v ON v.id=t.current_version_id`;

export function createCatalogService(db, assets) {
  function serialize(row, includeRecipe = true) {
    return {
      ...(includeRecipe
        ? {
            jobCount: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE template_id=?").get(row.id)
              .n,
          }
        : {}),
      kind: "motion",
      id: row.id,
      title: row.title,
      subtitle: row.description,
      category: row.category,
      creator: row.creator_name,
      image: "coast",
      tag: row.status === "public" ? "NEW" : "私有",
      favorite: false,
      uses: db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE template_id=? AND status='completed'")
        .get(row.id).n,
      color: "#82ced5",
      version: row.active_version,
      versionId: row.current_version_id,
      status: row.status,
      inputSlots: JSON.parse(row.input_schema),
      ...(includeRecipe
        ? {
            motionVideoIds: JSON.parse(row.reference_video_ids),
            promptRecipe: row.version_prompt_recipe,
          }
        : {}),
      outputOptions: JSON.parse(row.output_options),
      preview_url: row.preview_asset_id
        ? `/api/templates/${row.id}/preview-video?asset=${row.preview_asset_id}`
        : null,
      previewAssetId: row.preview_asset_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
    };
  }
  const getTemplateRow = (id) =>
    typeof id === "string" ? db.prepare(`${catalogSelect} WHERE t.id=?`).get(id) : null;
  function available(id, user) {
    if (typeof id !== "string" || !id.trim()) return null;
    const row = getTemplateRow(id);
    if (row) {
      if (row.status === "deleted") return null;
      if (row.status !== "public" && row.owner_id !== user?.id && user?.role !== "admin")
        return null;
      return serialize(row);
    }
    return null;
  }
  function listPublic(user) {
    const favoriteIds = new Set(
      user
        ? db
            .prepare("SELECT template_id FROM favorites WHERE user_id=?")
            .all(user.id)
            .map((row) => row.template_id)
        : [],
    );
    const publicTemplates = db
      .prepare(`${catalogSelect} WHERE t.status='public' ORDER BY t.created_at DESC`)
      .all()
      .map((row) => serialize(row, false));
    return publicTemplates.map((template) => ({
      ...template,
      favorite: favoriteIds.has(template.id),
    }));
  }
  function createCurated(ownerId, key, body) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(key))
      throw fail(400, "缺少有效的发布请求标识。");
    const {
      title,
      description = "",
      category = "动作",
      referenceVideoIds,
      previewVideoId,
      inputSlots,
      promptRecipe = "",
      outputOptions,
    } = body || {};
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.trim().length > 80 ||
      typeof description !== "string" ||
      description.length > 300 ||
      typeof category !== "string" ||
      !category.trim() ||
      category.length > 30 ||
      typeof promptRecipe !== "string" ||
      promptRecipe.length > 6000
    )
      throw fail(400, "模板信息无效。");
    validateReferences(referenceVideoIds);
    if (typeof previewVideoId !== "string") throw fail(400, "请上传示例成片。");
    validateSlots(inputSlots);
    const options = outputOptions || defaultOutputOptions;
    validateOptions(options);
    const normalized = {
      title: title.trim(),
      description: description.trim(),
      category: category.trim(),
      referenceVideoIds,
      previewVideoId,
      inputSlots: inputSlots.map((slot) => ({ ...slot, label: slot.label.trim() })),
      promptRecipe: promptRecipe.trim(),
      outputOptions: options,
    };
    const payload = JSON.stringify(normalized);
    return transact(db, () => {
      const previous = db
        .prepare("SELECT id,create_payload FROM templates WHERE owner_id=? AND create_key=?")
        .get(ownerId, key);
      if (previous) {
        if (previous.create_payload !== payload) throw fail(409, "发布请求标识已用于不同模板。");
        return { template: serialize(getTemplateRow(previous.id)), existing: true };
      }
      referenceVideoIds.forEach((id) => assets.requireReady(id, { ownerId, kind: "reference" }));
      assets.requireReady(previewVideoId, { ownerId, kind: "preview" });
      const id = randomUUID(),
        versionId = randomUUID(),
        now = Date.now();
      db.prepare(`INSERT INTO templates
        (id,owner_id,title,description,category,status,create_key,create_payload,created_at,updated_at,published_at)
        VALUES (?,?,?,?,?,'public',?,?,?,?,?)`).run(
        id,
        ownerId,
        normalized.title,
        normalized.description,
        normalized.category,
        key,
        payload,
        now,
        now,
        now,
      );
      db.prepare(`INSERT INTO template_versions
        (id,template_id,version,input_schema,prompt_recipe,output_options,created_at)
        VALUES (?,?,1,?,?,?,?)`).run(
        versionId,
        id,
        JSON.stringify(normalized.inputSlots),
        normalized.promptRecipe,
        JSON.stringify(options),
        now,
      );
      referenceVideoIds.forEach((assetId, position) =>
        db
          .prepare("INSERT INTO template_version_assets VALUES (?,?,?)")
          .run(versionId, assetId, position),
      );
      db.prepare("UPDATE templates SET current_version_id=?,preview_asset_id=? WHERE id=?").run(
        versionId,
        previewVideoId,
        id,
      );
      return { template: serialize(getTemplateRow(id)), existing: false };
    });
  }
  function updateCurated(adminId, id, body) {
    const {
      expectedUpdatedAt,
      title,
      description,
      category,
      status,
      previewVideoId,
      inputSlots,
      referenceVideoIds,
      promptRecipe,
      outputOptions,
    } = body || {};
    if (!Number.isSafeInteger(expectedUpdatedAt))
      throw fail(400, "缺少模板修改版本，请刷新后重试。");
    return transact(db, () => {
      const row = getTemplateRow(id);
      if (!row) throw fail(404, "模板不存在。");
      if (row.updated_at !== expectedUpdatedAt) throw fail(409, "模板已被修改，请刷新后重试。");
      if (row.status === "deleted") throw fail(409, "模板已删除，无法修改。");
      if (!["public", "private"].includes(row.status)) throw fail(409, "模板状态不允许修改。");
      if (status !== undefined && !["public", "private"].includes(status))
        throw fail(400, "模板状态无效。");
      const next = {
        title: title === undefined ? row.title : title,
        description: description === undefined ? row.description : description,
        category: category === undefined ? row.category : category,
      };
      if (
        typeof next.title !== "string" ||
        !next.title.trim() ||
        next.title.trim().length > 80 ||
        typeof next.description !== "string" ||
        next.description.length > 300 ||
        typeof next.category !== "string" ||
        !next.category.trim() ||
        next.category.length > 30
      )
        throw fail(400, "模板信息无效。");
      let versionId = row.current_version_id,
        version = row.active_version,
        previewId = row.preview_asset_id;
      const slots = inputSlots === undefined ? JSON.parse(row.input_schema) : inputSlots;
      if (inputSlots !== undefined) {
        validateSlots(slots);
      }
      const references =
        referenceVideoIds === undefined ? JSON.parse(row.reference_video_ids) : referenceVideoIds;
      const recipe = promptRecipe === undefined ? row.version_prompt_recipe : promptRecipe;
      const options = outputOptions === undefined ? JSON.parse(row.output_options) : outputOptions;
      validateReferences(references);
      const existing = JSON.parse(row.reference_video_ids);
      references.forEach((videoId) =>
        assets.requireReady(videoId, {
          kind: "reference",
          ...(existing.includes(videoId) ? {} : { ownerId: adminId }),
        }),
      );
      if (typeof recipe !== "string" || recipe.length > 6000) throw fail(400, "模板动作描述无效。");
      if (outputOptions !== undefined) validateOptions(options);
      let replacement;
      if (previewVideoId !== undefined) {
        if (typeof previewVideoId !== "string") throw fail(400, "示例视频无效。");
        replacement = db
          .prepare(
            "SELECT id FROM assets WHERE id=? AND owner_id=? AND kind='preview' AND state='ready'",
          )
          .get(previewVideoId, adminId);
        if (!replacement) throw fail(400, "示例视频不存在或无权使用。");
      }
      const now = Math.max(Date.now(), row.updated_at + 1);
      if (
        JSON.stringify(slots) !== row.input_schema ||
        JSON.stringify(references) !== row.reference_video_ids ||
        recipe.trim() !== row.version_prompt_recipe ||
        JSON.stringify(options) !== row.output_options
      ) {
        versionId = randomUUID();
        version += 1;
        db.prepare(`INSERT INTO template_versions
          (id,template_id,version,input_schema,prompt_recipe,output_options,created_at)
          VALUES (?,?,?,?,?,?,?)`).run(
          versionId,
          id,
          version,
          JSON.stringify(slots),
          recipe.trim(),
          JSON.stringify(options),
          now,
        );
        references.forEach((assetId, position) =>
          db
            .prepare("INSERT INTO template_version_assets VALUES (?,?,?)")
            .run(versionId, assetId, position),
        );
      }
      if (replacement) previewId = replacement.id;
      if (status === "public" && !previewId) throw fail(409, "请先设置示例成片再上架。");
      db.prepare(`UPDATE templates SET title=?,description=?,category=?,status=?,
        current_version_id=?,preview_asset_id=?,updated_at=?,published_at=? WHERE id=?`).run(
        next.title.trim(),
        next.description.trim(),
        next.category.trim(),
        status ?? row.status,
        versionId,
        previewId,
        now,
        status === "public" ? row.published_at || now : row.published_at,
        id,
      );
      return serialize(getTemplateRow(id));
    });
  }
  function queryAdmin(query = {}) {
    const { q = "", status = "all", category = "", page = "1", pageSize = "10" } = query;
    if (
      typeof q !== "string" ||
      q.length > 100 ||
      typeof category !== "string" ||
      category.length > 30 ||
      !["all", "public", "private", "deleted"].includes(status) ||
      typeof page !== "string" ||
      !/^[1-9][0-9]{0,5}$/.test(page) ||
      typeof pageSize !== "string" ||
      !/^[1-9][0-9]?$|^100$/.test(pageSize)
    )
      throw fail(400, "查询条件无效。");
    const where = [status === "all" ? "t.status!='deleted'" : "t.status=?"];
    const args = status === "all" ? [] : [status];
    if (q.trim()) {
      where.push("instr(lower(t.title || ' ' || t.description || ' ' || t.id),lower(?))>0");
      args.push(q.trim());
    }
    if (category) {
      where.push("t.category=?");
      args.push(category);
    }
    const filter = where.join(" AND ");
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM templates t WHERE ${filter}`)
      .get(...args).n;
    const size = Number(pageSize),
      current = Math.min(Number(page), Math.max(1, Math.ceil(total / size)));
    const rows = db
      .prepare(`${catalogSelect} WHERE ${filter} ORDER BY t.created_at DESC,t.id LIMIT ? OFFSET ?`)
      .all(...args, size, (current - 1) * size);
    const categories = db
      .prepare("SELECT DISTINCT category FROM templates ORDER BY category")
      .all()
      .map((r) => r.category);
    return {
      templates: rows.map((row) => serialize(row)),
      total,
      page: current,
      pageSize: size,
      categories,
    };
  }
  function detailAdmin(id) {
    const row = getTemplateRow(id);
    if (!row) throw fail(404, "模板不存在。");
    return serialize(row);
  }
  function remove(id, expectedUpdatedAt) {
    if (!Number.isSafeInteger(expectedUpdatedAt))
      throw fail(400, "缺少模板修改版本，请刷新后重试。");
    return transact(db, () => {
      const row = getTemplateRow(id);
      if (!row) throw fail(404, "模板不存在。");
      if (row.status === "deleted") return serialize(row);
      if (row.updated_at !== expectedUpdatedAt) throw fail(409, "模板已被修改，请刷新后重试。");
      db.prepare("UPDATE templates SET status='deleted',updated_at=? WHERE id=?").run(
        Math.max(Date.now(), row.updated_at + 1),
        id,
      );
      db.prepare("DELETE FROM favorites WHERE template_id=?").run(id);
      return serialize(getTemplateRow(id));
    });
  }
  return {
    getTemplateRow,
    available,
    listPublic,
    createCurated,
    updateCurated,
    queryAdmin,
    detailAdmin,
    remove,
  };
}
