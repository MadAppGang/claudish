#!/bin/sh
# Runs after the agent stopped. Prints rtk's own count of what it condensed.
echo "variant=rtk"
echo "tool=$(rtk --version 2>&1 | head -1)"
rtk gain 2>&1 | head -c 1500
exit 0
