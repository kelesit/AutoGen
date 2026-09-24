import { randomUUID } from "node:crypto";

const fail = (status, message) => Object.assign(new Error(message), { status });

// Both functions run inside the caller's job transaction.
export function holdCredits(db, { userId, jobId, cost, title, now }) {
  const changed = db
    .prepare("UPDATE users SET credits=credits-?,reserved=reserved+? WHERE id=? AND credits>=?")
    .run(cost, cost, userId, cost).changes;
  if (!changed) throw fail(402, "积分不足。演示版不支持付费充值。");
  db.prepare(
    "INSERT INTO ledger(id,user_id,job_id,kind,amount,description,created_at,reserved_delta) VALUES (?,?,?,?,?,?,?,?)",
  ).run(randomUUID(), userId, jobId, "hold", -cost, `${title} · 冻结 ${cost} 积分`, now, cost);
}

export function finishHeldCredits(db, job, settle, event) {
  const next = settle ? "settled" : "released";
  if (
    !db
      .prepare("UPDATE jobs SET billing_state=? WHERE id=? AND billing_state='held'")
      .run(next, job.id).changes
  )
    return;
  const updated = db
    .prepare("UPDATE users SET reserved=reserved-?,credits=credits+? WHERE id=? AND reserved>=?")
    .run(job.cost, settle ? 0 : job.cost, job.user_id, job.cost);
  if (!updated.changes) throw new Error("Frozen balance invariant violated");
  db.prepare(
    "INSERT INTO ledger(id,user_id,job_id,kind,amount,description,created_at,reserved_delta) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    randomUUID(),
    job.user_id,
    job.id,
    settle ? "settle" : "release",
    settle ? 0 : job.cost,
    settle ? "作品已保存 · 冻结积分结算" : "确认失败或未提交取消 · 释放冻结积分",
    Date.now(),
    -job.cost,
  );
  event(
    job.id,
    "billing",
    settle ? `结算 ${job.cost} 积分（可用余额不再扣减）` : `释放 ${job.cost} 冻结积分`,
  );
}
