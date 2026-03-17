/** @jsxImportSource @opentui/react */
import { useState } from "react";
import { loadConfig } from "../../profile-config.js";
import { PROVIDERS, maskKey } from "../providers.js";
import { C } from "../theme.js";

interface ConfigViewPanelProps {
  focused: boolean;
  height: number;
}

export function ConfigViewPanel({ focused, height }: ConfigViewPanelProps) {
  const [config] = useState(() => loadConfig());

  // Aggregate keys & endpoints concisely
  const items = PROVIDERS.map(p => {
    const kE = process.env[p.apiKeyEnvVar];
    const kC = config.apiKeys?.[p.apiKeyEnvVar];
    const eE = p.endpointEnvVar ? process.env[p.endpointEnvVar] : undefined;
    const eC = p.endpointEnvVar ? config.endpoints?.[p.endpointEnvVar] : undefined;
    
    if (!kE && !kC && !eE && !eC) return null;
    return {
      name: p.displayName,
      kSrc: kE && kC ? "e+c" : kE ? "env" : kC ? "cfg" : "---",
      eSrc: eE && eC ? "e+c" : eE ? "env" : eC ? "cfg" : "---",
      kVal: kC || kE,
      eVal: eC || eE
    };
  }).filter(Boolean);

  const tState = config.telemetry?.enabled ? "enabled" : "disabled";
  const tColor = config.telemetry?.enabled ? C.green : C.yellow;

  return (
    <scrollbox focused={focused} height={height}>
      <box flexDirection="column" paddingX={1} gap={0}>
        <text><strong><span fg={C.cyan}>System State</span></strong></text>
        <text><span fg={C.dim}>  Default Profile: </span><span fg={C.fg}>{config.defaultProfile}</span></text>
        <text><span fg={C.dim}>  Telemetry:       </span><span fg={tColor}>{tState}</span></text>
        <text><span fg={C.dim}>  Config File:     </span><span fg={C.fg}>~/.claudish/config.json</span></text>
        <text><span fg={C.dim}> </span></text>

        <text><strong><span fg={C.cyan}>Active Configurations (Provider / Endpoints)</span></strong></text>
        {items.length === 0 ? (
          <text><span fg={C.dim}>  No customizations found.</span></text>
        ) : items.map((itm) => (
          <text key={`sys-${itm?.name}`}>
            <span fg={C.fg}>  {itm?.name.padEnd(16)}</span>
            <span fg={C.green}> {maskKey(itm?.kVal)}</span>
            <span fg={C.dim}> ({itm?.kSrc})  </span>
            {itm?.eVal ? (
               <><span fg={C.cyan}>{itm.eVal.length > 20 ? itm.eVal.substring(0,20)+"…" : itm.eVal.padEnd(20)}</span><span fg={C.dim}> ({itm.eSrc})</span></>
            ) : <span fg={C.dim}> default target</span>}
          </text>
        ))}

        <text><span fg={C.dim}> </span></text>
        <text><strong><span fg={C.cyan}>Routing Rules</span></strong></text>
        {(!config.routing || Object.keys(config.routing).length === 0) ? (
          <text><span fg={C.dim}>  No custom routing bound.</span></text>
        ) : Object.entries(config.routing).map(([pat, chain]) => (
          <text key={`rr-${pat}`}>
            <span fg={C.fg}>  {pat.padEnd(16)} </span>
            <span fg={C.yellow}>{chain.join(" -> ")}</span>
          </text>
        ))}
      </box>
    </scrollbox>
  );
}
