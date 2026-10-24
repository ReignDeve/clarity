// Auto-updates via Nexus ReleaseHub (Tauri updater feed, see NEXUS.md).
// Checks never block the UI; downloads run in the background; installing
// only happens when the user clicks "Restart to update".

import type { Update } from "@tauri-apps/plugin-updater";
import { api, errorText, isNative } from "./api";
import { useApp } from "../store/app";

let pending: Update | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

async function deviceId(): Promise<string> {
  const s = useApp.getState();
  const settings = s.settings;
  if (!settings) return "";
  if (settings.deviceId) return settings.deviceId;
  const id = crypto.randomUUID();
  const saved = await api().saveSettings({ ...settings, deviceId: id });
  s.set({ settings: saved });
  return id;
}

export async function checkForUpdates(manual = false) {
  const s = useApp.getState();
  if (!isNative || ["checking", "downloading", "installing"].includes(s.update.status)) return;
  if (s.update.status === "ready" && !manual) return;
  s.set({ update: { ...s.update, status: "checking", error: undefined } });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 10_000, headers: { "X-Nexus-Device": await deviceId() } });
    const now = Math.floor(Date.now() / 1000);
    if (!update) {
      useApp.getState().set({ update: { status: "none", checkedAt: now } });
      if (manual) useApp.getState().toast("CLARITY is up to date.", "ok");
      return;
    }
    pending = update;
    useApp.getState().set({ update: { status: "available", version: update.version, notes: update.body, checkedAt: now } });
    if (useApp.getState().settings?.autoUpdate || manual) await download();
  } catch (e) {
    useApp.getState().set({ update: { status: "error", error: errorText(e), checkedAt: Math.floor(Date.now() / 1000) } });
    if (manual) useApp.getState().toast(`Update check failed: ${errorText(e)}`, "error");
  }
}

export async function download() {
  if (!pending) return;
  let total = 0;
  let got = 0;
  const set = (patch: Partial<ReturnType<typeof useApp.getState>["update"]>) => useApp.getState().set({ update: { ...useApp.getState().update, ...patch } });
  set({ status: "downloading", progress: 0 });
  try {
    await pending.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        set({ progress: total ? got / total : undefined });
      }
    });
    set({ status: "ready", progress: 1 });
  } catch (e) {
    set({ status: "error", error: errorText(e) });
  }
}

/** Runs the installer (passive) and relaunches CLARITY. */
export async function installAndRestart() {
  if (!pending) return;
  const s = useApp.getState();
  if (s.scanning || s.update.status !== "ready") return;
  s.set({ update: { ...s.update, status: "installing" } });
  try {
    await pending.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    useApp.getState().set({ update: { ...useApp.getState().update, status: "error", error: errorText(e) } });
  }
}

export function startUpdateChecks() {
  if (!isNative || timer) return;
  setTimeout(() => void checkForUpdates(false), 5_000);
  timer = setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1000);
}
