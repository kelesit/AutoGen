import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import path from "node:path";
import { transact } from "./database.mjs";
const fail = (status, message) => Object.assign(new Error(message), { status });
export const UPLOAD_TTL = 24 * 60 * 60 * 1000;
export function createAssetService(db, dataDir) {
  const directory = path.resolve(dataDir, "assets");
  mkdirSync(directory, { recursive: true });
  const get = (id) =>
    typeof id === "string" ? db.prepare("SELECT * FROM assets WHERE id=?").get(id) : null;
  function requireReady(id, { ownerId, kind } = {}) {
    const asset = get(id);
    if (
      !asset ||
      asset.state !== "ready" ||
      (ownerId && asset.owner_id !== ownerId) ||
      (kind && asset.kind !== kind)
    )
      throw fail(400, "素材不存在、已删除或无权使用。");
    return asset;
  }
  const retainedSQL = `
      EXISTS(SELECT 1 FROM templates WHERE preview_asset_id=a.id AND status!='deleted') OR
      EXISTS(SELECT 1 FROM template_version_assets r JOIN templates t ON t.current_version_id=r.version_id WHERE r.asset_id=a.id AND t.status!='deleted') OR
      EXISTS(SELECT 1 FROM job_input_assets r JOIN jobs j ON j.id=r.job_id WHERE r.asset_id=a.id AND j.status NOT IN ('completed','failed','cancelled')) OR
      EXISTS(SELECT 1 FROM job_outputs r JOIN jobs j ON j.id=r.job_id WHERE r.asset_id=a.id AND j.status NOT IN ('completed','failed','cancelled')) OR
      EXISTS(SELECT 1 FROM creations WHERE asset_id=a.id AND deleted_at IS NULL)`;
  function retained(id) {
    return !!db.prepare(`SELECT 1 FROM assets a WHERE a.id=? AND (${retainedSQL})`).get(id);
  }
  // Every byte mutation gets a new asset ID. Output retries reuse the stable job-bound ID only before delivery.
  function stage({ ownerId, kind, bytes, mime = "video/mp4", id = randomUUID(), jobId }) {
    const filename = `${id}.${kind === "image" ? "jpg" : "mp4"}`;
    const sha = createHash("sha256").update(bytes).digest("hex");
    transact(db, () => {
      const existing = get(id);
      if (
        existing &&
        (existing.state !== "staging" || existing.owner_id !== ownerId || existing.sha256 !== sha)
      )
        throw fail(409, "素材状态或内容已变化，不能覆盖。");
      if (!existing)
        db.prepare(`INSERT INTO assets(id,owner_id,kind,filename,mime,bytes,sha256,state,library,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,'staging',?,?,?)`).run(
          id,
          ownerId,
          kind,
          filename,
          mime,
          bytes.length,
          sha,
          0,
          Date.now(),
          Date.now() + UPLOAD_TTL,
        );
      else db.prepare("UPDATE assets SET bytes=?,sha256=? WHERE id=?").run(bytes.length, sha, id);
      if (jobId)
        db.prepare("INSERT OR IGNORE INTO job_outputs(job_id,asset_id) VALUES (?,?)").run(
          jobId,
          id,
        );
    });
    const temp = path.join(directory, `${id}.tmp`);
    writeFileSync(temp, bytes);
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path.join(directory, filename));
    const dirfd = openSync(directory, "r");
    try {
      fsyncSync(dirfd);
    } finally {
      closeSync(dirfd);
    }
    return get(id);
  }
  function ready(id) {
    db.prepare("UPDATE assets SET state='ready' WHERE id=? AND state='staging'").run(id);
    return requireReady(id);
  }
  function upload(input) {
    const asset = stage(input);
    return ready(asset.id);
  }
  function cleanup({ now = Date.now(), limit = 20, removeFile = unlinkSync } = {}) {
    const ids = transact(db, () => {
      const rows = db
        .prepare(`SELECT * FROM assets a WHERE state='deleting' OR
        (state IN ('ready','staging') AND (library=0 OR state='staging') AND expires_at<=? AND NOT (${retainedSQL})) ORDER BY created_at LIMIT ?`)
        .all(now, limit);
      return rows
        .filter((a) => a.state === "deleting" || !retained(a.id))
        .map((a) => {
          db.prepare(
            "UPDATE assets SET state='deleting',deleted_at=COALESCE(deleted_at,?) WHERE id=?",
          ).run(now, a.id);
          return a.id;
        });
    });
    for (const id of ids) {
      const asset = get(id);
      try {
        for (const name of [asset.filename, `${id}.tmp`])
          try {
            removeFile(path.join(directory, name));
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        db.prepare("UPDATE assets SET state='deleted',cleanup_error=NULL WHERE id=?").run(id);
      } catch (e) {
        db.prepare("UPDATE assets SET cleanup_error=? WHERE id=?").run(
          String(e.message).slice(0, 300),
          id,
        );
      }
    }
    return ids.length;
  }
  return {
    directory,
    get,
    requireReady,
    retained,
    stage,
    ready,
    upload,
    cleanup,
    read(id) {
      const asset = requireReady(id);
      return readFileSync(path.join(directory, asset.filename));
    },
  };
}
