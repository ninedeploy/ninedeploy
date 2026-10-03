import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";

/** Brutalist code block with a copy button and a filename tab. */
export function CodeBlock({ file, children }: { file?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="panel panel-hard not-prose my-5 overflow-hidden">
      <div className="flex items-center justify-between border-b-2 border-line px-4 py-2">
        <span className="font-mono text-xs text-zinc-500">{file ?? "shell"}</span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard
              ?.writeText(String(children).trim())
              .then(() => setCopied(true))
              .catch(() => {});
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1 font-mono text-xs text-zinc-500 hover:text-phosphor-dim"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-300">
        {children}
      </pre>
    </div>
  );
}
