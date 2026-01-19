import Foundation
import SwiftUI

// MARK: - Model Types

/// Provider category for models
enum ModelProviderType: String, Codable, CaseIterable {
    case openrouter = "OpenRouter"
    case openai = "OpenAI"
    case gemini = "Gemini"
    case kimi = "Kimi"
    case minimax = "MiniMax"
    case glm = "GLM"

    var prefix: String {
        switch self {
        case .openrouter: return ""  // OpenRouter uses full model IDs
        case .openai: return "oai/"
        case .gemini: return "g/"
        case .kimi: return "kimi/"
        case .minimax: return "mm/"
        case .glm: return "glm/"
        }
    }

    var icon: String {
        switch self {
        case .openrouter: return "globe"
        case .openai: return "brain"
        case .gemini: return "sparkles"
        case .kimi: return "moon.stars"
        case .minimax: return "bolt"
        case .glm: return "cpu"
        }
    }
}

/// Represents an available model from any provider
struct AvailableModel: Identifiable, Hashable {
    let id: String           // Full model ID for API calls
    let displayName: String  // Human-readable name
    let provider: ModelProviderType
    let description: String?
    let contextLength: Int?

    var searchText: String {
        "\(displayName) \(id) \(provider.rawValue) \(description ?? "")"
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: AvailableModel, rhs: AvailableModel) -> Bool {
        lhs.id == rhs.id
    }
}

// MARK: - OpenRouter API Types

struct OpenRouterModelsResponse: Codable {
    let data: [OpenRouterModel]
}

struct OpenRouterModel: Codable {
    let id: String
    let name: String
    let description: String?
    let contextLength: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case description
        case contextLength = "context_length"
    }
}

// MARK: - Model Provider

@MainActor
class ModelProvider: ObservableObject {
    static let shared = ModelProvider()

    @Published var allModels: [AvailableModel] = []
    @Published var isLoading = false
    @Published var lastError: String?
    @Published var lastFetchDate: Date?

    private let openRouterApiKey: String?

    init() {
        self.openRouterApiKey = ProcessInfo.processInfo.environment["OPENROUTER_API_KEY"]
        // Initialize with static models immediately
        self.allModels = Self.directApiModels

        // Auto-fetch OpenRouter models at startup
        Task {
            await fetchOpenRouterModels()
        }
    }

    // MARK: - Static Direct API Models

    static let directApiModels: [AvailableModel] = {
        var models: [AvailableModel] = []

        // OpenAI Direct API Models (GPT-5.x series)
        models.append(contentsOf: [
            AvailableModel(
                id: "oai/gpt-5.2",
                displayName: "GPT-5.2",
                provider: .openai,
                description: "Complex reasoning, broad knowledge, code-heavy tasks",
                contextLength: 128000
            ),
            AvailableModel(
                id: "oai/gpt-5.2-pro",
                displayName: "GPT-5.2 Pro",
                provider: .openai,
                description: "Tough problems requiring harder thinking",
                contextLength: 128000
            ),
            AvailableModel(
                id: "oai/gpt-5.2-codex",
                displayName: "GPT-5.2 Codex",
                provider: .openai,
                description: "Full spectrum coding tasks",
                contextLength: 128000
            ),
            AvailableModel(
                id: "oai/gpt-5-mini",
                displayName: "GPT-5 Mini",
                provider: .openai,
                description: "Cost-optimized reasoning and chat",
                contextLength: 128000
            ),
            AvailableModel(
                id: "oai/gpt-5-nano",
                displayName: "GPT-5 Nano",
                provider: .openai,
                description: "High-throughput, simple instruction-following",
                contextLength: 32000
            ),
        ])

        // Gemini Direct API Models
        models.append(contentsOf: [
            AvailableModel(
                id: "g/gemini-3-pro",
                displayName: "Gemini 3 Pro",
                provider: .gemini,
                description: "Most intelligent, multimodal understanding, agentic",
                contextLength: 1000000
            ),
            AvailableModel(
                id: "g/gemini-3-flash",
                displayName: "Gemini 3 Flash",
                provider: .gemini,
                description: "Balanced for speed, scale, and intelligence",
                contextLength: 1000000
            ),
            AvailableModel(
                id: "g/gemini-2.5-flash",
                displayName: "Gemini 2.5 Flash",
                provider: .gemini,
                description: "Best price-performance, agentic use cases",
                contextLength: 1000000
            ),
            AvailableModel(
                id: "g/gemini-2.5-flash-lite",
                displayName: "Gemini 2.5 Flash-Lite",
                provider: .gemini,
                description: "Ultra fast, cost-efficient, high throughput",
                contextLength: 1000000
            ),
            AvailableModel(
                id: "g/gemini-2.5-pro",
                displayName: "Gemini 2.5 Pro",
                provider: .gemini,
                description: "Advanced thinking, code, math, STEM, long context",
                contextLength: 1000000
            ),
        ])

        // Kimi Direct API Models
        models.append(contentsOf: [
            AvailableModel(
                id: "kimi/kimi-k2-0905-preview",
                displayName: "Kimi K2 0905",
                provider: .kimi,
                description: "1M context, latest preview",
                contextLength: 1000000
            ),
            AvailableModel(
                id: "kimi/kimi-k2-0711-preview",
                displayName: "Kimi K2 0711",
                provider: .kimi,
                description: "1M context, stable preview",
                contextLength: 1000000
            ),
            AvailableModel(
                id: "kimi/kimi-k2-turbo-preview",
                displayName: "Kimi K2 Turbo",
                provider: .kimi,
                description: "1M context, faster inference (Recommended)",
                contextLength: 1000000
            ),
            AvailableModel(
                id: "kimi/kimi-k2-thinking",
                displayName: "Kimi K2 Thinking",
                provider: .kimi,
                description: "1M context, enhanced reasoning",
                contextLength: 1000000
            ),
            AvailableModel(
                id: "kimi/kimi-k2-thinking-turbo",
                displayName: "Kimi K2 Thinking Turbo",
                provider: .kimi,
                description: "1M context, fast reasoning",
                contextLength: 1000000
            ),
        ])

        // MiniMax Direct API Models
        models.append(contentsOf: [
            AvailableModel(
                id: "mm/minimax-m2.1",
                displayName: "MiniMax M2.1",
                provider: .minimax,
                description: "230B params, optimized for code generation",
                contextLength: 200000
            ),
            AvailableModel(
                id: "mm/minimax-m2.1-lightning",
                displayName: "MiniMax M2.1 Lightning",
                provider: .minimax,
                description: "Same performance, significantly faster",
                contextLength: 200000
            ),
            AvailableModel(
                id: "mm/minimax-m2",
                displayName: "MiniMax M2",
                provider: .minimax,
                description: "200k context, agentic capabilities",
                contextLength: 200000
            ),
        ])

        // GLM Direct API Models
        models.append(contentsOf: [
            AvailableModel(
                id: "glm/glm-4.7",
                displayName: "GLM-4.7",
                provider: .glm,
                description: "Advanced Chinese/English language model",
                contextLength: 128000
            ),
        ])

        return models
    }()

    // MARK: - OpenRouter API

    func fetchOpenRouterModels() async {
        guard let apiKey = openRouterApiKey, !apiKey.isEmpty else {
            lastError = "OpenRouter API key not set"
            return
        }

        isLoading = true
        lastError = nil

        defer { isLoading = false }

        guard let url = URL(string: "https://openrouter.ai/api/v1/models") else {
            lastError = "Invalid OpenRouter URL"
            return
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                lastError = "Invalid response"
                return
            }

            guard httpResponse.statusCode == 200 else {
                lastError = "API error: \(httpResponse.statusCode)"
                return
            }

            let modelsResponse = try JSONDecoder().decode(OpenRouterModelsResponse.self, from: data)

            // Convert to AvailableModel
            let openRouterModels = modelsResponse.data.map { model in
                AvailableModel(
                    id: model.id,
                    displayName: model.name,
                    provider: .openrouter,
                    description: model.description,
                    contextLength: model.contextLength
                )
            }

            // Combine with static direct API models (direct APIs first)
            self.allModels = Self.directApiModels + openRouterModels
            self.lastFetchDate = Date()

            print("[ModelProvider] Loaded \(openRouterModels.count) OpenRouter models")

        } catch {
            lastError = "Failed to fetch models: \(error.localizedDescription)"
            print("[ModelProvider] Error: \(error)")
        }
    }

    // MARK: - Filtering

    func models(matching search: String) -> [AvailableModel] {
        if search.isEmpty {
            return allModels
        }
        return allModels.filter {
            $0.searchText.localizedCaseInsensitiveContains(search)
        }
    }

    func models(for provider: ModelProviderType) -> [AvailableModel] {
        allModels.filter { $0.provider == provider }
    }

    /// Group models by provider for display
    var modelsByProvider: [(provider: ModelProviderType, models: [AvailableModel])] {
        var result: [(ModelProviderType, [AvailableModel])] = []

        // Direct APIs first (in specific order)
        let directOrder: [ModelProviderType] = [.openai, .gemini, .kimi, .minimax, .glm]
        for provider in directOrder {
            let providerModels = models(for: provider)
            if !providerModels.isEmpty {
                result.append((provider, providerModels))
            }
        }

        // OpenRouter last
        let openRouterModels = models(for: .openrouter)
        if !openRouterModels.isEmpty {
            result.append((.openrouter, openRouterModels))
        }

        return result
    }
}
