import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Folder, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FileIcon } from "../components/FileIcon";
import { Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { bytes, num } from "../lib/format";
import type { ArchiveListing, Category, TextPreview as TP } from "../lib/types";
import { PreviewError } from "./common";

for (const [n, l] of Object.entries({ bash, cpp, csharp, css, go, ini, java, javascript, json, markdown, php, powershell, python, ruby, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(n, l);

const LANG: Record<string, string> = {
  rs: "rust", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", json: "json", ipynb: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", md: "markdown", html: "xml", xml: "xml", svg: "xml", vue: "xml", css: "css", scss: "css", sql: "sql", sh: "bash", bat: "bash", cmd: "bash", ps1: "powershell", go: "go", java: "java", kt: "java", c: "cpp", h: "cpp", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp", rb: "ruby", php: "php",
};
const HIGHLIGHT_LIMIT = 200_000;

export function TextPreview({ id, ext }: { id: number; ext: string }) {
  const [data, setData] = useState<TP | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setError(null);
    api().previewText(id).then(setData, (e) => setError(errorText(e)));
  }, [id]);

  const html = useMemo(() => {
    if (!data || data.binary) return null;
    const lang = LANG[ext];
    if (!lang || data.text.length > HIGHLIGHT_LIMIT) return null;
    try {
      return hljs.highlight(data.text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [data, ext]);

  if (error) return <PreviewError message="The file could not be read." detail={error} />;
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (data.binary) return <PreviewError message="This looks like a binary file, so there is no text to show." />;

  const lines = data.text.split("\n").length;
  return (
    <div className="flex h-full flex-col">
      <div className="scroll selectable flex-1">
        <div className="flex min-w-max font-mono text-[11.5px] leading-[1.6]">
          <pre className="sticky left-0 select-none bg-[var(--glass-1)] py-3 pl-3 pr-3 text-right text-fg-4">{Array.from({ length: Math.min(lines, 20000) }, (_, i) => i + 1).join("\n")}</pre>
          {html ? <pre className="hljs py-3 pr-4" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="py-3 pr-4 text-fg-2">{data.text}</pre>}
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between border-t hairline px-3 text-2xs text-fg-3">
        <span>
          {data.encoding} · {num(lines)} lines{LANG[ext] ? ` · ${LANG[ext]}` : ""}
        </span>
        {data.truncated && <span>Showing first {bytes(data.text.length)} of {bytes(data.totalBytes)}</span>}
      </div>
    </div>
  );
}

export function ArchivePreview({ id }: { id: number }) {
  const [data, setData] = useState<ArchiveListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setError(null);
    api().previewArchive(id).then(setData, (e) => setError(errorText(e)));
  }, [id]);
  if (error) return <PreviewError message="The archive could not be read." detail={error} />;
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (!data.supported) return <PreviewError message={data.note ?? "Unsupported archive format."} />;
  const ratio = data.compressedTotal && data.uncompressedTotal ? data.compressedTotal / data.uncompressedTotal : null;
  return (
    <div className="flex h-full flex-col">
      <div className="grid shrink-0 grid-cols-3 gap-px border-b hairline text-center">
        <Stat label="Entries" value={num(data.totalEntries)} />
        <Stat label="Unpacked" value={bytes(data.uncompressedTotal)} />
        <Stat label="Ratio" value={ratio ? `${Math.round(ratio * 100)}%` : "–"} />
      </div>
      <div className="scroll flex-1 py-1">
        {data.entries.map((e, i) => (
          <div key={i} className="flex h-7 items-center gap-2 px-3 text-xs hover:bg-hover">
            {e.isDir ? <Folder size={13} className="shrink-0 text-[var(--c-folder)]" /> : <FileIcon category={catOf(e.name)} size={13} />}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2" title={e.name}>
              {e.name}
            </span>
            {e.encrypted && <Lock size={11} className="text-warn" aria-label="Encrypted" />}
            {!e.isDir && <span className="tabular text-2xs text-fg-3">{bytes(e.size)}</span>}
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t hairline px-3 py-2 text-2xs text-fg-3">
        {data.format} · nothing was extracted{data.truncated ? ` · showing ${num(data.entries.length)} entries` : ""}
        {data.note && ` · ${data.note}`}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-2">
      <div className="tabular text-sm font-medium text-fg">{value}</div>
      <div className="text-2xs uppercase tracking-[0.08em] text-fg-4">{label}</div>
    </div>
  );
}

function catOf(name: string): Category {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(ext)) return "images";
  if (["mp4", "mkv", "mov", "avi"].includes(ext)) return "video";
  if (["mp3", "wav", "flac", "m4a"].includes(ext)) return "audio";
  if (["pdf", "doc", "docx", "txt", "md", "xlsx"].includes(ext)) return "documents";
  if (["zip", "7z", "rar", "gz"].includes(ext)) return "archives";
  if (LANG[ext]) return "code";
  return "other";
}
