import type { SelectOption } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
/** @jsxImportSource @opentui/react */
import { useCallback, useState } from "react";
import { loadConfig } from "../profile-config.js";
import { ApiKeysPanel } from "./panels/ApiKeysPanel.js";
import { ConfigViewPanel } from "./panels/ConfigViewPanel.js";
import { ProfilesPanel } from "./panels/ProfilesPanel.js";
import { ProvidersPanel } from "./panels/ProvidersPanel.js";
import { RoutingPanel } from "./panels/RoutingPanel.js";
import { TelemetryPanel } from "./panels/TelemetryPanel.js";
import { C } from "./theme.js";

const VERSION = "v5.12.0";

type Section = "apikeys" | "profiles" | "routing" | "telemetry" | "config" | "providers";
type Panel = "menu" | "content";

const MENU_ITEMS: Array<{ label: string; section: Section }> = [
  { label: "Providers & API Keys", section: "apikeys" },
  { label: "Profiles", section: "profiles" },
  { label: "Routing", section: "routing" },
  { label: "Telemetry", section: "telemetry" },
  { label: "View Config", section: "config" },
];

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [activePanel, setActivePanel] = useState<Panel>("menu");
  const [activeSection, setActiveSection] = useState<Section>("apikeys");
  const [menuIndex, setMenuIndex] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [config] = useState(() => loadConfig());

  const quit = useCallback(() => renderer.destroy(), [renderer]);

  const handleEditingChange = useCallback((editing: boolean) => {
    setIsEditing(editing);
    if (!editing) setActivePanel("content");
  }, []);

  useKeyboard((key) => {
    if (key.name === "q" && !isEditing) return quit();
    if (key.ctrl && key.name === "c") return quit();

    if (key.name === "tab" && !isEditing) {
      setActivePanel((p) => (p === "menu" ? "content" : "menu"));
    }
  });

  const handleMenuSelect = useCallback((_idx: number, opt: SelectOption | null) => {
    if (opt?.value) {
      setActiveSection(opt.value as Section);
      setActivePanel("content");
    }
  }, []);

  if (height < 15 || width < 60) {
    return (
      <box width="100%" height="100%" padding={1} backgroundColor={C.bg}>
        <text>
          <span fg={C.red}>Terminal too small ({width}x{height}). Resize to at least 60x15.</span>
        </text>
      </box>
    );
  }

  const menuWidth = 26;
  const contentWidth = width - menuWidth;
  const mainHeight = height - 2; // header + footer

  const menuOptions = MENU_ITEMS.map((item, idx) => ({
    name: (idx === menuIndex ? "  " : "  ") + item.label,
    value: item.section,
  }));

  const activeTitle = MENU_ITEMS.find((m) => m.section === activeSection)?.label ?? "Config";

  // Build header gap
  const titleText = " Claudish Configuration ";
  const rightText = ` ${VERSION} | profile: ${config.defaultProfile || "default"} `;
  const innerWidth = width - 4;
  const gap = Math.max(1, innerWidth - titleText.length - rightText.length);
  const headerPad = " ".repeat(gap);

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.bg}>
      {/* Dense Header */}
      <box height={1} flexDirection="row" paddingX={2} backgroundColor={C.bgAlt}>
        <text>
          <strong><span fg={C.cyan}>{titleText}</span></strong>
          <span fg={C.bgAlt}>{headerPad}</span>
          <span fg={C.dim}>{rightText}</span>
        </text>
      </box>

      {/* Main Row */}
      <box flexDirection="row" height={mainHeight}>
        {/* Navigation Sidebar */}
        <box
          border borderStyle="single" borderColor={activePanel === "menu" ? C.focusBorder : C.border}
          title=" Navigation "
          width={menuWidth}
          height={mainHeight}
          flexDirection="column"
          backgroundColor={C.bg}
        >
          <select
            options={menuOptions}
            focused={activePanel === "menu"}
            height={mainHeight - 2}
            selectedIndex={menuIndex}
            onSelect={handleMenuSelect}
            onChange={(idx) => {
              setMenuIndex(idx);
              const section = MENU_ITEMS[idx]?.section;
              if (section) setActiveSection(section);
            }}
            selectedBackgroundColor={C.bgAlt}
            selectedTextColor={C.cyan}
          />
        </box>

        {/* Content Pane */}
        <box
          border borderStyle="single" borderColor={activePanel === "content" ? C.focusBorder : C.border}
          title={` ${activeTitle} `}
          width={contentWidth}
          height={mainHeight}
          backgroundColor={C.bg}
        >
          <ContentPanel
            section={activeSection}
            focused={activePanel === "content"}
            height={mainHeight - 2}
            width={contentWidth - 2}
            onEditingChange={handleEditingChange}
          />
        </box>
      </box>

      {/* Footer Hints */}
      <box height={1} flexDirection="row" alignItems="center" paddingX={2}>
        <text>
          <span fg={C.cyan}>Tab</span>
          <span fg={C.dim}> switch  │  </span>
          <span fg={C.cyan}>↑↓</span>
          <span fg={C.dim}> browse  │  </span>
          <span fg={C.cyan}>Enter</span>
          <span fg={C.dim}> configure/select  │  </span>
          <span fg={C.cyan}>Esc/q</span>
          <span fg={C.dim}> back/quit</span>
        </text>
      </box>
    </box>
  );
}

interface ContentPanelProps {
  section: Section;
  focused: boolean;
  height: number;
  width: number;
  onEditingChange: (editing: boolean) => void;
}

function ContentPanel({ section, focused, height, width, onEditingChange }: ContentPanelProps) {
  switch (section) {
    case "apikeys":
      return <ApiKeysPanel focused={focused} height={height} width={width} onEditingChange={onEditingChange} />;
    case "providers":
      return <ProvidersPanel />;
    case "profiles":
      return <ProfilesPanel focused={focused} height={height} width={width} />;
    case "routing":
      return <RoutingPanel focused={focused} height={height} onEditingChange={onEditingChange} />;
    case "telemetry":
      return <TelemetryPanel focused={focused} height={height} onEditingChange={onEditingChange} />;
    case "config":
      return <ConfigViewPanel focused={focused} height={height} />;
    default:
      return null;
  }
}
