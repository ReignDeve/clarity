import { Minus, Square, X } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge } from "./ui";

/** Custom frameless title bar; the whole strip is a drag region. */
export function TitleBar() {
  const scan = useApp((s) => s.scan);
  const scanning = useApp((s) => s.scanning);
  const demo = api().demo;
  const w = api().window;
  return (
    <div
      className="relative z-40 flex h-10 shrink-0 items-center"
      data-tauri-drag-region
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        w.toggleMaximize();
      }}
    >
      <div className="pointer-events-none flex items-center gap-2.5 pl-[18px]">
        <Logo />
        <span className="text-[11.5px] font-semibold tracking-[0.32em] text-fg-2">CLARITY</span>
        {demo && (
          <Badge tone="warn" title="Running in a browser without the desktop backend. All data shown is synthetic.">
            DEMO DATA
          </Badge>
        )}
      </div>
      <div className="pointer-events-none flex flex-1 justify-center text-xs text-fg-3" data-tauri-drag-region>
        {scanning ? "Scanning…" : scan ? `${scan.roots.map((r) => r.path).join(", ")}${scan.cached ? " · from last session" : ""}` : ""}
      </div>
      <div className="flex h-full">
        <WinButton label="Minimize" onClick={w.minimize}>
          <Minus size={14} strokeWidth={1.5} />
        </WinButton>
        <WinButton label="Maximize" onClick={w.toggleMaximize}>
          <Square size={11} strokeWidth={1.5} />
        </WinButton>
        <WinButton label="Close" onClick={w.close} danger>
          <X size={15} strokeWidth={1.5} />
        </WinButton>
      </div>
    </div>
  );
}

function WinButton({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={`flex h-full w-[46px] items-center justify-center text-fg-3 transition-colors hover:text-fg ${danger ? "hover:bg-[#c42b1c] hover:text-white" : "hover:bg-hover"}`}>
      {children}
    </button>
  );
}

export function Logo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="var(--line-2)" strokeWidth="3" />
      <circle cx="12" cy="12" r="8.5" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray="25 60" transform="rotate(-90 12 12)" />
      <circle cx="12" cy="12" r="8.5" stroke="var(--violet)" strokeWidth="3" strokeLinecap="round" strokeDasharray="12 60" strokeDashoffset="-29" transform="rotate(-90 12 12)" />
      <circle cx="12" cy="12" r="8.5" stroke="var(--fg-2)" strokeWidth="3" strokeLinecap="round" strokeDasharray="5 60" strokeDashoffset="-45" transform="rotate(-90 12 12)" />
    </svg>
  );
}
