import React from "react";

interface TerminalWindowProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  noPadding?: boolean;
}

export const TerminalWindow: React.FC<TerminalWindowProps> = ({
  children,
  className = "",
  title = "claudish-cli",
  noPadding = false,
}) => {
  return (
    <div
      className={`bg-[#0d1117] border border-gray-800 rounded-xl shadow-2xl overflow-hidden flex flex-col ${className}`}
    >
      {/* Window Header */}
      <div className="bg-[#161b22] px-4 py-3 flex items-center border-b border-gray-800 select-none shrink-0">
        <div className="flex gap-2">
          <div className="w-3 h-3 rounded-full bg-[#ff5f56] hover:bg-[#ff5f56]/80 transition-colors" />
          <div className="w-3 h-3 rounded-full bg-[#ffbd2e] hover:bg-[#ffbd2e]/80 transition-colors" />
          <div className="w-3 h-3 rounded-full bg-[#27c93f] hover:bg-[#27c93f]/80 transition-colors" />
        </div>
        <div className="flex-1 text-center text-xs font-mono text-gray-500 font-medium ml-[-3.25rem]">
          {title}
        </div>
      </div>

      {/* Terminal Content */}
      <div
        className={`flex-1 ${noPadding ? "" : "p-4 md:p-6"} font-mono text-sm overflow-hidden relative leading-relaxed flex flex-col`}
      >
        {children}
      </div>
    </div>
  );
};
