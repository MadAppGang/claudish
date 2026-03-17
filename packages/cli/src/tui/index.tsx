/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.js";

export async function startConfigTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // Core shortcut handler
  });
  createRoot(renderer).render(<App />);
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
  startConfigTui().catch((err) => {
    console.error("TUI error:", err);
    process.exit(1);
  });
}
