import { FolderInput, Network } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { bytes, dateTime } from "../lib/format";
import type { FileDetail, MediaMeta, RelatedFile } from "../lib/types";
import { useApp } from "../store/app";
import { fmtDuration, resolutionLabel } from "../views/Media";
import { ConfidenceBadge } from "./FeatureDialogs";
import { Thumb } from "./Thumb";
import { Button, Spinner } from "./ui";

/** Resolution, duration, camera, artist… read from Windows. */
export function MediaFacts({ d, Fact }: { d: FileDetail; Fact: (p: { label: string; children: React.ReactNode }) => React.ReactNode }) {
  const [m, setM] = useState<MediaMeta | null | undefined>(undefined);
  const media = ["images", "video", "audio"].includes(d.row.category);
  useEffect(() => {
    setM(undefined);
    if (media && !d.row.cloud) api().mediaMeta(d.row.id).then(setM, () => setM(null));
  }, [d.row.id]);
  if (!media || !m) return null;
  const rows: [string, string][] = [
    ["Resolution", resolutionLabel(m)],
    ["Duration", fmtDuration(m.durationMs)],
    ["Frame rate", m.frameRate ? `${m.frameRate.toFixed(2).replace(/\.00$/, "")} fps` : ""],
    ["Bitrate", m.bitrate ? `${Math.round(m.bitrate / 1000)} kbps` : ""],
    ["Taken", m.taken ? dateTime(m.taken) : ""],
    ["Camera", m.camera ?? ""],
    ["Title", m.title ?? ""],
    ["Artist", m.artist ?? ""],
    ["Album", m.album ?? ""],
  ];
  return (
    <>
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <Fact key={k} label={k}>
            {v}
          </Fact>
        ))}
    </>
  );
}

const ORDER: RelatedFile["confidence"][] = ["confident", "likely", "possible"];

/** "Related files" section: navigate, preview, move together. */
export function RelatedSection({ d, Section }: { d: FileDetail; Section: (p: { title: string; children: React.ReactNode }) => React.ReactNode }) {
  const version = useApp((s) => s.version);
  const inspect = useApp((s) => s.inspect);
  const set = useApp((s) => s.set);
  const [rel, setRel] = useState<RelatedFile[] | null>(null);
  const [showPossible, setShowPossible] = useState(false);
  useEffect(() => {
    setRel(null);
    api().fileRelations(d.row.id).then(setRel, () => setRel([]));
  }, [d.row.id, version]);

  if (rel === null)
    return (
      <Section title="Related files">
        <div className="flex items-center gap-2 py-1 text-xs text-fg-3">
          <Spinner size={12} /> Looking for related files…
        </div>
      </Section>
    );
  if (rel.length === 0) return null;
  const possible = rel.filter((r) => r.confidence === "possible");
  const shown = rel.filter((r) => r.confidence !== "possible" || showPossible);

  return (
    <Section title="Related files">
      <div className="space-y-0.5">
        {ORDER.flatMap((c) => shown.filter((r) => r.confidence === c)).map((r) => (
          <div key={r.id} className="group flex items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 hover:bg-hover">
            <button onClick={() => inspect({ kind: "file", id: r.id })} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" title={r.reason}>
              <Thumb row={r.row} size={96} className="h-9 w-9 shrink-0 rounded-[6px]" iconSize={14} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-fg">{r.row.name}</div>
                <div className="flex items-center gap-1.5 text-2xs text-fg-3">
                  <span className="truncate">{r.label}</span>
                  <ConfidenceBadge c={r.confidence} />
                </div>
              </div>
            </button>
            <button onClick={() => set({ quickLook: r.id })} className="shrink-0 rounded px-1.5 py-0.5 text-2xs text-fg-3 opacity-0 hover:bg-active hover:text-fg group-hover:opacity-100">
              Preview
            </button>
            <span className="tabular shrink-0 text-2xs text-fg-4">{bytes(r.row.size)}</span>
          </div>
        ))}
      </div>
      {possible.length > 0 && !showPossible && (
        <button onClick={() => setShowPossible(true)} className="mt-1 flex items-center gap-1 px-1.5 text-2xs text-fg-3 hover:text-fg">
          <Network size={11} /> Show {possible.length} possible match{possible.length === 1 ? "" : "es"} (folder structure only)
        </button>
      )}
      {d.live.exists && !d.protected && (
        <Button size="sm" className="mt-2 w-full" icon={<FolderInput size={13} />} onClick={() => set({ moveRequest: { primary: { id: d.row.id, name: d.row.name, path: d.path, size: d.row.size }, related: rel } })}>
          Move with related files…
        </Button>
      )}
    </Section>
  );
}
