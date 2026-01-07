export type IssueSeverity = "critical" | "high" | "medium" | "low";
export type ImprovementCategory = "mandatory" | "recommended" | "optional";

export interface ValidationIssue {
  path: string;
  line?: number;
  severity: IssueSeverity;
  category: ImprovementCategory;
  message: string;
  hypothesis?: string;
  improvement?: string;
  details?: string;
}

export interface ValidationSuggestion {
  what: string;
  why: string;
  impact: number; // 0-1
  ease: number; // 0-1
  urgency: number; // 0-1
  score: number; // impact * 0.4 + ease * 0.3 + urgency * 0.3
}

export interface ValidationReport {
  issues: ValidationIssue[];
  summary: {
    total: number;
    bySeverity: {
      critical: ValidationIssue[];
      high: ValidationIssue[];
      medium: ValidationIssue[];
      low: ValidationIssue[];
    };
    byCategory: {
      mandatory: ValidationIssue[];
      recommended: ValidationIssue[];
      optional: ValidationIssue[];
    };
  };
}

export interface ValidationResult {
  project: ValidationReport;
  agents: ValidationReport;
  commands: ValidationReport;
  skills: ValidationReport;
  documentation: ValidationReport;
}

export interface ImprovementPlan {
  suggestions: ValidationSuggestion[];
  todos: string[];
  effort: "low" | "medium" | "high";
  priorityIssues: string[];
  estimatedTime: string;
}
