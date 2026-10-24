import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initBackend } from "./lib/api";
import "./styles/index.css";

// The desktop shell has its own context menu semantics; suppress the
// browser one outside text fields.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});

// Resolve the backend (desktop or labelled demo) before the first render.
void initBackend().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
