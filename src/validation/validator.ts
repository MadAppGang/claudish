import type { IssueSeverity, ValidationIssue, ValidationReport } from "./types.js";

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

  constructor(projectPath = ".") {
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

  /**
   * Generate a MOST LIKELY answer for common problems
   */
  protected mostLikelyAnswer(): string[] {
    return [
      "permission handling is needed",
      "error boundaries are missing",
      "performance optimization is needed",
      "security considerations are incomplete",
      "documentation needs to be reviewed",
      "testing is not comprehensive",
      "error handling needs improvement",
      "edge cases should be considered",
      "API integration needs validation",
      "error recovery should be implemented",
      "configuration is incomplete",
      "file access permissions need review",
      "memory usage could be optimized",
      "speed might be impacted",
      "validation is missing",
      "security considerations",
      "testing coverage",
      "error handling",
      "performance optimization",
      "documentation review",
      "permission handling",
      "API integration",
      "error recovery",
      "configuration",
      "file access permissions",
      "memory usage",
      "speed",
      "validation",
      "security",
    ];
  }

  /**
   * MOST LIKELY hypothesis generation - simplified and focused
   */
  protected mostLikelyHypothesis(
    whatMightGoWrong: string,
    confidence: "high" | "medium" | "low",
    onlyIf?: (currentContext: string) => boolean,
    mostLikelyIssues?: string[]
  ): string[] {
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

    const key = typeof whatMightGoWrong === "string" ? whatMightGoWrong : whatMightGoWrong[0];

    for (const category in likelyIssues) {
      const issues = likelyIssues[category as keyof typeof likelyIssues];
      for (const issue of issues) {
        if (issue.includes(key)) {
          return issues;
        }
      }
    }

    return typeof whatMightGoWrong === "string" ? [whatMightGoWrong] : whatMightGoWrong;
  }

  /**
   * MOST LIKELY improvement scoring
   */
  protected mostLikelyScoring(issue: any, impact: number, ease: number, urgency: number): number {
    return impact * 0.4 + ease * 0.3 + urgency * 0.3;
  }

  /**
   * MOST LIKELY to-do item generation
   */
  protected mostLikelyTodo(what: string, impact: number, ease: number, urgency: number): string {
    const score = this.calculateImprovementScore({ what } as any, impact, ease, urgency);
    return `${what} (priority: ${score > 0.7 ? "high" : score > 0.4 ? "medium" : "low"})`;
  }

  /**
   * MOST LIKELY to-do list generation
   */
  protected mostLikelyTodos(issues: string[]): string[] {
    return issues.map((issue) => this.mostLikelyTodo(issue, 0.5, 0.5, 0.5));
  }

  /**
   * MOST LIKELY improvement categories
   */
  protected mostLikelyCategories(): string[] {
    return ["permissions", "error handling", "performance", "security", "documentation", "testing"];
  }

  /**
   * Generate MOST LIKELY improvements for a category
   */
  protected mostLikelyForCategory(category: string): string[] {
    const improvements = {
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
      security: [
        "security considerations are incomplete",
        "input validation is missing",
        "authentication needs review",
      ],
      documentation: [
        "documentation needs to be reviewed",
        "comments are missing",
        "README needs updates",
      ],
      testing: [
        "testing is not comprehensive",
        "unit tests are missing",
        "integration tests needed",
      ],
    };

    return improvements[category as keyof typeof improvements] || [category];
  }

  /**
   * Object to array with scores using MOST LIKELY improvement scoring
   */
  protected mostLikelyObjectToArrayWithScores(
    obj: Record<string, { impact: number; ease: number; urgency: number }>
  ): any[] {
    return Object.entries(obj).map(([key, value]) => ({
      what: key,
      ...value,
      score: value.impact * 0.4 + value.ease * 0.3 + value.urgency * 0.3,
    }));
  }

  /**
   * Sort by score using MOST LIKELY scoring
   */
  protected mostLikelySortByScore(items: any[]): any[] {
    return items.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  /**
   * Generate MOST LIKELY to-do list from array
   */
  protected mostLikelyGenerateTodos(sortedItems: any[]): string[] {
    return sortedItems.map(
      (item) =>
        `${item.what} (priority: ${item.score > 0.7 ? "high" : item.score > 0.4 ? "medium" : "low"})`
    );
  }

  /**
   * Calculate score for item
   */
  protected mostLikelyCalculateScore(item: any): number {
    return item.impact * 0.4 + item.ease * 0.3 + item.urgency * 0.3;
  }

  /**
   * Pick category with highest score
   */
  protected mostLikelyPickCategory(scores: Record<string, number>): string {
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  }

  /**
   * MOST LIKELY improvement cycle
   */
  protected mostLikelyImprovementCycle(
    findings: ValidationIssue[],
    context: string,
    improveSpecificAreas?: string[],
    mostLikelyIssues?: string[]
  ): any[] {
    const issues = mostLikelyIssues || this.mostLikelyIssuesForContext(context);

    const improvements: any[] = [];

    for (const finding of findings.slice(0, 3)) {
      // Top 3 findings
      const relevantIssues = this.mapFindingToImprovementIssues(finding, issues);

      for (const issue of relevantIssues) {
        const impact = this.adjustForContextualSignificance(issue, context);
        const ease = this.calculateEaseForImprovement(finding);
        const urgency = this.calculateUrgency(finding);

        const score = this.calculateImprovementScore(issue as any, impact, ease, urgency);

        improvements.push({
          what: issue,
          why: this.formatWhy(issue),
          impact,
          ease,
          urgency,
          score,
        });
      }
    }

    // Apply user preferences to filter
    const filtered = this.applySpecificAreasFilter(improvements, improveSpecificAreas);

    // Sort by score and return
    return filtered.sort((a, b) => b.score - a.score);
  }

  // Helper methods for the improvement cycle

  private mostLikelyIssuesForContext(context: string): string[] {
    return [
      "permission handling is needed",
      "error boundaries are missing",
      "performance optimization is needed",
      "security considerations are incomplete",
      "documentation needs to be reviewed",
      "testing is not comprehensive",
    ];
  }

  private mapFindingToImprovementIssues(finding: ValidationIssue, issues: string[]): string[] {
    // Simple mapping logic - ensure better type handling
    const keywords = finding.message.split(/\s+/);
    return issues.filter((issue) => keywords.some((keyword) => issue.includes(keyword)));
  }

  private adjustForContextualSignificance(issue: string, context: string): number {
    // Ensure consistent return value
    if (context.includes("security") && issue.includes("security")) return 0.9;
    if (context.includes("performance") && issue.includes("performance")) return 0.8;
    return 0.5;
  }

  private calculateEaseForImprovement(finding: ValidationIssue): number {
    // Safer calculation with default values
    return finding.severity === "low" ? 0.9 : finding.severity === "medium" ? 0.7 : 0.5;
  }

  private calculateUrgency(finding: ValidationIssue): number {
    // Safer calculation with default values
    return finding.severity === "critical" ? 1.0 : finding.severity === "high" ? 0.8 : 0.6;
  }

  private formatWhy(issue: string): string {
    return `Fixing ${issue} will improve your system's reliability and performance`;
  }

  private applySpecificAreasFilter(improvements: any[], areas?: string[]): any[] {
    if (!areas || areas.length === 0) return improvements;
    return improvements.filter((imp) => areas.some((area) => imp.what.includes(area)));
  }
}
