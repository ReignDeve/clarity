import clsx from "clsx";
import { Check, Lightbulb, Plus } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { FileIcon } from "../components/FileIcon";
import { RiskBadge } from "../components/Inspector";
import { Button, Chip, Empty, Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { ago, bytes, num, REC_LABEL } from "../lib/format";
import type { Recommendation, RecKind } from "../lib/types";
import { selKey, useApp } from "../store/app";
import { ViewHeader } from "./Lists";

export function Suggestions() {
  const version = useApp((s) => s.version);
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<RecKind | "all">("all");
  const [risk, setRisk] = useState<"all" | "low">("all");
  const [limit, setLimit] = useState(150);

  useEffect(() => {
    api().recommendations().then(setRecs, (e) => setError(errorText(e)));
  }, [version]);

  const kinds = useMemo(() => {
    const m = new Map<RecKind, { n: number; bytes: number }>();
    for (const r of recs ?? []) {
      const e = m.get(r.kind) ?? { n: 0, bytes: 0 };
      e.n++;
      e.bytes += r.size;
      m.set(r.kind, e);
    }
    return [...m.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  }, [recs]);

  if (error) return <Empty title="Could not load suggestions">{error}</Empty>;
  if (!recs)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const shown = recs.filter((r) => (kind === "all" || r.kind === kind) && (risk === "all" || r.risk === "low"));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Suggestions">
        Transparent rules based on size, type, location, modification date and verified duplicates. CLARITY never decides for you, and nothing here is labelled “safe to delete”.
      </ViewHeader>
      <div className="mb-3 flex flex-wrap items-center gap-1.5 px-1">
        <Chip active={kind === "all"} onClick={() => setKind("all")}>
          All · {num(recs.length)}
        </Chip>
        {kinds.map(([k, v]) => (
          <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
            {REC_LABEL[k]} · {bytes(v.bytes)}
          </Chip>
        ))}
        <div className="ml-auto">
          <Chip active={risk === "low"} onClick={() => setRisk(risk === "low" ? "all" : "low")}>
            Low risk only
          </Chip>
        </div>
      </div>
      {shown.length === 0 ? (
        <Empty icon={<Lightbulb size={18} />} title="No suggestions">
          Nothing matched the review rules for the scanned folders. Rules and thresholds can be adjusted in Settings.
        </Empty>
      ) : (
        <div className="scroll -mx-1 min-h-0 flex-1 space-y-2 px-1 pb-24">
          {shown.slice(0, limit).map((r, i) => (
            <Card key={`${r.target.kind}${r.target.id}`} r={r} i={i} />
          ))}
          {shown.length > limit && (
            <div className="flex justify-center py-3">
              <Button size="sm" onClick={() => setLimit(limit + 150)}>
                Show more ({num(shown.length - limit)} left)
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Card({ r, i }: { r: Recommendation; i: number }) {
  const selection = useApp((s) => s.selection);
  const toggleSelect = useApp((s) => s.toggleSelect);
  const inspect = useApp((s) => s.inspect);
  const inspector = useApp((s) => s.inspector);
  const go = useApp((s) => s.go);
  const isGroup = r.target.kind === "dupGroup";
  const itemKind = r.target.kind === "dir" ? "dir" : "file";
  const selected = !isGroup && selection.has(selKey(itemKind, r.target.id));
  const active = !isGroup && inspector?.kind === itemKind && inspector.id === r.target.id;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(i, 12) * 0.02 }}
      onClick={() => (isGroup ? go("duplicates") : inspect({ kind: itemKind, id: r.target.id }))}
      className={clsx("glass flex cursor-default items-start gap-4 p-4 transition-shadow", active && "shadow-[0_0_0_1.5px_var(--accent-line),var(--shadow)]")}
    >
      <FileIcon category={r.category} size={16} boxed />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{r.title}</span>
          <RiskBadge risk={r.risk} />
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-2">{r.reason}</p>
        <p className="mt-1 text-xs text-fg-3">
          <span className="font-medium text-fg-2">Consider:</span> {r.riskNote}
        </p>
        {r.path && <p className="mt-1.5 truncate font-mono text-2xs text-fg-4">{r.path}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span className="tabular text-base font-semibold">{bytes(r.size)}</span>
        <span className="text-2xs text-fg-4">changed {ago(r.modified)}</span>
        {isGroup ? (
          <Button size="sm" tone="subtle" onClick={(e) => (e.stopPropagation(), go("duplicates"))}>
            Compare copies
          </Button>
        ) : (
          <Button
            size="sm"
            tone={selected ? "subtle" : "default"}
            icon={selected ? <Check size={12} /> : <Plus size={12} />}
            onClick={(e) => {
              e.stopPropagation();
              toggleSelect({ kind: itemKind, id: r.target.id, name: r.name, path: r.path, size: r.size });
            }}
          >
            {selected ? "Selected" : "Select"}
          </Button>
        )}
      </div>
    </motion.div>
  );
}
