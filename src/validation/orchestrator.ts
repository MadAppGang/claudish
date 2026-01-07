import type {
  ValidationResult,
  ValidationReport,
  ValidationIssue,
  ValidationSuggestion,
  ImprovementPlan,
} from "./types.js";
import type { BaseValidator } from "./validator.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "mcp__claude-global-tools__glob";
import { SeniorCodeReviewerValidationFormatter } from "./formatters.js";

export interface OrchestratorOptions {
  projectPath?: string;
  validateAgents?: boolean;
  validateCommands?: boolean;
  validateDocumentation?: boolean;
  specificAreas?: string[];
}

export class ValidationOrchestrator {
  private projectPath: string;
  private options: OrchestratorOptions;
  private validators: Map<string, BaseValidator> = new Map();

  constructor(options: OrchestratorOptions = {}) {
    this.projectPath = options.projectPath || ".";
    this.options = {
      validateAgents: true,
      validateCommands: true,
      validateDocumentation: true,
      ...options,
    };
  }

  /**
   * Register validators based on what exists in the project
   */
  async registerValidators(): Promise<void> {
    // Check what exists in the project
    const hasAgents = existsSync(join(this.projectPath, ".claude/agents"));
    const hasCommands = existsSync(join(this.projectPath, ".claude/commands"));
    const hasSkills = existsSync(join(this.projectPath, ".claude/skills"));
    const hasClaudeMd = existsSync(join(this.projectPath, "CLAUDE.md"));

    // Project validator (always included)
    const { ProjectValidator } = await import("./validators/project-validator.js");
    this.validators.set("project", new ProjectValidator(this.projectPath));

    // Agent validator
    if (this.options.validateAgents && hasAgents) {
      const { AgentValidator } = await import("./validators/agent-validator.js");
      this.validators.set("agents", new AgentValidator(this.projectPath));
    }

    // Command validator
    if (this.options.validateCommands && hasCommands) {
      const { CommandValidator } = await import("./validators/command-validator.js");
      this.validators.set("commands", new CommandValidator(this.projectPath));
    }

    // Skill validator
    if (this.options.validateCommands && hasSkills) {
      const { SkillValidator } = await import("./validators/skill-validator.js");
      this.validators.set("skills", new SkillValidator(this.projectPath));
    }

    // Documentation validator
    if (this.options.validateDocumentation && hasClaudeMd) {
      const { DocumentationValidator } = await import("./validators/documentation-validator.js");
      this.validators.set("documentation", new DocumentationValidator(this.projectPath));
    }
  }

  /**
   * Run all validators and generate comprehensive results
   */
  async run(): Promise<ValidationResult> {
    await this.registerValidators();

    const result: ValidationResult = {
      project: {
        issues: [],
        summary: {
          total: 0,
          bySeverity: { critical: [], high: [], medium: [], low: [] },
          byCategory: { mandatory: [], recommended: [], optional: [] },
        },
      },
      agents: {
        issues: [],
        summary: {
          total: 0,
          bySeverity: { critical: [], high: [], medium: [], low: [] },
          byCategory: { mandatory: [], recommended: [], optional: [] },
        },
      },
      commands: {
        issues: [],
        summary: {
          total: 0,
          bySeverity: { critical: [], high: [], medium: [], low: [] },
          byCategory: { mandatory: [], recommended: [], optional: [] },
        },
      },
      skills: {
        issues: [],
        summary: {
          total: 0,
          bySeverity: { critical: [], high: [], medium: [], low: [] },
          byCategory: { mandatory: [], recommended: [], optional: [] },
        },
      },
      documentation: {
        issues: [],
        summary: {
          total: 0,
          bySeverity: { critical: [], high: [], medium: [], low: [] },
          byCategory: { mandatory: [], recommended: [], optional: [] },
        },
      },
    };

    // Run each validator
    for (const [key, validator] of this.validators) {
      const report = validator.generateReport();

      switch (key) {
        case "project":
          result.project = report;
          break;
        case "agents":
          result.agents = report;
          break;
        case "commands":
          result.commands = report;
          break;
        case "skills":
          result.skills = report;
          break;
        case "documentation":
          result.documentation = report;
          break;
      }
    }

    return result;
  }

  /**
   * Generate improvement plan using MOST LIKELY methodology
   */
  generateImprovementPlan(result: ValidationResult): ImprovementPlan {
    const allIssues: ValidationIssue[] = [
      ...result.project.issues,
      ...result.agents.issues,
      ...result.commands.issues,
      ...result.skills.issues,
      ...result.documentation.issues,
    ];

    const suggestions = this.generateImprovementSuggestions(allIssues);

    const todos = suggestions
      .filter((s) => s.score > 0.5)
      .slice(0, 10)
      .map((s) => `${s.what} (priority: ${s.score > 0.7 ? "high" : "medium"})`);

    return {
      suggestions,
      todos,
      effort: this.calculateOverallEffort(suggestions),
      priorityIssues: todos.slice(0, 5),
      estimatedTime: this.calculateEstimatedTime(suggestions),
    };
  }

  /**
   * Generate structured improvement suggestions
   */
  private generateImprovementSuggestions(issues: ValidationIssue[]): ValidationSuggestion[] {
    const suggestions: ValidationSuggestion[] = [];

    for (const issue of issues.slice(0, 10)) {
      // Top 10 issues
      const likelyHypotheses = this.mostLikelyHypothesis(
        issue.message,
        issue.severity === "high" ? "high" : "medium"
      );

      for (const hypothesis of likelyHypotheses) {
        const impact = this.calculateImpact(issue);
        const ease = this.calculateEase(issue);
        const urgency = this.calculateUrgency(issue);

        suggestions.push({
          what: hypothesis,
          why: `Fixing ${hypothesis} will resolve: ${issue.message}`,
          impact,
          ease,
          urgency,
          score: impact * 0.4 + ease * 0.3 + urgency * 0.3,
        });
      }
    }

    // Sort by score and deduplicate
    return suggestions
      .sort((a, b) => b.score - a.score)
      .filter((item, index, self) => self.findIndex((t) => t.what === item.what) === index)
      .slice(0, 20);
  }

  private calculateImpact(issue: ValidationIssue): number {
    const severityWeights = { critical: 1.0, high: 0.8, medium: 0.6, low: 0.3 };
    const categoryWeights = { mandatory: 1.0, recommended: 0.7, optional: 0.4 };

    return severityWeights[issue.severity] * categoryWeights[issue.category];
  }

  private calculateEase(issue: ValidationIssue): number {
    // Lower severity = easier to fix
    const severityWeights = { critical: 0.3, high: 0.5, medium: 0.7, low: 0.9 };
    return severityWeights[issue.severity];
  }

  private calculateUrgency(issue: ValidationIssue): number {
    const urgencyByCategory = { mandatory: 1.0, recommended: 0.6, optional: 0.3 };
    const urgencyBySeverity = { critical: 1.0, high: 0.8, medium: 0.5, low: 0.2 };

    return urgencyByCategory[issue.category] * urgencyBySeverity[issue.severity];
  }

  private calculateOverallEffort(suggestions: ValidationSuggestion[]): "low" | "medium" | "high" {
    const highEffortCount = suggestions.filter((s) => s.ease < 0.5).length;
    if (highEffortCount > 5) return "high";
    if (highEffortCount > 2) return "medium";
    return "low";
  }

  private calculateEstimatedTime(suggestions: ValidationSuggestion[]): string {
    const totalEffort = suggestions.reduce((sum, s) => sum + (1 - s.ease), 0);
    if (totalEffort < 5) return "1-2 hours";
    if (totalEffort < 10) return "2-4 hours";
    if (totalEffort < 20) return "0.5-1 day";
    return "1-3 days";
  }

  /**
   * MOST LIKELY hypothesis generation
   */
  private mostLikelyHypothesis(
    whatMightGoWrong: string,
    confidence: "high" | "medium" | "low",
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

    const key = Array.isArray(whatMightGoWrong) ? whatMightGoWrong[0] : whatMightGoWrong;

    for (const category in likelyIssues) {
      const issues = likelyIssues[category as keyof typeof likelyIssues];
      for (const issue of issues) {
        if (issue.includes(key)) {
          return issues;
        }
      }
    }

    return Array.isArray(whatMightGoWrong) ? whatMightGoWrong : [whatMightGoWrong];
  }

  private mostLikelyAnswer(): string[] {
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
   * Generate human-readable report
   */
  generateReport(result: ValidationResult, plan: ImprovementPlan): string {
    const formatter = new SeniorCodeReviewerValidationFormatter();
    return formatter.format(result, plan);
  }

  /**
   * Apply improvements automatically (if --apply flag used)
   */
  async applyImprovements(plan: ImprovementPlan): Promise<void> {
    // This would be implemented to actually apply the improvements
    // For now, it's a placeholder
    return;
  }
}

export { ValidationOrchestrator };
