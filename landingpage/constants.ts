import { TerminalLine, Feature, ModelCard } from "./types";

export const HERO_SEQUENCE: TerminalLine[] = [
  // 1. System Boot
  {
    id: "boot-1",
    type: "system",
    content: "claudish --model google/gemini-3-pro-preview",
    delay: 500,
  },

  // 2. Welcome Screen
  {
    id: "welcome",
    type: "welcome",
    content: "Welcome",
    data: {
      user: "Developer",
      model: "google/gemini-3-pro-preview",
      version: "v2.4.0",
    },
    delay: 1500,
  },

  // 3. First Interaction (Context Analysis)
  {
    id: "prompt-1",
    type: "rich-input",
    content: "Refactor the authentication module to use JWT tokens",
    data: {
      model: "google/gemini-3-pro-preview",
      cost: "$0.002",
      context: "12%",
      color: "bg-blue-500", // Google Blueish
    },
    delay: 2800,
  },

  {
    id: "think-1",
    type: "thinking",
    content: "Thinking for 2s (tab to toggle)...",
    delay: 4300,
  },

  {
    id: "tool-1",
    type: "tool",
    content: "code-analysis:detective (Investigate auth structure)",
    data: {
      details: "> Analyzing source code of /auth directory to understand current implementation",
    },
    delay: 5300,
  },

  {
    id: "success-1",
    type: "success",
    content: "✓ Found 12 files to modify",
    delay: 6800,
  },
  {
    id: "success-2",
    type: "success",
    content: "✓ Created auth/jwt.ts",
    delay: 7300,
  },
  {
    id: "info-1",
    type: "info",
    content: "Done in 4.2s — 847 lines changed across 12 files",
    delay: 8300,
  },

  // 4. Second Interaction (Model Switch)
  {
    id: "prompt-2",
    type: "rich-input",
    content: "Switch to Grok and explain this quantum physics algorithm",
    data: {
      model: "x-ai/grok-code-fast-1",
      cost: "$0.142",
      context: "15%",
      color: "bg-white", // Grok
    },
    delay: 10300,
  },

  {
    id: "system-switch",
    type: "info",
    content: "Switching provider to x-ai Grok...",
    delay: 11300,
  },

  {
    id: "think-2",
    type: "thinking",
    content: "Thinking for 1.2s...",
    delay: 12300,
  },
];

export const HIGHLIGHT_FEATURES: Feature[] = [
  {
    id: "CORE_01",
    title: "Think → Superthink",
    description:
      "Enables extended thinking protocols on any supported model. Recursive reasoning chains are preserved and translated.",
    icon: "🧠",
    badge: "UNIVERSAL_COMPAT",
  },
  {
    id: "CORE_02",
    title: "Context Remapping",
    description:
      "Translates model-specific context windows to Claude Code's 200K expectation. Unlocks full 1M+ token windows on Gemini/DeepSeek.",
    icon: "📐",
    badge: "1M_TOKEN_MAX",
  },
  {
    id: "CORE_03",
    title: "Cost Telemetry",
    description:
      "Bypasses default pricing logic. Intercepts token usage statistics to calculate and display exact API spend per session.",
    icon: "💰",
    badge: "REALTIME_AUDIT",
  },
];

export const STANDARD_FEATURES: Feature[] = [
  {
    id: "SYS_01",
    title: "Orchestration Mesh",
    description: "Task splitting and role assignment across heterogeneous model backends.",
    icon: "⚡",
  },
  {
    id: "SYS_02",
    title: "Custom Command Interface",
    description: "Inject custom slash commands into the Claude Code runtime environment.",
    icon: "💻",
  },
  {
    id: "SYS_03",
    title: "Plugin Architecture",
    description: "Load external modules and community extensions without binary modification.",
    icon: "🔌",
  },
  {
    id: "SYS_04",
    title: "Sub-Agent Spawning",
    description: "Deploy specialized sub-agents running cheaper models for parallel tasks.",
    icon: "🤖",
  },
  {
    id: "SYS_05",
    title: "Schema Translation",
    description: "Real-time JSON <-> XML conversion for universal tool calling compatibility.",
    icon: "🔧",
  },
  {
    id: "SYS_06",
    title: "Vision Pipeline",
    description: "Multimodal input processing for screenshots and visual assets.",
    icon: "👁️",
  },
];

// Re-export for compatibility if needed, though we will switch to using the specific lists
export const MARKETING_FEATURES = [...HIGHLIGHT_FEATURES, ...STANDARD_FEATURES];

export const MODEL_CARDS: ModelCard[] = [
  {
    id: "m1",
    name: "google/gemini-3-pro-preview",
    provider: "Google",
    description: "1048K Context. The new standard for long-context reasoning.",
    tags: ["VISION", "TOOLS", "THINKING"],
    color: "bg-blue-500",
  },
  {
    id: "m2",
    name: "openai/gpt-5.1-codex",
    provider: "OpenAI",
    description: "High-fidelity code generation model with thinking enabled.",
    tags: ["CODING", "THINKING", "TOOLS"],
    color: "bg-green-600",
  },
  {
    id: "m3",
    name: "x-ai/grok-code-fast-1",
    provider: "xAI",
    description: "Extremely low latency coding assistant.",
    tags: ["FAST", "THINKING", "TOOLS"],
    color: "bg-white text-black",
  },
  {
    id: "m4",
    name: "minimax/minimax-m2",
    provider: "Minimax",
    description: "Cost-effective reasoning at scale.",
    tags: ["CHEAP", "THINKING", "TOOLS"],
    color: "bg-purple-600",
  },
  {
    id: "m5",
    name: "z-ai/glm-4.6",
    provider: "Z-ai",
    description: "Balanced performance for general tasks.",
    tags: ["BALANCED", "THINKING", "TOOLS"],
    color: "bg-indigo-500",
  },
  {
    id: "m6",
    name: "qwen/qwen3-vl-235b-a22b-ins...",
    provider: "Qwen",
    description: "Open weights vision language model.",
    tags: ["VISION", "TOOLS", "OPEN"],
    color: "bg-blue-400",
  },
];
