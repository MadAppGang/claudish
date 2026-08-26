/**
 * Session-event test fixtures — DERIVED FROM A REAL CAPTURED TRANSCRIPT
 * (repo rule: no hand-crafted fixtures).
 *
 * Source: ~/.claude/projects/-Users-jack-mag-claudish-packages-cli/
 *         4365c8f1-eb14-42b5-9d60-e69ad47e5fb3.jsonl (Claude Code 2.1.207,
 *         captured 2026-07-13). Lines copied verbatim.
 */

/** Real user line: `/effort ultracode` local-command stdout (scope: session only). */
export const FIXTURE_EFFORT_ULTRACODE_STDOUT = `{"parentUuid":"e24c5a75-8635-42ea-8365-585fa61dfda6","isSidechain":false,"promptId":"01f92171-1609-4cd4-8f02-648c74ee4dd2","type":"user","message":{"role":"user","content":"<local-command-stdout>Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration</local-command-stdout>"},"uuid":"ed1a6a25-4bf7-4ed2-b383-2aa63a91b01e","timestamp":"2026-07-13T13:31:05.055Z","userType":"external","entrypoint":"cli","cwd":"/Users/jack/mag/claudish/packages/cli","sessionId":"4365c8f1-eb14-42b5-9d60-e69ad47e5fb3","version":"2.1.207","gitBranch":"main"}`;

/** Real attachment line: ultracode mode entered. */
export const FIXTURE_ULTRA_EFFORT_ENTER = `{"parentUuid":"7091946b-1c08-4474-ab83-adef45cf09dc","isSidechain":false,"attachment":{"type":"ultra_effort_enter","reminderType":"full"},"type":"attachment","uuid":"5bc1a151-0908-4d6f-807e-cd5280dfc550","timestamp":"2026-07-13T13:31:08.930Z","userType":"external","entrypoint":"cli","cwd":"/Users/jack/mag/claudish/packages/cli","sessionId":"4365c8f1-eb14-42b5-9d60-e69ad47e5fb3","version":"2.1.207","gitBranch":"main"}`;

/** Real user line: `/effort high` local-command stdout (scope: saved as default). */
export const FIXTURE_EFFORT_HIGH_DEFAULT_STDOUT = `{"parentUuid":"06896b8a-b70d-4792-9d14-369df7af2aee","isSidechain":false,"promptId":"271dfb8d-8713-46d6-8e51-fdd88fcea3f4","type":"user","message":{"role":"user","content":"<local-command-stdout>Set effort level to high (saved as your default for new sessions): Comprehensive implementation with extensive testing and documentation</local-command-stdout>"},"uuid":"94a76c05-a155-47bd-9514-b9d54c2de80f","timestamp":"2026-07-13T13:31:26.234Z","userType":"external","entrypoint":"cli","cwd":"/Users/jack/mag/claudish/packages/cli","sessionId":"4365c8f1-eb14-42b5-9d60-e69ad47e5fb3","version":"2.1.207","gitBranch":"main"}`;

/** Real attachment line: ultracode mode exited. */
export const FIXTURE_ULTRA_EFFORT_EXIT = `{"parentUuid":"400eb219-eae9-4ac1-bcc1-24bbb95f59ad","isSidechain":false,"attachment":{"type":"ultra_effort_exit"},"type":"attachment","uuid":"5418c102-e293-4f70-865e-b7445a2cd0f2","timestamp":"2026-07-13T13:31:32.054Z","userType":"external","entrypoint":"cli","cwd":"/Users/jack/mag/claudish/packages/cli","sessionId":"4365c8f1-eb14-42b5-9d60-e69ad47e5fb3","version":"2.1.207","gitBranch":"main"}`;

/** The session id embedded in every fixture line above. */
export const FIXTURE_SESSION_ID = "4365c8f1-eb14-42b5-9d60-e69ad47e5fb3";
