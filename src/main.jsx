import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// Demo has no login. The copied MES supervisor page reads sessionStorage
// "mes_token" directly and only lets a user post cycle comments when a token
// is present, so a fixed demo token is set here. The demo server ignores it.
try { sessionStorage.setItem("mes_token", "demo"); sessionStorage.setItem("mes_username", "demo"); } catch {}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
