import { api, post, ApiError } from "./api";
import type { Job, User } from "./types";
export interface Pending {
  key: string;
  fingerprint: string;
  body: Record<string, unknown>;
  createdAt: number;
}
const storageKey = (userId: string) => `playbox:pending:${userId}`;
export function readPending(userId: string): Pending | null {
  try {
    return JSON.parse(localStorage.getItem(storageKey(userId)) || "null");
  } catch {
    return null;
  }
}
function clear(userId: string) {
  localStorage.removeItem(storageKey(userId));
  window.dispatchEvent(new Event("pending-request"));
}
async function send(userId: string, pending: Pending, discardResponse = false) {
  try {
    const result = await api<{ job: Job; user: User }>("/jobs", {
      ...post(pending.body),
      headers: { "Idempotency-Key": pending.key },
    });
    if (discardResponse)
      throw new Error(
        "演示：提交响应被丢弃。请关闭弹窗，使用恢复提示查询原任务；刷新页面后仍可恢复。",
      );
    clear(userId);
    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 401].includes(error.status)
    )
      clear(userId);
    throw error;
  }
}
export async function submitJob(
  userId: string,
  body: Record<string, unknown>,
  discardResponse = false,
) {
  const fingerprint = JSON.stringify(body);
  const previous = readPending(userId);
  if (previous && previous.fingerprint !== fingerprint)
    throw new Error("还有一笔提交结果未确认。请关闭窗口，在恢复提示中查单后再创建新任务。");
  const pending = previous || {
    key: crypto.randomUUID(),
    fingerprint,
    body,
    createdAt: Date.now(),
  };
  // Persist BEFORE sending. If persistence is unavailable, do not submit.
  localStorage.setItem(storageKey(userId), JSON.stringify(pending));
  window.dispatchEvent(new Event("pending-request"));
  return send(userId, pending, discardResponse);
}
export async function recoverPending(userId: string) {
  const pending = readPending(userId);
  if (!pending) return null;
  try {
    const result = await api<{ job: Job; user: User }>(
      `/jobs/by-key/${encodeURIComponent(pending.key)}`,
    );
    clear(userId);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return send(userId, pending);
    throw error;
  }
}
