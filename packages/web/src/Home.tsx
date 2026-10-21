import { useEffect, useState } from "react";
import { LanPair } from "./Lan";
import { API } from "./server";

interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  boards: { name: string; updatedAt: number }[];
}

function ago(at: number) {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} days ago` : new Date(at).toLocaleDateString();
}

const boardUrl = (p: ProjectInfo, board: string) => `/?p=${encodeURIComponent(p.id)}&board=${encodeURIComponent(board)}`;

/** The page without a board: every project this server knows, with its boards. */
export function Home({ missing }: { missing?: string }) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    document.title = "Livingboard";
    fetch(`${API}/projects`)
      .then((r) => (r.ok ? (r.json() as Promise<ProjectInfo[]>) : Promise.reject(new Error(String(r.status)))))
      .then((list) => setProjects(list.sort((a, b) => (b.boards[0]?.updatedAt ?? 0) - (a.boards[0]?.updatedAt ?? 0))))
      .catch(() => setError(true));
  }, []);

  return (
    <main className="home">
      <header className="home-head">
        <h1>✳ Livingboard</h1>
        <p className="muted">The whiteboards of your projects. Claude keeps each one in line with its project.</p>
      </header>

      {missing && (
        <p className="home-empty">
          This server does not know the project <b>{missing.replace(/-[0-9a-f]{6}$/, "")}</b>: open its board from Claude Code in the project folder
          (<code>/whiteboard</code>), or pick one below.
        </p>
      )}

      {error && <p className="home-empty">The Livingboard server does not answer.</p>}

      {projects?.length === 0 && (
        <div className="home-empty">
          <p>No boards yet.</p>
          <p className="muted">
            In Claude Code, inside a project folder, type <code>/whiteboard</code>: the board opens here and is saved in the project.
          </p>
        </div>
      )}

      {projects && projects.length > 0 && (
        <ul className="home-projects">
          {projects.map((p) => (
            <li key={p.id} className="home-project">
              <div className="home-project-head">
                <h2>{p.name}</h2>
                <span className="muted small" title={p.root}>
                  {p.root}
                </span>
              </div>
              {p.boards.length ? (
                <ul className="home-boards">
                  {p.boards.map((b) => (
                    <li key={b.name}>
                      <a href={boardUrl(p, b.name)}>
                        <span className="home-board-name">{b.name}</span>
                        <span className="muted small">{ago(b.updatedAt)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">
                  No boards saved yet. <a href={boardUrl(p, "main")}>Open “main”</a>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="home-lan">
        <h2>Open on another device</h2>
        <LanPair path="/" />
      </section>
    </main>
  );
}
