import type React from "react";
import { useEffect, useRef, useState } from "react";
import { TerminalWindow } from "./TerminalWindow";

export const MultiModelAnimation: React.FC = () => {
  const [stage, setStage] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Intersection Observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Animation Sequence
  useEffect(() => {
    if (!isVisible) return;

    // Sequence timing
    const timeline = [
      { s: 1, delay: 500 }, // Initial connect
      { s: 2, delay: 1000 }, // Opus activates
      { s: 3, delay: 1600 }, // GPT-5 activates
      { s: 4, delay: 2200 }, // Grok activates
      { s: 5, delay: 2800 }, // Minimax activates
      { s: 6, delay: 3500 }, // Processing start
      { s: 7, delay: 4200 }, // Data flow visualization
      { s: 8, delay: 5000 }, // Complete
    ];

    const timeouts: ReturnType<typeof setTimeout>[] = [];
    timeline.forEach((step) => {
      timeouts.push(setTimeout(() => setStage(step.s), step.delay));
    });

    return () => timeouts.forEach(clearTimeout);
  }, [isVisible]);

  return (
    <div ref={containerRef} className="max-w-5xl mx-auto my-24 relative px-4">
      {/* Main Dashboard Container */}
      <div className="bg-[#080808] rounded-lg border border-white/10 overflow-hidden shadow-2xl relative">
        {/* Header Bar */}
        <div className="h-10 border-b border-white/5 bg-[#0c0c0c] flex items-center px-4 justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-white/20"></div>
            <span className="font-mono text-xs text-gray-500 font-bold tracking-widest uppercase">
              Claudish Orchestrator // v2.4.0
            </span>
          </div>
          <div className="font-mono text-[10px] text-gray-600">
            {stage >= 1 ? (
              <span className="text-emerald-500">● ONLINE</span>
            ) : (
              <span>○ OFFLINE</span>
            )}
          </div>
        </div>

        <div className="flex flex-col md:flex-row min-h-[500px]">
          {/* LEFT PANEL: INPUT / TERMINAL */}
          <div className="w-full md:w-7/12 border-r border-white/5 bg-[#0a0a0a] p-6 flex flex-col relative">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-claude-ish/20 to-transparent opacity-50"></div>

            <div className="mb-6">
              <h3 className="font-mono text-xs text-gray-500 uppercase tracking-widest mb-4">
                Input Stream
              </h3>
              <div className="font-mono text-sm text-gray-300 bg-[#050505] p-4 rounded border border-white/5 min-h-[240px] flex flex-col">
                {/* Command Line */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-claude-ish font-bold">➜</span>
                  <span className="text-white font-bold">claudish</span>
                  <span className="text-gray-600">\</span>
                </div>

                {/* Flags */}
                <div className="flex flex-col gap-2 pl-4">
                  <CommandRow
                    visible={stage >= 2}
                    flag="--model-opus"
                    flagColor="text-purple-400"
                    value="google/gemini-3-pro"
                    comment="Complex planning & vision"
                  />
                  <CommandRow
                    visible={stage >= 3}
                    flag="--model-sonnet"
                    flagColor="text-emerald-400"
                    value="openai/gpt-5.1-codex"
                    comment="Main coding logic"
                  />
                  <CommandRow
                    visible={stage >= 4}
                    flag="--model-haiku"
                    flagColor="text-blue-400"
                    value="x-ai/grok-code-fast"
                    comment="Fast context processing"
                  />
                  <CommandRow
                    visible={stage >= 5}
                    flag="--model-subagent"
                    flagColor="text-orange-400"
                    value="minimax/minimax-m2"
                    comment="Background worker agents"
                  />
                </div>

                {/* Success State - Pushed to bottom */}
                <div
                  className={`mt-auto pt-6 space-y-1 transition-opacity duration-500 ${stage >= 6 ? "opacity-100" : "opacity-0"}`}
                >
                  <div className="flex items-center gap-2 text-[#3fb950]">
                    <span>✓</span> Connection established to 4 distinct providers
                  </div>
                  <div className="flex items-center gap-2 text-[#3fb950]">
                    <span>✓</span> Semantic complexity router: <b>Active</b>
                  </div>
                </div>

                {/* Ready State */}
                <div
                  className={`pt-4 transition-all duration-500 flex items-center ${stage >= 6 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}
                >
                  <span className="text-claude-ish font-bold mr-2 text-base">»</span>
                  <span className="text-white font-bold">
                    Ready. Orchestrating multi-model mesh.
                  </span>
                  <span
                    className={`inline-block w-2.5 h-4 bg-claude-ish/50 ml-2 ${stage >= 13 ? "hidden" : "animate-cursor-blink"}`}
                  ></span>
                </div>
              </div>
            </div>

            {/* Connection Diagram (Mobile hidden, Desktop visible) */}
            <div className="flex-1 relative hidden md:block">
              <CircuitryGraphic stage={stage} />
            </div>
          </div>

          {/* RIGHT PANEL: COMPUTE GRID */}
          <div className="w-full md:w-5/12 bg-[#050505] relative">
            {/* Background Grid Pattern */}
            <div
              className="absolute inset-0 opacity-10"
              style={{
                backgroundImage: `radial-gradient(#fff 1px, transparent 1px)`,
                backgroundSize: "20px 20px",
              }}
            ></div>

            <div className="p-6 relative z-10">
              <h3 className="font-mono text-xs text-gray-500 uppercase tracking-widest mb-6 flex justify-between items-center">
                <span>Active Compute Nodes</span>
                <span className="font-normal text-[10px]">AUTO_SCALING: ON</span>
              </h3>

              <div className="space-y-3">
                <ComputeUnit
                  active={stage >= 2}
                  name="GEMINI-3-PRO"
                  role="PLANNER"
                  provider="GOOGLE"
                  color="purple"
                  latency="45ms"
                  icon="◈"
                />
                <ComputeUnit
                  active={stage >= 3}
                  name="GPT-5.1-CODEX"
                  role="GENERATOR"
                  provider="OPENAI"
                  color="emerald"
                  latency="82ms"
                  icon="❖"
                />
                <ComputeUnit
                  active={stage >= 4}
                  name="GROK-FAST"
                  role="ANALYZER"
                  provider="X.AI"
                  color="blue"
                  latency="12ms"
                  icon="⚡"
                />
                <ComputeUnit
                  active={stage >= 5}
                  name="MINIMAX-M2"
                  role="WORKER"
                  provider="MINIMAX"
                  color="orange"
                  latency="110ms"
                  icon="⟁"
                />
              </div>

              {/* Aggregated Output Stats */}
              <div
                className={`mt-8 border-t border-white/10 pt-6 transition-all duration-700 ${stage >= 7 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
              >
                <div className="grid grid-cols-3 gap-4">
                  <StatBox label="TOKENS/SEC" value="840" color="text-white" />
                  <StatBox label="LATENCY" value="112ms" color="text-emerald-400" />
                  <StatBox label="COST" value="$0.004" color="text-gray-400" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Status Line */}
        <div className="border-t border-white/5 bg-[#080808] px-4 py-2 flex items-center justify-between font-mono text-[10px] text-gray-600">
          <div className="flex gap-4">
            <span>CPU: 12%</span>
            <span>MEM: 4.2GB</span>
            <span>NET: 1.2MB/s</span>
          </div>
          <div className="flex items-center gap-2">
            <span>Orchestrator Status:</span>
            <span className={stage >= 8 ? "text-emerald-500" : "text-amber-500"}>
              {stage >= 8 ? "IDLE" : "PROCESSING"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

// Helper: Command Row in Terminal
const CommandRow: React.FC<{
  visible: boolean;
  flag: string;
  flagColor: string;
  value: string;
  comment?: string;
}> = ({ visible, flag, flagColor, value, comment }) => (
  <div
    className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 transition-all duration-300 ${visible ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-4"}`}
  >
    <span className={`${flagColor} font-bold tracking-tight min-w-[140px]`}>{flag}</span>
    <span className="text-gray-200">{value}</span>
    {comment && <span className="text-gray-600 italic text-[11px] md:text-xs"># {comment}</span>}
  </div>
);

// Sub-components

const ComputeUnit: React.FC<{
  active: boolean;
  name: string;
  role: string;
  provider: string;
  color: "purple" | "emerald" | "blue" | "orange";
  latency: string;
  icon: string;
}> = ({ active, name, role, provider, color, latency, icon }) => {
  const colors = {
    purple: "bg-purple-500",
    emerald: "bg-emerald-500",
    blue: "bg-blue-500",
    orange: "bg-orange-500",
  };

  const textColors = {
    purple: "text-purple-400",
    emerald: "text-emerald-400",
    blue: "text-blue-400",
    orange: "text-orange-400",
  };

  const borderColors = {
    purple: "border-purple-500/30",
    emerald: "border-emerald-500/30",
    blue: "border-blue-500/30",
    orange: "border-orange-500/30",
  };

  return (
    <div
      className={`
            relative overflow-hidden transition-all duration-500 group
            bg-[#0c0c0c] border border-white/5 hover:border-white/10
            ${active ? `border-l-2 ${borderColors[color]}` : "opacity-40 grayscale"}
        `}
    >
      {/* Active Indicator Line */}
      <div
        className={`absolute top-0 bottom-0 left-0 w-[2px] ${active ? colors[color] : "bg-transparent"} transition-all duration-500`}
      />

      <div className="p-3 md:p-4 flex items-center justify-between">
        {/* Left: Identity */}
        <div className="flex items-center gap-4">
          <div
            className={`
                        w-8 h-8 md:w-10 md:h-10 rounded flex items-center justify-center
                        bg-white/5 font-bold text-lg
                        ${active ? textColors[color] : "text-gray-600"}
                    `}
          >
            {icon}
          </div>
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className={`font-mono text-sm font-bold ${active ? "text-gray-200" : "text-gray-500"}`}
              >
                {name}
              </span>
              <span
                className={`text-[9px] px-1.5 py-0.5 rounded border border-white/5 bg-white/5 text-gray-400 font-mono hidden md:inline-block`}
              >
                {provider}
              </span>
            </div>
            <div className="text-[10px] font-mono text-gray-500 flex items-center gap-2">
              <span className="tracking-widest uppercase">{role}</span>
              {active && (
                <>
                  <span className="text-gray-700">|</span>
                  <span className={textColors[color]}>CONNECTED</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right: Metrics */}
        <div className="text-right font-mono hidden sm:block">
          <div className={`text-xs ${active ? "text-gray-300" : "text-gray-600"}`}>{latency}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">LATENCY</div>
        </div>
      </div>

      {/* Scanline Effect when active */}
      {active && (
        <div
          className={`absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full animate-[shimmer_2s_infinite] pointer-events-none`}
        />
      )}
    </div>
  );
};

const StatBox: React.FC<{ label: string; value: string; color: string }> = ({
  label,
  value,
  color,
}) => (
  <div className="bg-[#0c0c0c] border border-white/5 p-3 rounded">
    <div className="text-[10px] text-gray-600 font-mono mb-1 tracking-wider">{label}</div>
    <div className={`text-lg md:text-xl font-mono font-bold ${color}`}>{value}</div>
  </div>
);

// CSS Graphic for the lines on the left
const CircuitryGraphic: React.FC<{ stage: number }> = ({ stage }) => {
  // Orthogonal lines path
  // Input (Top Left) -> Split -> Nodes (Right)

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none opacity-40"
      overflow="visible"
    >
      <defs>
        <marker id="dot" markerWidth="4" markerHeight="4" refX="2" refY="2">
          <circle cx="2" cy="2" r="1.5" fill="#666" />
        </marker>
      </defs>

      {/* Main Bus Line */}
      <path d="M 40 40 V 200" className="stroke-gray-700 stroke-[1] fill-none" />

      {/* Dropoffs to nodes */}
      {/* These y-coordinates should align roughly with the ComputeUnits in the right panel */}
      {/* Assuming ComputeUnits are stacked at roughly y=60, 140, 220, 300 relative to this container */}

      {/* to Node 1 */}
      <path
        d="M 40 60 H 400"
        className={`transition-all duration-500 stroke-[1] fill-none ${stage >= 2 ? "stroke-purple-500/50" : "stroke-gray-800"}`}
      />

      {/* to Node 2 */}
      <path
        d="M 40 130 H 400"
        className={`transition-all duration-500 stroke-[1] fill-none ${stage >= 3 ? "stroke-emerald-500/50" : "stroke-gray-800"}`}
      />

      {/* to Node 3 */}
      <path
        d="M 40 200 H 400"
        className={`transition-all duration-500 stroke-[1] fill-none ${stage >= 4 ? "stroke-blue-500/50" : "stroke-gray-800"}`}
      />

      {/* to Node 4 */}
      <path
        d="M 40 270 H 400"
        className={`transition-all duration-500 stroke-[1] fill-none ${stage >= 5 ? "stroke-orange-500/50" : "stroke-gray-800"}`}
      />

      {/* Active Data Packets */}
      {stage >= 2 && (
        <circle r="2" fill="#a855f7">
          <animateMotion path="M 40 60 H 400" dur="1.5s" repeatCount="indefinite" />
        </circle>
      )}

      {stage >= 3 && (
        <circle r="2" fill="#10b981">
          <animateMotion path="M 40 130 H 400" dur="1.2s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
};
