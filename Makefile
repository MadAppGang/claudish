# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║                           CLAUDISH MAKEFILE                                ║
# ║         Run Claude Code with any OpenRouter model - CLI & MCP Server       ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

.PHONY: help install dev build test lint format check clean kill release

# Executables (use full path if bun not in PATH)
BUN := $(shell command -v bun 2>/dev/null || echo "$(HOME)/.bun/bin/bun")
BIOME := $(BUN) run biome
TSC := $(BUN) run tsc

# Colors for pretty output
CYAN := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RED := \033[31m
BOLD := \033[1m
RESET := \033[0m

# Default target
.DEFAULT_GOAL := help

# ┌───────────────────────────────────────────────────────────────────────────┐
# │                              HELP                                          │
# └───────────────────────────────────────────────────────────────────────────┘

help: ## Show this help message
	@printf "\n"
	@printf "$(BOLD)$(CYAN)╔═══════════════════════════════════════════════════════════════╗$(RESET)\n"
	@printf "$(BOLD)$(CYAN)║                    CLAUDISH DEVELOPER COMMANDS                ║$(RESET)\n"
	@printf "$(BOLD)$(CYAN)╚═══════════════════════════════════════════════════════════════╝$(RESET)\n"
	@printf "\n"
	@printf "$(BOLD)Usage:$(RESET) make $(GREEN)<target>$(RESET)\n"
	@printf "\n"
	@awk 'BEGIN {FS = ":.*##"} \
		/^[a-zA-Z_-]+:.*##/ { \
			printf "  $(GREEN)%-15s$(RESET) %s\n", $$1, $$2 \
		} \
		/^##@/ { \
			printf "\n$(BOLD)$(YELLOW)%s$(RESET)\n", substr($$0, 5) \
		}' $(MAKEFILE_LIST)
	@printf "\n"

##@ 🚀 Getting Started

install: ## Install all dependencies
	@echo "$(CYAN)📦 Installing dependencies...$(RESET)"
	@pnpm install
	@echo "$(GREEN)✓ Dependencies installed$(RESET)"

setup: install ## Full project setup (install + build)
	@$(MAKE) build
	@echo "$(GREEN)✓ Project setup complete$(RESET)"

##@ 🔨 Development

dev: ## Run development server (interactive mode)
	@echo "$(CYAN)🚀 Starting development server...$(RESET)"
	@$(BUN) run src/index.ts --interactive

dev-mcp: ## Run as MCP server
	@echo "$(CYAN)🔌 Starting MCP server...$(RESET)"
	@$(BUN) run src/index.ts --mcp

dev-monitor: ## Run with monitor mode (debug logging)
	@echo "$(CYAN)🔍 Starting with monitor mode...$(RESET)"
	@$(BUN) run src/index.ts --interactive --monitor

dev-grok: ## Run with Grok model
	@echo "$(CYAN)🤖 Starting with Grok model...$(RESET)"
	@$(BUN) run src/index.ts --interactive --model x-ai/grok-code-fast-1

dev-debug: ## Run with full debug output
	@echo "$(CYAN)🐛 Starting with debug mode...$(RESET)"
	@$(BUN) run src/index.ts --interactive --debug --log-level info

##@ 🏗️ Build

build: extract-models ## Build the project for production (includes model extraction)
	@echo "$(CYAN)🏗️  Building project...$(RESET)"
	@$(BUN) run build
	@echo "$(GREEN)✓ Build complete: dist/index.js$(RESET)"

build-watch: ## Build and watch for changes
	@echo "$(CYAN)👀 Building and watching...$(RESET)"
	@$(BUN) build src/index.ts --outdir dist --target node --watch

extract-models: ## Extract models from all providers
	@echo "$(CYAN)📋 Extracting models from all providers...$(RESET)"
	@$(BUN) run scripts/extract-models.ts all
	@echo "$(GREEN)✓ Models extracted$(RESET)"

extract-models-poe: ## Extract only Poe models
	@echo "$(CYAN)📋 Extracting Poe models...$(RESET)"
	@$(BUN) run scripts/extract-models.ts poe
	@echo "$(GREEN)✓ Poe models extracted$(RESET)"

extract-models-openrouter: ## Extract only OpenRouter models
	@echo "$(CYAN)📋 Extracting OpenRouter models...$(RESET)"
	@$(BUN) run scripts/extract-models.ts openrouter
	@echo "$(GREEN)✓ OpenRouter models extracted$(RESET)"

update-models: extract-models build ## Update models and rebuild (all providers)
	@echo "$(GREEN)✓ Models updated and rebuilt$(RESET)"

update-models-poe: extract-models-poe build ## Update only Poe models and rebuild
	@echo "$(GREEN)✓ Poe models updated and rebuilt$(RESET)"

update-models-openrouter: extract-models-openrouter build ## Update only OpenRouter models and rebuild
	@echo "$(GREEN)✓ OpenRouter models updated and rebuilt$(RESET)"

##@ ✅ Quality Assurance

check: ## Run ALL checks (format, lint, typecheck, test)
	@echo "$(BOLD)$(CYAN)🔍 Running all quality checks...$(RESET)"
	@$(MAKE) format-check
	@$(MAKE) lint
	@$(MAKE) typecheck
	@$(MAKE) test
	@echo ""
	@echo "$(BOLD)$(GREEN)✓ All checks passed!$(RESET)"

lint: ## Check code for linting issues
	@echo "$(CYAN)🔎 Checking for lint issues...$(RESET)"
	@$(BIOME) check .
	@echo "$(GREEN)✓ No lint issues$(RESET)"

lint-fix: ## Fix auto-fixable lint issues
	@echo "$(CYAN)🔧 Fixing lint issues...$(RESET)"
	@$(BIOME) check --fix .
	@echo "$(GREEN)✓ Lint issues fixed$(RESET)"

format: ## Auto-format all code
	@echo "$(CYAN)✨ Formatting code...$(RESET)"
	@$(BIOME) format --write .
	@echo "$(GREEN)✓ Code formatted$(RESET)"

format-check: ## Check formatting without making changes
	@echo "$(CYAN)📐 Checking code formatting...$(RESET)"
	@$(BIOME) format .
	@echo "$(GREEN)✓ Formatting OK$(RESET)"

typecheck: ## Run TypeScript type checking
	@echo "$(CYAN)🔬 Running type check...$(RESET)"
	@$(TSC) --noEmit
	@echo "$(GREEN)✓ Type check passed$(RESET)"

##@ 🧪 Testing

test: ## Run all tests
	@echo "$(CYAN)🧪 Running tests...$(RESET)"
	@$(BUN) test ./tests/comprehensive-model-test.ts

test-all: ## Run all test files
	@echo "$(CYAN)🧪 Running all test files...$(RESET)"
	@$(BUN) test ./tests/

test-watch: ## Run tests in watch mode
	@echo "$(CYAN)👀 Running tests in watch mode...$(RESET)"
	@$(BUN) test --watch ./tests/

test-grok: ## Run Grok adapter tests
	@echo "$(CYAN)🧪 Running Grok tests...$(RESET)"
	@$(BUN) test ./tests/grok-adapter.test.ts ./tests/grok-tool-format.test.ts

test-gemini: ## Run Gemini compatibility tests
	@echo "$(CYAN)🧪 Running Gemini tests...$(RESET)"
	@$(BUN) test ./tests/gemini-compatibility.test.ts

test-images: ## Run image handling tests
	@echo "$(CYAN)🧪 Running image tests...$(RESET)"
	@$(BUN) test ./tests/image-handling.test.ts ./tests/image-transformation.test.ts

##@ 📦 Installation & Distribution

link: ## Link package globally (for local development)
	@echo "$(CYAN)🔗 Linking package globally...$(RESET)"
	@npm link
	@echo "$(GREEN)✓ Package linked: 'claudish' command now available$(RESET)"

unlink: ## Unlink package globally
	@echo "$(CYAN)🔓 Unlinking package...$(RESET)"
	@npm unlink -g claudish
	@echo "$(GREEN)✓ Package unlinked$(RESET)"

install-global: build ## Build and install globally
	@echo "$(CYAN)🌍 Installing globally...$(RESET)"
	@npm link
	@echo "$(GREEN)✓ Claudish installed globally$(RESET)"

##@ 🧹 Cleanup & Utilities

clean: ## Clean build artifacts
	@echo "$(CYAN)🧹 Cleaning build artifacts...$(RESET)"
	@rm -rf dist/
	@rm -rf node_modules/.cache/
	@echo "$(GREEN)✓ Cleaned$(RESET)"

clean-all: clean ## Deep clean (including node_modules)
	@echo "$(CYAN)🧹 Deep cleaning...$(RESET)"
	@rm -rf node_modules/
	@echo "$(GREEN)✓ Deep cleaned (run 'make install' to restore)$(RESET)"

kill: ## Kill all running claudish processes
	@echo "$(CYAN)💀 Killing claudish processes...$(RESET)"
	@pkill -f 'bun.*claudish' 2>/dev/null || true
	@pkill -f 'claude.*claudish-settings' 2>/dev/null || true
	@echo "$(GREEN)✓ Processes killed$(RESET)"

##@ 🚢 Release

release: check build ## Prepare for release (run all checks + build)
	@echo ""
	@echo "$(BOLD)$(GREEN)╔═══════════════════════════════════════════════════════════════╗$(RESET)"
	@echo "$(BOLD)$(GREEN)║                    READY FOR RELEASE! 🎉                       ║$(RESET)"
	@echo "$(BOLD)$(GREEN)╚═══════════════════════════════════════════════════════════════╝$(RESET)"
	@echo ""
	@echo "Next steps:"
	@echo "  1. Update version in package.json"
	@echo "  2. git add . && git commit -m 'Release vX.X.X'"
	@echo "  3. git tag vX.X.X && git push --tags"
	@echo "  4. npm publish"
	@echo ""

# ┌───────────────────────────────────────────────────────────────────────────┐
# │                         QUICK ALIASES                                      │
# └───────────────────────────────────────────────────────────────────────────┘

# Shorthand aliases
i: install    ## Alias for install
d: dev        ## Alias for dev
b: build      ## Alias for build
t: test       ## Alias for test
l: lint       ## Alias for lint
f: format     ## Alias for format
c: check      ## Alias for check
