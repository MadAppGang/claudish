import type { BenchObservation, Check } from "./types.js";

const REQUIRED_MODELS = 3;
const CATALOG_TOOL = /list_models|search_models/;

function catalogCalls(obs: BenchObservation): BenchObservation["calls"] {
  return obs.calls.filter((call) => CATALOG_TOOL.test(call.tool));
}

function distinctModelsUsed(obs: BenchObservation): string[] {
  const runPromptCalls = obs.calls.filter((call) => call.tool === "run_prompt");
  const modelBearingCalls = runPromptCalls.length > 0 ? runPromptCalls : obs.calls;
  return [
    ...new Set(
      modelBearingCalls.map((call) => call.model?.trim() ?? "").filter((model) => model.length > 0)
    ),
  ];
}

function excerpt(text: string): string {
  const first = text.slice(0, 120);
  return first.length > 0 ? (JSON.stringify(first) ?? '""') : "<empty>";
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(", ") : "<none>";
}

function modelIdsNearMatch(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

function resultMentionsModel(resultText: string, model: string): boolean {
  const normalized = model.trim().toLowerCase();
  const unprefixed = normalized.split("/").at(-1) ?? normalized;
  const result = resultText.toLowerCase();
  return result.includes(normalized) || result.includes(unprefixed);
}

export const CHECKS: Check[] = [
  // A clean process exit is the boundary between a completed benchmark and
  // partial evidence left behind by a crash or timeout.
  {
    id: "session-completed",
    description: "The real Claude Code session completed without timing out.",
    run(obs) {
      if (obs.exitCode === 0 && obs.timedOut === false) return [];
      return [
        `Expected the session to exit with code 0 and timedOut=false; observed exitCode=${obs.exitCode} and timedOut=${obs.timedOut}.`,
      ];
    },
  },

  // The init frame is the protocol's own record of what the model actually had
  // available when it decided what to do; prose in the transcript proves
  // nothing and could claim a connection or tool that never existed.
  {
    id: "mcp-connected",
    description: "Claudish was connected and exposed an MCP tool in the session init frame.",
    run(obs) {
      if (!obs.init) {
        return [
          "Expected a system/init frame recording a connected claudish server and claudish MCP tool; observed no init frame.",
        ];
      }

      const servers = obs.init.mcp_servers ?? [];
      const tools = obs.init.tools ?? [];
      const failures: string[] = [];
      const connected = servers.some(
        (server) => server.name.toLowerCase().includes("claudish") && server.status === "connected"
      );
      const claudishTool = tools.some(
        (tool) => tool.startsWith("mcp__") && tool.toLowerCase().includes("claudish")
      );

      if (!connected) {
        const observed = servers.map((server) => `${server.name}:${server.status}`);
        failures.push(
          `Expected init.mcp_servers to contain a claudish entry with status=connected; observed ${formatList(observed)}.`
        );
      }
      if (!claudishTool) {
        failures.push(
          `Expected init.tools to contain a name starting with mcp__ and containing claudish; observed ${formatList(tools)}.`
        );
      }
      return failures;
    },
  },

  // Requiring a successful catalog call keeps "latest" as the agent's live
  // resolution and catches regressions where it skips discovery and guesses.
  {
    id: "catalog-consulted",
    description: "The agent successfully consulted claudish's live model catalog.",
    run(obs) {
      const calls = catalogCalls(obs);
      if (calls.some((call) => call.isError === false)) return [];

      const observed =
        calls.length > 0
          ? calls
              .map(
                (call) =>
                  `${call.tool} (isError=${call.isError}, result excerpt=${excerpt(call.resultText)})`
              )
              .join("; ")
          : "no list_models or search_models calls";
      return [
        `Expected at least one non-error list_models or search_models call; observed ${observed}.`,
      ];
    },
  },

  // Distinct model ids prove the agent routed across the requested breadth
  // instead of repeating one model or making model-free prompt calls.
  {
    id: "three-distinct-models",
    description: "At least three distinct non-empty model ids were used.",
    run(obs) {
      const models = distinctModelsUsed(obs);
      if (models.length >= REQUIRED_MODELS) return [];

      const hasRunPromptCalls = obs.calls.some((call) => call.tool === "run_prompt");
      const source = hasRunPromptCalls ? "run_prompt calls" : "fallback model-bearing calls";
      return [
        `Expected at least ${REQUIRED_MODELS} distinct non-empty model ids from ${source}; observed ${models.length}: ${formatList(models)}.`,
      ];
    },
  },

  // Catalog corroboration catches hallucinated ids. Aggregators routinely add
  // vendor prefixes, so ids match when either lowercased id contains the other;
  // a false failure here is worse than admitting that deliberate near-match.
  {
    id: "models-are-real",
    description: "Every model used was corroborated by the catalog this session saw.",
    run(obs) {
      const models = distinctModelsUsed(obs);
      const calls = catalogCalls(obs);
      const uncorroborated = models.filter(
        (model) =>
          !obs.catalogModels.some((catalogModel) => modelIdsNearMatch(model, catalogModel)) &&
          !calls.some((call) => resultMentionsModel(call.resultText, model))
      );
      if (uncorroborated.length === 0) return [];

      const resultExcerpts = calls.map((call) => `${call.tool}: ${excerpt(call.resultText)}`);
      return [
        `Expected every used model to appear in obs.catalogModels or a list_models/search_models result; uncorroborated models were ${formatList(uncorroborated)}. Observed catalogModels=${formatList(obs.catalogModels)} and catalog result excerpts=${formatList(resultExcerpts)}.`,
      ];
    },
  },

  // A tool invocation is not completion: each chosen model must have at least
  // one successful result containing the one protocol-independent answer.
  {
    id: "every-model-answered",
    description: "Every model used returned the expected arithmetic answer without an error.",
    run(obs) {
      const failures: string[] = [];
      for (const model of distinctModelsUsed(obs)) {
        const calls = obs.calls.filter(
          (call) => call.tool === "run_prompt" && call.model?.trim() === model
        );
        if (
          calls.some(
            (call) => call.isError === false && call.resultText.includes(obs.expectedAnswer)
          )
        ) {
          continue;
        }

        if (calls.length === 0) {
          failures.push(
            `Expected model \`${model}\` to have a non-error run_prompt result containing \`${obs.expectedAnswer}\`; observed no run_prompt call for that model and no result text to excerpt.`
          );
          continue;
        }

        const nonErrorCalls = calls.filter((call) => call.isError === false);
        if (nonErrorCalls.length === 0) {
          failures.push(
            `Expected model \`${model}\` to have a run_prompt call with isError=false; observed ${calls.length} call(s), all with isError=true. Result excerpts: ${calls.map((call) => excerpt(call.resultText)).join(", ")}.`
          );
          continue;
        }

        failures.push(
          `Expected a non-error run_prompt result for model \`${model}\` to contain \`${obs.expectedAnswer}\`; observed ${nonErrorCalls.length} non-error result(s), none containing it. Result excerpts: ${nonErrorCalls.map((call) => excerpt(call.resultText)).join(", ")}.`
        );
      }
      return failures;
    },
  },

  // Even when enough models answer, any errored claudish call is a real partial
  // failure that would otherwise disappear behind the successful subset.
  {
    id: "no-tool-errors",
    description: "No claudish MCP tool call returned an error.",
    run(obs) {
      return obs.calls
        .filter((call) => call.isError === true)
        .map(
          (call) =>
            `Expected no claudish tool errors; observed ${call.tool} with isError=true and result excerpt=${excerpt(call.resultText)}.`
        );
    },
  },
];
