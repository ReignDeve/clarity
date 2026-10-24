import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { IconButton, Spinner } from "../components/ui";
import { PreviewError } from "./common";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface Meta {
  title?: string;
  author?: string;
  producer?: string;
  creator?: string;
  pages: number;
}

/** Lazily rendered, scrollable PDF viewer. Scripts/forms in PDFs are disabled. */
export function PdfPreview({ url, large }: { url: string; large?: boolean }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: pdfjs.PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    const task = pdfjs.getDocument({ url, isEvalSupported: false, enableXfa: false, disableAutoFetch: true, disableStream: false });
    task.promise
      .then(async (d) => {
        loaded = d;
        if (cancelled) return d.destroy();
        setDoc(d);
        const m = await d.getMetadata().catch(() => null);
        const info = (m?.info ?? {}) as Record<string, string>;
        if (!cancelled) setMeta({ title: info.Title, author: info.Author, producer: info.Producer, creator: info.Creator, pages: d.numPages });
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
      void task.destroy();
      void loaded?.destroy();
    };
  }, [url]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const pages = [...el.querySelectorAll<HTMLElement>("[data-page]")];
    const mid = el.scrollTop + el.clientHeight / 3;
    const cur = pages.find((p) => p.offsetTop + p.offsetHeight > mid);
    if (cur) setPage(Number(cur.dataset.page));
  };

  const goTo = (n: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (error) return <PreviewError message="This PDF could not be displayed. It may be damaged or encrypted." detail={error} />;
  if (!doc)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );

  const width = (large ? 760 : 300) * zoom;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b hairline px-2 text-xs text-fg-3">
        <IconButton label="Previous page" onClick={() => goTo(Math.max(1, page - 1))} disabled={page <= 1}>
          <ChevronLeft size={14} />
        </IconButton>
        <span className="tabular min-w-[64px] text-center">
          {page} / {doc.numPages}
        </span>
        <IconButton label="Next page" onClick={() => goTo(Math.min(doc.numPages, page + 1))} disabled={page >= doc.numPages}>
          <ChevronRight size={14} />
        </IconButton>
        <div className="flex-1" />
        <IconButton label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
          <ZoomOut size={14} />
        </IconButton>
        <span className="tabular w-10 text-center">{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
          <ZoomIn size={14} />
        </IconButton>
      </div>
      <div ref={scroller} onScroll={onScroll} className="scroll flex-1 bg-[rgba(0,0,0,0.18)] py-3">
        {Array.from({ length: doc.numPages }, (_, i) => (
          <PdfPage key={i} doc={doc} n={i + 1} width={width} />
        ))}
      </div>
      {meta && (meta.title || meta.author || meta.producer) && (
        <div className="shrink-0 border-t hairline px-3 py-2 text-2xs text-fg-3">
          {meta.title && <div className="truncate">Title: {meta.title}</div>}
          {meta.author && <div className="truncate">Author: {meta.author}</div>}
          {(meta.producer || meta.creator) && <div className="truncate">Made with: {meta.creator || meta.producer}</div>}
        </div>
      )}
    </div>
  );
}

function PdfPage({ doc, n, width }: { doc: pdfjs.PDFDocumentProxy; n: number; width: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(n <= 2);
  const [aspect, setAspect] = useState(1.414);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let task: pdfjs.RenderTask | null = null;
    let cancelled = false;
    doc.getPage(n).then((p) => {
      if (cancelled || !canvas.current) return;
      const base = p.getViewport({ scale: 1 });
      setAspect(base.height / base.width);
      const dpr = window.devicePixelRatio || 1;
      const vp = p.getViewport({ scale: (width / base.width) * dpr });
      const c = canvas.current;
      c.width = vp.width;
      c.height = vp.height;
      task = p.render({ canvasContext: c.getContext("2d")!, viewport: vp });
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, width, doc, n]);

  return (
    <div ref={holder} data-page={n} className="mx-auto mb-3 overflow-hidden rounded-[3px] bg-white shadow-[0_4px_18px_-6px_rgba(0,0,0,0.5)]" style={{ width, height: width * aspect }}>
      <canvas ref={canvas} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
