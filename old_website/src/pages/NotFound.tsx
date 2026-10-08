import { Link } from "react-router";
import { Home } from "lucide-react";
import { useState } from "react";

const errors = [
  { cmd: "cd /this/page && ls", out: "ls: no such file or directory" },
  { cmd: "docker run this/page", out: "Error response from daemon: page not found" },
  { cmd: "curl -I /this/page", out: "HTTP/1.1 404 Not Found" },
  { cmd: "git checkout this-page", out: "error: pathspec 'this-page' did not match any file" },
  { cmd: "ping this.page", out: "Request timeout for icmp_seq 0" },
];

export function NotFound() {
  const [err] = useState(() => errors[Math.floor(Math.random() * errors.length)]!);
  return (
    <section className="grid-bg min-h-[70vh] grid place-items-center px-4">
      <div className="text-center">
        <div className="font-mono text-7xl md:text-9xl font-bold text-phosphor-dim">404</div>
        <p className="mt-4 font-mono text-sm text-zinc-500">
          $ {err.cmd}
          <br />
          <span className="text-pink-term">{err.out}</span>
        </p>
        <Link
          to="/"
          className="mt-8 inline-flex items-center gap-2 font-mono font-bold border-2 border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void px-6 py-3 hover:-translate-y-0.5 transition-transform"
        >
          <Home size={15} /> cd ~/
        </Link>
      </div>
    </section>
  );
}
