import { FileWarning } from "lucide-react";

export function PreviewError({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <FileWarning size={20} className="text-fg-3" />
      <p className="text-sm text-fg-2">{message}</p>
      {detail && <p className="max-w-xs break-words font-mono text-2xs text-fg-4">{detail}</p>}
    </div>
  );
}
