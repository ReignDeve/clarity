import clsx from "clsx";
import { CloudOff } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import type { FileRow } from "../lib/types";
import { useApp } from "../store/app";
import { FileIcon } from "./FileIcon";

const THUMBABLE = new Set(["images", "video", "audio", "documents"]);

/** Shell thumbnail with an icon fallback (unsupported format, cloud-only, unreadable). */
export function Thumb({ row, size = 256, className, iconSize = 20, fit = "cover" }: { row: FileRow; size?: number; className?: string; iconSize?: number; fit?: "cover" | "contain" }) {
  const scanKey = useApp((s) => s.scan?.id ?? "");
  const [failed, setFailed] = useState<number | null>(null);
  const broken = failed === row.id || !THUMBABLE.has(row.category);
  return (
    <div className={clsx("relative flex items-center justify-center overflow-hidden bg-[var(--glass-0)]", className)}>
      {broken ? (
        <div className="flex flex-col items-center gap-1">
          <FileIcon category={row.category} size={iconSize} />
          {row.cloud && <CloudOff size={11} className="text-fg-4" aria-label="Cloud-only: no local preview" />}
        </div>
      ) : (
        <img
          key={row.id}
          src={api().thumbUrl(row.id, size, scanKey)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(row.id)}
          className={clsx("h-full w-full", fit === "cover" ? "object-cover" : "object-contain")}
        />
      )}
    </div>
  );
}
