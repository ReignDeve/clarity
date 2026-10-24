import clsx from "clsx";
import { Check, Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { catColor } from "../lib/format";

type Tone = "default" | "primary" | "ghost" | "danger" | "subtle";

export function Button({ tone = "default", size = "md", icon, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "sm" | "md"; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] font-medium transition-[background,box-shadow,color,opacity] duration-150 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
        tone === "primary" && "bg-accent text-[var(--on-accent)] shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_6px_16px_-6px_var(--accent-line)] hover:bg-accent-strong",
        tone === "default" && "bg-hover text-fg shadow-[0_0_0_1px_var(--line-2),0_1px_0_var(--sheen)_inset] hover:bg-active",
        tone === "ghost" && "text-fg-2 hover:bg-hover hover:text-fg",
        tone === "subtle" && "bg-accent-soft text-accent hover:bg-[var(--accent-line)]",
        tone === "danger" && "bg-danger text-white shadow-[0_6px_16px_-6px_var(--danger)] hover:brightness-110",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-30",
        active && "bg-active text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, size = "md" }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-[8px] bg-hover p-0.5 shadow-[0_0_0_1px_var(--line)]" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            "whitespace-nowrap rounded-[6px] px-2.5 font-medium transition-all duration-150",
            size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
            o.value === value ? "bg-[var(--glass-2)] text-fg shadow-[0_0_0_1px_var(--line-2),0_2px_6px_-2px_rgba(0,0,0,0.3)]" : "text-fg-3 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ active, onClick, color, children }: { active?: boolean; onClick?: () => void; color?: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors",
        active ? "bg-accent-soft text-fg shadow-[0_0_0_1px_var(--accent-line)]" : "text-fg-3 shadow-[0_0_0_1px_var(--line)] hover:bg-hover hover:text-fg-2",
      )}
    >
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: "neutral" | "accent" | "warn" | "danger" | "ok"; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 text-2xs font-medium tracking-wide",
        tone === "neutral" && "bg-hover text-fg-3",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "warn" && "bg-[var(--warn-soft)] text-warn",
        tone === "danger" && "bg-[var(--danger-soft)] text-danger",
        tone === "ok" && "bg-[var(--ok-soft)] text-ok",
      )}
    >
      {children}
    </span>
  );
}

export function Checkbox({ checked, onChange, label, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label?: string; indeterminate?: boolean }) {
  return (
    <button
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={clsx(
        "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] transition-all duration-100",
        checked || indeterminate ? "bg-accent text-[var(--on-accent)]" : "shadow-[0_0_0_1.2px_var(--fg-4)] hover:shadow-[0_0_0_1.2px_var(--fg-3)]",
      )}
    >
      {checked && <Check size={11} strokeWidth={3} />}
      {!checked && indeterminate && <span className="h-[1.5px] w-2 rounded bg-current" />}
    </button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx("relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-200", checked ? "bg-accent" : "bg-active shadow-[0_0_0_1px_var(--line-2)_inset]")}
    >
      <span className={clsx("absolute left-0 top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[translate] duration-200", checked ? "translate-x-[16px]" : "translate-x-[2px]")} />
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="spin text-fg-3" />;
}

export function Panel({ className, children, title, actions, pad = true }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode; pad?: boolean }) {
  return (
    <section className={clsx("glass edge-light flex min-h-0 flex-col", className)}>
      {(title || actions) && (
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 px-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">{title}</h3>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      <div className={clsx("min-h-0 flex-1", pad && "px-4 pb-4", !title && pad && "pt-4")}>{children}</div>
    </section>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 px-8 text-center">
      {icon && <div className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-hover text-fg-3 shadow-[0_0_0_1px_var(--line)]">{icon}</div>}
      <div className="space-y-1">
        <p className="text-base font-medium text-fg">{title}</p>
        {children && <p className="mx-auto max-w-sm text-sm text-fg-3">{children}</p>}
      </div>
      {action}
    </div>
  );
}

/** Thin horizontal usage bar. */
export function Meter({ value, max, color = "var(--accent)", className }: { value: number; max: number; color?: string; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={clsx("h-1 overflow-hidden rounded-full bg-active", className)}>
      <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function CatDot({ category, size = 8 }: { category: string; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: catColor(category) }} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Large figure with a smaller unit, e.g. 412 GB. */
export function Figure({ value, unit, className }: { value: string; unit?: string; className?: string }) {
  return (
    <span className={clsx("tabular font-semibold tracking-tight", className)}>
      {value}
      {unit && <span className="ml-1 text-[0.55em] font-medium tracking-normal text-fg-3">{unit}</span>}
    </span>
  );
}
