import "./legacy";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import "./panel.css";
import "./home.css";
import { lazy, type ReactNode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "./Home";
import { API } from "./server";

// A board needs its project (`?p=`): without one, the home page lists projects and boards.
// The board app (and Excalidraw with it) loads only when a board is opened.
const App = lazy(() => import("./App"));
const project = new URLSearchParams(location.search).get("p");
const root = createRoot(document.getElementById("root")!);
const render = (node: ReactNode) => root.render(node);

if (!project) render(<Home />);
else {
  // A link to a project this server does not know (moved folder, other computer) would load forever.
  fetch(`${API}/projects`)
    .then((r) => (r.ok ? (r.json() as Promise<{ id: string }[]>) : null))
    .then((list) => (list ? list.some((p) => p.id === project) : true))
    .catch(() => true)
    .then((known) =>
      render(
        known ? (
          <Suspense fallback={null}>
            <App />
          </Suspense>
        ) : (
          <Home missing={project} />
        ),
      ),
    );
}
