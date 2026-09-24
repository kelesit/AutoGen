import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, post } from "./api";
import { submitJob } from "./recovery";
import { scenarioLabels } from "./demoScenarios";
import type { Job, Template, User } from "./types";

export function CreateModal({
  template,
  userId,
  onClose,
  onCreated,
}: {
  template: Template;
  userId: string;
  onClose: () => void;
  onCreated: (job: Job, user: User) => void;
}) {
  const [uploads, setUploads] = useState<Record<string, { id: string; preview: string }>>({});
  const [scenario, setScenario] = useState("normal");
  const [discardResponse, setDiscardResponse] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [resolution, setResolution] = useState(template.outputOptions.default.resolution);
  const [duration, setDuration] = useState(template.outputOptions.default.duration);
  const [quote, setQuote] = useState<{
    key: string;
    cost: number;
    version: string;
  } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [reconfirmKey, setReconfirmKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previewUrls = useRef<string[]>([]);
  const quoteKey = `${template.id}:${resolution}:${duration}`;
  const currentQuote = quote?.key === quoteKey ? quote : null;
  useEffect(() => {
    let alive = true;
    setQuote(null);
    setQuoteLoading(true);
    setError("");
    api<{ cost: number; version: string }>(
      "/quote",
      post({ templateId: template.id, resolution, duration }),
    )
      .then((value) => {
        if (alive) {
          setQuote({ ...value, key: quoteKey });
          if (reconfirmKey === quoteKey)
            setError(`本次报价为 ${value.cost} 积分，请再次点击确认。`);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setQuoteLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [quoteKey, quoteRevision, reconfirmKey, template.id, resolution, duration]);
  useEffect(() => () => previewUrls.current.forEach((url) => URL.revokeObjectURL(url)), []);
  async function upload(key: string, file?: File) {
    if (!file) return;
    // A new selection invalidates the previous asset before any validation or request.
    setUploads((old) => {
      const next = { ...old };
      if (next[key]) URL.revokeObjectURL(next[key].preview);
      delete next[key];
      return next;
    });
    if (file.size > 5 * 1024 * 1024) return setError("每张图片最多 5 MB。");
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("image", file);
      const saved = await api<{ id: string }>("/uploads", { method: "POST", body });
      const preview = URL.createObjectURL(file);
      previewUrls.current.push(preview);
      setUploads((old) => ({ ...old, [key]: { id: saved.id, preview } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !currentQuote || template.inputSlots.some((slot) => !uploads[slot.key])) return;
    const uploadIds = Object.fromEntries(
      Object.entries(uploads).map(([key, value]) => [key, value.id]),
    );
    setBusy(true);
    setError("");
    try {
      const result = await submitJob(
        userId,
        {
          templateId: template.id,
          templateVersionId: template.versionId,
          uploadIds,
          prompt,
          resolution,
          duration,
          scenario,
          expectedCost: currentQuote.cost,
          priceVersion: currentQuote.version,
        },
        discardResponse,
      );
      onCreated(result.job, result.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.message === "报价已变化，请重新确认。") {
        setQuote(null);
        setQuoteLoading(true);
        setReconfirmKey(quoteKey);
        setQuoteRevision((value) => value + 1);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        className="modal custom-create"
        role="dialog"
        aria-modal="true"
        aria-label={`使用 ${template.title} 模板`}
      >
        <button
          className="icon-button modal-close"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
        <h2>{template.title}</h2>
        {template.tags.length > 0 && (
          <div className="template-tags" aria-label="模板标签">
            {template.tags.map((tag) => <span className="template-tag" key={tag}>{tag}</span>)}
          </div>
        )}
        <p className="muted">
          上传与动作模板对应的人物图片。任务会固定模板版本、动作视频和图片槽位。
        </p>
        {template.preview_url && (
          <video controls autoPlay muted loop playsInline src={template.preview_url} />
        )}
        <form onSubmit={(e) => void submit(e)}>
          {template.inputSlots.map((slot) => (
            <label key={slot.key}>
              {slot.label}
              {slot.referenceRole && <span className="muted"> · 对应{slot.referenceRole}</span>}
              <input
                required
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(e) => void upload(slot.key, e.target.files?.[0])}
              />
              {uploads[slot.key] && (
                <img className="slot-preview" src={uploads[slot.key].preview} alt="已上传图片" />
              )}
            </label>
          ))}
          {template.outputOptions.allowUserPrompt && (
            <label>
              补充描述（可选）
              <textarea
                rows={2}
                maxLength={500}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
          )}
          <div className="form-columns">
            <label>
              分辨率
              <select
                value={resolution}
                disabled={busy}
                onChange={(e) => {
                  setQuote(null);
                  setQuoteLoading(true);
                  setReconfirmKey(null);
                  setError("");
                  setResolution(e.target.value);
                }}
              >
                {template.outputOptions.allowedResolutions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              时长
              <select
                value={duration}
                disabled={busy}
                onChange={(e) => {
                  setQuote(null);
                  setQuoteLoading(true);
                  setReconfirmKey(null);
                  setError("");
                  setDuration(Number(e.target.value));
                }}
              >
                {template.outputOptions.allowedDurations.map((value) => (
                  <option key={value} value={value}>
                    {value} 秒
                  </option>
                ))}
              </select>
            </label>
          </div>
          <details className="advanced">
            <summary>演示选项</summary>
            <label>
              故障场景
              <select
                disabled={busy}
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
              >
                {Object.entries(scenarioLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                disabled={busy}
                checked={discardResponse}
                onChange={(e) => setDiscardResponse(e.target.checked)}
              />
              模拟浏览器丢弃提交响应（可刷新后查单）
            </label>
            <p className="small-text muted">仅用于验证任务恢复，供应商调用与成本均为模拟数据。</p>
            {scenario === "unknown_no_lookup" && (
              <p className="form-error">此场景会停在人工核查并保留冻结积分，不适合连续创建。</p>
            )}
          </details>
          <p className="muted">演示阶段使用固定样片验证业务闭环；此处展示模拟积分报价。</p>
          {error && (
            <div role="alert" className="form-error">
              {error}
            </div>
          )}
          {!quoteLoading && !currentQuote && !busy && (
            <button
              type="button"
              className="button secondary full"
              onClick={() => setQuoteRevision((value) => value + 1)}
            >
              重新获取报价
            </button>
          )}
          <button
            className="button primary full"
            disabled={busy || !currentQuote || template.inputSlots.some((slot) => !uploads[slot.key])}
          >
            {busy ? "处理中…" : `开始生成 · ${currentQuote?.cost ?? "…"} 积分`}
          </button>
        </form>
      </div>
    </div>
  );
}
