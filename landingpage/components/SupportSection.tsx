import React from "react";

const SupportSection: React.FC = () => {
  return (
    <section className="py-16 bg-[#080808] border-t border-white/5">
      <div className="max-w-4xl mx-auto px-6">
        {/* Terminal-style status card */}
        <div className="border border-gray-800 bg-[#0c0c0c] overflow-hidden">
          {/* Header bar */}
          <div className="bg-[#111] px-6 py-3 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-yellow-500/80"></span>
              <span className="text-xs font-mono text-gray-500 uppercase tracking-widest">
                Open Source Status
              </span>
            </div>
            <span className="text-[10px] font-mono text-gray-600">MIT License</span>
          </div>

          {/* Content */}
          <div className="p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
              {/* Left: Message */}
              <div className="space-y-3 flex-1">
                <div className="font-mono text-sm text-gray-400">
                  <span className="text-claude-ish">$</span> git status --community
                </div>
                <div className="font-mono text-gray-300 text-sm md:text-base leading-relaxed">
                  Claudish is free and open source.
                  <br />
                  <span className="text-gray-500">
                    Stars on GitHub help us prioritize development
                  </span>
                  <br />
                  <span className="text-gray-500">
                    and show that the community finds this useful.
                  </span>
                </div>
              </div>

              {/* Right: Action */}
              <div className="shrink-0">
                <a
                  href="https://github.com/MadAppGang/claudish"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-3 px-5 py-3 bg-[#161616] border border-gray-700 hover:border-claude-ish/50 text-gray-300 hover:text-white font-mono text-sm transition-all group"
                >
                  <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                  </svg>
                  <span>Star on GitHub</span>
                  <svg
                    viewBox="0 0 16 16"
                    width="14"
                    height="14"
                    fill="currentColor"
                    className="text-yellow-500 group-hover:scale-110 transition-transform"
                  >
                    <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" />
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default SupportSection;
