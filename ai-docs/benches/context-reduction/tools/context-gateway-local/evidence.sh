#!/bin/sh
# Prints the gateway's counts under this variant's name and stops it.
here=$(cd "$(dirname "$0")" && pwd)
exec sh "$here/../context-gateway/evidence.sh" context-gateway-local
