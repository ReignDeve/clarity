import { Maximize, Music2, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../components/ui";
import { PreviewError } from "./common";

export function ImagePreview({ url, large, onInfo }: { url: string; large?: boolean; onInfo?: (s: string) => void }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setDims(null);
    setFailed(false);
  }, [url]);

  if (failed) return <PreviewError message="This image format cannot be displayed here." detail="HEIC, RAW and PSD files need their own application." />;

  return (
    <div className="flex h-full flex-col">
      <div
        className="relative flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        style={{ backgroundImage: "repeating-conic-gradient(var(--hover) 0% 25%, transparent 0% 50%)", backgroundSize: "16px 16px" }}
        onWheel={(e) => {
          const nz = Math.min(8, Math.max(1, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
          setZoom(nz);
          if (nz === 1) setPan({ x: 0, y: 0 });
        }}
        onPointerDown={(e) => {
          if (zoom === 1) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y });
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => {
          setZoom(zoom === 1 ? 2.5 : 1);
          setPan({ x: 0, y: 0 });
        }}
      >
        <img
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const d = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
            setDims(d);
            onInfo?.(`${d.w} × ${d.h} px`);
          }}
          onError={() => setFailed(true)}
          className="absolute inset-0 m-auto max-h-full max-w-full object-contain transition-transform duration-75"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, padding: large ? 24 : 12 }}
        />
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-t hairline px-3 text-2xs text-fg-3">
        <span className="tabular">{dims ? `${dims.w} × ${dims.h} px · ${((dims.w * dims.h) / 1e6).toFixed(1)} MP` : "…"}</span>
        <span>{zoom > 1 ? `${Math.round(zoom * 100)}% · drag to pan` : "Scroll to zoom"}</span>
      </div>
    </div>
  );
}

export function VideoPreview({ url, onInfo }: { url: string; onInfo?: (s: string) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => setFailed(false), [url]);
  if (failed) return <PreviewError message="This video codec or container is not supported by the built-in player." detail="Use “Open” to play it in its default application." />;
  return (
    <div className="flex h-full flex-col bg-black/40">
      <video
        ref={ref}
        src={url}
        controls
        preload="metadata"
        className="min-h-0 flex-1"
        onError={() => setFailed(true)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          const s = `${fmtTime(v.duration)} · ${v.videoWidth} × ${v.videoHeight}`;
          setInfo(s);
          onInfo?.(s);
        }}
      />
      <div className="flex h-8 shrink-0 items-center justify-between border-t hairline px-3 text-2xs text-fg-3">
        <span className="tabular">{info ?? "Loading…"}</span>
        <IconButton label="Fullscreen" onClick={() => ref.current?.requestFullscreen()}>
          <Maximize size={12} />
        </IconButton>
      </div>
    </div>
  );
}

export function AudioPreview({ url, name, onInfo }: { url: string; name: string; onInfo?: (s: string) => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setPlaying(false);
    setT(0);
  }, [url]);
  if (failed) return <PreviewError message="This audio format is not supported by the built-in player." />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6">
      <div className="flex h-24 w-24 items-center justify-center rounded-[22px] shadow-[0_0_0_1px_var(--line-2),0_20px_40px_-20px_var(--c-audio)]" style={{ background: "linear-gradient(135deg, color-mix(in oklab, var(--c-audio) 30%, transparent), color-mix(in oklab, var(--violet) 18%, transparent))" }}>
        <Music2 size={30} className="text-fg" strokeWidth={1.5} />
      </div>
      <div className="w-full max-w-xs text-center">
        <p className="truncate text-sm text-fg">{name}</p>
        <p className="tabular text-2xs text-fg-3">
          {fmtTime(t)} / {fmtTime(dur)}
        </p>
      </div>
      <div className="flex w-full max-w-xs items-center gap-3">
        <button
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => (playing ? ref.current?.pause() : ref.current?.play())}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-[var(--on-accent)] transition-transform hover:scale-105"
        >
          {playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
        </button>
        <input
          type="range"
          min={0}
          max={dur || 0}
          step={0.1}
          value={t}
          onChange={(e) => ref.current && (ref.current.currentTime = Number(e.target.value))}
          className="h-1 flex-1 accent-[var(--accent)]"
          aria-label="Seek"
        />
      </div>
      <audio
        ref={ref}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          setDur(e.currentTarget.duration);
          onInfo?.(fmtTime(e.currentTarget.duration));
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return "–:––";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
