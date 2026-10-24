import { PanelRightOpen } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { Inspector } from "./components/Inspector";
import { CleanupDialog, QuickLook, SelectionTray, ShortcutsOverlay, Toasts } from "./components/Overlays";
import { Onboarding, ScanProgressView, ScanSetup } from "./components/Scan";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { IconButton, Spinner } from "./components/ui";
import { api, errorText, initBackend } from "./lib/api";
import { bytes, num } from "./lib/format";
import { useApp, type View } from "./store/app";
import { Analysis } from "./views/Analysis";
import { Duplicates } from "./views/Duplicates";
import { Explorer } from "./views/Explorer";
import { History, Settings } from "./views/HistorySettings";
import { Downloads, LargeFiles, OldFiles } from "./views/Lists";
import { Overview } from "./views/Overview";
import { Media } from "./views/Media";
import { Organizer } from "./views/Organizer";
import { startUpdateChecks } from "./lib/updates";
import { MoveDialog, WatchDialog } from "./components/FeatureDialogs";
import { Suggestions } from "./views/Suggestions";

const VIEWS: Record<View, () => ReactNode> = {
  overview: () => <Overview />,
  media: () => <Media />,
  organize: () => <Organizer />,
  suggestions: () => <Suggestions />,
  analysis: () => <Analysis />,
  old: () => <OldFiles />,
  large: () => <LargeFiles />,
  duplicates: () => <Duplicates />,
  downloads: () => <Downloads />,
  explorer: () => <Explorer />,
  history: () => <History />,
  settings: () => <Settings />,
};

const KEY_VIEWS: Record<string, View> = { "1": "overview", "2": "analysis", "3": "explorer", "4": "suggestions", "5": "old", "6": "large", "7": "duplicates", "8": "downloads", "9": "media", ",": "settings" };

let booted = false;

async function boot() {
  if (booted) return; // StrictMode runs effects twice in development.
  booted = true;
  const be = await initBackend();
  const st = useApp.getState();
  const [info, settings, drives] = await Promise.all([be.appInfo(), be.settings(), be.drives()]);
  st.set({ info, settings, drives });

  await be.onScanProgress((p) => useApp.getState().set({ progress: p }));
  await be.onScanFinished(async (f) => {
    const s = useApp.getState();
    s.set({ scanning: false, progress: null, drives: await be.drives() });
    if (f.cancelled) s.toast(f.kept ? "Scan cancelled. Showing the previous results." : "Scan cancelled. Results are partial.");
    if (!f.kept && f.info) {
      s.set({ scan: f.info, view: "overview", inspector: null, selection: new Map() });
      if (!f.cancelled) s.toast(`Scan complete: ${num(f.info.files)} files, ${bytes(f.info.bytes)}`, "ok");
    }
    s.bump();
  });
  await be.onMediaProgress((p) => useApp.getState().set({ mediaIndex: { ...p, running: p.done < p.total } }));
  await be.onMediaFinished(() => {
    const s = useApp.getState();
    s.set({ mediaIndex: { done: s.mediaIndex?.total ?? 0, total: s.mediaIndex?.total ?? 0, running: false } });
  });
  await be.onWatchAlerts((n) => {
    const s = useApp.getState();
    s.toast(`${n} new watchlist alert${n === 1 ? "" : "s"}: see Storage Analysis → Watchlist`);
    s.bump();
  });
  await be.onDupProgress((p) => useApp.getState().set({ dupProgress: p }));
  await be.onDupFinished((f) => {
    const s = useApp.getState();
    s.set({ dupRunning: false, dupProgress: null });
    if (f.cancelled) s.toast("Duplicate search cancelled.");
    s.bump();
  });

  if (info.scanning) st.set({ scanning: true });
  else if (info.hasIndex) {
    const ov = await be.overview().catch(() => null);
    if (ov) st.set({ scan: ov.scan });
  } else if (info.cacheSavedAt) {
    const cached = await be.loadCachedScan().catch(() => null);
    if (cached) st.set({ scan: cached });
  }
  st.set({ ready: true });
  startUpdateChecks();
}

export default function App() {
  const ready = useApp((s) => s.ready);
  const settings = useApp((s) => s.settings);
  const scan = useApp((s) => s.scan);
  const scanning = useApp((s) => s.scanning);
  const view = useApp((s) => s.view);
  const showSetup = useApp((s) => s.showScanSetup);
  const inspectorOpen = useApp((s) => s.inspectorOpen);
  const version = useApp((s) => s.version);
  const set = useApp((s) => s.set);

  useEffect(() => {
    boot().catch((e) => {
      useApp.getState().toast(`Startup failed: ${errorText(e)}`, "error");
      useApp.getState().set({ ready: true });
    });
  }, []);

  // Theme: explicit choice or follow Windows.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const t = settings?.theme ?? "system";
      document.documentElement.dataset.theme = t === "system" ? (mq.matches ? "light" : "dark") : t;
      document.documentElement.dataset.motion = settings?.motion ?? "system";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings?.theme, settings?.motion]);

  // Sidebar badges.
  useEffect(() => {
    if (!scan) return;
    api()
      .overview()
      .then(async (o) => {
        const w = await api().watchList().catch(() => null);
        set({ navCounts: { suggestions: o.recCount, duplicates: o.duplicates?.[0] ?? 0, analysis: w?.alerts.filter((a) => !a.seen).length ?? 0 } });
      })
      .then(() => api().drives())
      .then((drives) => set({ drives }))
      .catch(() => {});
  }, [scan, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.ctrlKey && KEY_VIEWS[e.key] && s.scan) {
        e.preventDefault();
        s.go(KEY_VIEWS[e.key]);
      } else if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        window.dispatchEvent(new Event("clarity:focus-search"));
      } else if (typing || e.ctrlKey || e.altKey) {
        return;
      } else if (e.key === "i" || e.key === "I") {
        s.set({ inspectorOpen: !s.inspectorOpen });
      } else if (e.key === "?") {
        s.set({ shortcutsOpen: true });
      } else if (e.key === "Delete" && s.selection.size > 0 && !s.reviewOpen) {
        s.set({ reviewOpen: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reduced = settings?.motion === "reduced" ? "always" : settings?.motion === "full" ? "never" : "user";
  const firstRun = ready && settings && !settings.onboarded && !scan && !scanning;
  const showInspector = !!scan && !scanning && !showSetup && inspectorOpen && view !== "settings" && view !== "history";

  let main: ReactNode;
  if (!ready) main = <Centered><Spinner size={18} /></Centered>;
  else if (scanning) main = <ScanProgressView />;
  else if (showSetup || !scan) main = <Centered><div className="w-full max-w-[720px]"><ScanSetup onCancel={scan ? () => set({ showScanSetup: false }) : undefined} /></div></Centered>;
  else main = (VIEWS[view] ?? VIEWS.overview)();

  return (
    <MotionConfig reducedMotion={reduced} transition={{ type: "spring", stiffness: 420, damping: 36 }}>
      <div className="app-backdrop" />
      <div className="relative flex h-full flex-col">
        <TitleBar />
        {firstRun ? (
          <div className="min-h-0 flex-1">
            <Onboarding />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-2.5 px-2.5 pb-2.5">
            <Sidebar />
            <main className="relative min-w-0 flex-1">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={scanning ? "scanning" : showSetup || !scan ? "setup" : view}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
                  className={view === "overview" && scan && !showSetup && !scanning ? "scroll absolute inset-0 pr-1" : "absolute inset-0 flex flex-col"}
                >
                  {main}
                </motion.div>
              </AnimatePresence>
              <SelectionTray />
              {!!scan && !scanning && !showSetup && !inspectorOpen && view !== "settings" && view !== "history" && (
                <IconButton label="Show inspector (I)" onClick={() => set({ inspectorOpen: true })} className="glass absolute right-2 top-2 z-20">
                  <PanelRightOpen size={15} />
                </IconButton>
              )}
            </main>
            <AnimatePresence initial={false}>{showInspector && <Inspector key="inspector" />}</AnimatePresence>
          </div>
        )}
      </div>
      <QuickLook />
      <MoveDialog />
      <WatchDialog />
      <CleanupDialog />
      <ShortcutsOverlay />
      <Toasts />
    </MotionConfig>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6">{children}</div>;
}
