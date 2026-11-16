// The claudish_build of a variant that measures a local claudish build. It
// refuses to start, so a run that did not name the build errors at launch
// instead of measuring something else.
console.error("no claudish build given: pass --param claudish_build=/absolute/path/to/a/compiled/claudish");
process.exit(1);
