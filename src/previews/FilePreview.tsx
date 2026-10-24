import { EyeOff } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { FileIcon } from "../components/FileIcon";
import { Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import type { FileDetail } from "../lib/types";
import { PreviewError } from "./common";
import { AudioPreview, ImagePreview, VideoPreview } from "./MediaPreviews";
import { ArchivePreview, TextPreview } from "./TextArchive";

// pdf.js is large; load it only when a PDF is actually previewed.
const PdfPreview = lazy(() => import("./PdfPreview").then((m) => ({ default: m.PdfPreview })));

const center = (
  <div className="flex h-full items-center justify-center">
    <Spinner />
  </div>
);

export function FilePreview({ detail, large }: { detail: FileDetail; large?: boolean }) {
  const { row, preview } = detail;
  const media = preview === "pdf" || preview === "image" || preview === "video" || preview === "audio";
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!media || !detail.live.exists) return;
    let cancelled = false;
    api()
      .previewUrl(row.id)
      .then((u) => !cancelled && setUrl(u))
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [row.id, media, detail.live.exists]);

  if (!detail.live.exists) return <PreviewError message="This file no longer exists at its scanned location." />;
  if (row.cloud)
    return (
      <Placeholder category={row.category}>
        Cloud-only file. CLARITY does not preview it because opening it would download it.
      </Placeholder>
    );
  if (preview === "none")
    return (
      <Placeholder category={row.category}>
        No built-in preview for .{row.ext || "?"} files.{detail.canOpen ? " Use “Open” to view it in its default application." : ""}
      </Placeholder>
    );
  if (preview === "text") return <TextPreview id={row.id} ext={row.ext} />;
  if (preview === "archive") return <ArchivePreview id={row.id} />;
  if (error) return <PreviewError message="Preview unavailable." detail={error} />;
  if (!url) return center;

  switch (preview) {
    case "pdf":
      return (
        <Suspense fallback={center}>
          <PdfPreview url={url} large={large} />
        </Suspense>
      );
    case "image":
      return <ImagePreview url={url} large={large} />;
    case "video":
      return <VideoPreview url={url} />;
    case "audio":
      return <AudioPreview url={url} name={row.name} />;
  }
  return null;
}

function Placeholder({ category, children }: { category: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="relative">
        <FileIcon category={category} size={22} boxed />
        <EyeOff size={12} className="absolute -bottom-1 -right-1 rounded bg-[var(--glass-2)] p-[1px] text-fg-3" />
      </div>
      <p className="max-w-[260px] text-xs text-fg-3">{children}</p>
    </div>
  );
}
