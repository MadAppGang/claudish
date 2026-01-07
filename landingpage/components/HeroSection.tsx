import React, { useState, useRef, useEffect } from "react";
import { TerminalWindow } from "./TerminalWindow";
import { HERO_SEQUENCE } from "../constants";
import { TypingAnimation } from "./TypingAnimation";
import { BlockLogo } from "./BlockLogo";

// Text-based Ghost Logo from CLI
const AsciiGhost = () => {
  return (
    <pre
      className="text-[#d97757] font-bold select-none"
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "18px",
        lineHeight: 0.95,
      }}
    >
      {` ▐▛███▜▌
▝▜█████▛▘
  ▘▘ ▝▝`}
    </pre>
  );
};

const HeroSection: React.FC = () => {
  const [rotation, setRotation] = useState({ x: 0, y: 0 });
  const [visibleLines, setVisibleLines] = useState<number>(0);

  // State for status bar
  const [status, setStatus] = useState({
    model: "google/gemini-3-pro-preview",
    cost: "$0.000",
    context: "0%",
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mouse movement for 3D effect
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Calculate percentage from center (-1 to 1)
    const xPct = (x / rect.width - 0.5) * 2;
    const yPct = (y / rect.height - 0.5) * 2;

    // Limit rotation to 15 degrees
    setRotation({
      x: yPct * -8,
      y: xPct * 8,
    });
  };

  const handleMouseLeave = () => {
    setRotation({ x: 0, y: 0 });
  };

  // Sequence Controller
  useEffect(() => {
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    const runSequence = () => {
      setVisibleLines(0);
      let cumulativeDelay = 0;

      HERO_SEQUENCE.forEach((line, index) => {
        const t = setTimeout(() => {
          setVisibleLines((prev) => Math.max(prev, index + 1));
        }, line.delay);
        timeouts.push(t);

        if (line.delay && line.delay > cumulativeDelay) {
          cumulativeDelay = line.delay;
        }
      });

      const restart = setTimeout(() => {
        runSequence();
      }, cumulativeDelay + 4000);
      timeouts.push(restart);
    };

    runSequence();

    return () => timeouts.forEach(clearTimeout);
  }, []);

  // Update Status Bar based on visible lines
  useEffect(() => {
    let newStatus = { ...status };
    let hasUpdates = false;

    // Scan visible lines to find the latest state
    for (let i = 0; i < visibleLines && i < HERO_SEQUENCE.length; i++) {
      const line = HERO_SEQUENCE[i];
      if (line.data) {
        if (line.data.model) {
          newStatus.model = line.data.model;
          hasUpdates = true;
        }
        if (line.data.cost) {
          newStatus.cost = line.data.cost;
          hasUpdates = true;
        }
        if (line.data.context) {
          newStatus.context = line.data.context;
          hasUpdates = true;
        }
      }
    }

    if (hasUpdates) {
      setStatus(newStatus);
    }
  }, [visibleLines]);

  // Auto-scroll effect
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [visibleLines]);

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center pt-24 pb-12 px-4 overflow-hidden">
      {/* Background Gradients */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-[-10%] left-[20%] w-[600px] h-[600px] bg-claude-accent/5 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[10%] w-[500px] h-[500px] bg-claude-ish/5 rounded-full blur-[100px]" />
      </div>

      <div className="text-center mb-12 max-w-5xl mx-auto z-10 flex flex-col items-center">
        <div className="flex gap-3 mb-8 animate-fadeIn">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-mono text-claude-ish">
            <span className="w-2 h-2 rounded-full bg-claude-ish animate-pulse"></span>
            v2.4.0 Public Beta
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-900/20 border border-green-500/20 text-xs font-mono text-green-400">
            <span className="text-[10px]">🎁</span>
            Top models free on OpenRouter — Grok, Gemini, DeepSeek, Llama
          </div>
        </div>

        {/* BlockLogo */}
        <div className="mb-6 scale-90 md:scale-110 origin-center">
          <BlockLogo />
        </div>

        <h1 className="text-3xl md:text-5xl font-sans font-bold tracking-tight text-white mb-2">
          Claude Code. <span className="text-gray-500">Any Model.</span>
        </h1>

        <p className="text-lg md:text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed font-sans mb-10">
          The most powerful AI coding agent now speaks every language.
          <br />
          <span className="text-white">Gemini</span>, <span className="text-white">GPT</span>,{" "}
          <span className="text-white">Grok</span>, <span className="text-white">DeepSeek</span>.{" "}
          <span className="text-white">580+ models via OpenRouter.</span>
          <br />
          <span className="text-claude-ish">
            Works with your Claude subscription. Or start completely free.
          </span>
        </p>

        <div className="mt-6 flex flex-col items-center animate-float">
          <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-5 md:p-6 shadow-2xl relative group">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#d97757] text-[#0f0f0f] text-[10px] font-bold px-2 py-0.5 rounded shadow-lg">
              GET STARTED
            </div>
            <div className="flex flex-col gap-3 font-mono text-sm md:text-base text-left">
              <div className="flex items-center gap-3 text-gray-300 group-hover:text-white transition-colors">
                <span className="text-claude-ish select-none font-bold">$</span>
                <span>npm install -g claudish</span>
              </div>
              <div className="w-full h-[1px] bg-white/5"></div>
              <div className="flex items-center gap-3 text-white font-bold">
                <span className="text-claude-ish select-none font-bold">$</span>
                <span>claudish --free</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 3D Container */}
      <div
        ref={containerRef}
        className="perspective-container w-full max-w-4xl relative h-[550px] mt-4"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <div
          className="w-full h-full transition-transform duration-100 ease-out preserve-3d"
          style={{
            transform: `rotateX(${rotation.x}deg) rotateY(${rotation.y}deg)`,
          }}
        >
          <TerminalWindow
            className="h-full w-full bg-[#0d1117] shadow-[0_0_50px_rgba(0,0,0,0.6)] border-[#30363d]"
            title="claudish — -zsh — 140×45"
            noPadding={true}
          >
            <div className="flex flex-col h-full font-mono text-[13px] md:text-sm">
              {/* Terminal Flow - Scrollable Area */}
              <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto scrollbar-hide scroll-smooth p-4 md:p-6 pb-2"
              >
                {HERO_SEQUENCE.map((line, idx) => {
                  if (idx >= visibleLines) return null;

                  return (
                    <div key={line.id} className="leading-normal mb-2">
                      {/* System / Boot Output */}
                      {line.type === "system" && (
                        <div className="text-gray-400 font-semibold px-2">
                          <span className="text-[#3fb950]">➜</span> {line.content}
                        </div>
                      )}

                      {/* Rich Welcome Screen */}
                      {line.type === "welcome" && (
                        <div className="my-4 border border-[#d97757] rounded p-1 mx-2 relative">
                          <div className="absolute top-[-10px] left-4 bg-[#0d1117] px-2 text-[#d97757] text-xs font-bold uppercase tracking-wider">
                            Claudish
                          </div>
                          <div className="flex gap-2 md:gap-6 p-4">
                            {/* Left Side: Logo & Info */}
                            <div className="flex-1 border-r border-[#30363d] pr-4 md:pr-6 flex items-center justify-center">
                              <div className="flex items-center gap-4 md:gap-6">
                                <AsciiGhost />
                                <div className="flex flex-col text-left space-y-0.5 md:space-y-1">
                                  <div className="font-bold text-gray-200">
                                    Claude Code {line.data.version}
                                  </div>
                                  <div className="text-xs text-gray-400">
                                    {line.data.model} • Claude Max
                                  </div>
                                  <div className="text-xs text-gray-600">
                                    ~/dev/claudish-landing
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Right Side: Activity */}
                            <div className="hidden md:block flex-1 text-xs space-y-3 pl-2">
                              <div className="text-[#d97757] font-bold">Recent activity</div>
                              <div className="flex gap-2 text-gray-400">
                                <span className="text-gray-600">1m ago</span>
                                <span>Tracking Real OpenRouter Cost</span>
                              </div>
                              <div className="flex gap-2 text-gray-400">
                                <span className="text-gray-600">39m ago</span>
                                <span>Refactoring Auth Middleware</span>
                              </div>
                              <div className="w-full h-[1px] bg-[#30363d] my-2"></div>
                              <div className="text-[#d97757] font-bold">What's new</div>
                              <div className="text-gray-400">
                                Fixed duplicate message display when using Gemini.
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Rich Input (Updated to be cleaner, status moved to bottom) */}
                      {line.type === "rich-input" && (
                        <div className="mt-4 mb-2 px-2">
                          <div className="flex items-start text-white group">
                            <span className="text-[#ff5f56] mr-3 font-bold select-none text-base">
                              {">>"}
                            </span>
                            <TypingAnimation
                              text={line.content}
                              speed={15}
                              className="text-gray-100 font-medium"
                            />
                          </div>
                        </div>
                      )}

                      {/* Thinking Block */}
                      {line.type === "thinking" && (
                        <div className="text-gray-500 px-2 flex items-center gap-2 text-xs my-2">
                          <span className="animate-pulse">⠋</span>
                          {line.content}
                        </div>
                      )}

                      {/* Tool Execution */}
                      {line.type === "tool" && (
                        <div className="my-2 px-2">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                            <span className="bg-[#1f2937] text-blue-400 px-1 rounded text-xs font-bold">
                              {line.content.split("(")[0]}
                            </span>
                            <span className="text-gray-400 text-xs">
                              ({line.content.split("(")[1]}
                            </span>
                          </div>
                          {line.data?.details && (
                            <div className="border-l border-gray-700 ml-3 pl-3 mt-1 text-gray-500 text-xs py-1">
                              {line.data.details}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Standard Output/Success/Info */}
                      {line.type === "info" && (
                        <div className="text-gray-500 px-2 py-1">{line.content}</div>
                      )}

                      {line.type === "progress" && (
                        <div className="text-claude-accent animate-pulse px-2">{line.content}</div>
                      )}

                      {line.type === "success" && (
                        <div className="text-[#3fb950] px-2">{line.content}</div>
                      )}
                    </div>
                  );
                })}

                {/* Interactive Cursor line if active */}
                <div className="flex items-center text-white mt-1 px-2 pb-4">
                  <span className="text-[#ff5f56] mr-3 font-bold text-base opacity-0">{">"}</span>
                  <div className="h-4 w-2.5 bg-gray-500/50 animate-cursor-blink" />
                </div>
              </div>

              {/* Persistent Footer Status Bar */}
              <div className="bg-[#161b22] border-t border-[#30363d] px-3 py-1.5 flex justify-between items-center text-[10px] md:text-[11px] font-mono leading-none shrink-0 select-none z-20">
                <div className="flex items-center gap-2 md:gap-3">
                  <span className="font-bold text-claude-ish">claudish</span>
                  <span className="text-[#484f58]">●</span>
                  <span className="text-[#e2b340]">{status.model}</span>
                  <span className="text-[#484f58]">●</span>
                  <span className="text-[#3fb950]">{status.cost}</span>
                  <span className="text-[#484f58]">●</span>
                  <span className="text-[#a371f7]">{status.context}</span>
                </div>
                <div className="flex items-center gap-2 text-gray-500">
                  <span className="hidden sm:inline">
                    bypass permissions <span className="text-[#ff5f56]">on</span>
                  </span>
                  <span className="text-[#484f58] hidden sm:inline">|</span>
                  <span className="hidden sm:inline">(shift+tab to cycle)</span>
                </div>
              </div>
            </div>
          </TerminalWindow>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
