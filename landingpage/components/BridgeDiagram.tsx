import React, { useState, useEffect } from "react";

export const BridgeDiagram: React.FC = () => {
  const [modelIndex, setModelIndex] = useState(0);
  const models = ["GOOGLE/GEMINI-3-PRO", "OPENAI/GPT-5.1", "XAI/GROK-FAST", "MINIMAX/M2"];

  useEffect(() => {
    const interval = setInterval(() => {
      setModelIndex((prev) => (prev + 1) % models.length);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="w-full max-w-5xl mx-auto">
      <div className="bg-[#0c0c0c] border border-gray-800 rounded-lg p-2 md:p-8 font-mono relative overflow-hidden shadow-2xl">
        {/* Header / Decor */}
        <div className="absolute top-0 left-0 right-0 h-8 bg-[#151515] border-b border-gray-800 flex items-center px-4 justify-between select-none">
          <div className="flex gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-900/50 border border-red-800"></div>
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-900/50 border border-yellow-800"></div>
            <div className="w-2.5 h-2.5 rounded-full bg-green-900/50 border border-green-800"></div>
          </div>
          <div className="text-[10px] text-gray-600 tracking-widest font-bold">
            SYSTEM_MONITOR // PROTOCOL_BRIDGE
          </div>
          <div className="w-10"></div>
        </div>

        {/* Grid Pattern Background */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#111_1px,transparent_1px),linear-gradient(to_bottom,#111_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none z-0 mt-8"></div>

        <div className="relative z-10 mt-12 mb-4 flex flex-col md:flex-row items-center justify-center gap-0 md:gap-4">
          {/* LEFT NODE: CLAUDE CODE */}
          <div className="w-full md:w-64 flex flex-col items-center">
            <div className="w-full bg-[#0a0a0a] border border-gray-700 p-4 rounded-sm shadow-lg relative group">
              <div className="absolute -top-3 left-3 bg-[#0c0c0c] px-2 text-[10px] text-gray-500 font-bold border border-gray-800 rounded-sm">
                INTERFACE
              </div>
              <div className="text-center py-4">
                <div className="text-gray-300 font-bold mb-1">CLAUDE_CODE</div>
                <div className="text-xs text-red-500/50 uppercase tracking-wider">
                  [STOCK_BINARY]
                </div>
              </div>
              {/* Decor lines */}
              <div className="flex justify-between mt-2 opacity-30">
                <div className="h-1 w-1 bg-gray-500"></div>
                <div className="h-1 w-1 bg-gray-500"></div>
              </div>
            </div>
          </div>

          {/* CONNECTOR 1 */}
          <Connector />

          {/* MIDDLE NODE: CLAUDISH */}
          <div className="w-full md:w-72 flex flex-col items-center relative z-20">
            {/* Glowing Backdrop */}
            <div className="absolute inset-0 bg-claude-ish/5 blur-xl rounded-full"></div>

            <div className="w-full bg-[#111] border border-claude-ish p-4 rounded-sm shadow-[0_0_15px_rgba(0,212,170,0.1)] relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#0c0c0c] px-2 text-[10px] text-claude-ish font-bold border border-claude-ish/50 rounded-sm whitespace-nowrap">
                TRANSLATION LAYER
              </div>
              <div className="text-center py-4">
                <div className="text-white font-bold text-lg mb-1 tracking-tight">CLAUDISH</div>
                <div className="flex items-center justify-center gap-2 text-[10px] text-claude-ish/80 font-bold uppercase tracking-widest">
                  <span className="animate-pulse">●</span> Active
                </div>
              </div>
              {/* Tech Decor */}
              <div className="absolute top-2 right-2 flex flex-col gap-0.5">
                <div className="w-8 h-[1px] bg-claude-ish/30"></div>
                <div className="w-6 h-[1px] bg-claude-ish/30 ml-auto"></div>
              </div>
              <div className="absolute bottom-2 left-2 flex flex-col gap-0.5">
                <div className="w-8 h-[1px] bg-claude-ish/30"></div>
                <div className="w-4 h-[1px] bg-claude-ish/30"></div>
              </div>
            </div>
          </div>

          {/* CONNECTOR 2 */}
          <Connector />

          {/* RIGHT NODE: TARGET MODEL */}
          <div className="w-full md:w-64 flex flex-col items-center">
            <div className="w-full bg-[#0a0a0a] border border-dashed border-gray-700 p-4 rounded-sm relative">
              <div className="absolute -top-3 right-3 bg-[#0c0c0c] px-2 text-[10px] text-gray-500 font-bold border border-gray-800 rounded-sm">
                NATIVE_EXECUTION
              </div>
              <div className="text-center py-4">
                <div className="text-gray-300 font-bold mb-1 transition-all duration-300">
                  {models[modelIndex]}
                </div>
                <div className="text-xs text-blue-500/50 uppercase tracking-wider">
                  [API_ENDPOINT]
                </div>
              </div>
              <div className="flex justify-center mt-2 gap-1">
                <div className="w-1 h-1 bg-gray-700 rounded-full animate-pulse"></div>
                <div className="w-1 h-1 bg-gray-700 rounded-full animate-pulse delay-100"></div>
                <div className="w-1 h-1 bg-gray-700 rounded-full animate-pulse delay-200"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const Connector: React.FC = () => {
  return (
    <div className="relative flex-shrink-0 flex md:flex-col items-center justify-center h-16 w-8 md:h-12 md:w-24 overflow-hidden">
      {/* Horizontal Flow (Desktop) */}
      <div className="hidden md:block w-full h-full relative">
        {/* Top Arrow: Left to Right */}
        <div className="absolute top-[30%] left-0 w-full h-[1px] bg-gray-800"></div>
        <div className="absolute top-[30%] left-0 w-[20%] h-[2px] bg-claude-ish shadow-[0_0_5px_#00D4AA] animate-flow-right"></div>

        {/* Bottom Arrow: Right to Left */}
        <div className="absolute bottom-[30%] left-0 w-full h-[1px] bg-gray-800"></div>
        <div className="absolute bottom-[30%] right-0 w-[20%] h-[2px] bg-blue-500 shadow-[0_0_5px_#3b82f6] animate-flow-left"></div>
      </div>

      {/* Vertical Flow (Mobile) */}
      <div className="md:hidden w-full h-full relative">
        {/* Left Arrow: Top to Bottom */}
        <div className="absolute left-[30%] top-0 h-full w-[1px] bg-gray-800"></div>
        <div className="absolute left-[30%] top-0 h-[20%] w-[2px] bg-claude-ish shadow-[0_0_5px_#00D4AA] animate-flow-down"></div>

        {/* Right Arrow: Bottom to Top */}
        <div className="absolute right-[30%] top-0 h-full w-[1px] bg-gray-800"></div>
        <div className="absolute right-[30%] bottom-0 h-[20%] w-[2px] bg-blue-500 shadow-[0_0_5px_#3b82f6] animate-flow-up"></div>
      </div>
    </div>
  );
};
