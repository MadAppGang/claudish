import type { SelectOption } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
/** @jsxImportSource @opentui/react */
import { useCallback, useEffect, useState } from "react";
import { loadConfig, removeApiKey, removeEndpoint, setApiKey, setEndpoint } from "../../profile-config.js";
import { PROVIDERS, maskKey } from "../providers.js";
import { C } from "../theme.js";

type Mode = "browse" | "action" | "input_key" | "input_endpoint";

interface ApiKeysPanelProps {
  focused: boolean;
  height: number;
  width: number;
  onEditingChange?: (editing: boolean) => void;
}

function pad(str: string, len: number) {
  return str.padEnd(len).substring(0, len);
}

export function ApiKeysPanel({ focused, height, width, onEditingChange }: ApiKeysPanelProps) {
  const [config, setConfig] = useState(() => loadConfig());
  const [mode, setMode] = useState<Mode>("browse");
  const [itemIndex, setItemIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    onEditingChange?.(mode !== "browse");
  }, [mode, onEditingChange]);

  const selectedProvider = PROVIDERS[itemIndex]!;

  const getActionOptions = useCallback(() => {
    const p = selectedProvider;
    const hasCfgKey = !!config.apiKeys?.[p.apiKeyEnvVar];
    const hasCfgEnd = p.endpointEnvVar ? !!config.endpoints?.[p.endpointEnvVar] : false;

    const opts: Array<{ name: string; value: string }> = [
      { name: "Set API Key...", value: "set_key" },
    ];
    if (hasCfgKey) opts.push({ name: "Remove stored API Key", value: "rm_key" });

    if (p.endpointEnvVar) {
      opts.push({ name: "Set Custom Endpoint...", value: "set_end" });
      if (hasCfgEnd) opts.push({ name: "Remove Custom Endpoint", value: "rm_end" });
    }
    opts.push({ name: "Back", value: "back" });
    return opts;
  }, [selectedProvider, config]);

  const handleActionSelect = useCallback((_idx: number, opt: SelectOption | null) => {
    if (!opt?.value) return;
    const { value } = opt;
    setStatusMsg(null);

    if (value === "back") {
      setMode("browse");
    } else if (value === "set_key") {
      setInputValue("");
      setMode("input_key");
    } else if (value === "set_end") {
      setInputValue(selectedProvider.endpointEnvVar ? config.endpoints?.[selectedProvider.endpointEnvVar] || "" : "");
      setMode("input_endpoint");
    } else if (value === "rm_key") {
      removeApiKey(selectedProvider.apiKeyEnvVar);
      setConfig(loadConfig());
      setStatusMsg("✓ Key removed from config.");
      setMode("browse");
    } else if (value === "rm_end" && selectedProvider.endpointEnvVar) {
      removeEndpoint(selectedProvider.endpointEnvVar);
      setConfig(loadConfig());
      setStatusMsg("✓ Endpoint reset.");
      setMode("browse");
    }
  }, [selectedProvider, config]);

  useKeyboard((key) => {
    if (!focused) return;
    if (mode === "input_key" || mode === "input_endpoint") {
      if (key.name === "return" || key.name === "enter") {
        const val = inputValue.trim();
        if (!val) {
          setStatusMsg("✗ Aborted (empty).");
          setMode("browse");
          return;
        }
        if (mode === "input_key") {
          setApiKey(selectedProvider.apiKeyEnvVar, val);
          process.env[selectedProvider.apiKeyEnvVar] = val;
          setStatusMsg(`✓ API Key saved for ${selectedProvider.displayName}.`);
        } else {
          setEndpoint(selectedProvider.endpointEnvVar!, val);
          process.env[selectedProvider.endpointEnvVar!] = val;
          setStatusMsg(`✓ Custom endpoint saved.`);
        }
        setConfig(loadConfig());
        setInputValue("");
        setMode("browse");
      } else if (key.name === "escape") {
        setMode("action");
      }
    } else if (mode === "action" && (key.name === "escape" || key.name === "q")) {
      setMode("browse");
    }
  });

  const listHeight = Math.max(3, height - 8);
  const bottomHeight = height - listHeight - 1;

  // Render highly-dense single line row arrays
  const listOptions = PROVIDERS.map((p) => {
    const hasEnvK = !!process.env[p.apiKeyEnvVar];
    const hasCfgK = !!config.apiKeys?.[p.apiKeyEnvVar];
    const icon = hasEnvK || hasCfgK ? "✓" : "✗";

    const kStr = p.apiKeyEnvVar ? pad(maskKey(hasCfgK ? config.apiKeys![p.apiKeyEnvVar] : process.env[p.apiKeyEnvVar]), 8) : "        ";
    const kSrc = hasEnvK && hasCfgK ? "e+c" : hasEnvK ? "env" : hasCfgK ? "cfg" : "---";

    let eSrc = "   ";
    if (p.endpointEnvVar) {
      const hasEnvE = !!process.env[p.endpointEnvVar];
      const hasCfgE = !!config.endpoints?.[p.endpointEnvVar];
      eSrc = hasEnvE && hasCfgE ? "e+c" : hasEnvE ? "env" : hasCfgE ? "cfg" : "def";
    }

    // Exact string length ensures columns align without jitter
    // Format: "[v] [Provider      ] [key.....] [src] [url]"
    return {
      name: ` ${icon}  ${pad(p.displayName, 14)} ${kStr}   ${pad(kSrc, 3)}   ${pad(eSrc, 3)}`,
      value: p.name,
    };
  });

  // Fetch contextual values for the active sub-pane item
  const envKeyMask = maskKey(process.env[selectedProvider.apiKeyEnvVar]);
  const cfgKeyMask = maskKey(config.apiKeys?.[selectedProvider.apiKeyEnvVar]);
  const activeUrl = config.endpoints?.[selectedProvider.endpointEnvVar!] || process.env[selectedProvider.endpointEnvVar!] || selectedProvider.defaultEndpoint || "None";

  const divider = "─".repeat(Math.max(1, width - 2));

  return (
    <box flexDirection="column" height={height}>
      {/* Table Header */}
      <box height={1} paddingX={1}>
        <text><span fg={C.dim}>    PROVIDER       KEY        SRC   URL</span></text>
      </box>
      
      {/* Main List */}
      <select
        options={listOptions}
        focused={focused && mode === "browse"}
        height={listHeight - 1} // account for header
        selectedIndex={itemIndex}
        onSelect={() => { setMode("action"); setActionIndex(0); setStatusMsg(null); }}
        onChange={(idx) => setItemIndex(idx)}
        selectedBackgroundColor={C.bgAlt}
        selectedTextColor={C.cyan}
      />

      <box height={1}><text><span fg={C.border}>{divider}</span></text></box>

      {/* Sub-pane / Master Detail view */}
      <box flexDirection="column" height={bottomHeight} paddingX={1}>
        {mode === "browse" && (
          <>
            <text>
              <strong><span fg={C.cyan}>{selectedProvider.displayName}</span></strong>
              <span fg={C.dim}>  {selectedProvider.description}</span>
            </text>
            <text>
              <span fg={C.dim}>Keys: </span>
              <span fg={C.fg}>env={envKeyMask} cfg={cfgKeyMask}  </span>
              <span fg={C.dim}>Url: </span><span fg={C.cyan}>{pad(activeUrl, 30)}</span>
              {statusMsg && <span fg={C.green}>  {statusMsg}</span>}
            </text>
          </>
        )}

        {mode === "action" && (
          <>
            <text><strong><span fg={C.yellow}>Configure {selectedProvider.displayName}</span></strong></text>
            <select
              options={getActionOptions()}
              focused={focused && mode === "action"}
              height={bottomHeight - 1}
              selectedIndex={actionIndex}
              onSelect={handleActionSelect}
              onChange={setActionIndex}
              selectedBackgroundColor={C.dim}
              selectedTextColor={C.fg}
            />
          </>
        )}

        {(mode === "input_key" || mode === "input_endpoint") && (
          <box flexDirection="column" gap={1}>
            <text>
               <strong><span fg={C.yellow}>Input {mode === "input_key" ? "API Key" : "Custom Endpoint URL"}</span></strong>
               <span fg={C.dim}> (Enter to save, Esc to cancel)</span>
            </text>
            <box flexDirection="row">
              <text><span fg={C.dim}>&gt; </span></text>
              <input
                value={inputValue}
                onChange={setInputValue}
                focused={true}
                width={width - 5}
                backgroundColor={C.bgAlt}
                textColor={C.fg}
              />
            </box>
          </box>
        )}
      </box>
    </box>
  );
}
