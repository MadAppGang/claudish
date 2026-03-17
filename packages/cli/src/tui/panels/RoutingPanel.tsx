import type { SelectOption } from "@opentui/core";
/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";
import { loadConfig, saveConfig } from "../../profile-config.js";
import { C } from "../theme.js";

type Mode = "list" | "action" | "add_pattern" | "add_chain";

interface RoutingPanelProps {
  focused: boolean;
  height: number;
  onEditingChange?: (editing: boolean) => void;
}

function pStr(s: string, len: number) {
  return s.padEnd(len).substring(0, len);
}

export function RoutingPanel({ focused, height, onEditingChange }: RoutingPanelProps) {
  const [config, setConfig] = useState(() => loadConfig());
  const [mode, setMode] = useState<Mode>("list");
  const [itemIndex, setItemIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  
  const [patternInput, setPatternInput] = useState("");
  const [chainInput, setChainInput] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => onEditingChange?.(mode !== "list"), [mode, onEditingChange]);

  const rules = config.routing ?? {};
  const ruleEntries = Object.entries(rules);

  const listOptions = [
    { name: " [+] Add new routing rule...", value: "__add__" },
    ...ruleEntries.map(([pat, chain]) => ({
      name: `  ${pStr(pat, 18)} →  ${chain.join(" | ")}`,
      value: pat,
    }))
  ];

  const handleActionSelect = useCallback((_idx: number, opt: SelectOption | null) => {
    if (!opt?.value) return;
    if (opt.value === "back") {
      setMode("list");
    } else if (opt.value === "delete") {
      const tgt = ruleEntries[itemIndex - 1]?.[0];
      if (tgt) {
        delete rules[tgt];
        if (Object.keys(rules).length === 0) config.routing = undefined;
        saveConfig(config);
        setConfig(loadConfig());
        setStatusMsg(`✓ Deleted rule for '${tgt}'`);
      }
      setMode("list");
    } else if (opt.value === "clear") {
      config.routing = undefined;
      saveConfig(config);
      setConfig(loadConfig());
      setStatusMsg("✓ Cleared all custom routing rules");
      setMode("list");
    }
  }, [itemIndex, ruleEntries, rules, config]);

  useKeyboard((key) => {
    if (!focused) return;
    if (mode === "list") {
      // Hotkeys for power users
      if (key.name === "a") {
         setPatternInput(""); setChainInput(""); setMode("add_pattern");
      }
      if ((key.name === "r" || key.name === "delete") && itemIndex > 0) {
         setMode("action");
      }
    } else if (mode === "add_pattern") {
      if (key.name === "return" || key.name === "enter") {
        if (patternInput.trim()) setMode("add_chain");
      } else if (key.name === "escape") {
        setMode("list"); setStatusMsg(null);
      }
    } else if (mode === "add_chain") {
      if (key.name === "return" || key.name === "enter") {
        const pat = patternInput.trim();
        const ch = chainInput.trim().split(",").map(s => s.trim()).filter(Boolean);
        if (pat && ch.length) {
          if (!config.routing) config.routing = {};
          config.routing[pat] = ch;
          saveConfig(config);
          setConfig(loadConfig());
          setStatusMsg(`✓ Rule added for '${pat}'`);
        }
        setMode("list");
      } else if (key.name === "escape") {
        setMode("add_pattern");
      }
    } else if (mode === "action" && key.name === "escape") {
      setMode("list");
    }
  });

  const listHeight = Math.max(3, height - 7);

  return (
    <box flexDirection="column" height={height}>
      <box height={1} paddingX={1}>
         <text><span fg={C.dim}>  PATTERN              PROVIDER CHAIN</span></text>
      </box>

      <select
        options={listOptions}
        focused={focused && mode === "list"}
        height={listHeight - 1}
        selectedIndex={itemIndex}
        onSelect={(idx, opt) => {
           if (opt?.value === "__add__") {
             setPatternInput(""); setChainInput(""); setMode("add_pattern");
           } else {
             setActionIndex(0); setMode("action");
           }
        }}
        onChange={setItemIndex}
        selectedBackgroundColor={C.bgAlt}
        selectedTextColor={C.cyan}
      />
      
      <box height={1}><text><span fg={C.border}>{"─".repeat(50)}</span></text></box>

      <box flexDirection="column" height={7} paddingX={1}>
        {mode === "list" && (
           <>
             <text><strong><span fg={C.yellow}>Routing Behavior</span></strong></text>
             <text><span fg={C.dim}>Map matched model name requests directly to specific provider chains.</span></text>
             <text><span fg={C.dim}>Useful for forcing patterns like 'qwen-*' natively through OpenRouter.</span></text>
             {statusMsg && <text><span fg={C.green}>{statusMsg}</span></text>}
             {!statusMsg && <text><span fg={C.dim}>Hotkeys: [a] add  [r] remove</span></text>}
           </>
        )}

        {mode === "action" && (
           <>
             <text><strong><span fg={C.yellow}>Manage Selected Rule</span></strong></text>
             <select
               options={[
                 { name: "Delete Rule", value: "delete" },
                 { name: "Clear ALL Rules", value: "clear" },
                 { name: "Back", value: "back" }
               ]}
               focused={mode === "action"}
               height={3}
               selectedIndex={actionIndex}
               onSelect={handleActionSelect}
               onChange={setActionIndex}
               selectedBackgroundColor={C.dim}
             />
           </>
        )}

        {mode === "add_pattern" && (
           <box flexDirection="column" gap={1}>
             <text><strong><span fg={C.yellow}>Step 1: Match Pattern</span></strong><span fg={C.dim}> (e.g. 'kimi-*' or 'gpt-4o')</span></text>
             <box flexDirection="row">
               <text><span fg={C.dim}>&gt; </span></text>
               <input value={patternInput} onChange={setPatternInput} focused={true} width={40} backgroundColor={C.bgAlt} />
             </box>
           </box>
        )}

        {mode === "add_chain" && (
           <box flexDirection="column" gap={1}>
             <text><strong><span fg={C.yellow}>Step 2: Provider Chain</span></strong><span fg={C.dim}> (e.g. 'kimi@kimi-k2, openrouter')</span></text>
             <box flexDirection="row">
               <text><span fg={C.dim}>&gt; </span></text>
               <input value={chainInput} onChange={setChainInput} focused={true} width={40} backgroundColor={C.bgAlt} />
             </box>
           </box>
        )}
      </box>
    </box>
  );
}
