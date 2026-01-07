import React from "react";
import HeroSection from "./components/HeroSection";
import FeatureSection from "./components/FeatureSection";
import SupportSection from "./components/SupportSection";

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white selection:bg-claude-ish selection:text-black font-sans">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-[#0f0f0f]/90 border-b border-white/5 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-end">
          <div className="flex items-center gap-6 text-xs md:text-sm font-mono text-gray-400">
            <a
              href="https://github.com/MadAppGang/claudish/blob/main/docs/index.md"
              target="_blank"
              rel="noreferrer"
              className="hover:text-white transition-colors"
            >
              Documentation
            </a>
            <a
              href="https://github.com/MadAppGang/claudish"
              target="_blank"
              rel="noreferrer"
              className="hover:text-white transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </nav>

      <main>
        <HeroSection />
        <FeatureSection />
        <SupportSection />
      </main>

      {/* Footer / About Section */}
      <footer className="py-24 bg-[#0a0a0a] border-t border-white/5 relative overflow-hidden">
        {/* Ambient Glow */}
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-claude-ish/5 blur-[100px] rounded-full pointer-events-none -z-10"></div>

        <div className="max-w-4xl mx-auto px-6">
          <div className="bg-[#0f0f0f] border border-gray-800 rounded-2xl p-8 md:p-12 text-center relative shadow-2xl">
            {/* Badge */}
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#0f0f0f] px-4 py-1 text-[10px] font-bold font-mono text-gray-500 uppercase tracking-widest border border-gray-800 rounded-full">
              About Claudish
            </div>

            <div className="space-y-6">
              <div className="text-gray-300 font-medium font-sans text-base md:text-lg">
                Created by{" "}
                <a
                  href="https://madappgang.com"
                  className="text-white hover:underline decoration-claude-ish/50 transition-all"
                >
                  MadAppGang
                </a>
                , led by{" "}
                <a
                  href="https://x.com/jackrudenko"
                  className="text-white hover:underline decoration-claude-ish/50 transition-all"
                >
                  Jack Rudenko
                </a>
                .
              </div>

              <h3 className="text-xl md:text-2xl font-bold text-white font-sans">
                Claudish was built with Claudish — powered by{" "}
                <span className="text-claude-ish">7 top models</span>
                <br className="hidden md:block" />
                collaborating through Claude Code.
              </h3>

              <p className="text-gray-400 text-sm md:text-base max-w-2xl mx-auto leading-relaxed font-mono">
                This landing page: <span className="text-gray-200 font-bold">Opus 4.5</span> +{" "}
                <span className="text-gray-200 font-bold">Gemini 3.0 Pro</span> working together
                <br />
                in a single session.
              </p>

              <div className="text-gray-500 text-sm italic">Practicing what we preach.</div>
            </div>

            <div className="my-8 w-full h-[1px] bg-gradient-to-r from-transparent via-gray-800 to-transparent"></div>

            {/* Links */}
            <div className="flex flex-wrap justify-center gap-6 md:gap-8 text-xs md:text-sm font-mono text-gray-400 font-medium mb-8">
              <a
                href="https://github.com/MadAppGang/claudish/blob/main/docs/index.md"
                target="_blank"
                rel="noreferrer"
                className="hover:text-claude-ish transition-colors"
              >
                Documentation
              </a>
              <a
                href="https://github.com/MadAppGang/claudish"
                target="_blank"
                rel="noreferrer"
                className="hover:text-claude-ish transition-colors"
              >
                GitHub
              </a>
              <a
                href="https://openrouter.ai/"
                target="_blank"
                rel="noreferrer"
                className="hover:text-claude-ish transition-colors"
              >
                OpenRouter
              </a>
              <a
                href="https://x.com/jackrudenko"
                target="_blank"
                rel="noreferrer"
                className="hover:text-claude-ish transition-colors"
              >
                Twitter
              </a>
              <a
                href="https://madappgang.com"
                target="_blank"
                rel="noreferrer"
                className="hover:text-claude-ish transition-colors"
              >
                MadAppGang
              </a>
            </div>

            {/* Copyright */}
            <div className="text-[10px] text-gray-600 uppercase tracking-widest font-mono">
              © 2025 • MIT License
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
