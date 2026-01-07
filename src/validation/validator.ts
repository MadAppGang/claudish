import type { ValidationReport, ValidationIssue, IssueSeverity } from "./types.js";

export enum ValidationCategory {
  MANDATORY = "mandatory",
  RECOMMENDED = "recommended",
  OPTIONAL = "optional",
}

export interface Validator {
  /**
   * Validate the implementation and return issues
   */
  validate(): ValidationIssue[];
}

export abstract class BaseValidator implements Validator {
  protected projectPath: string;

  constructor(projectPath: string = ".") {
    this.projectPath = projectPath;
  }

  abstract validate(): ValidationIssue[];

  public generateReport(): ValidationReport {
    const issues = this.validate();
    const bySeverity = {
      critical: issues.filter((i) => i.severity === "critical"),
      high: issues.filter((i) => i.severity === "high"),
      medium: issues.filter((i) => i.severity === "medium"),
      low: issues.filter((i) => i.severity === "low"),
    };

    return {
      issues,
      summary: {
        total: issues.length,
        bySeverity,
        byCategory: {
          mandatory: issues.filter((i) => i.category === "mandatory"),
          recommended: issues.filter((i) => i.category === "recommended"),
          optional: issues.filter((i) => i.category === "optional"),
        },
      },
    };
  }

  /**
   * MOST LIKELY hypothesis generation - simplified and focused
   */
  protected generateImprovementIssue(
    whatMightGoWrong: string,
    confidence: "high" | "medium" | "low",
    onlyIf?: (currentContext: string) => boolean
  ): ValidationIssue | null {
    if (onlyIf && !onlyIf("")) {
      return null;
    }

    return {
      path: "",
      severity: confidence === "high" ? "high" : "medium",
      category: "recommended",
      message: `Consider adding: ${whatMightGoWrong}`,
      hypothesis: whatMightGoWrong,
      improvement: `Add ${whatMightGoWrong}`,
    };
  }

  /**
   * MOST LIKELY improvement scoring
   */
  protected calculateImprovementScore(
    issue: ValidationIssue,
    impact: number,
    ease: number,
    urgency: number
  ): number {
    return impact * 0.4 + ease * 0.3 + urgency * 0.3;
  }

  protected mostLikely(val: string | string[]): string[] {
    const likelyIssues = {
      permissions: [
        "permission handling is needed",
        "file access permissions are incomplete",
        "read/write permissions need review",
      ],
      "error handling": [
        "error boundaries are missing",
        "exception handling needs improvement",
        "edge cases should be considered",
      ],
      performance: [
        "performance optimization is needed",
        "memory usage could be optimized",
        "speed might be impacted",
      ],
    };

    const key = typeof val === "string" ? val : val[0];

    for (const category in likelyIssues) {
      const issues = likelyIssues[category as keyof typeof likelyIssues];
      for (const issue of issues) {
        if (issue.includes(key)) {
          return issues;
        }
      }
    }

    return typeof val === "string" ? [val] : val;
  }
}
