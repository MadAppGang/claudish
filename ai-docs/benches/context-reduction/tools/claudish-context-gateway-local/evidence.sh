#!/bin/sh
# The claudish proof first, then the gateway's own counts; stops the gateway.
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../claudish/evidence.sh"
exec sh "$here/../context-gateway/evidence.sh" claudish-context-gateway-local
