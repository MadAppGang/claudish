import React, { useState, useEffect } from "react";
import { HIGHLIGHT_FEATURES, STANDARD_FEATURES } from "../constants";
import { TerminalWindow } from "./TerminalWindow";
import { MultiModelAnimation } from "./MultiModelAnimation";
import { BridgeDiagram } from "./BridgeDiagram";
import { SmartRouting } from "./SmartRouting";

const COMPARISON_ROWS = [
  { label: "Sub-agent context", others: "Lost", claudish: "Full inheritance" },
  { label: "Image handling", others: "Breaks", claudish: "Native translation" },
  { label: "Tool calling", others: "Generic", claudish: "Per-model adapters" },
  { label: "Thinking modes", others: "Maybe", claudish: "Native support" },
  { label: "/commands", others: "Maybe", claudish: "Always work" },
  { label: "Plugins (agents, skills, hooks)", others: "No", claudish: "Full ecosystem" },
  { label: "MCP servers", others: "No", claudish: "Fully supported" },
  { label: "Team marketplaces", others: "No", claudish: "Just work" },
];

const FeatureSection: React.FC = () => {
  const [statementIndex, setStatementIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setStatementIndex((prev) => (prev < 3 ? prev + 1 : prev));
    }, 800);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="bg-[#050505] relative overflow-hidden">
      {/* 1. THE PROBLEM SECTION */}
      <section className="py-24 max-w-7xl mx-auto px-6 border-t border-white/5 relative">
        {/* Radial Gradient Spot */}
        <div className="absolute top-[40%] left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-indigo-500/5 rounded-full blur-[120px] pointer-events-none -z-10" />

        <div className="text-center mb-16 relative z-10">
          <h2 className="text-3xl md:text-5xl font-sans font-bold text-white mb-6">
            Claude Code is incredible.
            <br />
            <span className="text-gray-500">But what if you want to use other models?</span>
          </h2>
        </div>

        {/* Terminal Comparison */}
        <div className="grid md:grid-cols-2 gap-8 mb-24 max-w-5xl mx-auto">
          {/* Without Claudish */}
          <div className="bg-[#0a0a0a] rounded-xl border border-red-500/20 overflow-hidden shadow-lg group hover:border-red-500/40 transition-colors h-full flex flex-col">
            <div className="bg-red-500/5 px-4 py-3 border-b border-red-500/10 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500/50"></span>
                <span className="text-xs font-mono text-red-400/60">zsh — 80x24</span>
              </div>
              <span className="text-[10px] font-bold text-red-500/50 uppercase tracking-widest">
                Stock CLI
              </span>
            </div>
            <div className="p-6 font-mono text-sm text-left flex-1 flex flex-col justify-center min-h-[200px]">
              <div className="text-gray-400 mb-2">
                <span className="text-green-500">➜</span> claude --model google/gemini-3-pro-preview
              </div>
              <div className="text-red-400">
                Error: Invalid model "google/gemini-3-pro-preview"
                <br />
                <span className="text-gray-600 mt-2 block leading-relaxed text-xs">
                  Only Anthropic models are supported.
                  <br />
                  Please use claude-3-opus or claude-3.5-sonnet.
                </span>
              </div>
            </div>
          </div>

          {/* With Claudish */}
          <div className="bg-[#0a0a0a] rounded-xl border border-claude-ish/20 overflow-hidden shadow-[0_0_30px_rgba(0,212,170,0.05)] group hover:border-claude-ish/40 transition-colors h-full flex flex-col">
            <div className="bg-claude-ish/5 px-4 py-3 border-b border-claude-ish/10 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-claude-ish"></span>
                <span className="text-xs font-mono text-claude-ish/60">zsh — 80x24</span>
              </div>
              <span className="text-[10px] font-bold text-claude-ish uppercase tracking-widest">
                Claudish
              </span>
            </div>
            <div className="p-6 font-mono text-sm text-left flex-1 flex flex-col justify-center min-h-[200px]">
              <div className="text-gray-400 mb-2">
                <span className="text-claude-ish">➜</span> claudish --model
                google/gemini-3-pro-preview
              </div>
              <div className="text-gray-300">
                <div className="text-claude-ish/80 mb-1">✓ Connected via OpenRouter</div>
                <div className="text-claude-ish/80 mb-1">✓ Architecture: Claude Code 2.4.0</div>
                <div className="text-claude-ish/80 mb-1">
                  ✓ Access OpenRouter's free tier — real top models, not scraps
                </div>
                <div className="mt-4 text-white font-bold animate-pulse">
                  &gt;&gt; Ready. What would you like to build?
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Architecture Animation */}
        <div className="relative">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 text-xs font-mono text-gray-600 uppercase tracking-widest mb-4">
            Unified Agent Protocol
          </div>
          <MultiModelAnimation />
        </div>
      </section>

      {/* 2. HOW IT WORKS SECTION */}
      <section className="py-24 bg-[#080808] border-y border-white/5 relative">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-5xl font-sans font-bold text-white mb-2">
              Native Translation. <span className="text-claude-ish">Not a Hack.</span>
            </h2>
            <p className="text-xl text-gray-500 font-mono">Bidirectional. Seamless. Invisible.</p>
          </div>

          {/* PRIMARY VISUAL: BRIDGE DIAGRAM */}
          <div className="mb-20">
            <BridgeDiagram />
          </div>

          {/* EXPLANATION CARDS */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
            {/* Card 1: Intercept */}
            <div className="bg-[#0f0f0f] border border-gray-800 p-6 rounded-sm hover:border-claude-ish/30 transition-colors group">
              <div className="flex items-center gap-3 mb-4 text-gray-400 group-hover:text-white">
                <div className="w-8 h-8 flex items-center justify-center border border-gray-700 rounded bg-[#151515]">
                  🔌
                </div>
                <h3 className="font-mono text-sm font-bold uppercase tracking-wider">
                  01_INTERCEPT
                </h3>
              </div>
              <p className="text-gray-500 text-sm leading-relaxed font-mono">
                Claudish sits between Claude Code and the API layer. Captures all calls to{" "}
                <span className="text-gray-300 bg-white/5 px-1 rounded">api.anthropic.com</span> via
                standard proxy injection.
              </p>
              <div className="mt-4 pt-4 border-t border-dashed border-gray-800 font-mono text-[10px] text-gray-600">
                STATUS: LISTENING ON PORT 3000
              </div>
            </div>

            {/* Card 2: Translate */}
            <div className="bg-[#0f0f0f] border border-gray-800 p-6 rounded-sm hover:border-claude-ish/30 transition-colors group">
              <div className="flex items-center gap-3 mb-4 text-gray-400 group-hover:text-white">
                <div className="w-8 h-8 flex items-center justify-center border border-gray-700 rounded bg-[#151515]">
                  ↔
                </div>
                <h3 className="font-mono text-sm font-bold uppercase tracking-wider">
                  02_TRANSLATE
                </h3>
              </div>
              <div className="bg-[#050505] p-2 rounded border border-gray-800 mb-3 text-[10px] font-mono text-gray-400">
                <div>
                  {"<tool_use>"} <span className="text-gray-600">--&gt;</span> {"{function_call}"}
                </div>
                <div>
                  {"<result>"} <span className="text-gray-600">&lt;--</span> {"{content: json}"}
                </div>
              </div>
              <p className="text-gray-500 text-sm leading-relaxed font-mono">
                Bidirectional schema translation. Converts Anthropic XML tools to OpenAI/Gemini JSON
                specs and back again in real-time.
              </p>
            </div>

            {/* Card 3: Execute */}
            <div className="bg-[#0f0f0f] border border-gray-800 p-6 rounded-sm hover:border-claude-ish/30 transition-colors group">
              <div className="flex items-center gap-3 mb-4 text-gray-400 group-hover:text-white">
                <div className="w-8 h-8 flex items-center justify-center border border-gray-700 rounded bg-[#151515]">
                  🚀
                </div>
                <h3 className="font-mono text-sm font-bold uppercase tracking-wider">03_EXECUTE</h3>
              </div>
              <p className="text-gray-500 text-sm leading-relaxed font-mono">
                Target model executes logic natively. Response is re-serialized to look exactly like
                Claude 3.5 Sonnet output.
              </p>
              <div className="mt-4 pt-4 border-t border-dashed border-gray-800 font-mono text-[10px] text-claude-ish">
                RESULT: 100% COMPATIBILITY
              </div>
            </div>
          </div>

          {/* KEY STATEMENT */}
          <div className="text-center font-mono space-y-2 mb-12 min-h-[100px]">
            <div
              className={`text-xl md:text-2xl text-white font-bold transition-all duration-700 ${statementIndex >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
            >
              Zero patches to Claude Code binary.
            </div>
            <div
              className={`text-xl md:text-2xl text-white font-bold transition-all duration-700 ${statementIndex >= 2 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
            >
              Every update works automatically.
            </div>
            <div
              className={`text-xl md:text-2xl text-claude-ish font-bold transition-all duration-700 ${statementIndex >= 3 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}
            >
              Translation happens at runtime — invisible and instant.
            </div>
          </div>

          {/* DIALECT LIST */}
          <div className="flex flex-wrap justify-center gap-2 md:gap-4 opacity-70 hover:opacity-100 transition-opacity">
            {["ANTHROPIC", "OPENAI", "GOOGLE", "X.AI", "MISTRAL", "DEEPSEEK", "+580 MORE"].map(
              (provider) => (
                <span
                  key={provider}
                  className="px-3 py-1 bg-[#151515] border border-gray-800 rounded text-[10px] md:text-xs font-mono text-gray-400"
                >
                  [{provider}]
                </span>
              )
            )}
          </div>
        </div>
      </section>

      {/* NEW SECTION: SMART ROUTING */}
      <section className="py-24 max-w-7xl mx-auto px-6 border-b border-white/5 bg-[#0a0a0a]">
        <SmartRouting />
      </section>

      {/* 3. FEATURE SHOWCASE */}
      <section className="py-24 max-w-7xl mx-auto px-6 bg-[#050505]">
        <div className="text-center mb-20">
          <h2 className="text-3xl md:text-5xl font-sans font-bold text-white mb-4">
            Every Feature. Every Model.
          </h2>
          <p className="text-xl text-gray-500">Full agent architecture compatibility.</p>
        </div>

        {/* HIGHLIGHTED DIFFERENTIATORS */}
        <div className="relative mb-24">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 text-xs font-mono text-gray-600 uppercase tracking-widest -mt-8">
            SYSTEM CAPABILITIES
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-0 border border-gray-800 bg-[#0a0a0a]">
            {HIGHLIGHT_FEATURES.map((feature, idx) => (
              <div
                key={feature.id}
                className={`p-8 hover:bg-[#111] transition-all group relative border-b md:border-b-0 border-gray-800 ${idx !== HIGHLIGHT_FEATURES.length - 1 ? "md:border-r" : ""}`}
              >
                {/* Top Badge */}
                <div className="flex justify-between items-start mb-6">
                  <div className="font-mono text-[10px] text-gray-600 uppercase tracking-widest">
                    {feature.id}
                  </div>
                  <div className="bg-claude-ish/10 text-claude-ish px-2 py-0.5 text-[9px] font-mono tracking-wider uppercase border border-claude-ish/20">
                    {feature.badge}
                  </div>
                </div>

                <div className="text-3xl mb-4 text-gray-400 group-hover:text-white group-hover:scale-110 transition-all origin-left duration-300">
                  {feature.icon}
                </div>

                <h3 className="text-lg text-white font-mono font-bold uppercase mb-3 tracking-tight">
                  {feature.title}
                </h3>
                <p className="text-gray-500 text-xs leading-relaxed font-mono">
                  {feature.description}
                </p>

                {/* Corner Accent */}
                <div className="absolute bottom-0 right-0 w-3 h-3 border-r border-b border-gray-800 group-hover:border-claude-ish/50 transition-colors"></div>
              </div>
            ))}
          </div>
        </div>

        {/* DEMOS SECTION: COST & CONTEXT */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-32">
          {/* Cost/Top Models Terminal */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-2 mb-2">
              <span className="text-xs font-mono text-gray-500 uppercase tracking-widest">
                Global Leaderboard
              </span>
            </div>
            <TerminalWindow
              title="claudish — top-models"
              className="h-[320px] shadow-2xl border-gray-800"
            >
              <div className="flex flex-col gap-1 text-xs">
                <div className="text-gray-400 mb-2">
                  <span className="text-claude-ish">➜</span> claudish --top-models
                </div>
                <div className="grid grid-cols-12 text-gray-500 border-b border-gray-800 pb-1 mb-1 font-bold">
                  <div className="col-span-1">#</div>
                  <div className="col-span-5">MODEL</div>
                  <div className="col-span-3">COST/1M</div>
                  <div className="col-span-3 text-right">CONTEXT</div>
                </div>
                {/* List Items */}
                <div className="grid grid-cols-12 text-gray-300 hover:bg-white/5 p-0.5 rounded cursor-default">
                  <div className="col-span-1 text-gray-600">1</div>
                  <div className="col-span-5 text-purple-400">gemini-3-pro</div>
                  <div className="col-span-3">$0.00</div>
                  <div className="col-span-3 text-right">2,000K</div>
                </div>
                <div className="grid grid-cols-12 text-gray-300 hover:bg-white/5 p-0.5 rounded cursor-default">
                  <div className="col-span-1 text-gray-600">2</div>
                  <div className="col-span-5 text-green-400">gpt-5.1</div>
                  <div className="col-span-3">$15.00</div>
                  <div className="col-span-3 text-right">128K</div>
                </div>
                <div className="grid grid-cols-12 text-gray-300 hover:bg-white/5 p-0.5 rounded cursor-default">
                  <div className="col-span-1 text-gray-600">3</div>
                  <div className="col-span-5 text-white">claude-3.7-opus</div>
                  <div className="col-span-3">$15.00</div>
                  <div className="col-span-3 text-right">200K</div>
                </div>
                <div className="grid grid-cols-12 text-gray-300 hover:bg-white/5 p-0.5 rounded cursor-default">
                  <div className="col-span-1 text-gray-600">4</div>
                  <div className="col-span-5 text-blue-400">deepseek-r1</div>
                  <div className="col-span-3">$0.55</div>
                  <div className="col-span-3 text-right">128K</div>
                </div>
                <div className="grid grid-cols-12 text-gray-300 hover:bg-white/5 p-0.5 rounded cursor-default">
                  <div className="col-span-1 text-gray-600">5</div>
                  <div className="col-span-5 text-orange-400">mistral-large</div>
                  <div className="col-span-3">$3.00</div>
                  <div className="col-span-3 text-right">32K</div>
                </div>
              </div>
            </TerminalWindow>
          </div>

          {/* Models Search Terminal */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-2 mb-2">
              <span className="text-xs font-mono text-gray-500 uppercase tracking-widest">
                Universal Registry
              </span>
            </div>
            <TerminalWindow
              title="claudish — search"
              className="h-[320px] shadow-2xl border-gray-800"
            >
              <div className="flex flex-col gap-1 text-xs">
                <div className="text-gray-400 mb-2">
                  <span className="text-claude-ish">➜</span> claudish --models "vision fast"
                </div>
                <div className="text-gray-500 italic mb-2">
                  Searching 583 models for 'vision fast'...
                </div>

                <div className="space-y-3">
                  <div className="border-l-2 border-green-500 pl-3">
                    <div className="font-bold text-green-400">google/gemini-flash-1.5</div>
                    <div className="text-gray-500 text-[10px]">
                      Context: 1M • Vision: Yes • Speed: 110 tok/s
                    </div>
                  </div>
                  <div className="border-l-2 border-gray-700 pl-3 hover:border-claude-ish transition-colors">
                    <div className="font-bold text-gray-300">openai/gpt-4o-mini</div>
                    <div className="text-gray-500 text-[10px]">
                      Context: 128K • Vision: Yes • Speed: 95 tok/s
                    </div>
                  </div>
                  <div className="border-l-2 border-gray-700 pl-3 hover:border-claude-ish transition-colors">
                    <div className="font-bold text-gray-300">meta/llama-3.2-90b-vision</div>
                    <div className="text-gray-500 text-[10px]">
                      Context: 128K • Vision: Yes • Speed: 80 tok/s
                    </div>
                  </div>
                </div>
                <div className="mt-4 text-gray-500">(Use arrows to navigate, Enter to select)</div>
              </div>
            </TerminalWindow>
          </div>
        </div>

        {/* REPLACED TABLE SECTION */}
        <div className="max-w-4xl mx-auto">
          <div className="mb-4 flex items-center justify-between px-2 opacity-80">
            <span className="text-xs font-mono text-gray-500 uppercase tracking-widest">
              Competitive Analysis
            </span>
            <span className="text-xs font-mono text-gray-600 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-claude-ish animate-pulse"></span>
              LIVE
            </span>
          </div>

          <div className="border border-gray-800 bg-[#0c0c0c] rounded-lg overflow-hidden shadow-2xl font-mono text-sm relative">
            {/* ASCII Header Art Style */}
            <div className="border-b border-gray-800 bg-[#111] p-6 text-center">
              <h3 className="text-xl md:text-2xl font-bold text-white mb-1">
                Claudish vs Other Proxies
              </h3>
              <div className="text-gray-600 text-xs uppercase tracking-widest">
                Performance Comparison Matrix
              </div>
            </div>

            {/* Column Headers */}
            <div className="grid grid-cols-12 border-b border-gray-800 bg-[#0f0f0f] py-3 px-6 text-xs uppercase tracking-wider font-bold text-gray-500">
              <div className="col-span-6 md:col-span-5">Feature</div>
              <div className="col-span-3 md:col-span-3 text-center md:text-left text-gray-600">
                Others
              </div>
              <div className="col-span-3 md:col-span-4 text-right md:text-left text-claude-ish">
                Claudish
              </div>
            </div>

            {/* Table Body */}
            <div className="divide-y divide-gray-800/50">
              {COMPARISON_ROWS.map((row, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-12 py-4 px-6 hover:bg-white/5 transition-colors group"
                >
                  <div className="col-span-6 md:col-span-5 text-gray-400 group-hover:text-white transition-colors flex items-center">
                    {row.label}
                  </div>
                  <div className="col-span-3 md:col-span-3 text-red-900/50 md:text-red-500/50 font-medium flex items-center justify-center md:justify-start">
                    <span className="line-through decoration-red-900/50">{row.others}</span>
                  </div>
                  <div className="col-span-3 md:col-span-4 text-claude-ish font-bold shadow-claude-ish/10 flex items-center justify-end md:justify-start">
                    {row.claudish}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="bg-[#151515] p-6 text-center border-t border-gray-800">
              <p className="text-gray-400 font-mono italic">
                "We didn't cut corners. That's the difference."
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default FeatureSection;
