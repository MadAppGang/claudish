import React, { useState, useEffect, useRef } from "react";
import { TerminalWindow } from "./TerminalWindow";
import { TypingAnimation } from "./TypingAnimation";

export const SmartRouting: React.FC = () => {
  const [activePath, setActivePath] = useState<0 | 1 | 2>(1);

  // Animation state for the bottom terminal
  const [actionStep, setActionStep] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Loop for the diagram animation
  useEffect(() => {
    const interval = setInterval(() => {
      setActivePath((prev) => ((prev + 1) % 3) as 0 | 1 | 2);
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  // Loop for the terminal sequence
  useEffect(() => {
    const timeline = [
      { step: 1, delay: 1000 }, // Start typing cmd 1
      { step: 2, delay: 3500 }, // Show output 1
      { step: 3, delay: 6500 }, // Start typing cmd 2 (Free)
      { step: 4, delay: 9000 }, // Show output 2
      { step: 5, delay: 12000 }, // Start typing cmd 3
      { step: 6, delay: 14000 }, // Show output 3
      { step: 7, delay: 17000 }, // Start typing cmd 4
      { step: 8, delay: 20000 }, // Show output 4
      { step: 9, delay: 24000 }, // Pause before reset
    ];

    let timeouts: ReturnType<typeof setTimeout>[] = [];

    const runSequence = () => {
      setActionStep(0);
      let cumDelay = 0;
      timeline.forEach(({ step, delay }) => {
        timeouts.push(setTimeout(() => setActionStep(step), delay));
        cumDelay = Math.max(cumDelay, delay);
      });
      // Reset loop
      timeouts.push(setTimeout(runSequence, cumDelay + 1000));
    };

    runSequence();
    return () => timeouts.forEach(clearTimeout);
  }, []);

  // Auto-scroll effect
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [actionStep]);

  const getPathColor = (pathIndex: number) => {
    if (pathIndex === 0) return "#d97757"; // Native (Orange)
    if (pathIndex === 1) return "#3fb950"; // Free (Green)
    return "#8b5cf6"; // Premium (Purple)
  };

  return (
    <div className="w-full relative">
      {/* Background Grid Texture */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none -z-10"></div>

      {/* Section Header */}
      <div className="text-center mb-24 relative z-10">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#1a1a1a] border border-gray-800 text-[11px] font-mono text-gray-400 uppercase tracking-widest mb-6 shadow-xl">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-claude-ish opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-claude-ish"></span>
          </span>
          Dynamic Route Resolution
        </div>
        <h2 className="text-4xl md:text-6xl font-sans font-bold text-white mb-6 tracking-tight">
          Free to Start.{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-claude-ish to-blue-500">
            Native When You Need It.
          </span>
        </h2>
        <p className="text-lg text-gray-400 font-mono max-w-2xl mx-auto leading-relaxed">
          Claudish intelligently routes your prompts based on the model you select.
          <br />
          <span className="text-white">Zero config. Zero friction.</span>
        </p>
      </div>

      {/* DIAGRAM CONTAINER */}
      <div className="relative max-w-7xl mx-auto px-4 min-h-[600px]">
        {/* SVG CIRCUIT LAYER (Absolute) */}
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none overflow-visible hidden md:block">
          <svg className="w-full h-full" viewBox="0 0 1200 600" preserveAspectRatio="none">
            <defs>
              <filter id="glow-trace" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Connection Lines */}
            {/* Center Start Point: 600, 120 (Bottom of Router) */}

            {/* Path 0: Left (Native) */}
            <path
              d="M 600 120 L 600 180 L 200 180 L 200 240"
              fill="none"
              stroke={activePath === 0 ? getPathColor(0) : "#333"}
              strokeWidth={activePath === 0 ? 4 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              filter={activePath === 0 ? "url(#glow-trace)" : ""}
              className="transition-all duration-500"
            />

            {/* Path 1: Center (Free) */}
            <path
              d="M 600 120 L 600 240"
              fill="none"
              stroke={activePath === 1 ? getPathColor(1) : "#333"}
              strokeWidth={activePath === 1 ? 4 : 2}
              strokeLinecap="round"
              filter={activePath === 1 ? "url(#glow-trace)" : ""}
              className="transition-all duration-500"
            />

            {/* Path 2: Right (Premium) */}
            <path
              d="M 600 120 L 600 180 L 1000 180 L 1000 240"
              fill="none"
              stroke={activePath === 2 ? getPathColor(2) : "#333"}
              strokeWidth={activePath === 2 ? 4 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              filter={activePath === 2 ? "url(#glow-trace)" : ""}
              className="transition-all duration-500"
            />

            {/* Moving Packets */}
            {activePath === 0 && (
              <circle r="6" fill="white" filter="url(#glow-trace)">
                <animateMotion
                  dur="0.8s"
                  repeatCount="indefinite"
                  path="M 600 120 L 600 180 L 200 180 L 200 240"
                  keyPoints="0;1"
                  keyTimes="0;1"
                  calcMode="linear"
                />
              </circle>
            )}
            {activePath === 1 && (
              <circle r="6" fill="white" filter="url(#glow-trace)">
                <animateMotion
                  dur="0.8s"
                  repeatCount="indefinite"
                  path="M 600 120 L 600 240"
                  keyPoints="0;1"
                  keyTimes="0;1"
                  calcMode="linear"
                />
              </circle>
            )}
            {activePath === 2 && (
              <circle r="6" fill="white" filter="url(#glow-trace)">
                <animateMotion
                  dur="0.8s"
                  repeatCount="indefinite"
                  path="M 600 120 L 600 180 L 1000 180 L 1000 240"
                  keyPoints="0;1"
                  keyTimes="0;1"
                  calcMode="linear"
                />
              </circle>
            )}
          </svg>
        </div>

        {/* --- TOP: ROUTER NODE --- */}
        <div className="relative z-20 flex justify-center mb-24 md:mb-32">
          <div className="relative group">
            {/* Glow effect */}
            <div className="absolute inset-0 bg-claude-ish/20 blur-xl rounded-lg group-hover:bg-claude-ish/30 transition-all"></div>

            <div className="bg-[#0f0f0f] border-2 border-gray-700 w-[320px] rounded-lg p-1 relative shadow-2xl">
              {/* Port labels */}
              <div className="absolute -left-2 top-4 w-1 h-3 bg-gray-600 rounded-l"></div>
              <div className="absolute -right-2 top-4 w-1 h-3 bg-gray-600 rounded-r"></div>

              <div className="bg-[#050505] rounded border border-gray-800 p-4 relative overflow-hidden">
                <div className="flex justify-between items-center mb-3 border-b border-gray-800 pb-2">
                  <span className="text-white font-bold font-mono tracking-tight">
                    CLAUDISH_ROUTER
                  </span>
                  <div className="flex gap-1">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                    <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
                  </div>
                </div>

                {/* Dynamic Terminal Text */}
                <div className="font-mono text-xs space-y-2 min-h-[40px]">
                  <div className="text-gray-500">$ claudish routing-table --watch</div>
                  <div className="text-claude-ish truncate">
                    {activePath === 0 && ">> DETECTED: opus-4.5 (NATIVE)"}
                    {activePath === 1 && ">> DETECTED: grok-free (OPENROUTER)"}
                    {activePath === 2 && ">> DETECTED: gpt-5.1 (PREMIUM)"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* --- BOTTOM: 3 DESTINATIONS --- */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative z-20">
          {/* 1. NATIVE CARD */}
          <div
            className={`
                        flex flex-col bg-[#0a0a0a] rounded-xl overflow-hidden border-2 transition-all duration-500 ease-out
                        ${
                          activePath === 0
                            ? "border-[#d97757] shadow-[0_0_50px_-12px_rgba(217,119,87,0.5)] translate-y-0 scale-[1.02]"
                            : "border-gray-800 opacity-60 translate-y-4 hover:opacity-80"
                        }
                    `}
          >
            <div className="bg-[#d97757] p-1"></div> {/* Colored Top Bar */}
            <div className="p-6 flex-1 flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h3
                  className={`text-xl font-bold font-sans ${activePath === 0 ? "text-white" : "text-gray-400"}`}
                >
                  Your Subscription
                </h3>
                <div className="text-[10px] font-bold bg-[#d97757]/20 text-[#d97757] px-2 py-1 rounded border border-[#d97757]/30">
                  NATIVE
                </div>
              </div>

              <div className="text-sm font-mono text-gray-400 mb-6 flex-1">
                <p className="mb-4 text-gray-500">
                  Direct passthrough to Anthropic's API. Uses your existing credits or Pro plan.
                </p>
                <ul className="space-y-2">
                  <li className="flex items-center gap-2 text-white">
                    <span className="text-[#d97757]">✓</span> opus-4.5
                  </li>
                  <li className="flex items-center gap-2 text-white">
                    <span className="text-[#d97757]">✓</span> sonnet-4.5
                  </li>
                  <li className="flex items-center gap-2 text-white">
                    <span className="text-[#d97757]">✓</span> haiku-4.5
                  </li>
                </ul>
              </div>

              <div className="mt-auto pt-4 border-t border-gray-800 text-xs text-gray-500 font-mono">
                0% MARKUP • DIRECT API
              </div>
            </div>
          </div>

          {/* 2. FREE CARD (Updated) */}
          <div
            className={`
                        flex flex-col bg-[#0a0a0a] rounded-xl overflow-hidden border-2 transition-all duration-500 ease-out
                        ${
                          activePath === 1
                            ? "border-[#3fb950] shadow-[0_0_50px_-12px_rgba(63,185,80,0.5)] translate-y-0 scale-[1.02]"
                            : "border-gray-800 opacity-60 translate-y-4 hover:opacity-80"
                        }
                    `}
          >
            <div className="bg-[#3fb950] p-1"></div>
            <div className="p-6 flex-1 flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h3
                  className={`text-xl font-bold font-sans ${activePath === 1 ? "text-white" : "text-gray-400"}`}
                >
                  Top Models. Always Free.
                </h3>
                <div className="text-[10px] font-bold bg-[#3fb950]/20 text-[#3fb950] px-2 py-1 rounded border border-[#3fb950]/30">
                  OPENROUTER FREE TIER
                </div>
              </div>

              <div className="text-sm font-mono text-gray-400 mb-6 flex-1">
                <p className="mb-4 text-gray-500 leading-relaxed">
                  OpenRouter consistently offers high-quality models at no cost. Not trials. Not
                  limited versions. Real models from Google, xAI, DeepSeek, Meta, Microsoft, and
                  more.
                </p>
                <ul className="space-y-2">
                  <li className="flex items-center gap-2 text-white">
                    <span className="text-[#3fb950]">✓</span> x-ai/grok-4.1-fast:free
                  </li>
                  <li className="flex items-center gap-2 text-white">
                    <span className="text-[#3fb950]">✓</span> gemini-2.0-flash
                  </li>
                  <li className="flex items-center gap-2 text-white">
                    <span className="text-[#3fb950]">✓</span> deepseek-r1
                  </li>
                </ul>
              </div>

              <div className="mt-auto pt-4 border-t border-gray-800 text-xs text-gray-500 font-mono">
                Google · xAI · DeepSeek · Meta · Microsoft
              </div>
            </div>
          </div>

          {/* 3. PREMIUM CARD */}
          <div
            className={`
                        flex flex-col bg-[#0a0a0a] rounded-xl overflow-hidden border-2 transition-all duration-500 ease-out
                        ${
                          activePath === 2
                            ? "border-[#8b5cf6] shadow-[0_0_50px_-12px_rgba(139,92,246,0.5)] translate-y-0 scale-[1.02]"
                            : "border-gray-800 opacity-60 translate-y-4 hover:opacity-80"
                        }
                    `}
          >
            <div className="bg-[#8b5cf6] p-1"></div>
            <div className="p-6 flex-1 flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h3
                  className={`text-xl font-bold font-sans ${activePath === 2 ? "text-white" : "text-gray-400"}`}
                >
                  Pay As You Go
                </h3>
                <div className="text-[10px] font-bold bg-[#8b5cf6]/20 text-[#8b5cf6] px-2 py-1 rounded border border-[#8b5cf6]/30">
                  PREMIUM
                </div>
              </div>

              <div className="text-sm font-mono text-gray-400 mb-6 flex-1">
                <p className="mb-4 text-gray-500">
                  Use top-tier reasoning models from other providers. Paid per token.
                </p>
                <ul className="space-y-2">
                  <li className="flex items-center gap-2 text-white">
                    <span className="text-[#8b5cf6]">✓</span> gpt-5.1
                  </li>
                  <li className="flex items-center gap-2 text-white">
                    <span className="text-[#8b5cf6]">✓</span> gemini-3-pro
                  </li>
                  <li className="flex items-center gap-2 text-white">
                    <span className="text-[#8b5cf6]">✓</span> deepseek-v3.1
                  </li>
                </ul>
              </div>

              <div className="mt-auto pt-4 border-t border-gray-800 text-xs text-gray-500 font-mono">
                PAY PER TOKEN • PREPAID
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* TERMINAL EXAMPLE - SEE IT IN ACTION */}
      <div className="mt-32 max-w-4xl mx-auto px-4">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-white mb-2">See It In Action</h2>
          <p className="text-gray-500 font-mono text-sm">Real-time CLI routing behavior</p>
        </div>

        <TerminalWindow
          title="claudish routing"
          className="bg-[#050505] shadow-[0_0_60px_-15px_rgba(0,0,0,0.8)] border-gray-800 rounded-lg h-[500px]"
          noPadding={true}
        >
          <div
            ref={scrollRef}
            className="p-6 font-mono text-sm leading-relaxed overflow-y-auto h-full scrollbar-hide scroll-smooth"
          >
            {/* 1. NATIVE SCENARIO */}
            <div
              className={`transition-opacity duration-500 ${actionStep >= 1 ? "opacity-100" : "opacity-0 hidden"}`}
            >
              <div className="text-gray-500 mb-1">
                # Use your Claude Max subscription (native passthrough)
              </div>
              <div className="flex gap-2 text-white mb-4">
                <span className="text-claude-ish">$</span>
                <TypingAnimation
                  text="claudish --model anthropic/claude-sonnet-4.5"
                  speed={20}
                  className="font-semibold"
                />
              </div>
            </div>

            <div
              className={`transition-all duration-500 mb-8 border-b border-gray-800/50 pb-8 ${actionStep >= 2 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 hidden"}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-gray-400">Routing:</span>
                <span className="text-white">Native Anthropic API</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-gray-400">Subscription:</span>
                <span className="text-[#d97757]">Claude Max detected</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-gray-400">Context:</span>
                <span className="text-white">1,000K available</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-white font-bold">Ready</span>
              </div>
            </div>

            {/* 2. FREE SCENARIO (Updated) */}
            <div
              className={`transition-opacity duration-500 ${actionStep >= 3 ? "opacity-100" : "opacity-0 hidden"}`}
            >
              <div className="text-gray-500 mb-1">
                # OpenRouter's free tier — real top models, always available
              </div>
              <div className="flex gap-2 text-white mb-4">
                <span className="text-claude-ish">$</span>
                <TypingAnimation text="claudish --free" speed={20} className="font-semibold" />
              </div>
            </div>

            <div
              className={`transition-all duration-500 mb-8 border-b border-gray-800/50 pb-8 ${actionStep >= 4 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 hidden"}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-white">15 curated free models from trusted providers</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-white">Grok 4.1 Fast — 2M context</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-white">Gemini 2.0 Flash — 1M context</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-white">DeepSeek R1 — 164K context</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-white">Llama 3.3 70B — 131K context</span>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-gray-400">
                  These aren't trials. They're real models. Pick one and start coding.
                </span>
              </div>
            </div>

            {/* 3. PREMIUM SCENARIO */}
            <div
              className={`transition-opacity duration-500 ${actionStep >= 5 ? "opacity-100" : "opacity-0 hidden"}`}
            >
              <div className="text-gray-500 mb-1"># Use premium models (pay per token)</div>
              <div className="flex gap-2 text-white mb-4">
                <span className="text-claude-ish">$</span>
                <TypingAnimation
                  text="claudish --model openai/gpt-5.1"
                  speed={20}
                  className="font-semibold"
                />
              </div>
            </div>

            <div
              className={`transition-all duration-500 mb-8 border-b border-gray-800/50 pb-8 ${actionStep >= 6 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 hidden"}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-gray-400">Routing:</span>
                <span className="text-white">OpenRouter</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-gray-400">Cost:</span>
                <span className="text-white">$5.63 / 1M tokens</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-gray-400">Context:</span>
                <span className="text-white">400K available</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-white font-bold">Ready</span>
              </div>
            </div>

            {/* 4. MIXED SCENARIO */}
            <div
              className={`transition-opacity duration-500 ${actionStep >= 7 ? "opacity-100" : "opacity-0 hidden"}`}
            >
              <div className="text-gray-500 mb-1"># Mix models for cost optimization</div>
              <div className="flex gap-2 text-white">
                <span className="text-claude-ish">$</span>
                <div className="flex flex-col">
                  <div>claudish \</div>
                  <div className="pl-4">
                    --model-opus anthropic/claude-opus-4.5 \{" "}
                    <span className="text-gray-600"># Native Claude</span>
                  </div>
                  <div className="pl-4">
                    --model-sonnet x-ai/grok-4 \ <span className="text-gray-600"># Premium</span>
                  </div>
                  <div className="pl-4 mb-4">
                    --model-haiku x-ai/grok-4.1-fast:free{" "}
                    <span className="text-gray-600"># Free</span>
                  </div>
                </div>
              </div>
            </div>

            <div
              className={`transition-all duration-500 pb-2 ${actionStep >= 8 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 hidden"}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-gray-400">Opus:</span>
                <span className="text-[#d97757]">Native Anthropic (subscription)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-gray-400">Sonnet:</span>
                <span className="text-white">OpenRouter ($9.00/1M)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-gray-400">Haiku:</span>
                <span className="text-[#3fb950]">OpenRouter (free!)</span>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[#3fb950]">✓</span>
                <span className="text-white font-bold">Ready — 3 models collaborating</span>
              </div>
            </div>

            {/* Cursor at bottom */}
            <div
              className={`flex items-center mt-2 ${actionStep >= 8 ? "opacity-100" : "opacity-0"}`}
            >
              <span className="text-claude-ish mr-2">$</span>
              <div className="w-2.5 h-4 bg-gray-500/50 animate-cursor-blink"></div>
            </div>
          </div>
        </TerminalWindow>
      </div>
    </div>
  );
};
