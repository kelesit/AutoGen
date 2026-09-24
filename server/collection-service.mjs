import { transact } from "./database.mjs";
const fail = (status, message) => Object.assign(new Error(message), { status });
export function createCollectionService(db) {
  const findByJob = (jobId) =>
    db.prepare("SELECT * FROM creations WHERE job_id=?").get(jobId) || null;
  function requireOwned(id, userId) {
    const row = db
      .prepare(`SELECT c.*,a.filename,a.bytes,a.sha256 FROM creations c JOIN assets a ON a.id=c.asset_id
      WHERE c.id=? AND c.user_id=? AND c.deleted_at IS NULL AND a.state='ready'`)
      .get(id, userId);
    if (!row) throw fail(404, "作品不存在或已删除。");
    return row;
  }
  function remove(id, userId) {
    return transact(db, () => {
      const row = db.prepare("SELECT * FROM creations WHERE id=? AND user_id=?").get(id, userId);
      if (!row) throw fail(404, "作品不存在。");
      if (row.deleted_at !== null) return { deleted: true };
      db.prepare("UPDATE creations SET deleted_at=? WHERE id=?").run(Date.now(), id);
      db.prepare("UPDATE assets SET expires_at=? WHERE id=?").run(Date.now(), row.asset_id);
      return { deleted: true };
    });
  }
  const list = (userId) =>
    db
      .prepare(`SELECT c.id,c.job_id,c.created_at,j.template_id,j.template_version_id,a.bytes,a.sha256
    FROM creations c JOIN jobs j ON j.id=c.job_id JOIN assets a ON a.id=c.asset_id
    WHERE c.user_id=? AND c.deleted_at IS NULL AND a.state='ready' ORDER BY c.created_at DESC LIMIT 100`)
      .all(userId)
      .map((row) => ({ ...row, video_url: `/api/creations/${row.id}/video` }));
  function feed(userId) {
    const jobs = db
      .prepare(`SELECT j.* FROM jobs j LEFT JOIN creations c ON c.job_id=j.id
      WHERE j.user_id=? AND (j.status!='completed' OR (c.id IS NOT NULL AND c.deleted_at IS NULL))
      ORDER BY (j.status NOT IN ('completed','failed','cancelled')) DESC,j.created_at DESC LIMIT 100`)
      .all(userId);
    const totalCreations = db
      .prepare("SELECT COUNT(*) n FROM creations WHERE user_id=? AND deleted_at IS NULL")
      .get(userId).n;
    const activeTasks = db
      .prepare(
        "SELECT COUNT(*) n FROM jobs WHERE user_id=? AND status NOT IN ('completed','failed','cancelled')",
      )
      .get(userId).n;
    return { jobs, totalCreations, activeTasks };
  }
  return { findByJob, requireOwned, list, remove, feed };
}
