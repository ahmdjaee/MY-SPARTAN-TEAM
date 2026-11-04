import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom";
import {
  api,
  type ProjectInfo,
  type RoleId,
  type RoleInfo,
  type Settings as SettingsData,
  type Slots,
  type TaskListItem,
  type TaskStatus,
} from "./api.ts";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { NewTaskDialog } from "./components/NewTaskDialog.tsx";
import { ProjectPicker } from "./components/ProjectPicker.tsx";
import { TaskList } from "./components/TaskList.tsx";
import { maybeNotify, setTitleBadge, startAttentionStream } from "./notifications.ts";
import { ROLE_IDS, STATUSES, keepFilters, taskPath, type AppContext } from "./routes.tsx";
import { THEME_LABEL, applyTheme, nextTheme, readTheme, type Theme } from "./theme.ts";

const SIDEBAR_KEY = "ai-team-sidebar";

export function App() {
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [slots, setSlots] = useState<Slots>();
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [account, setAccount] = useState<{
    email?: string;
    subscriptionType?: string;
  } | null>();
  const [settings, setSettings] = useState<SettingsData>();
  const settingsRef = useRef<SettingsData | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Posisi Anda dibaca dari alamat, bukan dari state — supaya refresh tidak menghapusnya.
  const navigate = useNavigate();
  const location = useLocation();
  const taskMatch = useMatch("/tasks/:id/*");
  const selected = taskMatch?.params.id;
  const [search, setSearch] = useSearchParams();
  const roleParam = search.get("role") as RoleId | null;
  const statusParam = search.get("status") as TaskStatus | null;
  const projectParam = search.get("project");
  const filterRole = roleParam && ROLE_IDS.includes(roleParam) ? roleParam : "";
  const filterStatus = statusParam && STATUSES.includes(statusParam) ? statusParam : "";
  // Project yang sudah tidak ada (mis. bookmark lama) dianggap "semua project".
  const filterProject = projectParam && projects.some((project) => project.id === projectParam) ? projectParam : "";
  const activeProject = projects.find((project) => project.id === filterProject);

  const setFilter = useCallback(
    (key: "project" | "role" | "status", value: string) => {
      const next = new URLSearchParams(search);
      if (value) next.set(key, value);
      else next.delete(key);
      // Pindah project: tugas yang sedang terbuka bisa milik project lain, jadi
      // kembali ke halaman utama supaya tugas pertama project baru yang dibuka.
      if (key === "project" && location.pathname.startsWith("/tasks/")) {
        navigate(`/${next.toString() ? `?${next.toString()}` : ""}`, { replace: true });
        return;
      }
      // Mengganti filter bukan perpindahan tempat, jadi jangan menumpuk riwayat.
      setSearch(next, { replace: true });
    },
    [search, location.pathname, navigate, setSearch],
  );

  // Tombol Memori/Pengaturan bisa diklik lagi untuk kembali ke tugas yang tadi dibuka.
  const lastTaskPath = useRef("/");
  useEffect(() => {
    if (location.pathname.startsWith("/tasks/")) lastTaskPath.current = `${location.pathname}${location.search}`;
  }, [location]);
  // Filter daftar hidup di alamat, jadi pindah halaman harus membawanya — kalau tidak,
  // daftar tugas melompat kembali ke "semua project" begitu Anda mendarat.
  const togglePage = (path: string) =>
    navigate(location.pathname === path ? lastTaskPath.current : `${path}${keepFilters(search)}`);

  // Ctrl+B (atau Cmd+B) melipat/membuka sidebar dari mana saja, termasuk saat
  // kursor sedang di kotak arahan — sama seperti kebiasaan editor kode.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      setCollapsed((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Pilihan lipat sidebar ikut tersimpan di browser, sama seperti tema.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      // localStorage bisa diblokir; abaikan
    }
  }, [collapsed]);

  // Payload yang sama tidak boleh memicu render ulang seluruh aplikasi — daftar dibandingkan dulu.
  const lastTasksJson = useRef("");
  const lastSlotsJson = useRef("");
  const lastProjectsJson = useRef("");
  // Respons filter lama yang datang terlambat tidak boleh menimpa daftar filter baru.
  const tasksRequest = useRef(0);

  const loadTasks = useCallback(() => {
    const requestId = (tasksRequest.current += 1);
    void api
      .tasks({ role: filterRole, status: filterStatus, project: filterProject })
      .then((data) => {
        if (requestId !== tasksRequest.current) return;
        const tasksJson = JSON.stringify(data.tasks);
        if (tasksJson !== lastTasksJson.current) {
          lastTasksJson.current = tasksJson;
          setTasks(data.tasks);
        }
        const slotsJson = JSON.stringify(data.slots);
        if (slotsJson !== lastSlotsJson.current) {
          lastSlotsJson.current = slotsJson;
          setSlots(data.slots);
        }
        setTasksLoaded(true);
      })
      .catch(() => undefined);
  }, [filterRole, filterStatus, filterProject]);

  const loadProjects = useCallback(() => {
    void api
      .projects()
      .then((data) => {
        const json = JSON.stringify(data.projects);
        if (json === lastProjectsJson.current) return;
        lastProjectsJson.current = json;
        setProjects(data.projects);
      })
      .catch(() => undefined);
  }, []);

  // Filter berganti → daftar yang lama sudah basi. Tandai belum siap supaya halaman
  // utama tidak melompat ke tugas dari project sebelumnya.
  useEffect(() => {
    setTasksLoaded(false);
    lastTasksJson.current = "";
  }, [filterRole, filterStatus, filterProject]);

  // Sumber utama pembaruan daftar adalah event `tasks_changed` dari server (di bawah);
  // interval ini hanya cadangan, dan diam saat tab tidak terlihat.
  useEffect(() => {
    loadTasks();
    const timer = setInterval(() => {
      if (!document.hidden) loadTasks();
    }, 30_000);
    const onVisible = () => {
      if (!document.hidden) loadTasks();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadTasks]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void api.roles().then((data) => {
      setRoles(data.roles);
      setWorkspaceDir(data.workspaceDir);
      setTargetUrl(data.targetUrl);
    });
    void api
      .auth()
      .then((data) => setAccount(data.account))
      .catch(() => setAccount(null));
    void api.settings().then((data) => {
      setSettings(data);
      settingsRef.current = data;
    });
  }, []);

  // Satu aliran untuk seluruh aplikasi: notifikasi tetap muncul walau Anda
  // sedang membuka tugas lain atau halaman Pengaturan.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const loadTasksRef = useRef(loadTasks);
  loadTasksRef.current = loadTasks;
  useEffect(() => {
    return startAttentionStream(
      (event) => {
        const prefs = settingsRef.current?.notifications;
        if (!prefs) return;
        maybeNotify(event, prefs, (taskId) => navigateRef.current(taskPath(taskId)));
      },
      () => {
        // Angka di pemilih project (menunggu, biaya) ikut turunan dari tugas.
        loadTasksRef.current();
        loadProjects();
      },
    );
  }, [loadProjects]);

  // Penanda jumlah tugas yang menunggu keputusan di judul tab.
  useEffect(() => {
    setTitleBadge(tasks.filter((task) => task.status === "waiting").length);
  }, [tasks]);

  const refresh = useCallback(() => {
    loadTasks();
    loadProjects();
    setRefreshKey((value) => value + 1);
  }, [loadTasks, loadProjects]);

  const onSettingsSaved = useCallback((next: SettingsData) => {
    setSettings(next);
    settingsRef.current = next;
  }, []);

  // Objek yang stabil: konsumen useOutletContext hanya render ulang kalau isinya memang berubah.
  const context = useMemo<AppContext>(
    () => ({ tasks, tasksLoaded, roles, projects, refreshKey, refresh, onSettingsSaved }),
    [tasks, tasksLoaded, roles, projects, refreshKey, refresh, onSettingsSaved],
  );

  const onSelectTask = useCallback((id: string) => navigate(taskPath(id, undefined, search)), [navigate, search]);
  const onFilterRole = useCallback((value: string) => setFilter("role", value), [setFilter]);
  const onFilterStatus = useCallback((value: string) => setFilter("status", value), [setFilter]);

  return (
    <div className="flex h-full">
      <aside
        className={`flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-150 ${
          collapsed ? "w-12" : "w-80"
        }`}
      >
        {collapsed ? (
          <div className="flex flex-col items-center gap-1 px-2 py-3">
            <button
              onClick={() => setCollapsed(false)}
              title="Buka sidebar (Ctrl+B)"
              aria-label="Buka sidebar"
              className="rounded-lg px-2 py-1 text-muted hover:bg-hover hover:text-ink"
            >
              »
            </button>
            <button
              onClick={() => setCreating(true)}
              title="Tugas baru"
              aria-label="Tugas baru"
              className="rounded-lg bg-accent px-2.5 py-1 text-sm font-medium text-on-accent hover:bg-accent-hover"
            >
              +
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 py-3">
            <button
              onClick={() => setCollapsed(true)}
              title="Lipat sidebar (Ctrl+B)"
              aria-label="Lipat sidebar"
              className="-ml-1 rounded-lg px-1.5 py-1 text-muted hover:bg-hover hover:text-ink"
            >
              «
            </button>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold tracking-wide text-ink">AI TEAM</h1>
              {/* <p className="truncate text-[11px] text-muted">
              {account === undefined
                ? "memeriksa sesi…"
                : account
                  ? `${account.email} · ${account.subscriptionType ?? "?"}`
                  : "sesi Claude tidak terdeteksi"}
            </p> */}
            </div>
            <button
              onClick={() => setCreating(true)}
              className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
            >
              + Tugas
            </button>
          </div>
        )}

        {!collapsed && (
          <>
            <ProjectPicker
              projects={projects}
              value={filterProject}
              onChange={(value) => setFilter("project", value)}
              onCreate={() => setCreatingProject(true)}
            />

            <div className="min-h-0 flex-1">
              <TaskList
                tasks={tasks}
                projects={projects}
                showProject={!filterProject}
                selectedId={selected}
                filterRole={filterRole}
                filterStatus={filterStatus}
                onSelect={onSelectTask}
                onFilterRole={onFilterRole}
                onFilterStatus={onFilterStatus}
              />
            </div>

            <div className="border-t border-line px-2 py-2">
              {(
                [
                  ["/memory", "Memori global"],
                  ["/settings", "Pengaturan"],
                ] as const
              ).map(([path, label]) => (
                <button
                  key={path}
                  onClick={() => togglePage(path)}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                    location.pathname === path ? "bg-hover text-ink" : "text-muted hover:bg-hover"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="space-y-1 px-4 py-3 text-[11px] text-faint">
              <p className="truncate" title={activeProject?.workspaceDir ?? workspaceDir}>
                workspace: {activeProject?.workspaceDir ?? workspaceDir}
              </p>
              <p className="flex items-center gap-2">
                <span>
                  slot agen: {slots?.inUse ?? 0}/{slots?.max ?? 0}
                  {slots?.workspaceBusy ? " · workspace terkunci" : ""}
                </span>
                <button
                  onClick={() => {
                    const next = nextTheme(theme);
                    setTheme(next);
                    applyTheme(next);
                  }}
                  title="Ganti tema"
                  className="ml-auto rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-ink"
                >
                  {THEME_LABEL[theme]}
                </button>
              </p>
            </div>
          </>
        )}

        {collapsed && (
          <button
            onClick={() => {
              const next = nextTheme(theme);
              setTheme(next);
              applyTheme(next);
            }}
            title={`Tema: ${THEME_LABEL[theme]} — klik untuk ganti`}
            aria-label={`Tema: ${THEME_LABEL[theme]}`}
            className="mt-auto px-2 py-3 text-sm text-faint hover:text-ink"
          >
            {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
          </button>
        )}
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        <Outlet context={context} />
      </main>

      {creatingProject && (
        <NewProjectDialog
          onClose={() => setCreatingProject(false)}
          onCreated={(projectId) => {
            loadProjects();
            setFilter("project", projectId);
            navigate(`/projects/${encodeURIComponent(projectId)}`);
          }}
        />
      )}

      {creating && (
        <NewTaskDialog
          roles={roles}
          projects={projects}
          defaultProjectId={filterProject || projects[0]?.id || ""}
          defaultTargetUrl={targetUrl}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            navigate(taskPath(id, undefined, search));
            refresh();
          }}
        />
      )}
    </div>
  );
}
