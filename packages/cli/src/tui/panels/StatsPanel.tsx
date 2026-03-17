/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import { loadConfig, saveConfig } from "../../profile-config.js";
import { getBufferStats, clearBuffer } from "../../stats-buffer.js";
import { C } from "../theme.js";

interface StatsPanelProps {
  height: number;
  width: number;
}

function setStatsEnabled(enabled: boolean): void {
  const cfg = loadConfig();
  if (!cfg.stats) cfg.stats = { enabled: false };
  cfg.stats.enabled = enabled;
  if (enabled && !cfg.stats.enabledAt) {
    cfg.stats.enabledAt = new Date().toISOString();
  }
  saveConfig(cfg);
}

function resetStatsConsent(): void {
  const cfg = loadConfig();
  cfg.stats = { enabled: false };
  saveConfig(cfg);
  clearBuffer();
}

export function StatsPanel({ height, width }: StatsPanelProps) {
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [config, setConfig] = useState(() => loadConfig());
  const [bufStats, setBufStats] = useState(() => getBufferStats());

  const refreshConfig = useCallback(() => {
    setConfig(loadConfig());
    setBufStats(getBufferStats());
  }, []);

  const stats = config.stats;
  const envOverride = process.env.CLAUDISH_STATS;
  const envDisabled = envOverride === "0" || envOverride === "false" || envOverride === "off";
  const isEnabled = !envDisabled && stats?.enabled === true;

  useKeyboard((key) => {
    if (key.name === "e") {
      setStatsEnabled(true);
      refreshConfig();
      setStatusMsg("Usage stats enabled");
    } else if (key.name === "d") {
      setStatsEnabled(false);
      refreshConfig();
      setStatusMsg("Usage stats disabled");
    } else if (key.name === "c") {
      clearBuffer();
      refreshConfig();
      setStatusMsg("Buffer cleared");
    } else if (key.name === "r") {
      resetStatsConsent();
      refreshConfig();
      setStatusMsg("Consent reset — banner will show on next run");
    }
  });

  const statusColor = envDisabled ? C.yellow : isEnabled ? C.green : C.dim;
  const statusText = envDisabled ? "DISABLED (env override)" : isEnabled ? "ENABLED" : "DISABLED";

  const kb = (bufStats.bytes / 1024).toFixed(1);
  const lastSent = stats?.lastSentAt ? stats.lastSentAt.slice(0, 19).replace("T", " ") : "never";

  return (
    <box flexDirection="column" height={height} padding={1}>
      <box height={1} flexDirection="row">
        <text>
          <span fg={C.dim}>Status: </span>
          <span fg={statusColor}>{statusText}</span>
        </text>
      </box>

      {stats?.enabledAt && (
        <box height={1}>
          <text>
            <span fg={C.dim}>Configured: {stats.enabledAt.slice(0, 10)}</span>
          </text>
        </box>
      )}

      <box height={1}>
        <text>
          <span fg={C.dim}>Buffer: </span>
          <span fg={C.fg}>{bufStats.events} events</span>
          <span fg={C.dim}> ({kb} KB)</span>
        </text>
      </box>

      <box height={1}>
        <text>
          <span fg={C.dim}>Last sent: </span>
          <span fg={C.fg}>{lastSent}</span>
        </text>
      </box>

      <box height={1} flexDirection="row" paddingTop={1}>
        <text>
          <span fg={C.border}>{"─".repeat(width - 2)}</span>
        </text>
      </box>

      <box flexDirection="column" paddingTop={1}>
        <text>
          <span fg={C.dim}>When enabled, collects:</span>
        </text>
        <text>
          <span fg={C.dim}> • Model ID, provider, latency, HTTP status</span>
        </text>
        <text>
          <span fg={C.dim}> • Token counts, estimated cost, stream format</span>
        </text>
        <text>
          <span fg={C.dim}> • Adapter/middleware names, fallback info</span>
        </text>
        <text>
          <span fg={C.dim}> • Platform, arch, timezone, runtime, version</span>
        </text>
      </box>

      <box flexDirection="column" paddingTop={1}>
        <text>
          <span fg={C.dim}>Never collected: prompts, responses, API keys, file paths</span>
        </text>
      </box>

      <box height={1} flexDirection="row" paddingTop={2}>
        <text>
          <span fg={C.blue}>e</span>
          <span fg={C.dim}> enable │ </span>
          <span fg={C.blue}>d</span>
          <span fg={C.dim}> disable │ </span>
          <span fg={C.blue}>c</span>
          <span fg={C.dim}> clear buffer │ </span>
          <span fg={C.blue}>r</span>
          <span fg={C.dim}> reset consent</span>
        </text>
      </box>

      {statusMsg && (
        <box paddingTop={1}>
          <text>
            <span fg={C.green}>{statusMsg}</span>
          </text>
        </box>
      )}
    </box>
  );
}
