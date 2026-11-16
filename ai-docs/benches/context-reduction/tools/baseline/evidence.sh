#!/bin/sh
# Runs after the agent stopped. Prints what the context-reduction tool recorded
# about its own work. The baseline has no tool.
echo "variant=baseline"
echo "tool=none"
exit 0
