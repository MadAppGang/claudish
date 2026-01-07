import React from "react";

// Grid definition: 1 = filled block, 0 = empty space
const LETTERS: Record<string, number[][]> = {
  C: [
    [1, 1, 1, 1],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 1, 1, 1],
  ],
  L: [
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 1, 1, 1],
  ],
  A: [
    [1, 1, 1, 1],
    [1, 0, 0, 1],
    [1, 1, 1, 1],
    [1, 0, 0, 1],
    [1, 0, 0, 1],
  ],
  U: [
    [1, 0, 0, 1],
    [1, 0, 0, 1],
    [1, 0, 0, 1],
    [1, 0, 0, 1],
    [1, 1, 1, 1],
  ],
  D: [
    [1, 1, 1, 0],
    [1, 0, 0, 1],
    [1, 0, 0, 1],
    [1, 0, 0, 1],
    [1, 1, 1, 0],
  ],
  I: [
    // Fallback
    [1, 1, 1],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [1, 1, 1],
  ],
};

const WORD = "CLAUD";

export const BlockLogo: React.FC = () => {
  return (
    <div className="flex select-none items-end justify-center">
      {/* Main Block Letters */}
      <div className="flex gap-2 md:gap-3 flex-wrap justify-center items-end">
        {WORD.split("").map((char, i) => (
          <Letter key={`w-${i}`} char={char} />
        ))}
      </div>

      {/* Handwritten 'ish' suffix */}
      <div className="relative ml-2 mb-[-5px] md:mb-[-10px] z-20">
        <span className="font-hand text-5xl md:text-7xl text-claude-ish opacity-0 animate-writeIn block -rotate-6">
          ish
        </span>
        <div className="absolute top-0 right-[-10px] w-2 h-2 rounded-full bg-claude-ish/50 animate-ping delay-1000"></div>
      </div>
    </div>
  );
};

const Letter: React.FC<{ char: string }> = ({ char }) => {
  const grid = LETTERS[char] || LETTERS["I"];

  // Dimensions for blocks
  const blockSize = "w-2 h-2 md:w-[18px] md:h-[18px]";
  const gapSize = "gap-[1px] md:gap-[2px]";

  return (
    <div className="relative mb-2 md:mb-0">
      {/* Shadow Layer (Offset Wireframe) */}
      <div
        className={`absolute top-[3px] left-[3px] md:top-[6px] md:left-[6px] flex flex-col ${gapSize} -z-10`}
        aria-hidden="true"
      >
        {grid.map((row, y) => (
          <div key={`s-${y}`} className={`flex ${gapSize}`}>
            {row.map((cell, x) => (
              <div
                key={`s-${y}-${x}`}
                className={`
                  ${blockSize}
                  transition-all duration-300
                  ${
                    cell
                      ? "border border-[#d97757] opacity-60" // Wireframe look for shadow
                      : "bg-transparent"
                  }
                `}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Main Layer (Filled Blocks) */}
      <div className={`flex flex-col ${gapSize} z-10 relative`}>
        {grid.map((row, y) => (
          <div key={`m-${y}`} className={`flex ${gapSize}`}>
            {row.map((cell, x) => (
              <div
                key={`m-${y}-${x}`}
                className={`
                  ${blockSize}
                  transition-all duration-300
                  ${
                    cell
                      ? "bg-[#d97757] shadow-sm" // Solid fill for main
                      : "bg-transparent"
                  }
                `}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
