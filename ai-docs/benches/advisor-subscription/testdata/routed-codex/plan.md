# Cache plan

Reference: heron-5521

We want to cache the parsed config of a CLI tool between runs. The plan is to write the
parsed JSON to `/tmp/cli-config-cache.json` and reuse it whenever the file exists, without
checking whether the source config changed since the cache was written.
