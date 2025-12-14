# Claudish - Development Notes

## Release Process

**Releases are handled by CI/CD** - do NOT manually run `npm publish`.

1. Bump version in `package.json`
2. Commit with conventional commit message (e.g., `feat!: v3.0.0 - description`)
3. Create annotated tag: `git tag -a v3.0.0 -m "message"`
4. Push with tags: `git push origin main --tags`
5. CI/CD will automatically publish to npm

## Build Commands

- `bun run build` - Full build (extracts models + bundles)
- `bun run build:ci` - CI build (bundles only, no model extraction)
- `bun run dev` - Development mode

## Local Model Support

Claudish supports local models via:
- **Ollama**: `claudish --model ollama/llama3.2`
- **LM Studio**: `claudish --model lmstudio/model-name`
- **Custom URLs**: `claudish --model http://localhost:11434/model`

### Context Tracking for Local Models

Local model APIs (LM Studio, Ollama) report `prompt_tokens` as the **full conversation context** each request, not incremental tokens. The `writeTokenFile` function uses assignment (`=`) not accumulation (`+=`) for input tokens to handle this correctly.

## Debug Logging

Debug logging is behind the `--debug` flag and outputs to `logs/` directory. It's disabled by default.
