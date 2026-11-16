#!/bin/sh
# Starts the shared gateway script with this variant's config.
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/../context-gateway/start.sh" "$here/config.yaml"
