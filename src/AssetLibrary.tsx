import { useEffect, useState } from "react";
import { api } from "./api";
type Asset = { id: string; kind: string; bytes: number; createdAt: number };
export function AssetLibrary() {
  const [items, setItems] = useState<Asset[]>([]),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState<Asset | null>(null),
    [busy, setBusy] = useState(false);
  async function refresh() {
    try {
      const data = await api<{ references: Asset[]; previews: Asset[] }>("/admin/catalog-uploads");
      setItems([...data.references, ...data.previews]);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await api(`/assets/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="catalog-panel">
      <h2>我的模板素材</h2>
      <p>
        上传的动作参考与示例视频可以重复使用。被当前模板或未结束任务引用的素材不能删除；删除后无法恢复。
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {deleting && (
        <div role="alertdialog" aria-label="删除素材">
          <p>确认删除素材 {deleting.id.slice(0, 8)}？</p>
          <button className="button danger" disabled={busy} onClick={() => void remove()}>
            确认删除素材
          </button>
          <button className="button" disabled={busy} onClick={() => setDeleting(null)}>
            取消
          </button>
        </div>
      )}
      <button className="button" disabled={busy} onClick={() => void refresh()}>
        刷新素材
      </button>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>素材 ID</th>
              <th>用途</th>
              <th>大小</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.id.slice(0, 8)}</td>
                <td>{item.kind === "reference" ? "动作参考" : "示例视频"}</td>
                <td>{(item.bytes / 1024 / 1024).toFixed(1)} MB</td>
                <td>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setDeleting(item);
                    }}
                  >
                    删除素材 {item.id.slice(0, 8)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && <p>暂无已保存素材。</p>}
    </section>
  );
}
