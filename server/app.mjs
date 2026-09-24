import express from "express";
import multer from "multer";
import sharp from "sharp";
import { openDatabase, transact } from "./database.mjs";
import { createEngine } from "./engine.mjs";
import { createCatalogService, defaultOutputOptions } from "./catalog-service.mjs";
import { createGenerationService } from "./generation-service.mjs";
import { createCollectionService } from "./collection-service.mjs";
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssetService } from "./asset-service.mjs";

const scrypt = promisify(scryptCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await scrypt(password, salt, 64)).toString("hex")}`;
}
async function passwordMatches(password, stored) {
  const [salt, key] = stored.split(":");
  return timingSafeEqual(Buffer.from(key, "hex"), await scrypt(password, salt, 64));
}
const fail = (status, message) => Object.assign(new Error(message), { status });
export async function createApp({
  dataDir = path.join(root, ".data-v2"),
  jobDuration = 14000,
  seed = true,
  startWorker = false,
} = {}) {
  const db = openDatabase(dataDir);
  const transaction = (fn) => transact(db, fn);
  const assets = createAssetService(db, dataDir);
  const engine = createEngine({ db, dataDir, jobDuration });
  const catalog = createCatalogService(db, assets);
  const generation = createGenerationService({ db, catalog, assets, event: engine.event });
  const collection = createCollectionService(db);
  let processing = false;
  const worker = startWorker
    ? setInterval(async () => {
        if (processing) return;
        processing = true;
        try {
          await engine.tick();
        } catch (error) {
          console.error("Worker failed:", error);
        } finally {
          processing = false;
        }
      }, 25)
    : null;
  worker?.unref();
  function addUser(email, name, password, role = "user") {
    const id = randomUUID();
    transaction(() => {
      db.prepare(
        "INSERT INTO users (id,email,name,password,role,credits,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, email, name, password, role, 300, Date.now());
      db.prepare(
        "INSERT INTO ledger (id,user_id,job_id,kind,amount,description,created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
      ).run(randomUUID(), id, "welcome", 300, "欢迎加入 · 演示积分", Date.now());
    });
    return id;
  }
  if (seed) {
    for (const [email, name, password, role] of [
      ["demo@playbox.local", "Demo Creator", "PlayboxDemo2026!", "user"],
      ["admin@playbox.local", "Studio Admin", "PlayboxAdmin2026!", "admin"],
    ]) {
      if (!db.prepare("SELECT id FROM users WHERE email = ?").get(email))
        addUser(email, name, await passwordHash(password), role);
    }
    if (!db.prepare("SELECT 1 FROM templates").get()) {
      const adminId = db
        .prepare("SELECT id FROM users WHERE email=?")
        .get("admin@playbox.local").id;
      const bytes = await readFile(path.join(root, "public", "media", "sample.mp4"));
      const reference = assets.upload({ ownerId: adminId, kind: "reference", bytes });
      const preview = assets.upload({ ownerId: adminId, kind: "preview", bytes });
      catalog.createCurated(adminId, "seed-template-001", {
        title: "动作参考 · 单人",
        description: "上传人物图片，使用动作参考生成视频",
        category: "动作",
        referenceVideoIds: [reference.id],
        previewVideoId: preview.id,
        inputSlots: [
          {
            key: "person",
            kind: "person",
            label: "人物图片",
            required: true,
            referenceRole: "主体",
          },
        ],
        promptRecipe: "Follow the reference motion.",
        outputOptions: defaultOutputOptions,
      });
    }
  }
  const userView = (id) =>
    db
      .prepare(
        "SELECT id, email, name, role, credits, reserved, created_at FROM users WHERE id = ?",
      )
      .get(id);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
      const allowed = new Set(
        [
          `http://${req.headers.host}`,
          "http://127.0.0.1:5173",
          "http://localhost:5173",
          process.env.APP_ORIGIN,
        ].filter(Boolean),
      );
      if (!allowed.has(req.headers.origin))
        return res.status(403).json({ error: "请求来源不受信任。" });
    }
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use("/api", (req, res, next) => {
    const token = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("playbox_session="))
      ?.slice(16);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const session = db
        .prepare("SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?")
        .get(hash(token), Date.now());
      if (session) req.user = userView(session.user_id);
    }
    next();
  });
  const auth = (req, res, next) =>
    req.user ? next() : res.status(401).json({ error: "请先登录。" });
  const admin = (req, res, next) =>
    req.user?.role === "admin" ? next() : res.status(403).json({ error: "需要管理员权限。" });
  const getTemplateRow = catalog.getTemplateRow;
  const availableTemplate = catalog.available;
  const attempts = new Map();
  const limitAuth = (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (now - value.time > 60000) attempts.delete(key);
    const record = attempts.get(req.ip) || { time: now, count: 0 };
    attempts.set(req.ip, record);
    if (++record.count > 30) return res.status(429).json({ error: "操作太频繁，请稍后再试。" });
    next();
  };
  function login(res, userId) {
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
      hash(token),
      userId,
      Date.now() + 7 * 86400000,
    );
    res.cookie("playbox_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true",
      maxAge: 7 * 86400000,
      path: "/",
    });
    res.json({ user: userView(userId) });
  }
  app.get("/api/health", (req, res) =>
    res.json({ ok: true, provider: "mock", storage: "sqlite", ...engine.health() }),
  );
  app.get("/api/me", (req, res) => res.json({ user: req.user || null }));
  app.post("/api/auth/register", limitAuth, async (req, res) => {
    const { email, password, name } = req.body || {};
    if (
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 200
    )
      throw fail(400, "请输入有效邮箱。");
    if (typeof password !== "string" || password.length < 8 || password.length > 128)
      throw fail(400, "密码需为 8–128 位。");
    if (typeof name !== "string" || !name.trim() || name.trim().length > 40)
      throw fail(400, "昵称需为 1–40 个字符。");
    const normalized = email.trim().toLowerCase();
    const secret = await passwordHash(password);
    if (db.prepare("SELECT id FROM users WHERE email = ?").get(normalized))
      throw fail(409, "这个邮箱已经注册。");
    login(res, addUser(normalized, name.trim(), secret));
  });
  app.post("/api/auth/login", limitAuth, async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string" || password.length > 128)
      throw fail(400, "请输入邮箱和密码。");
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase());
    if (!user || !(await passwordMatches(password, user.password)))
      throw fail(401, "邮箱或密码不正确。");
    login(res, user.id);
  });
  app.post("/api/auth/logout", auth, (req, res) => {
    const token = req.headers.cookie
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("playbox_session="))
      ?.slice(16);
    if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(hash(token));
    res.clearCookie("playbox_session", { path: "/" });
    res.json({ ok: true });
  });
  app.get("/api/templates", (req, res) => res.json({ templates: catalog.listPublic(req.user) }));
  const videoUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 1,
    },
  });
  app.post("/api/template-videos", auth, admin, videoUpload.single("video"), async (req, res) => {
    const bytes = req.file?.buffer;
    if (!bytes || bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp")
      throw fail(400, "请上传 MP4 或 MOV 视频。");
    const isMov = req.file.mimetype === "video/quicktime";
    if (!isMov && req.file.mimetype !== "video/mp4") throw fail(400, "仅支持 MP4 或 MOV 视频。");
    const asset = assets.upload({
      ownerId: req.user.id,
      kind: "reference",
      bytes,
      mime: isMov ? "video/quicktime" : "video/mp4",
    });
    res.status(201).json({ id: asset.id });
  });
  app.get("/api/admin/catalog-uploads", auth, admin, (req, res) =>
    res.json({
      references: assets.list(req.user.id, "reference"),
      previews: assets.list(req.user.id, "preview"),
    }),
  );
  app.delete("/api/assets/:id", auth, (req, res) =>
    res.json(assets.removeOwned(req.params.id, req.user.id)),
  );
  app.post(
    "/api/admin/catalog-preview-uploads",
    auth,
    admin,
    videoUpload.single("video"),
    (req, res) => {
      const bytes = req.file?.buffer;
      if (
        !bytes ||
        bytes.length < 12 ||
        bytes.toString("ascii", 4, 8) !== "ftyp" ||
        req.file.mimetype !== "video/mp4"
      )
        throw fail(400, "请上传有效的 MP4 示例视频。");
      const asset = assets.upload({ ownerId: req.user.id, kind: "preview", bytes });
      res.status(201).json({ id: asset.id });
    },
  );
  app.get("/api/admin/catalog-templates", auth, admin, (req, res) => {
    res.json(catalog.queryAdmin(req.query));
  });
  app.get("/api/admin/catalog-templates/:id", auth, admin, (req, res) => {
    res.json({ template: catalog.detailAdmin(req.params.id) });
  });
  app.get("/api/admin/catalog-templates/:id/reference-videos/:videoId", auth, admin, (req, res) => {
    const template = catalog.detailAdmin(req.params.id);
    if (!template.motionVideoIds.includes(req.params.videoId))
      throw fail(404, "模板未引用此动作视频。");
    const video = assets.requireReady(req.params.videoId, { kind: "reference" });
    res.sendFile(video.filename, { root: assets.directory });
  });
  app.delete("/api/admin/catalog-templates/:id", auth, admin, (req, res) => {
    res.json({ template: catalog.remove(req.params.id, req.body?.expectedUpdatedAt) });
  });
  app.post("/api/admin/catalog-templates", auth, admin, (req, res) => {
    const result = catalog.createCurated(req.user.id, req.headers["idempotency-key"], req.body);
    res.status(result.existing ? 200 : 201).json({ template: result.template });
  });
  app.patch("/api/admin/catalog-templates/:id", auth, admin, (req, res) => {
    res.json({ template: catalog.updateCurated(req.user.id, req.params.id, req.body) });
  });
  app.get("/api/templates/:id/preview-video", (req, res) => {
    const row = getTemplateRow(req.params.id);
    if (!row || row.status === "deleted" || (row.status !== "public" && req.user?.role !== "admin"))
      throw fail(404, "预览不存在。");
    const preview = assets.requireReady(row.preview_asset_id, { kind: "preview" });
    res.sendFile(preview.filename, { root: assets.directory });
  });
  app.put("/api/favorites/:id", auth, (req, res) => {
    if (!availableTemplate(req.params.id, req.user)) throw fail(404, "模板不存在。");
    if (typeof req.body?.favorite !== "boolean") throw fail(400, "收藏状态无效。");
    if (req.body.favorite)
      db.prepare("INSERT OR IGNORE INTO favorites VALUES (?, ?)").run(req.user.id, req.params.id);
    else
      db.prepare("DELETE FROM favorites WHERE user_id = ? AND template_id = ?").run(
        req.user.id,
        req.params.id,
      );
    res.json({ favorite: req.body.favorite });
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });
  app.post("/api/uploads", auth, upload.single("image"), async (req, res) => {
    if (!req.file) throw fail(400, "请选择一张图片。");
    let buffer;
    try {
      const metadata = await sharp(req.file.buffer, { limitInputPixels: 25000000 }).metadata();
      if (!["jpeg", "png", "webp"].includes(metadata.format)) throw new Error("format");
      buffer = await sharp(req.file.buffer, { limitInputPixels: 25000000 })
        .rotate()
        .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .toBuffer();
    } catch {
      throw fail(400, "请上传有效的 JPG、PNG 或 WebP 图片，尺寸不超过 2500 万像素。");
    }
    const asset = assets.upload({
      ownerId: req.user.id,
      kind: "image",
      bytes: buffer,
      mime: "image/jpeg",
    });
    res.status(201).json({ id: asset.id, url: `/api/uploads/${asset.id}` });
  });
  app.get("/api/uploads/:id", auth, (req, res) => {
    const asset = assets.get(req.params.id);
    if (
      !asset ||
      asset.owner_id !== req.user.id ||
      asset.kind !== "image" ||
      asset.state !== "ready"
    )
      throw fail(404, "图片不存在。");
    res.sendFile(asset.filename, { root: assets.directory });
  });
  const serialize = (job) => {
    const creation = job.status === "completed" ? collection.findByJob(job.id) : null;
    return {
      ...job,
      template: JSON.parse(job.template_snapshot),
      quote: job.quote_snapshot ? JSON.parse(job.quote_snapshot) : null,
      creation_id: creation?.id ?? null,
      output_url:
        creation && creation.deleted_at === null ? `/api/creations/${creation.id}/video` : null,
      creation_deleted: !!creation?.deleted_at,
      input_assets: job.input_assets_snapshot ? JSON.parse(job.input_assets_snapshot) : null,
      provider: "mock",
    };
  };
  app.get("/api/jobs", auth, (req, res) =>
    res.json({
      jobs: db
        .prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100")
        .all(req.user.id)
        .map(serialize),
    }),
  );
  app.get("/api/creations", auth, (req, res) =>
    res.json({ creations: collection.list(req.user.id) }),
  );
  app.get("/api/creations/:id/video", auth, (req, res) => {
    const creation = collection.requireOwned(req.params.id, req.user.id);
    if (req.query.download === "1") res.attachment("playbox-demo-sample.mp4");
    res.sendFile(creation.filename, { root: assets.directory });
  });
  app.delete("/api/creations/:id", auth, (req, res) =>
    res.json(collection.remove(req.params.id, req.user.id)),
  );
  app.get("/api/collection", auth, (req, res) => {
    const result = collection.feed(req.user.id);
    res.json({ ...result, jobs: result.jobs.map(serialize) });
  });
  app.post("/api/quote", auth, (req, res) => res.json(generation.quote(req.user, req.body)));
  app.get("/api/jobs/by-key/:key", auth, (req, res) => {
    const job = db
      .prepare("SELECT * FROM jobs WHERE user_id=? AND request_key=?")
      .get(req.user.id, req.params.key);
    if (!job) throw fail(404, "没有找到该请求。可以使用原请求标识重试提交。");
    res.json({ job: serialize(job), user: userView(req.user.id) });
  });
  app.post("/api/jobs", auth, (req, res) => {
    const result = generation.createJob(req.user, req.body, req.headers["idempotency-key"]);
    res.status(result.existing ? 200 : 201).json({
      job: serialize(result.job),
      user: userView(req.user.id),
    });
  });
  app.post("/api/jobs/:id/cancel", auth, (req, res) => {
    const job = engine.cancel(req.params.id, req.user.id);
    res.json({ job: serialize(job), user: userView(req.user.id) });
  });
  app.get("/api/jobs/:id/detail", auth, (req, res) => {
    const job = db
      .prepare("SELECT * FROM jobs WHERE id=? AND (user_id=? OR ?=1)")
      .get(req.params.id, req.user.id, Number(req.user.role === "admin"));
    if (!job) throw fail(404, "任务不存在。");
    res.json({ job: serialize(job), ...engine.detail(job.id) });
  });
  app.post("/api/admin/jobs/:id/recover", auth, admin, (req, res) =>
    res.json({ job: serialize(engine.recover(req.params.id, req.user.id)) }),
  );
  app.post("/api/admin/jobs/:id/replay", auth, admin, (req, res) => {
    const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(req.params.id);
    if (!job || job.status !== "completed") throw fail(409, "请选一个已完成任务演示事件重放。");
    const cost = db.prepare("SELECT cost_units FROM provider_costs WHERE job_id=?").get(job.id);
    if (!cost) throw fail(409, "任务没有可重放的供应商记录。");
    transaction(() =>
      engine.event(
        job.id,
        "admin_replay",
        `管理员 ${req.user.id} 注入 3 次重复成功和 1 次过期处理中事件（模拟事件，不是真实回调）`,
      ),
    );
    for (const status of ["succeeded", "succeeded", "succeeded", "running"])
      engine.applyProviderEvent(job.id, {
        id: job.provider_id,
        status,
        costUnits: cost.cost_units,
      });
    res.json({ ok: true });
  });
  app.get("/api/ledger", auth, (req, res) =>
    res.json({
      ledger: db
        .prepare("SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 200")
        .all(req.user.id),
    }),
  );
  app.get("/api/admin", auth, admin, (req, res) => {
    res.json({
      runtime: engine.health(),
      stats: {
        users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
        jobs: db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n,
        active: db
          .prepare(
            "SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ('completed','failed','cancelled')",
          )
          .get().n,
        completed: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'completed'").get().n,
        credits: db
          .prepare("SELECT COALESCE(SUM(cost),0) AS n FROM jobs WHERE billing_state='settled'")
          .get().n,
      },
      jobs: db
        .prepare(
          "SELECT jobs.*, users.name AS user_name, users.email FROM jobs JOIN users ON users.id = jobs.user_id ORDER BY jobs.created_at DESC LIMIT 100",
        )
        .all()
        .map(serialize),
      users: db
        .prepare(
          "SELECT id, name, email, role, credits, reserved, created_at FROM users ORDER BY created_at DESC LIMIT 100",
        )
        .all(),
      ledger: db
        .prepare(
          "SELECT ledger.*, users.name AS user_name FROM ledger JOIN users ON users.id = ledger.user_id ORDER BY ledger.created_at DESC LIMIT 100",
        )
        .all(),
    });
  });
  app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在。" }));
  if (existsSync(path.join(root, "dist"))) {
    app.use(express.static(path.join(root, "dist")));
    app.get("/{*path}", (req, res) => res.sendFile(path.join(root, "dist", "index.html")));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof multer.MulterError ? 400 : error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? req.path.includes("template-videos") || req.path.includes("catalog-preview-uploads")
            ? "视频大小不能超过 50 MB。"
            : "图片大小不能超过 5 MB。"
          : status < 500
            ? error.message
            : "服务暂时不可用，请稍后再试。",
    });
  });
  return {
    app,
    db,
    engine,
    close: () => {
      clearInterval(worker);
      engine.close();
      db.close();
    },
  };
}
