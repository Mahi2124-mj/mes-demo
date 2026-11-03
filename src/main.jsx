import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// Demo has no login. The copied MES supervisor page reads sessionStorage
// "mes_token" directly and only lets a user post cycle comments when a token
// is present, so a fixed demo token is set here. The demo server ignores it.
try { sessionStorage.setItem("mes_token", "demo"); sessionStorage.setItem("mes_username", "demo"); } catch {}

// Open screens pick up a new build by themselves: every 30 s compare the bundle named in the server's
// index.html with the one this page runs, and reload when it changed (not while someone is typing).
const BUNDLE = /\/assets\/index-[\w-]+\.js/;
const running = [...document.scripts].map(s => s.src.match(BUNDLE)?.[0]).find(Boolean);
if (running) {
  const check = async () => {
    try {
      const html = await (await fetch("/", { cache: "no-store" })).text();
      const latest = html.match(BUNDLE)?.[0];
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
      if (latest && latest !== running && !typing) window.location.reload();
    } catch { /* server restarting: try again next time */ }
  };
  setInterval(check, 30000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
