#!/bin/sh
# Cases that build or test claudish: install its dependencies before the agent.
set -eu
bun install --frozen-lockfile
