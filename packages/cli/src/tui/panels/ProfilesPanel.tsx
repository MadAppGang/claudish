/** @jsxImportSource @opentui/react */
import { listAllProfiles } from "../../profile-config.js";
import { C } from "../theme.js";

interface ProfilesPanelProps {
  focused: boolean;
  height: number;
  width: number;
}

export function ProfilesPanel({ height, width }: ProfilesPanelProps) {
  const profiles = listAllProfiles();

  if (profiles.length === 0) {
    return (
      <box flexDirection="column" height={height} padding={1}>
        <text><span fg={C.dim}>No profiles. Run </span><span fg={C.cyan}>claudish init</span></text>
      </box>
    );
  }

  return (
    <box flexDirection="column" height={height}>
      {/* Header */}
      <box height={1} paddingX={1}>
         <text><span fg={C.dim}>  PROFILE          MAPPINGS (o/s/h/sub)   SCOPE</span></text>
      </box>

      <box flexDirection="column" paddingX={1} gap={0}>
        {profiles.map((p, i) => {
           const isDef = p.isDefault;
           const sName = (isDef ? "★ " : "○ ") + p.name;
           const nPad = sName.padEnd(16).substring(0, 16);
           const pColor = isDef ? C.green : C.fg;
           
           const r = (val?: string) => val ? val.split("/").pop()! : "-";
           const mapStr = `${r(p.models.opus)} | ${r(p.models.sonnet)} | ${r(p.models.haiku)}`;
           const mPad = mapStr.padEnd(22).substring(0, 22);

           return (
             <text key={`${p.scope}-${p.name}-${i}`}>
               <span fg={pColor}>{nPad}</span>
               <span fg={C.dim}> </span>
               <span fg={C.fg}>{mPad}</span>
               <span fg={C.dim}>  [{p.scope}]</span>
               {p.shadowed && <span fg={C.yellow}> (shadowed)</span>}
             </text>
           );
        })}
      </box>
      <box paddingTop={2} paddingX={1}>
        <text><span fg={C.dim}>{`─`.repeat(Math.max(1, width - 2))}</span></text>
        <text><span fg={C.dim}>Read-only view. Manage profiles via standard CLI commands:</span></text>
        <text><span fg={C.dim}>  $ claudish profile add/edit</span></text>
      </box>
    </box>
  );
}
