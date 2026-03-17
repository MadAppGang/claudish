import type { SelectOption } from "@opentui/core";
/** @jsxImportSource @opentui/react */
import { useCallback, useEffect, useState } from "react";
import { loadConfig, saveConfig } from "../../profile-config.js";
import { C } from "../theme.js";

interface TelemetryPanelProps {
  focused: boolean;
  height: number;
  onEditingChange?: (editing: boolean) => void;
}

export function TelemetryPanel({ focused, height, onEditingChange }: TelemetryPanelProps) {
  const [config, setConfig] = useState(() => loadConfig());
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Unused layout prop for this simple menu, ensures generic UI compatibility
  useEffect(() => onEditingChange?.(false), [onEditingChange]);

  const telemetry = config.telemetry;
  const envDisabled = process.env.CLAUDISH_TELEMETRY === "0" || process.env.CLAUDISH_TELEMETRY === "false";
  const isEnabled = !envDisabled && telemetry?.enabled === true;

  const handleSelect = useCallback((_idx: number, opt: SelectOption | null) => {
    if (!opt?.value) return;
    const cfg = loadConfig();
    
    if (opt.value === "toggle") {
      const next = !isEnabled;
      cfg.telemetry = { ...(cfg.telemetry ?? {}), enabled: next, askedAt: cfg.telemetry?.askedAt ?? new Date().toISOString() };
      saveConfig(cfg);
      setStatusMsg(next ? "✓ Telemetry enabled." : "✓ Telemetry disabled.");
    } else if (opt.value === "reset") {
      if (cfg.telemetry) {
        cfg.telemetry.askedAt = undefined;
        cfg.telemetry.enabled = false;
        saveConfig(cfg);
      }
      setStatusMsg("✓ Consent reset. You will be prompted on the next error.");
    }
    setConfig(loadConfig());
  }, [isEnabled]);

  const toggleText = `[${isEnabled ? "x" : " "}] Expand error reporting pipeline`;

  return (
    <box flexDirection="column" height={height}>
      <select
        options={[
          { name: toggleText, value: "toggle" },
          { name: " [-] Reset Prompts/Consent", value: "reset" }
        ]}
        focused={focused}
        height={3}
        onSelect={handleSelect}
        selectedBackgroundColor={C.bgAlt}
        selectedTextColor={C.cyan}
      />
      <box height={1}><text><span fg={C.border}>{"─".repeat(50)}</span></text></box>
      <box flexDirection="column" paddingX={1} gap={0}>
        <text>
          <span fg={C.dim}>Status: </span>
          {envDisabled ? <span fg={C.yellow}>DISABLED (Env override)</span> 
           : !telemetry ? <span fg={C.dim}>Not configured yet</span>
           : telemetry.enabled ? <span fg={C.green}>ENABLED</span>
           : <span fg={C.yellow}>DISABLED</span>}
        </text>
        <text><span fg={C.dim}>Last Prompt: {telemetry?.askedAt || "Never"}</span></text>
        <text><span fg={C.dim}> </span></text>
        <text><strong><span fg={C.cyan}>Anonymous Payloads ONLY include:</span></strong></text>
        <text><span fg={C.dim}>- Claudish release architecture & platform execution targets</span></text>
        <text><span fg={C.dim}>- Sanitized message failures (No env vars, no paths)</span></text>
        <text><span fg={C.dim}>- Isolated stack execution points</span></text>
        <text><span fg={C.dim}> </span></text>
        <text><span fg={C.dim}>NEVER collected: Auth strings, keys, project paths, prompt body.</span></text>
        {statusMsg && <text><span fg={C.green}>{statusMsg}</span></text>}
      </box>
    </box>
  );
}
