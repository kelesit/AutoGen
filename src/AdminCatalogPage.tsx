import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, post } from "./api";
import type { AdminTemplate } from "./types";
import { CatalogManager } from "./CatalogManager";

type SlotMode = "single" | "duo";
type SavedVideo = { id: string; bytes: number; createdAt: number };
type AssetMode = "new" | "saved";
type Draft = {
  title: string;
  description: string;
  category: string;
  mode: SlotMode;
  promptRecipe: string;
  roles: string[];
  durations: number[];
  resolutions: string[];
  allowUserPrompt: boolean;
  selectedReferences: string[];
  selectedPreview: string;
  requestKey: string;
  lastPayload: string;
  needsFiles: boolean;
};
function readDraft(key: string): Partial<Draft> {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function AdminCatalogPage({
  userId,
  onPublished,
}: {
  userId: string;
  onPublished: () => void;
}) {
  const draftKey = `playbox:catalog-draft:${userId}`;
  const [draft] = useState(() => readDraft(draftKey));
  const [showCreate, setShowCreate] = useState(false);
  const [revision, setRevision] = useState(0);
  const [title, setTitle] = useState(draft.title ?? "");
  const [description, setDescription] = useState(draft.description ?? "");
  const [category, setCategory] = useState(draft.category ?? "动作");
  const [mode, setMode] = useState<SlotMode>(draft.mode ?? "single");
  const [promptRecipe, setPromptRecipe] = useState(draft.promptRecipe ?? "");
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [referenceMode, setReferenceMode] = useState<AssetMode>(
    draft.selectedReferences?.length ? "saved" : "new",
  );
  const [previewMode, setPreviewMode] = useState<AssetMode>(
    draft.selectedPreview ? "saved" : "new",
  );
  const [savedReferences, setSavedReferences] = useState<SavedVideo[]>([]);
  const [savedPreviews, setSavedPreviews] = useState<SavedVideo[]>([]);
  const [selectedReferences, setSelectedReferences] = useState<string[]>(
    draft.selectedReferences ?? [],
  );
  const [selectedPreview, setSelectedPreview] = useState(draft.selectedPreview ?? "");
  const [durations, setDurations] = useState<number[]>(draft.durations ?? [4, 8]);
  const [resolutions, setResolutions] = useState<string[]>(draft.resolutions ?? ["720p", "1080p"]);
  const [allowUserPrompt, setAllowUserPrompt] = useState(draft.allowUserPrompt ?? true);
  const [roles, setRoles] = useState<string[]>(draft.roles ?? ["主体人物", ""]);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const requestKey = useRef(draft.requestKey ?? crypto.randomUUID());
  const lastPayload = useRef(draft.lastPayload ?? "");
  useEffect(() => {
    const remainingFiles =
      (referenceMode === "new" && referenceFiles.length > referenceIds.length) ||
      (previewMode === "new" && !!previewFile && !previewId);
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          title,
          description,
          category,
          mode,
          promptRecipe,
          roles,
          durations,
          resolutions,
          allowUserPrompt,
          selectedReferences:
            referenceMode === "saved"
              ? selectedReferences
              : referenceFiles.length === referenceIds.length
                ? referenceIds
                : [],
          selectedPreview: previewMode === "saved" ? selectedPreview : previewId || "",
          requestKey: requestKey.current,
          lastPayload: lastPayload.current,
          needsFiles: remainingFiles,
        }),
      );
    } catch {
      /* Keep the mounted draft even when browser storage is unavailable. */
    }
    if (!remainingFiles) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [
    draftKey,
    title,
    description,
    category,
    mode,
    promptRecipe,
    roles,
    durations,
    resolutions,
    allowUserPrompt,
    selectedReferences,
    selectedPreview,
    referenceMode,
    previewMode,
    referenceFiles,
    previewFile,
    referenceIds,
    previewId,
    busy,
  ]);

  async function refreshUploads() {
    const data = await api<{ references: SavedVideo[]; previews: SavedVideo[] }>(
      "/admin/catalog-uploads",
    );
    setSavedReferences(data.references);
    setSavedPreviews(data.previews);
  }
  useEffect(() => {
    void refreshUploads().catch((e) => setError((e as Error).message));
  }, []);

  const videoLabel = (item: SavedVideo) =>
    `${new Date(item.createdAt).toLocaleString("zh-CN")} · ${(item.bytes / 1024 / 1024).toFixed(1)} MB · ${item.id.slice(0, 8)}`;

  async function uploadVideo(file: File, url: string) {
    const body = new FormData();
    body.append("video", file);
    return api<{ id: string }>(url, { method: "POST", body });
  }
  async function publish(event: FormEvent) {
    event.preventDefault();
    if (
      (referenceMode === "new" && (!referenceFiles.length || referenceFiles.length > 3)) ||
      (referenceMode === "saved" &&
        (!selectedReferences.length || selectedReferences.length > 3)) ||
      (previewMode === "new" && !previewFile) ||
      (previewMode === "saved" && !selectedPreview)
    )
      return setError("请为动作参考选择 1–3 段视频，并选择一段 MP4 示例成片。");
    if (!durations.length || !resolutions.length) return setError("至少选择一种时长和分辨率。");
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const ids = referenceMode === "saved" ? [...selectedReferences] : [...referenceIds];
      if (referenceMode === "new") {
        for (const file of referenceFiles.slice(ids.length)) {
          const saved = await uploadVideo(file, "/template-videos");
          ids.push(saved.id);
          setReferenceIds([...ids]);
        }
      }
      let coverId = previewMode === "saved" ? selectedPreview : previewId;
      if (!coverId && previewMode === "new" && previewFile) {
        const saved = await uploadVideo(previewFile, "/admin/catalog-preview-uploads");
        coverId = saved.id;
        setPreviewId(coverId);
      }
      const inputSlots =
        mode === "single"
          ? [
              {
                key: "person",
                kind: "person",
                label: "人物图片",
                required: true,
                referenceRole: roles[0].trim(),
              },
            ]
          : [
              {
                key: "person_a",
                kind: "person",
                label: "人物 A 图片",
                required: true,
                referenceRole: roles[0].trim(),
              },
              {
                key: "person_b",
                kind: "person",
                label: "人物 B 图片",
                required: true,
                referenceRole: roles[1].trim(),
              },
            ];
      const options = {
        default: { duration: durations[0], resolution: resolutions[0] },
        allowedDurations: durations,
        allowedResolutions: resolutions,
        allowUserPrompt,
      };
      const payload = {
        title,
        description,
        category,
        referenceVideoIds: ids,
        previewVideoId: coverId,
        inputSlots,
        promptRecipe,
        outputOptions: options,
      };
      const fingerprint = JSON.stringify(payload);
      if (fingerprint !== lastPayload.current) {
        requestKey.current = crypto.randomUUID();
        lastPayload.current = fingerprint;
      }
      try {
        const savedDraft = readDraft(draftKey);
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({
            ...savedDraft,
            requestKey: requestKey.current,
            lastPayload: lastPayload.current,
            selectedReferences: ids,
            selectedPreview: coverId,
            needsFiles: false,
          }),
        );
      } catch {
        /* The current tab still retains the request key. */
      }
      const created = await api<{ template: AdminTemplate }>("/admin/catalog-templates", {
        ...post(payload),
        headers: { "Idempotency-Key": requestKey.current },
      });
      setSuccess(`“${created.template.title}”已发布到 Explore。`);
      setTitle("");
      setDescription("");
      setCategory("动作");
      setMode("single");
      setRoles(["主体人物", ""]);
      setPromptRecipe("");
      setReferenceFiles([]);
      setPreviewFile(null);
      setReferenceIds([]);
      setPreviewId(null);
      setFileKey((value) => value + 1);
      setSelectedReferences([]);
      setSelectedPreview("");
      lastPayload.current = "";
      const reloaded = await Promise.allSettled([refreshUploads()]);
      if (reloaded.some((result) => result.status === "rejected"))
        setError("模板已发布，但列表刷新失败；刷新页面即可查看已发布模板。");
      setShowCreate(false);
      setRevision((value) => value + 1);
      onPublished();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const toggleDuration = (value: number) =>
    setDurations((old) =>
      old.includes(value) ? old.filter((item) => item !== value) : [value, ...old].sort(),
    );
  const toggleResolution = (value: string) =>
    setResolutions((old) =>
      old.includes(value) ? old.filter((item) => item !== value) : [value, ...old].sort(),
    );

  return (
    <div className="catalog-page">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="catalog-success" role="status">
          {success}
        </p>
      )}
      <div hidden={showCreate}>
        <CatalogManager
          key={revision}
          onCreate={() => {
            setShowCreate(true);
            setSuccess("");
            void refreshUploads().catch((e) => setError((e as Error).message));
          }}
          onChanged={() => {
            setSuccess("");
            onPublished();
          }}
        />
      </div>
      <div hidden={!showCreate}>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => setShowCreate(false)}
        >
          返回模板列表（保留草稿）
        </button>
        <form className="catalog-panel catalog-form" onSubmit={(event) => void publish(event)}>
          <fieldset disabled={busy} className="catalog-form-fields">
            <h2>发布动作模板</h2>
            {draft.needsFiles && (
              <p className="muted">已恢复表单草稿；刷新前未上传的本地视频需要重新选择。</p>
            )}
            <p className="muted">
              管理员预置模板：动作参考用于生成，示例成片只用于广场预览。首次发布为
              v1，已提交任务的配置保持不变。
            </p>
            <label>
              模板名称
              <input
                required
                maxLength={80}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              动作说明
              <input
                maxLength={300}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              分类
              <input
                required
                maxLength={30}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </label>
            <label>
              图片槽位
              <select value={mode} onChange={(e) => setMode(e.target.value as SlotMode)}>
                <option value="single">单人物 · 1 张图片</option>
                <option value="duo">双人物 · 2 张图片</option>
              </select>
            </label>
            {(mode === "duo" ? [0, 1] : [0]).map((index) => (
              <label key={index}>
                {mode === "duo" ? `人物 ${index === 0 ? "A" : "B"} 的角色说明` : "人物角色说明"}
                <input
                  required
                  maxLength={200}
                  value={roles[index] || ""}
                  placeholder={
                    index === 0 ? "例如：视频左侧挥手的人物" : "例如：视频右侧回应的人物"
                  }
                  onChange={(e) =>
                    setRoles((old) => old.map((value, i) => (i === index ? e.target.value : value)))
                  }
                />
              </label>
            ))}
            <div className="catalog-asset-group">
              <strong>动作参考视频（1–3 段）</strong>
              {savedReferences.length > 0 && (
                <div className="catalog-asset-modes">
                  <button
                    type="button"
                    className={referenceMode === "new" ? "selected" : ""}
                    onClick={() => setReferenceMode("new")}
                  >
                    上传新视频
                  </button>
                  <button
                    type="button"
                    className={referenceMode === "saved" ? "selected" : ""}
                    onClick={() => setReferenceMode("saved")}
                  >
                    选择已上传视频
                  </button>
                </div>
              )}
              {referenceMode === "new" ? (
                <label>
                  MP4 / MOV，每段最多 50 MB
                  <input
                    key={`ref-${fileKey}`}
                    required
                    type="file"
                    accept="video/mp4,video/quicktime"
                    multiple
                    onChange={(e) => {
                      setReferenceFiles(Array.from(e.target.files || []));
                      setReferenceIds([]);
                    }}
                  />
                </label>
              ) : (
                <div className="catalog-saved-list">
                  {savedReferences.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={selectedReferences.includes(item.id)}
                        onChange={(e) =>
                          setSelectedReferences((old) =>
                            e.target.checked
                              ? [...old, item.id]
                              : old.filter((id) => id !== item.id),
                          )
                        }
                      />
                      {videoLabel(item)}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="catalog-asset-group">
              <strong>广场示例成片</strong>
              {savedPreviews.length > 0 && (
                <div className="catalog-asset-modes">
                  <button
                    type="button"
                    className={previewMode === "new" ? "selected" : ""}
                    onClick={() => setPreviewMode("new")}
                  >
                    上传新视频
                  </button>
                  <button
                    type="button"
                    className={previewMode === "saved" ? "selected" : ""}
                    onClick={() => setPreviewMode("saved")}
                  >
                    选择已上传视频
                  </button>
                </div>
              )}
              {previewMode === "new" ? (
                <label>
                  MP4，最多 50 MB
                  <input
                    key={`preview-${fileKey}`}
                    required
                    type="file"
                    accept="video/mp4"
                    onChange={(e) => {
                      setPreviewFile(e.target.files?.[0] || null);
                      setPreviewId(null);
                    }}
                  />
                </label>
              ) : (
                <div className="catalog-saved-list">
                  {savedPreviews.map((item) => (
                    <label key={item.id}>
                      <input
                        type="radio"
                        name="saved-preview"
                        value={item.id}
                        checked={selectedPreview === item.id}
                        onChange={() => setSelectedPreview(item.id)}
                      />
                      {videoLabel(item)}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label>
              模板动作描述（可选）
              <textarea
                rows={3}
                maxLength={6000}
                value={promptRecipe}
                onChange={(e) => setPromptRecipe(e.target.value)}
              />
            </label>
            <div className="catalog-options">
              <fieldset>
                <legend>允许时长</legend>
                {[4, 8].map((value) => (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={durations.includes(value)}
                      onChange={() => toggleDuration(value)}
                    />
                    {value} 秒
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>允许分辨率</legend>
                {["720p", "1080p"].map((value) => (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={resolutions.includes(value)}
                      onChange={() => toggleResolution(value)}
                    />
                    {value}
                  </label>
                ))}
              </fieldset>
            </div>
            <label className="catalog-check">
              <input
                type="checkbox"
                checked={allowUserPrompt}
                onChange={(e) => setAllowUserPrompt(e.target.checked)}
              />
              允许使用者补充描述
            </label>
            <button className="button primary" disabled={busy}>
              {busy ? "上传并发布中…" : "发布到 Explore"}
            </button>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
