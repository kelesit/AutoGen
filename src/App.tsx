import { AssetLibrary } from "./AssetLibrary";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Coins,
  Compass,
  Download,
  Film,
  Heart,
  LayoutGrid,
  LoaderCircle,
  LogOut,
  Menu,
  Play,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { api, post, imageUrl, dateLabel } from "./api";
import { readPending, recoverPending, type Pending } from "./recovery";
import { CreateModal } from "./CreateModal";
import { scenarioLabels } from "./demoScenarios";
import { AdminCatalogPage } from "./AdminCatalogPage";
import type { AdminData, Job, JobDetail, Ledger, Page, Template, User } from "./types";

const pageNames: Record<Page, string> = {
  explore: "探索灵感",
  collection: "我的作品",
  favorites: "我的收藏",
  credits: "积分记录",
  admin: "管理后台",
};
const statuses: Record<Job["status"], string> = {
  queued: "排队中",
  running: "生成中",
  submitting: "正在提交",
  submission_unknown: "正在核查接单",
  persisting: "保存作品中",
  needs_review: "需要人工核查",
  completed: "已完成",
  failed: "生成失败",
  cancelled: "已取消",
};
const isActive = (job: Job) => !["completed", "failed", "cancelled"].includes(job.status);
const billingLabels = {
  held: "积分冻结中",
  settled: "已结算",
  released: "已释放",
};
function currentPage(): Page {
  const key = location.hash.slice(1) as Page;
  return key in pageNames ? key : "explore";
}
function Mark() {
  return (
    <span className="brand-mark">
      <Play size={20} fill="currentColor" strokeWidth={0} />
    </span>
  );
}
function Status({ job }: { job: Job }) {
  return (
    <span className={`status ${job.status}`}>
      {job.status === "running" ? <LoaderCircle size={12} className="spin" /> : <i />}
      {statuses[job.status]}
    </span>
  );
}
function JobCoverImage({ job }: { job: Job }) {
  return job.output_url ? (
    <video src={job.output_url} preload="metadata" muted playsInline aria-label="作品视频预览" />
  ) : (
    <img src={imageUrl(job.template.image)} alt="创作任务" />
  );
}
function Empty({
  title,
  text,
  action,
  onAction,
  icon = <Film size={28} />,
}: {
  title: string;
  text: string;
  action?: string;
  onAction?: () => void;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{text}</p>
      {action && (
        <button className="button primary" onClick={onAction}>
          {action}
          <ArrowRight size={16} />
        </button>
      )}
    </div>
  );
}
function Modal({
  children,
  onClose,
  title,
  wide = false,
}: {
  children: ReactNode;
  onClose: () => void;
  title: string;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
        ) || [],
      ).filter((el) => el.getClientRects().length);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0],
        last = items[items.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === ref.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === ref.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "modal-wide" : ""}`}
      >
        <button aria-label="关闭弹窗" className="icon-button modal-close" onClick={onClose}>
          <X size={20} />
        </button>
        {children}
      </div>
    </div>
  );
}
function AuthModal({
  onClose,
  onSuccess,
  adminDefault = false,
}: {
  onClose: () => void;
  onSuccess: (user: User) => void;
  adminDefault?: boolean;
}) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState(adminDefault ? "admin@playbox.local" : "demo@playbox.local");
  const [password, setPassword] = useState(adminDefault ? "PlayboxAdmin2026!" : "PlayboxDemo2026!");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ user: User }>(
        register ? "/auth/register" : "/auth/login",
        post({ email, password, name }),
      );
      onSuccess(data.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={register ? "创建账户" : "登录 Playbox"} onClose={onClose}>
      <div className="auth-content">
        <Mark />
        <div className="eyebrow">WELCOME TO YOUR STUDIO</div>
        <h2>{register ? "从一个灵感开始。" : "欢迎回来，创作者。"}</h2>
        <p className="muted">
          {register
            ? "注册即获 300 演示积分，开启你的第一部作品。"
            : "登录后，继续探索你的无限可能。"}
        </p>
        <form onSubmit={submit}>
          {register && (
            <label>
              昵称
              <input
                required
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                placeholder="你的创作者名称"
                autoComplete="nickname"
              />
            </label>
          )}
          <label>
            邮箱
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              required
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={register ? "new-password" : "current-password"}
            />
          </label>
          {error && (
            <div role="alert" className="form-error">
              {error}
            </div>
          )}
          <button disabled={busy} className="button primary full">
            {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
            {register ? "创建账户" : "登录工作室"}
          </button>
        </form>
        <div className="auth-switch">
          {register ? "已经有账户？" : "第一次来这里？"}
          <button
            onClick={() => {
              setRegister(!register);
              setError("");
              setEmail("");
              setPassword("");
            }}
          >
            {register ? "去登录" : "免费注册"}
          </button>
        </div>
        {!register && (
          <div className="demo-accounts">
            <span>快速填入演示账户</span>
            <div>
              <button
                onClick={() => {
                  setEmail("demo@playbox.local");
                  setPassword("PlayboxDemo2026!");
                }}
              >
                普通用户
              </button>
              <button
                onClick={() => {
                  setEmail("admin@playbox.local");
                  setPassword("PlayboxAdmin2026!");
                }}
              >
                管理员
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
function TemplateCard({
  template,
  onCreate,
  onFavorite,
}: {
  template: Template;
  onCreate: () => void;
  onFavorite: () => void;
}) {
  return (
    <article className="template-card">
      <button
        className="template-visual"
        onClick={onCreate}
        aria-label={`使用 ${template.title} 模板`}
      >
        {template.preview_url ? (
          <video src={template.preview_url} autoPlay muted loop playsInline />
        ) : (
          <img src={imageUrl(template.image)} alt={template.subtitle} loading="lazy" />
        )}
        <div className="card-shade" />
        {template.tag && (
          <span className={`badge ${template.tag === "NEW" ? "badge-new" : ""}`}>
            {template.tag === "热门" && <Zap size={10} />}
            {template.tag}
          </span>
        )}
        <span className="duration-badge">
          <Film size={12} />
          {template.outputOptions.allowedDurations.join("/")}s
        </span>
        <span className="card-play">
          <Play fill="currentColor" size={19} />
        </span>
        <span className="card-create">
          使用模板
          <ArrowUpRight size={16} />
        </span>
      </button>
      <button
        className={`favorite-button ${template.favorite ? "is-favorite" : ""}`}
        aria-label={`${template.favorite ? "取消收藏" : "收藏"} ${template.title}`}
        onClick={onFavorite}
      >
        <Heart size={16} fill={template.favorite ? "currentColor" : "none"} />
      </button>
      <div className="card-info">
        <div>
          <button onClick={onCreate} className="card-title">
            {template.title}
          </button>
          <p>
            {template.subtitle}
            <span>·</span>
            {template.creator}
          </p>
        </div>
        <span className="use-count">
          <Play size={10} />
          {template.uses >= 1000 ? `${(template.uses / 1000).toFixed(1)}k` : template.uses}
        </span>
      </div>
    </article>
  );
}
export default function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [user, setUser] = useState<User | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [creationCount, setCreationCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [deletingCreation, setDeletingCreation] = useState<Job | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const removedJobs = useRef(new Set<string>());
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [adminData, setAdminData] = useState<AdminData | null>(null);
  const [adminTab, setAdminTab] = useState("任务列表");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [privateLoading, setPrivateLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [sort, setSort] = useState("推荐");
  const [jobFilter, setJobFilter] = useState("全部");
  const [authOpen, setAuthOpen] = useState(false);
  const [adminLogin, setAdminLogin] = useState(false);
  const pendingTemplate = useRef<string | null>(null);
  const [selected, setSelected] = useState<Template | null>(null);
  const [playing, setPlaying] = useState<Job | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const go = useCallback((target: Page) => {
    location.hash = target;
    setPage(target);
    setMobileNav(false);
  }, []);
  useEffect(() => {
    const update = () => setPage(currentPage());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const loadPublic = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [me, data] = await Promise.all([
        api<{ user: User | null }>("/me"),
        api<{ templates: Template[] }>("/templates"),
      ]);
      setUser(me.user);
      setTemplates(data.templates);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadPublic();
  }, [loadPublic]);
  useEffect(() => {
    if (!user) {
      setJobs([]);
      setCreationCount(0);
      removedJobs.current.clear();
      setLedger([]);
      setAdminData(null);
      return;
    }
    let alive = true;
    let fetching = false;
    setPrivateLoading(true);
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const [j, me, l, a] = await Promise.all([
          api<{ jobs: Job[]; totalCreations: number; activeTasks: number }>("/collection"),
          api<{ user: User | null }>("/me"),
          page === "credits" ? api<{ ledger: Ledger[] }>("/ledger") : Promise.resolve(null),
          page === "admin" && user?.role === "admin"
            ? api<AdminData>("/admin")
            : Promise.resolve(null),
        ]);
        if (!alive) return;
        setJobs(j.jobs.filter((job) => !removedJobs.current.has(job.id)));
        setCreationCount(
          Math.max(
            0,
            j.totalCreations -
              j.jobs.filter((job) => job.status === "completed" && removedJobs.current.has(job.id))
                .length,
          ),
        );
        setActiveCount(j.activeTasks);
        setUser(me.user);
        if (l) setLedger(l.ledger);
        if (a) setAdminData(a);
      } catch (err) {
        if (alive) notify((err as Error).message);
      } finally {
        fetching = false;
        if (alive) setPrivateLoading(false);
      }
    }
    void refresh();
    const interval = setInterval(refresh, 2200);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [user?.id, user?.role, page, notify]);
  function showLogin(admin = false) {
    setSelected(null);
    pendingTemplate.current = null;
    setAdminLogin(admin);
    setAuthOpen(true);
  }
  function create(template: Template) {
    // Historical task snapshots are display records, not the current creation contract.
    const current = templates.find((item) => item.id === template.id);
    if (!current) {
      go("explore");
      notify("该模板已下架或属于历史演示，请选择当前动作模板。");
      return;
    }
    if (!user) {
      showLogin();
      pendingTemplate.current = current.id;
      notify("先登录，即可领取积分并创建作品。");
    } else setSelected(current);
  }
  async function favorite(template: Template) {
    if (!user) return showLogin();
    try {
      const result = await api<{ favorite: boolean }>(`/favorites/${template.id}`, {
        method: "PUT",
        body: JSON.stringify({ favorite: !template.favorite }),
      });
      setTemplates((values) =>
        values.map((t) => (t.id === template.id ? { ...t, favorite: result.favorite } : t)),
      );
    } catch (err) {
      notify((err as Error).message);
    }
  }
  async function signedIn(value: User) {
    setUser(value);
    setAuthOpen(false);
    setJobs([]);
    setLedger([]);
    setAdminData(null);
    notify(`欢迎回来，${value.name}`);
    try {
      const data = await api<{ templates: Template[] }>("/templates");
      setTemplates(data.templates);
      const intent = pendingTemplate.current;
      pendingTemplate.current = null;
      if (intent) {
        const template = data.templates.find((item) => item.id === intent);
        if (template) {
          setSelected(template);
          return;
        }
        notify("该模板已下架，请选择其他模板。");
      }
    } catch (err) {
      pendingTemplate.current = null;
      notify((err as Error).message);
    }
    if (value.role === "admin") go("admin");
  }
  async function logout() {
    try {
      await api("/auth/logout", post({}));
      setUser(null);
      setTemplates((items) => items.map((t) => ({ ...t, favorite: false })));
      go("explore");
      notify("已安全退出登录");
    } catch (err) {
      notify((err as Error).message);
    }
  }
  async function cancel(job: Job) {
    try {
      const result = await api<{ job: Job; user: User }>(`/jobs/${job.id}/cancel`, post({}));
      setJobs((items) => items.map((item) => (item.id === job.id ? result.job : item)));
      setUser(result.user);
      notify(`任务已取消，${job.cost} 积分已退回。`);
    } catch (err) {
      notify((err as Error).message);
    }
  }
  async function deleteCreation() {
    if (!deletingCreation?.creation_id) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api(`/creations/${deletingCreation.creation_id}`, { method: "DELETE" });
      removedJobs.current.add(deletingCreation.id);
      setJobs((items) => items.filter((item) => item.id !== deletingCreation.id));
      setCreationCount((n) => Math.max(0, n - 1));
      setPlaying(null);
      setDeletingCreation(null);
      notify("作品已删除，生成费用不退还。");
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }
  const activeJobs = jobs.filter((job) => isActive(job)).length;
  const visibleTemplates = templates
    .filter(
      (t) =>
        (category === "全部" || t.category === category) &&
        (page !== "favorites" || t.favorite) &&
        `${t.title} ${t.subtitle} ${t.creator}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "热门"
        ? b.uses - a.uses
        : sort === "最新"
          ? Number(b.tag === "NEW") - Number(a.tag === "NEW")
          : 0,
    );
  const visibleJobs = jobs.filter(
    (job) =>
      jobFilter === "全部" ||
      (jobFilter === "进行中"
        ? isActive(job)
        : jobFilter === "已完成"
          ? job.status === "completed"
          : ["failed", "cancelled"].includes(job.status)),
  );
  const categories = ["全部", ...new Set(templates.map((item) => item.category))];
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <button
            className="icon-button mobile-menu"
            aria-label="打开导航"
            onClick={() => setMobileNav(!mobileNav)}
          >
            <Menu size={21} />
          </button>
          <button className="brand" onClick={() => go("explore")} aria-label="Playbox 首页">
            <Mark />
            <span>
              playbox<span className="brand-period">.</span>
            </span>
          </button>
          <span className="demo-label">STUDIO DEMO</span>
        </div>
        <div className="topbar-right">
          <button className="credits-button" onClick={() => (user ? go("credits") : showLogin())}>
            <Zap size={15} />
            <strong>{user?.credits ?? 300}</strong>
            <span>积分</span>
            <Plus size={13} />
          </button>
          {user ? (
            <button
              className="avatar"
              title={`${user.name} · ${user.email}`}
              onClick={() => go("credits")}
            >
              {user.name.slice(0, 1).toUpperCase()}
            </button>
          ) : (
            <button className="button primary login-button" onClick={() => showLogin()}>
              登录 / 注册
              <ArrowRight size={15} />
            </button>
          )}
        </div>
      </header>
      {mobileNav && <div className="sidebar-scrim" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="sidebar-caption">工作室</div>
        <nav>
          {(
            [
              ["explore", Compass],
              ["collection", LayoutGrid],
              ["favorites", Heart],
            ] as const
          ).map(([key, Icon]) => (
            <button
              key={key}
              className={`nav-item ${page === key ? "active" : ""}`}
              onClick={() => {
                setCategory("全部");
                setQuery("");
                go(key);
              }}
            >
              <Icon size={19} />
              <span>{pageNames[key]}</span>
              {key === "explore" && <span className="nav-new">NEW</span>}
              {key === "collection" && activeJobs > 0 && (
                <span className="nav-count">{activeJobs}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="sidebar-caption">你的账户</div>
        <button
          className={`nav-item ${page === "credits" ? "active" : ""}`}
          onClick={() => go("credits")}
        >
          <Wallet size={18} />
          <span>积分记录</span>
        </button>
        <button
          className={`nav-item ${page === "admin" ? "active" : ""}`}
          onClick={() => go("admin")}
        >
          <ShieldCheck size={18} />
          <span>管理后台</span>
        </button>
        <div className="sidebar-bottom">
          <div className="studio-note">
            <div className="studio-note-icon">
              <Sparkles size={18} />
            </div>
            <strong>
              每个好故事，
              <br />
              都从一帧开始。
            </strong>
            <p>选一个模板，试试你的灵感。</p>
            <button onClick={() => templates[0] && create(templates[0])}>
              创建第一部作品
              <ArrowUpRight size={15} />
            </button>
          </div>
          <button className="help-link" onClick={() => setAboutOpen(true)}>
            <CircleHelp size={16} />
            关于这个演示
            <ArrowUpRight size={13} />
          </button>
          {user && (
            <div className="sidebar-user">
              <span className="avatar small">{user.name[0].toUpperCase()}</span>
              <div>
                <strong>{user.name}</strong>
                <span>{user.role === "admin" ? "管理员账户" : "创作者账户"}</span>
              </div>
              <button className="icon-button" aria-label="退出登录" onClick={() => void logout()}>
                <LogOut size={15} />
              </button>
            </div>
          )}
          <div className="sidebar-footer">
            PLAYBOX STUDIO <span>© 2026</span>
          </div>
        </div>
      </aside>
      <main>
        {user && (
          <RecoveryBanner
            userId={user.id}
            onRecovered={(job, value) => {
              setUser(value);
              setJobs((items) => [job, ...items.filter((j) => j.id !== job.id)]);
              go("collection");
            }}
          />
        )}
        <div className="page-top">
          <div className="breadcrumb">
            STUDIO <ChevronRight size={12} />
            <span>{pageNames[page]}</span>
          </div>
          <button className="demo-mode" onClick={() => setAboutOpen(true)}>
            <span />
            演示工作室
            <ChevronDown size={13} />
          </button>
        </div>
        {(page === "explore" || page === "favorites") && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  {page === "favorites"
                    ? "YOUR INSPIRATION BOARD"
                    : "A LITTLE INSPIRATION. ENDLESS POSSIBILITIES."}
                </div>
                <h1>
                  {page === "favorites" ? "值得留下的灵感" : "下一部好作品，从这里开始"}
                  <span className="title-dot">.</span>
                </h1>
                <p>
                  {page === "favorites"
                    ? "收藏喜欢的模板，随时回来，让灵感发生。"
                    : "选择动作模板，上传图片，生成属于你的作品。"}
                </p>
              </div>
              <div className="search-field">
                <Search size={17} />
                <input
                  aria-label="搜索模板"
                  placeholder="搜索模板、风格或创作者"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && (
                  <button
                    className="icon-button"
                    aria-label="清空搜索"
                    onClick={() => setQuery("")}
                  >
                    <X size={14} />
                  </button>
                )}
                <span className="search-shortcut">⌕</span>
              </div>
            </div>
            {page === "explore" && !query && category === "全部" && templates[0] && (
              <section className="feature-banner">
                {templates[0].preview_url ? (
                  <video src={templates[0].preview_url} autoPlay muted loop playsInline />
                ) : (
                  <img src={imageUrl(templates[0].image)} alt={templates[0].title} />
                )}
                <div className="feature-shade" />
                <div className="feature-content">
                  <span className="feature-kicker">
                    <span />
                    THIS WEEK’S CREATIVE PICK
                  </span>
                  <h2>
                    把灵感，
                    <br />
                    变成下一帧。
                  </h2>
                  <p>让静止的瞬间，拥有自己的故事。</p>
                  <button
                    className="button light"
                    onClick={() => templates[0] && create(templates[0])}
                  >
                    使用精选模板
                    <ArrowUpRight size={16} />
                  </button>
                </div>
                <div className="feature-credit">
                  <span className="feature-number">
                    01 <i>/ {templates.length}</i>
                  </span>
                  <span className="feature-line" />
                  <strong>{templates[0].title}</strong>
                  <span>
                    {templates[0].subtitle} · {templates[0].creator}
                  </span>
                  <div className="feature-dots">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
                <div className="feature-corner">CURATED BY PLAYBOX</div>
              </section>
            )}
            <div className="explore-toolbar">
              <div className="category-tabs">
                {categories.map((value) => (
                  <button
                    key={value}
                    onClick={() => setCategory(value)}
                    className={category === value ? "selected" : ""}
                  >
                    {value === "全部" && <LayoutGrid size={14} />}
                    {value}
                    {value === "全部" && (
                      <span>
                        {page === "favorites"
                          ? templates.filter((t) => t.favorite).length
                          : templates.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="sort-field">
                <SlidersHorizontal size={14} />
                <select
                  aria-label="模板排序"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option>推荐</option>
                  <option>热门</option>
                  <option>最新</option>
                </select>
              </div>
            </div>
            <div className="grid-caption">
              <span>
                {page === "favorites"
                  ? "收藏的模板"
                  : category === "全部"
                    ? "为你的下一次创作精选"
                    : `${category}风格精选`}
              </span>
              <span>
                {visibleTemplates.length} 个模板<em>持续更新</em>
              </span>
            </div>
            {loading ? (
              <div className="template-grid">
                {Array.from({ length: 8 }, (_, i) => (
                  <div className="skeleton-card" key={i} />
                ))}
              </div>
            ) : loadError ? (
              <Empty
                title="暂时无法加载工作室"
                text={loadError}
                action="重新加载"
                onAction={() => void loadPublic()}
              />
            ) : !visibleTemplates.length ? (
              <Empty
                title={page === "favorites" ? "把喜欢的灵感收藏在这里" : "没有找到这个灵感"}
                text={
                  page === "favorites"
                    ? "点击模板右上角的爱心，即可收藏。"
                    : "试试其他关键词，或者看看全部模板。"
                }
                action="浏览全部模板"
                onAction={() => {
                  setQuery("");
                  setCategory("全部");
                  go("explore");
                }}
                icon={<Heart size={28} />}
              />
            ) : (
              <div className="template-grid">
                {visibleTemplates.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    onCreate={() => create(template)}
                    onFavorite={() => void favorite(template)}
                  />
                ))}
              </div>
            )}
            <div className="end-note">
              <span />
              灵感没有终点。你的故事才刚开始。
              <span />
            </div>
          </>
        )}
        {page === "collection" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR CREATIVE SPACE</div>
                <h1>
                  每一帧，都属于你<span className="title-dot">.</span>
                </h1>
                <p>保存你的灵感，见证作品从想象到完成。</p>
              </div>
              <button className="button primary" onClick={() => go("explore")}>
                <Plus size={17} />
                创建新作品
              </button>
            </div>
            {!user ? (
              <Empty
                title="你的创作，值得被保存"
                text="登录后查看作品、生成进度和历史记录。"
                action="登录工作室"
                onAction={() => showLogin()}
              />
            ) : (
              <>
                <div className="collection-toolbar">
                  <div className="category-tabs">
                    {["全部", "进行中", "已完成", "其他"].map((item) => (
                      <button
                        key={item}
                        className={jobFilter === item ? "selected" : ""}
                        onClick={() => setJobFilter(item)}
                      >
                        {item}
                        {item === "全部" && <span>{jobs.length}</span>}
                      </button>
                    ))}
                  </div>
                  <span className="muted small-text">
                    {creationCount} 件作品 · {activeCount} 个任务处理中
                  </span>
                </div>
                {privateLoading ? (
                  <div className="loading-state">
                    <LoaderCircle className="spin" />
                    正在加载作品
                  </div>
                ) : !visibleJobs.length ? (
                  <Empty
                    title={jobs.length ? "这里还没有作品" : "你的第一部作品，正在等你"}
                    text="选择喜欢的模板，开始一次新的创作。"
                    action="探索模板"
                    onAction={() => go("explore")}
                  />
                ) : (
                  <div className="jobs-grid">
                    {visibleJobs.map((job) => (
                      <article className="job-card" key={job.id}>
                        <div className="job-image">
                          <JobCoverImage job={job} />
                          <div className="card-shade" />
                          <Status job={job} />
                          {job.status === "completed" && (
                            <button
                              className="job-play"
                              aria-label={`播放 ${job.template.title} 演示样片`}
                              onClick={() => setPlaying(job)}
                            >
                              <Play size={23} fill="currentColor" />
                            </button>
                          )}
                          {isActive(job) && (
                            <div className="job-progress">
                              <LoaderCircle className="spin" size={25} />
                              <strong>{statuses[job.status]}</strong>
                              <span>流程阶段 · 非模型实时进度</span>
                              <div>
                                <i style={{ width: `${job.progress}%` }} />
                              </div>
                            </div>
                          )}
                          <span className="sample-label">
                            {job.status === "completed" ? "输出为固定演示样片" : "模拟生成"}
                          </span>
                        </div>
                        <div className="job-info">
                          <h3>{job.template.title}</h3>
                          <p>
                            {job.resolution} · {job.duration} 秒（演示规格）
                          </p>
                          <div className="job-meta">
                            <span>{dateLabel(job.created_at)}</span>
                            <span>
                              <Zap size={12} />
                              {job.cost}
                            </span>
                          </div>
                          {job.error && <p className="job-error">{job.error}</p>}
                          <div className="job-actions">
                            {job.status === "completed" ? (
                              <>
                                <button
                                  className="button secondary"
                                  onClick={() => setPlaying(job)}
                                >
                                  <Play size={13} />
                                  查看样片
                                </button>
                                <a
                                  className="button secondary"
                                  href={`${job.output_url}?download=1`}
                                >
                                  <Download size={14} />
                                  下载
                                </a>
                                <button
                                  className="button danger"
                                  onClick={() => {
                                    setDeleteError("");
                                    setDeletingCreation(job);
                                  }}
                                >
                                  删除作品
                                </button>
                              </>
                            ) : job.status === "queued" ? (
                              <button className="button secondary" onClick={() => void cancel(job)}>
                                取消排队并释放积分
                              </button>
                            ) : isActive(job) ? (
                              <span className="muted small-text">
                                {billingLabels[job.billing_state]} · 提交后不支持取消
                              </span>
                            ) : (
                              <button
                                className="button secondary"
                                onClick={() => create(job.template)}
                              >
                                <Sparkles size={14} />
                                {templates.some((item) => item.id === job.template_id)
                                  ? "再次创作"
                                  : "选择新模板"}
                              </button>
                            )}
                          </div>
                          <button
                            className="button secondary job-trace-button"
                            onClick={() => setDetailId(job.id)}
                          >
                            查看任务详情与恢复记录 ↗
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
        {page === "credits" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">EVERY IDEA COUNTS</div>
                <h1>
                  让灵感，持续发生<span className="title-dot">.</span>
                </h1>
                <p>每一笔积分，都有迹可循。</p>
              </div>
            </div>
            {!user ? (
              <Empty
                title="登录后查看你的积分"
                text="新账户拥有 300 演示积分，体验完整创作流程。"
                action="登录工作室"
                onAction={() => showLogin()}
                icon={<Wallet size={28} />}
              />
            ) : (
              <>
                <div className="balance-card">
                  <div>
                    <span className="eyebrow">AVAILABLE CREDITS</span>
                    <h2>
                      {user.credits}
                      <span>积分</span>
                    </h2>
                    <p>可用积分可用于新任务；冻结积分等待当前任务结果。</p>
                  </div>
                  <div className="balance-right">
                    <Zap size={44} />
                    <span>冻结中：{user.reserved} 积分</span>
                    <span>演示积分 · 无实际货币价值</span>
                  </div>
                </div>
                <div className="section-heading">
                  <h2>积分流水</h2>
                  <span>提交冻结 → 保存结算 / 确认失败或排队取消释放</span>
                </div>
                {privateLoading ? (
                  <div className="loading-state">
                    <LoaderCircle className="spin" />
                  </div>
                ) : (
                  <LedgerTable entries={ledger} />
                )}
              </>
            )}
          </>
        )}
        {page === "admin" && (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">STUDIO CONTROL ROOM</div>
                <h1>
                  每一次创作，尽在掌握<span className="title-dot">.</span>
                </h1>
                <p>用户、任务与积分流水，一处查看。</p>
              </div>
              <span className="live-indicator">
                <span />
                自动更新
              </span>
            </div>
            {user?.role !== "admin" ? (
              <Empty
                title="管理员工作台"
                text="此页面需要管理员权限。演示账户可查看任务和积分流水。"
                action="登录管理员演示账户"
                onAction={() => showLogin(true)}
                icon={<ShieldCheck size={28} />}
              />
            ) : !adminData ? (
              <div className="loading-state">
                <LoaderCircle className="spin" />
                正在加载后台数据
              </div>
            ) : (
              <>
                <div className="runtime-banner">
                  <span className={adminData.runtime.worker_online ? "positive" : "negative"}>
                    {adminData.runtime.worker_online ? "● Worker 在线" : "● Worker 未连接"}
                  </span>
                  <span>供应商并发上限 {adminData.runtime.max_concurrency}</span>
                  <span>待核查 {adminData.runtime.needs_review} 笔</span>
                  <span>
                    {adminData.runtime.paused_until > Date.now()
                      ? "新提交暂停，等待恢复"
                      : "新提交正常"}
                  </span>
                </div>
                <div className="stats-grid">
                  {[
                    { label: "注册用户", value: adminData.stats.users, icon: Users },
                    { label: "生成任务", value: adminData.stats.jobs, icon: Film },
                    { label: "进行中", value: adminData.stats.active, icon: Clock3 },
                    { label: "已完成", value: adminData.stats.completed, icon: CheckCircle2 },
                    { label: "净消耗积分", value: adminData.stats.credits, icon: Coins },
                  ].map(({ label, value, icon: Icon }) => (
                    <div className="stat-card" key={label}>
                      <div>
                        <span>{label}</span>
                        <Icon size={17} />
                      </div>
                      <strong>{value}</strong>
                    </div>
                  ))}
                </div>
                <div className="admin-tabs category-tabs">
                  {["任务列表", "模板目录", "素材库", "用户列表", "积分流水"].map((tab) => (
                    <button
                      key={tab}
                      className={adminTab === tab ? "selected" : ""}
                      onClick={() => setAdminTab(tab)}
                    >
                      {tab}
                    </button>
                  ))}
                  <span className="admin-provider">生成服务：模拟服务</span>
                </div>
                {adminTab === "任务列表" && (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>作品 / 任务 ID</th>
                          <th>用户</th>
                          <th>状态</th>
                          <th>规格</th>
                          <th>积分</th>
                          <th>创建时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminData.jobs.map((job) => (
                          <tr key={job.id}>
                            <td>
                              <button className="text-button" onClick={() => setDetailId(job.id)}>
                                {job.template.title} ↗
                              </button>
                              <small>{job.id.slice(0, 8)}</small>
                            </td>
                            <td>
                              {job.user_name}
                              <small>{job.email}</small>
                            </td>
                            <td>
                              <Status job={job} />
                            </td>
                            <td>
                              {job.resolution} / {job.duration}s
                            </td>
                            <td>
                              {job.cost}
                              <small>{billingLabels[job.billing_state]}</small>
                            </td>
                            <td>{dateLabel(job.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!adminData.jobs.length && (
                      <div className="table-empty">还没有生成任务，去创建第一部作品吧。</div>
                    )}
                  </div>
                )}

                {adminTab === "素材库" && <AssetLibrary />}
                {adminTab === "用户列表" && (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>用户</th>
                          <th>邮箱</th>
                          <th>角色</th>
                          <th>剩余积分</th>
                          <th>注册时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminData.users.map((item) => (
                          <tr key={item.id}>
                            <td>
                              <strong>{item.name}</strong>
                            </td>
                            <td>{item.email}</td>
                            <td>
                              <span className="role-badge">
                                {item.role === "admin" ? "管理员" : "创作者"}
                              </span>
                            </td>
                            <td>{item.credits}</td>
                            <td>{dateLabel(item.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {adminTab === "积分流水" && <LedgerTable entries={adminData.ledger} admin />}
              </>
            )}
          </>
        )}
        {user?.role === "admin" && (
          <div hidden={page !== "admin" || adminTab !== "模板目录" || !adminData}>
            <AdminCatalogPage
              key={user.id}
              userId={user.id}
              onPublished={() => void loadPublic()}
            />
          </div>
        )}
        <footer className="main-footer">
          <span>Made for the things you imagine.</span>
          <span>Playbox Studio · 独立开发演示</span>
        </footer>
      </main>
      {authOpen && (
        <AuthModal
          adminDefault={adminLogin}
          onClose={() => {
            setAuthOpen(false);
            pendingTemplate.current = null;
          }}
          onSuccess={(value) => void signedIn(value)}
        />
      )}
      {selected && user && (
        <CreateModal
          userId={user.id}
          template={selected}
          onClose={() => setSelected(null)}
          onCreated={(job, value) => {
            setUser(value);
            setJobs((items) => [job, ...items]);
            setSelected(null);
            go("collection");
            notify("任务已提交。你可以留在这里查看生成进度。");
          }}
        />
      )}
      {detailId && user && (
        <TaskDetail id={detailId} admin={user.role === "admin"} onClose={() => setDetailId(null)} />
      )}
      {deletingCreation && (
        <Modal
          title="删除作品"
          onClose={() => {
            if (!deleteBusy) setDeletingCreation(null);
          }}
        >
          <p>
            删除“{deletingCreation.template.title}
            ”的这件作品？删除后无法播放、下载或恢复。生成任务和积分流水保留，费用不退还。
          </p>
          {deleteError && (
            <p className="form-error" role="alert">
              {deleteError}
            </p>
          )}
          <button
            className="button danger"
            disabled={deleteBusy}
            onClick={() => void deleteCreation()}
          >
            {deleteBusy ? "删除中…" : "确认删除作品"}
          </button>
          <button
            className="button"
            disabled={deleteBusy}
            onClick={() => setDeletingCreation(null)}
          >
            取消
          </button>
        </Modal>
      )}
      {playing && (
        <Modal title="播放演示样片" onClose={() => setPlaying(null)} wide>
          <div className="video-modal">
            <div className="eyebrow">YOUR DEMO PREVIEW</div>
            <h2>{playing.template.title}</h2>
            <video controls autoPlay playsInline src={playing.output_url!} />
            <div className="video-description">
              <p>
                这是固定演示样片，用于验证任务完成、权限校验、播放和下载流程；并非根据输入生成的视频，实际样片规格与所选参数无关。
              </p>
              <a className="button primary" href={`${playing.output_url}?download=1`}>
                <Download size={16} />
                下载样片
              </a>
            </div>
            {playing.prompt && (
              <div className="saved-prompt">
                <span>已保存的创意描述</span>
                <p>{playing.prompt}</p>
              </div>
            )}
          </div>
        </Modal>
      )}
      {aboutOpen && (
        <Modal title="关于这个演示" onClose={() => setAboutOpen(false)}>
          <div className="about-content">
            <Mark />
            <div className="eyebrow">PLAYBOX STUDIO DEMO</div>
            <h2>从界面，到完整体验。</h2>
            <p>这是参考 Playbox 产品结构制作的独立全栈演示，与原网站无关联。</p>
            <ul>
              <li>
                <Check size={17} />
                真实注册登录与账户隔离
              </li>
              <li>
                <Check size={17} />
                图片上传、收藏和作品持久保存
              </li>
              <li>
                <Check size={17} />
                任务持久恢复、积分冻结与结算
              </li>
              <li>
                <Check size={17} />
                任务时间线、故障场景与恢复操作
              </li>
            </ul>
            <div className="demo-notice">
              <CircleHelp size={17} />
              <span>AI 生成使用模拟服务和固定样片。未接入真实模型、支付或模型训练。</span>
            </div>
            <button className="button primary full" onClick={() => setAboutOpen(false)}>
              开始探索
              <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          <span>{toast}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
function LedgerTable({ entries, admin = false }: { entries: Ledger[]; admin?: boolean }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>交易记录</th>
            {admin && <th>用户</th>}
            <th>关联任务</th>
            <th>可用积分变动</th>
            <th>冻结积分变动</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>
                <div className="ledger-description">
                  <span className={`ledger-icon ${entry.amount > 0 ? "positive" : ""}`}>
                    {entry.amount > 0 ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
                  </span>
                  <strong>{entry.description}</strong>
                </div>
              </td>
              {admin && <td>{entry.user_name}</td>}
              <td className="mono">{entry.job_id?.slice(0, 8) || "—"}</td>
              <td className={entry.amount > 0 ? "positive amount" : "amount"}>
                {entry.amount > 0 ? "+" : ""}
                {entry.amount}
              </td>
              <td className="amount">
                {entry.reserved_delta > 0 ? "+" : ""}
                {entry.reserved_delta}
              </td>
              <td>{dateLabel(entry.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!entries.length && <div className="table-empty">暂无积分记录。</div>}
    </div>
  );
}

function RecoveryBanner({
  userId,
  onRecovered,
}: {
  userId: string;
  onRecovered: (job: Job, user: User) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(() => readPending(userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => setPending(readPending(userId));
    refresh();
    window.addEventListener("pending-request", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("pending-request", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [userId]);
  if (!pending) return null;
  return (
    <div className="recovery-banner" role="status">
      <div>
        <strong>有一笔提交结果等待确认</strong>
        <p>刷新不会产生新的请求标识。先查询原任务；未创建时使用原标识恢复提交。</p>
        {error && <p className="negative">{error}</p>}
      </div>
      <button
        className="button secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const result = await recoverPending(userId);
            if (result) onRecovered(result.job, result.user);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "正在核查…" : "查询并恢复"}
      </button>
    </div>
  );
}
function TaskDetail({ id, admin, onClose }: { id: string; admin: boolean; onClose: () => void }) {
  const [data, setData] = useState<JobDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true,
      fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await api<JobDetail>(`/jobs/${id}/detail`);
        if (alive) {
          setData(value);
          setError("");
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  async function action(name: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/admin/jobs/${id}/${name}`, post({}));
      setData(await api<JobDetail>(`/jobs/${id}/detail`));
      setNotice(
        name === "replay"
          ? "已注入 3 次重复成功和 1 次过期事件；可查看忽略记录和结算状态。"
          : "已恢复原执行阶段。",
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="任务详情与恢复记录" onClose={onClose} wide>
      <div className="task-detail">
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {!data ? (
          <p>正在读取任务…</p>
        ) : (
          <>
            <div className="detail-heading">
              <div>
                <div className="eyebrow">TASK TRACE · MOCK PROVIDER</div>
                <h2>{data.job.template.title}</h2>
                <p className="mono">{id}</p>
              </div>
              <Status job={data.job} />
            </div>
            <div className="detail-grid">
              <div>
                <span>积分状态</span>
                <strong>
                  {data.job.cost} · {billingLabels[data.job.billing_state]}
                </strong>
              </div>
              <div>
                <span>供应商成本（模拟单位）</span>
                <strong>
                  {data.supplier_cost ? `${data.supplier_cost.cost_units} mock units` : "尚未确认"}
                </strong>
              </div>
              <div>
                <span>故障场景</span>
                <strong>{scenarioLabels[data.job.scenario] || "未知场景"}</strong>
              </div>
              <div>
                <span>价格版本</span>
                <strong>{data.job.quote?.version || "未记录"}</strong>
              </div>
            </div>
            <p className="small-text muted">
              供应商 ID：<span className="mono">{data.job.provider_id || "尚未确认接单"}</span>
            </p>
            {data.job.error && <div className="demo-notice">{data.job.error}</div>}
            {data.job.status === "needs_review" && (
              <div className="demo-notice">
                <CircleHelp size={18} />
                <span>
                  结果未确认，积分继续冻结。无法可靠查单时需要人工联系供应商；直接重做可能产生双重费用。
                </span>
              </div>
            )}
            {data.media && (
              <div className="asset-proof">
                <CheckCircle2 size={18} />
                <div>
                  <strong>作品已保存到私有目录 · {(data.media.bytes / 1024).toFixed(1)} KB</strong>
                  <p className="mono">SHA-256 {data.media.sha256}</p>
                </div>
              </div>
            )}
            <div className="detail-columns">
              <section>
                <h3>任务时间线</h3>
                <ol className="timeline">
                  {data.events.map((event) => (
                    <li key={event.id}>
                      <time>{dateLabel(event.created_at)}</time>
                      <p>{event.message}</p>
                    </li>
                  ))}
                </ol>
                {!data.events.length && <p className="muted">暂无时间线记录。</p>}
              </section>
              <section>
                <h3>外部调用记录</h3>
                <div className="attempt-list">
                  {data.attempts.map((attempt) => (
                    <div key={attempt.id}>
                      <span className={attempt.outcome === "ok" ? "positive" : "negative"}>
                        {attempt.outcome === "ok" ? "成功" : "异常"}
                      </span>
                      <strong>
                        {
                          (
                            {
                              submit: "提交",
                              lookup: "查单",
                              poll: "查询状态",
                              download: "保存输出",
                            } as Record<string, string>
                          )[attempt.phase]
                        }
                      </strong>
                      <small>{dateLabel(attempt.created_at)}</small>
                      {attempt.detail && <p>{attempt.detail}</p>}
                    </div>
                  ))}
                  {!data.attempts.length && <p className="muted">还没有外部调用。</p>}
                </div>
              </section>
            </div>
            {data.job.template_snapshot && (
              <details className="snapshot">
                <summary>查看固定的模板与计费快照</summary>
                <pre>
                  {JSON.stringify(
                    { template: JSON.parse(data.job.template_snapshot), quote: data.job.quote },
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
            {admin && (
              <div className="detail-actions">
                {data.job.status === "needs_review" && (
                  <button
                    disabled={busy}
                    className="button secondary"
                    onClick={() => void action("recover")}
                  >
                    恢复原执行阶段
                  </button>
                )}
                {data.job.status === "completed" && data.supplier_cost && (
                  <button
                    disabled={busy}
                    className="button secondary"
                    onClick={() => void action("replay")}
                  >
                    演示重复 / 乱序事件
                  </button>
                )}
                <span className="muted small-text">后台操作记录到任务时间线</span>
              </div>
            )}
            {notice && (
              <p role="status" className="positive">
                {notice}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
