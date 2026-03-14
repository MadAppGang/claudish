import type { Feature, ModelCard, TerminalLine } from "./types";

export const HERO_SEQUENCE: TerminalLine[] = [
  // 1. System Boot
  {
    id: "boot-1",
    type: "system",
    content: "claudish --model g@gemini-2.5-pro",
    delay: 500,
  },

  // 2. Welcome Screen
  {
    id: "welcome",
    type: "welcome",
    content: "Welcome",
    data: {
      user: "Developer",
      model: "g@gemini-2.5-pro",
      version: "v5.9.0",
    },
    delay: 1500,
  },

  // 3. First Interaction (Context Analysis)
  {
    id: "prompt-1",
    type: "rich-input",
    content: "Refactor the authentication module to use JWT tokens",
    data: {
      model: "g@gemini-2.5-pro",
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
      model: "x-ai/grok-3-fast",
      cost: "$0.142",
      context: "15%",
      color: "bg-white", // Grok
    },
    delay: 10300,
  },

  {
    id: "system-switch",
    type: "info",
    content: "Switching provider to xAI Grok...",
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
    name: "g@gemini-2.5-pro",
    provider: "Google",
    description: "1M context. Direct Gemini API with thinking and vision.",
    tags: ["VISION", "TOOLS", "THINKING"],
    color: "bg-blue-500",
  },
  {
    id: "m2",
    name: "oai@gpt-4.1",
    provider: "OpenAI",
    description: "Direct OpenAI API. High-fidelity code generation.",
    tags: ["CODING", "THINKING", "TOOLS"],
    color: "bg-green-600",
  },
  {
    id: "m3",
    name: "x-ai/grok-3-fast",
    provider: "xAI",
    description: "Grok via OpenRouter. Fast reasoning with large context.",
    tags: ["FAST", "THINKING", "TOOLS"],
    color: "bg-gray-100",
  },
  {
    id: "m4",
    name: "kc@kimi-for-coding",
    provider: "Kimi Coding",
    description: "Direct API or OAuth. Specialized for code tasks.",
    tags: ["CODING", "THINKING", "TOOLS"],
    color: "bg-purple-600",
  },
  {
    id: "m5",
    name: "mm@MiniMax-M1",
    provider: "MiniMax",
    description: "Cost-effective Anthropic-compatible reasoning.",
    tags: ["CHEAP", "THINKING", "TOOLS"],
    color: "bg-yellow-600",
  },
  {
    id: "m6",
    name: "glm@GLM-4-Plus",
    provider: "GLM",
    description: "Zhipu direct API. Balanced performance for general tasks.",
    tags: ["BALANCED", "THINKING", "TOOLS"],
    color: "bg-red-500",
  },
  {
    id: "m7",
    name: "v@gemini-2.5-pro",
    provider: "Vertex AI",
    description: "Google Cloud Vertex. Enterprise-grade with OAuth.",
    tags: ["ENTERPRISE", "VISION", "TOOLS"],
    color: "bg-sky-500",
  },
  {
    id: "m8",
    name: "ollama@qwen3-coder:latest",
    provider: "Local",
    description: "100% offline. Your code never leaves your machine.",
    tags: ["LOCAL", "PRIVACY", "FREE"],
    color: "bg-cyan-500",
  },
];
