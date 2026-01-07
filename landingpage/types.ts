export interface TerminalLine {
  id: string;
  type:
    | "input"
    | "output"
    | "success"
    | "info"
    | "ascii"
    | "progress"
    | "system"
    | "welcome"
    | "rich-input"
    | "thinking"
    | "tool";
  content: string | any;
  prefix?: string;
  delay?: number; // Simulated delay before appearing
  data?: any; // Extra data for rich components
}

export interface Feature {
  id: string;
  title: string;
  description: string;
  icon?: string;
  badge?: string;
  key?: string; // Legacy support if needed
  value?: string | string[]; // Legacy support if needed
}

export interface ModelCard {
  id: string;
  name: string;
  provider: string;
  description: string;
  tags: string[];
  color: string;
}
