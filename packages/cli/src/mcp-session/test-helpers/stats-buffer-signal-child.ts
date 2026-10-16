#!/usr/bin/env bun

// Import the same module-load signal handler that runs first in every claudish
// model process, then stay alive until the parent test sends a real signal.
import "../../stats-buffer.js";

process.stdout.write("ready\n");
setInterval(() => {}, 60_000);
