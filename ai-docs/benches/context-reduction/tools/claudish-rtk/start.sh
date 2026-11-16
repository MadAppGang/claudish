#!/bin/sh
# Copies this variant's claudish config into the run's home.
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/../claudish/start.sh" "$here"
