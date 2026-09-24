import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import type { AdminTemplate } from "./types";
import { TagInput } from "./TagInput";

const statusLabel: Record<string, string> = {
  public: "已上架",
  private: "未上架",
  deleted: "已删除",
};
type Listing = {
  templates: AdminTemplate[];
  total: number;
  page: number;
  pageSize: number;
};
const when = (time?: number) => (time ? new Date(time).toLocaleString("zh-CN") : "—");

export function CatalogManager({
  onCreate,
  onChanged,
}: {
  onCreate: () => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Listing>({
    templates: [],
    total: 0,
    page: 1,
    pageSize: 10,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState<AdminTemplate | null>(null);
  const [editing, setEditing] = useState<AdminTemplate | null>(null);
  const [deleting, setDeleting] = useState<AdminTemplate | null>(null);
  const request = useRef(0);
  async function refresh() {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<Listing>(
        `/admin/catalog-templates?${new URLSearchParams({ q: query, status, page: String(page) })}`,
      );
      if (id === request.current) {
        setData(result);
        if (result.page !== page) setPage(result.page);
      }
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 200);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [query, status, page]);
  async function open(item: AdminTemplate, edit: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ template: AdminTemplate }>(`/admin/catalog-templates/${item.id}`);
      if (edit) {
        setEditing(result.template);
        setDetail(null);
      } else {
        setDetail(result.template);
        setEditing(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(item: AdminTemplate) {
    setBusy(true);
    setError("");
    try {
      await api(`/admin/catalog-templates/${item.id}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedUpdatedAt: item.updatedAt }),
      });
      setDeleting(null);
      setDetail(null);
      setEditing(null);
      setMessage("模板已删除，历史任务和作品保留；不能恢复。");
      onChanged();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="catalog-toolbar">
        <div>
          <h2>模板管理</h2>
          <p className="muted">新增、查询、编辑模板，或将不再使用的模板删除。</p>
        </div>
        <button
          className="button primary"
          onClick={onCreate}
          disabled={busy || !!editing || !!deleting}
        >
          新增模板
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="catalog-success">
          {message}
        </p>
      )}
      {deleting && (
        <section className="catalog-panel" role="alertdialog" aria-label="确认删除模板">
          <h3>删除“{deleting.title}”？</h3>
          <p>
            {deleting.jobCount
              ? `已有 ${deleting.jobCount} 个任务引用此模板，任务、作品和积分流水都会保留。`
              : "该模板尚无任务引用。"}{" "}
            删除后不能再用于新生成，且无法恢复。
          </p>
          <div className="catalog-row-actions">
            <button className="button danger" disabled={busy} onClick={() => void remove(deleting)}>
              确认删除
            </button>
            <button className="button" disabled={busy} onClick={() => setDeleting(null)}>
              取消删除
            </button>
          </div>
        </section>
      )}
      {editing && (
        <TemplateEditor
          key={`${editing.id}:${editing.updatedAt}`}
          template={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMessage("模板修改已保存。");
            onChanged();
            void refresh();
          }}
        />
      )}
      {detail && (
        <section className="catalog-panel catalog-detail">
          <div className="catalog-toolbar">
            <h3>模板详情：{detail.title}</h3>
            <button className="button" onClick={() => setDetail(null)}>
              关闭详情
            </button>
          </div>
          <p>{detail.subtitle || "暂无说明"}</p>
          <dl>
            <dt>模板 ID</dt>
            <dd>{detail.id}</dd>
            <dt>状态 / 版本</dt>
            <dd>
              {statusLabel[detail.status || "private"]} · v{detail.version}
            </dd>
            <dt>创建者</dt>
            <dd>{detail.creator}</dd>
            <dt>标签</dt>
            <dd><div className="template-tags">{detail.tags.length ? detail.tags.map((tag) => <span className="template-tag" key={tag}>{tag}</span>) : "暂无标签"}</div></dd>
            <dt>创建 / 修改时间</dt>
            <dd>
              {when(detail.createdAt)} / {when(detail.updatedAt)}
            </dd>
            <dt>任务引用</dt>
            <dd>{detail.jobCount || 0} 个任务</dd>
            <dt>允许规格</dt>
            <dd>
              {detail.outputOptions.allowedResolutions.join("、")} /{" "}
              {detail.outputOptions.allowedDurations.join("、")} 秒
            </dd>
            <dt>默认规格</dt>
            <dd>
              {detail.outputOptions.default.resolution} / {detail.outputOptions.default.duration} 秒
            </dd>
            <dt>补充描述</dt>
            <dd>{detail.outputOptions.allowUserPrompt ? "允许" : "不允许"}</dd>
          </dl>
          <h4>图片槽位</h4>
          {detail.inputSlots.map((slot) => (
            <p key={slot.key}>
              {slot.label || slot.key}（{slot.key}） · {slot.referenceRole || "未设置角色说明"}
            </p>
          ))}
          <h4>模板 Prompt</h4>
          <pre>{detail.promptRecipe || "未设置"}</pre>
          {detail.status === "deleted" ? (
            <p className="muted">模板已删除，仅保留配置记录，不再展示媒体预览。</p>
          ) : (
            <>
              <h4>动作参考视频</h4>
              <div className="catalog-media">
                {detail.motionVideoIds.map((id) => (
                  <video
                    key={id}
                    controls
                    preload="metadata"
                    src={`/api/admin/catalog-templates/${detail.id}/reference-videos/${id}`}
                  />
                ))}
              </div>
              <h4>广场示例成片</h4>
              {detail.preview_url ? (
                <video controls preload="metadata" src={detail.preview_url} />
              ) : (
                <p>尚未设置</p>
              )}
            </>
          )}
        </section>
      )}
      <div hidden={!!editing || !!deleting}>
        <div className="catalog-filters">
          <label>
            搜索模板
            <input
              value={query}
              maxLength={100}
              placeholder="名称、说明或 ID"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            模板状态
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">全部（不含已删除）</option>
              {Object.entries(statusLabel).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="button" disabled={loading || busy} onClick={() => void refresh()}>
            刷新列表
          </button>
        </div>
        {loading ? (
          <p role="status">正在查询模板…</p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="catalog-table">
                <thead>
                  <tr>
                    <th>模板</th>
                    <th>标签</th>
                    <th>状态 / 版本</th>
                    <th>引用任务</th>
                    <th>修改时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.templates.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.title}</strong>
                        <small>{item.id.slice(0, 8)}</small>
                      </td>
                      <td>{item.tags.join("、") || "—"}</td>
                      <td>
                        {statusLabel[item.status || "private"]} · v{item.version}
                      </td>
                      <td>{item.jobCount || 0}</td>
                      <td>{when(item.updatedAt)}</td>
                      <td>
                        <div className="catalog-row-actions">
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => void open(item, false)}
                            aria-label={`查看 ${item.title}`}
                          >
                            查看
                          </button>
                          {item.status !== "deleted" && (
                            <>
                              {["public", "private"].includes(item.status || "") && (
                                <button
                                  className="text-button"
                                  disabled={busy}
                                  onClick={() => void open(item, true)}
                                  aria-label={`编辑 ${item.title}`}
                                >
                                  编辑
                                </button>
                              )}
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() => {
                                  setDeleting(item);
                                  setEditing(null);
                                  setDetail(null);
                                  setError("");
                                }}
                                aria-label={`删除 ${item.title}`}
                              >
                                删除
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.templates.length && <p className="table-empty">没有符合条件的模板。</p>}
            <div className="catalog-toolbar">
              <span>
                共 {data.total} 个 · 第 {data.page} /{" "}
                {Math.max(1, Math.ceil(data.total / data.pageSize))} 页
              </span>
              <div className="catalog-row-actions">
                <button
                  className="button"
                  disabled={data.page <= 1}
                  onClick={() => setPage(data.page - 1)}
                >
                  上一页
                </button>
                <button
                  className="button"
                  disabled={data.page * data.pageSize >= data.total}
                  onClick={() => setPage(data.page + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function TemplateEditor({
  template,
  onCancel,
  onSaved,
}: {
  template: AdminTemplate;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(template.title);
  const [description, setDescription] = useState(template.subtitle);
  const [tags, setTags] = useState(template.tags);
  const [slots, setSlots] = useState(template.inputSlots);
  const [status, setStatus] = useState(template.status === "public" ? "public" : "private");
  const [prompt, setPrompt] = useState(template.promptRecipe);
  const [options, setOptions] = useState(template.outputOptions);
  const [references, setReferences] = useState(template.motionVideoIds);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedReferences, setUploadedReferences] = useState<string[]>([]);
  const [preview, setPreview] = useState<File | null>(null);
  const [uploadedPreview, setUploadedPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload(file: File, url: string) {
    const body = new FormData();
    body.append("video", file);
    return api<{ id: string }>(url, { method: "POST", body });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (references.length + files.length < 1 || references.length + files.length > 3)
      return setError("请保留或上传合计 1–3 段动作参考视频。");
    if (!options.allowedDurations.length || !options.allowedResolutions.length)
      return setError("至少选择一种时长和分辨率。");
    setBusy(true);
    setError("");
    try {
      const added = [...uploadedReferences];
      for (const file of files.slice(added.length)) {
        added.push((await upload(file, "/template-videos")).id);
        setUploadedReferences([...added]);
      }
      let previewVideoId = uploadedPreview;
      if (preview && !previewVideoId) {
        previewVideoId = (await upload(preview, "/admin/catalog-preview-uploads")).id;
        setUploadedPreview(previewVideoId);
      }
      await api(`/admin/catalog-templates/${template.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedUpdatedAt: template.updatedAt,
          title,
          description,
          tags,
          inputSlots: slots,
          status,
          referenceVideoIds: [...references, ...added],
          promptRecipe: prompt,
          outputOptions: options,
          ...(previewVideoId ? { previewVideoId } : {}),
        }),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function toggleDuration(value: number) {
    setOptions((old) => {
      const values = old.allowedDurations.includes(value)
        ? old.allowedDurations.filter((n) => n !== value)
        : [...old.allowedDurations, value].sort();
      return {
        ...old,
        allowedDurations: values,
        default: {
          ...old.default,
          duration: values.includes(old.default.duration) ? old.default.duration : values[0] || 4,
        },
      };
    });
  }
  function toggleResolution(value: string) {
    setOptions((old) => {
      const values = old.allowedResolutions.includes(value)
        ? old.allowedResolutions.filter((n) => n !== value)
        : [...old.allowedResolutions, value];
      return {
        ...old,
        allowedResolutions: values,
        default: {
          ...old.default,
          resolution: values.includes(old.default.resolution)
            ? old.default.resolution
            : values[0] || "720p",
        },
      };
    });
  }
  return (
    <form className="catalog-panel catalog-form" onSubmit={(e) => void save(e)}>
      <fieldset disabled={busy} className="catalog-form-fields">
        <h3>编辑模板：{template.title}</h3>
        <p className="muted">
          修改生成配置会保存为新版本，已有任务继续使用原版本。下架只停止公开使用，删除请返回列表操作。
        </p>
        <label>
          修改模板名称
          <input required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          修改动作说明
          <input
            maxLength={300}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <TagInput tags={tags} onChange={setTags} />
        <h4>图片槽位</h4>
        {slots.map((slot, index) => (
          <div key={slot.key} className="catalog-asset-group">
            <small>槽位标识：{slot.key}</small>
            <label>
              槽位 {index + 1} 名称
              <input
                required
                maxLength={80}
                value={slot.label}
                onChange={(e) =>
                  setSlots((old) =>
                    old.map((v, i) => (i === index ? { ...v, label: e.target.value } : v)),
                  )
                }
              />
            </label>
            <label>
              槽位 {index + 1} 类型
              <select
                value={slot.kind}
                onChange={(e) =>
                  setSlots((old) =>
                    old.map((v, i) =>
                      i === index ? { ...v, kind: e.target.value as "person" | "scene" } : v,
                    ),
                  )
                }
              >
                <option value="person">人物图片</option>
                <option value="scene">场景图片</option>
              </select>
            </label>
            <label>
              槽位 {index + 1} 角色说明
              <input
                required
                maxLength={200}
                value={slot.referenceRole || ""}
                onChange={(e) =>
                  setSlots((old) =>
                    old.map((v, i) => (i === index ? { ...v, referenceRole: e.target.value } : v)),
                  )
                }
              />
            </label>
            <button
              type="button"
              className="button"
              disabled={slots.length <= 1}
              onClick={() => setSlots((old) => old.filter((_, i) => i !== index))}
            >
              移除槽位 {index + 1}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button"
          disabled={slots.length >= 4}
          onClick={() =>
            setSlots((old) => [
              ...old,
              {
                key: `person_${crypto.randomUUID().slice(0, 8)}`,
                kind: "person",
                label: `人物 ${old.length + 1} 图片`,
                required: true,
                referenceRole: "",
              },
            ])
          }
        >
          添加图片槽位
        </button>
        <h4>动作参考视频</h4>
        {references.map((id, index) => (
          <div key={id} className="catalog-asset-group">
            <video
              controls
              preload="metadata"
              src={`/api/admin/catalog-templates/${template.id}/reference-videos/${id}`}
            />
            <button
              type="button"
              className="button"
              onClick={() => setReferences((old) => old.filter((value) => value !== id))}
            >
              移除参考视频 {index + 1}
            </button>
          </div>
        ))}
        <label>
          添加动作参考视频
          <input
            type="file"
            multiple
            accept="video/mp4,video/quicktime"
            onChange={(e) => {
              setFiles(Array.from(e.target.files || []));
              setUploadedReferences([]);
            }}
          />
        </label>
        <p className="muted">
          现有 {references.length} 段，待上传 {files.length} 段；合计最多 3 段。替换时先移除旧视频。
        </p>
        <label>
          修改模板 Prompt
          <textarea
            rows={3}
            maxLength={6000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <div className="catalog-options">
          <fieldset>
            <legend>允许时长</legend>
            {[4, 8].map((n) => (
              <label key={n}>
                <input
                  type="checkbox"
                  checked={options.allowedDurations.includes(n)}
                  onChange={() => toggleDuration(n)}
                />
                {n} 秒
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>允许分辨率</legend>
            {["720p", "1080p"].map((n) => (
              <label key={n}>
                <input
                  type="checkbox"
                  checked={options.allowedResolutions.includes(n)}
                  onChange={() => toggleResolution(n)}
                />
                {n}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="form-columns">
          <label>
            默认时长
            <select
              value={options.default.duration}
              onChange={(e) =>
                setOptions((old) => ({
                  ...old,
                  default: { ...old.default, duration: Number(e.target.value) },
                }))
              }
            >
              {options.allowedDurations.map((n) => (
                <option value={n} key={n}>
                  {n} 秒
                </option>
              ))}
            </select>
          </label>
          <label>
            默认分辨率
            <select
              value={options.default.resolution}
              onChange={(e) =>
                setOptions((old) => ({
                  ...old,
                  default: { ...old.default, resolution: e.target.value },
                }))
              }
            >
              {options.allowedResolutions.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="catalog-check">
          <input
            type="checkbox"
            checked={options.allowUserPrompt}
            onChange={(e) => setOptions((old) => ({ ...old, allowUserPrompt: e.target.checked }))}
          />
          允许使用者补充描述
        </label>
        <label>
          替换示例成片（可选）
          <input
            type="file"
            accept="video/mp4"
            onChange={(e) => {
              setPreview(e.target.files?.[0] || null);
              setUploadedPreview(null);
            }}
          />
        </label>
        <label>
          上架状态
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="public">公开上架</option>
            <option value="private">下架</option>
          </select>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="catalog-row-actions">
          <button className="button primary">{busy ? "保存中…" : "保存修改"}</button>
          <button type="button" className="button" onClick={onCancel}>
            取消修改
          </button>
        </div>
      </fieldset>
    </form>
  );
}
