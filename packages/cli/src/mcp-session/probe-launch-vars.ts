/**
 * The environment variables that decide what a Claude Code launch loads, beyond its config dir:
 * which plugins and from where ({@link PROBE_PLUGIN_VARS}), and which setting sources, plugins,
 * skills and MCP configs a launch mode takes away ({@link PROBE_MODE_VARS}). The plugin probe
 * takes each from the launch it stands for, and the caller's are read from the caller's own
 * launch environment ({@link CALLER_LAUNCH_ENV_KEYS}), never from this server's: Claude Code
 * 2.1.332 removes several of them from the environment it hands the processes it starts
 * (`delete e.CLAUDE_CODE_HOST_WORKTREE_FENCE,Y1a(e);for(let r of Object.keys(e)){let i=r.toUpperCase();if(i==="CLAUDE_CODE_PLUGIN_DIRS"||…||i==="CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS"||i==="CLAUDE_CODE_SKIP_PLUGIN_MCP_BUNDLES"||…)delete e[r]}`,
 * with `S=["CLAUDE_CODE_SAFE_MODE","CLAUDE_CODE_SIMPLE","CLAUDE_CODE_RESTRICTED",...[]]` and
 * `Y1a(_){for(let E of Object.keys(_))if(U.has(E.toUpperCase()))delete _[E]}`), and an MCP
 * server definition's `env` can set any of them for the server alone.
 * See ai-docs/architecture/mcp-sessions.md § The caller's plugin copies: `--plugin-dir`.
 */

/**
 * The variables Claude Code 2.1.332 reads to decide which plugins load and from where, handed to
 * the probe as the launch it stands for holds them, so its plugin list is that launch's:
 * - `CLAUDE_CODE_PLUGIN_CACHE_DIR`: the plugin folder,
 *   `Xd(){let e=s.CLAUDE_CODE_PLUGIN_CACHE_DIR;if(e)return $p(e);return k(nt(),B())}`;
 * - `CLAUDE_CODE_PLUGIN_SEED_DIR`: read-only seed folders,
 *   `oV(){let e=s.CLAUDE_CODE_PLUGIN_SEED_DIR;if(!e)return[];return e.split(Le).filter(Boolean).map($p)}`;
 * - `CLAUDE_CODE_PLUGIN_DIRS`: plugin folders loaded as `--plugin-dir` ones,
 *   `if(process.env.CLAUDE_CODE_PLUGIN_DIRS?.trim()){…setInlinePlugins…}` and
 *   `tEt(){let n=(s.CLAUDE_CODE_PLUGIN_DIRS??"").split(a)…}`;
 * - `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE`: marketplaces read from a zip cache in that folder,
 *   `w6(){return s.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE}function MCo(){if(!w6())return;let e=s.CLAUDE_CODE_PLUGIN_CACHE_DIR;…}`.
 *
 * `CLAUDE_CODE_USE_COWORK_PLUGINS` also decides which plugins load, and is not here: a launch
 * that sets it gets no probe ({@link PROBE_REFUSAL_ENV_KEYS}).
 *
 * The settings files' location is decided by `aOt=["CLAUDE_CONFIG_DIR","HOME","USERPROFILE",
 * "HOMEDRIVE","HOMEPATH","CLAUDE_CODE_USE_COWORK_PLUGINS"]` (`settings_moved` when one differs
 * from the launch's); the middle three are Windows names, and no probe runs on Windows. The
 * managed settings folder reads no variable
 * (`hr(){let e=qSa();if(e!==void 0)return e;switch(C()){case"macos":return"/Library/Application Support/ClaudeCode";…}`
 * with `qSa(){return}`). Left out: `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` and
 * `FORCE_AUTOUPDATE_PLUGINS`, which install or update plugins over the network rather than
 * choose among the installed ones.
 */
export const PROBE_PLUGIN_VARS = [
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE",
] as const;

/**
 * Claude Code 2.1.332's launch mode switches: each read at a `-p` boot, and each only takes away
 * setting sources, plugins, skills or MCP configs, so a probe given one loads less, never more.
 * A value the launch holds passes through as it is; the probe never sets one itself.
 * - `CLAUDE_CODE_RESTRICTED`: no user, project or local settings, as `--restricted`, so no
 *   plugin they enable is in the init list (measured: a user-enabled and a project-enabled
 *   plugin both leave it),
 *   `ILe(){return He(process.env.CLAUDE_CODE_RESTRICTED)}` and
 *   `qNs(){let e=J_("--setting-sources");if(e!==void 0)m(e);if(Zv("--restricted")||ILe())m(""),LKo(!0);…}`;
 * - `CLAUDE_CODE_SAFE_MODE`: no installed plugin's commands or skills, no skill, hook or MCP
 *   server, as `--safe-mode`, `ms(){return He(process.env.CLAUDE_CODE_SAFE_MODE)||kZt("--safe-mode")||!1}`,
 *   `Jo(e,t){if(o[e]&&V())return!0;if(ms()&&!a[e])return!0;if(eo()&&!t?.explicitlyRequested)return l[e];return!1}`
 *   with `a={claudeMd:!1,skills:!1,workflows:!1,plugins:!1,…}`, and the plugin command and skill
 *   loaders' `if(Jo("plugins",{explicitlyRequested:r.handedIn!==void 0||vE().length>0||oI().length>0||vRe().length>0}))return[]`.
 *   Measured on 2.1.332: the init event's `plugins` list is the same with and without it;
 * - `CLAUDE_CODE_SIMPLE`: bare mode, as `--bare`, `eo(){return He(process.env.CLAUDE_CODE_SIMPLE)||kZt("--bare")}`
 *   and the same `Jo` with `l={claudeMd:!0,skills:!0,workflows:!1,plugins:!0,…}`: no installed
 *   plugin's commands or skills unless the command line names a plugin (the init `plugins` list
 *   is again unchanged, measured);
 * - `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG`: no plugin from the user's own skills folder,
 *   `cb(){return s.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG===!0||He(o?.()?.CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG)}`
 *   and `h=cb(),…if(Le.scope==="user"&&h)return y++,!1;…t(…[skill-as-plugin] not loading plugins from ${y} folder(s) in your own skills directory (CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG); they load as skills only…)`;
 * - `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`:
 *   `k7(i){return s.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS||(i??Rt()).disableBundledSkills===!0}`;
 * - `CLAUDE_CODE_DISABLE_POLICY_SKILLS`:
 *   `s.CLAUDE_CODE_DISABLE_POLICY_SKILLS||hCe()||Ye?Promise.resolve([]):Xz(h,"policySettings")`;
 * - `CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL`, `CLAUDE_CODE_DISABLE_CLAUDE_CODE_SKILL`:
 *   `g({disabled:s.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL===!0});…y({disabled:s.CLAUDE_CODE_DISABLE_CLAUDE_CODE_SKILL===!0})`;
 * - `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS` and its exceptions `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT`:
 *   `if(s.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS){if(!rAo(e,{fullIdsOnly:!1})){t(…Skipping plugin MCP server discovery for "${e.name}" (CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS is set)…);return}…`
 *   with `rAo(e,{fullIdsOnly:n}){let r=s.CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT;if(!r)return!1;…}`;
 * - `CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS`, `CLAUDE_CODE_SKIP_PLUGIN_MCP_BUNDLES`:
 *   `L=!A&&s.CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS,z=L||!A&&s.CLAUDE_CODE_SKIP_PLUGIN_MCP_BUNDLES`;
 * - `ENABLE_CLAUDEAI_MCP_SERVERS`: no claude.ai connector,
 *   `Hwr(){return s.ENABLE_CLAUDEAI_MCP_SERVERS===!1?"env_var":NWe()?"setting":void 0}`.
 *
 * Read and left out: `CLAUDE_CODE_MANAGED_SETTINGS_PATH` and `CLAUDE_CODE_REMOTE_SETTINGS_PATH`,
 * whose readers are empty in this build (`qSa(){return}`, `bH(){return}`);
 * `CLAUDE_CODE_SHOWN_PLUGINS_DIR` and `CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR`, read only under
 * a desktop host (`n.setShownPluginsDir(wX()&&a!==void 0&&L(a)?a:void 0)`,
 * `n.setDesktopSkillsPluginDir(d?s.CLAUDE_CODE_DESKTOP_SKILLS_PLUGIN_DIR:void 0)` with `d=iu()`);
 * `CLAUDE_CODE_MCP_SERVE_SETTINGS` and `CLAUDE_CODE_MCP_SERVE_ENABLED_PLUGINS`, read only by
 * `claude mcp serve` (`Xb=Q9(e,null)` with `e=…toolServerShape`); `CLAUDE_CODE_REMOTE_MCP_CONFIG`,
 * read only in a remote session (`let n=Ku()?s.CLAUDE_CODE_REMOTE_MCP_CONFIG:void 0`);
 * `CLAUDE_CODE_PERSONAL_HOOKS_OFF` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, which change hooks and
 * CLAUDE.md files only; `CLAUDE_CODE_PLUGIN_DIR_WATCH`, which changes which `--plugin-dir` folders
 * are watched, not loaded; and the plugin and skill sync switches (`CLAUDE_CODE_SYNC_PLUGINS`,
 * `CLAUDE_CODE_SYNC_SKILLS`, …), which install over the network.
 */
export const PROBE_MODE_VARS = [
  "CLAUDE_CODE_RESTRICTED",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG",
  "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS",
  "CLAUDE_CODE_DISABLE_POLICY_SKILLS",
  "CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL",
  "CLAUDE_CODE_DISABLE_CLAUDE_CODE_SKILL",
  "CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS",
  "CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT",
  "CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS",
  "CLAUDE_CODE_SKIP_PLUGIN_MCP_BUNDLES",
  "ENABLE_CLAUDEAI_MCP_SERVERS",
] as const;

/**
 * The only keys read from the caller's launch environment: its config dir, which decides its
 * install rows and user settings, then {@link PROBE_PLUGIN_VARS} and {@link PROBE_MODE_VARS}.
 * No other value of that environment is kept.
 */
export const CALLER_LAUNCH_ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  ...PROBE_PLUGIN_VARS,
  ...PROBE_MODE_VARS,
] as const;

export type CallerLaunchEnvKey = (typeof CALLER_LAUNCH_ENV_KEYS)[number];

/**
 * Cowork plugins mode's switch in Claude Code 2.1.332. It moves the plugin folder and the user
 * settings file: `B(){if(eqo())return H;if(s.CLAUDE_CODE_USE_COWORK_PLUGINS)return H;return re}`
 * (`re="plugins"`, `H="cowork_plugins"`) and
 * `ws(e){if(e.coworkPlugins||s.CLAUDE_CODE_USE_COWORK_PLUGINS)return LO.cowork;return LO.default}`
 * with `LO={default:"settings.json",cowork:"cowork_settings.json"}`. It is read as a boolean,
 * `CLAUDE_CODE_USE_COWORK_PLUGINS:()=>uD` with `uD=L.bool()` and `bool:()=>m`,
 * `m=r((n)=>He(n))`. claudish does not model `cowork_settings.json` or `cowork_plugins`, so a
 * launch in that mode gets no probe: the switch is read only to refuse, never handed to a probe.
 */
export const PROBE_COWORK_SWITCH = "CLAUDE_CODE_USE_COWORK_PLUGINS";

/** The launch environment keys read only to refuse a probe: {@link PROBE_COWORK_SWITCH}. */
export const PROBE_REFUSAL_ENV_KEYS = [PROBE_COWORK_SWITCH] as const;

/**
 * Every key read from the caller's launch environment: {@link CALLER_LAUNCH_ENV_KEYS}, which a
 * caller probe is given, then {@link PROBE_REFUSAL_ENV_KEYS}, which only refuse.
 */
export const HOST_READ_ENV_KEYS = [...CALLER_LAUNCH_ENV_KEYS, ...PROBE_REFUSAL_ENV_KEYS] as const;

export type HostReadEnvKey = (typeof HOST_READ_ENV_KEYS)[number];
