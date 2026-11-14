#!/bin/sh
# Copies this variant's claudish config into the run's home, then starts
# the gateway with the native local variant's config. The gateway forwards each
# request to claudish's proxy on loopback, which it refuses unless allowed here.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../claudish/start.sh" "$here"
export GATEWAY_ALLOWED_HOSTS=127.0.0.1
exec sh "$here/../context-gateway/start.sh" "$here/../context-gateway-local/config.yaml"
