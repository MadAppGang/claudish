import Foundation

// MARK: - API Response Types

/// Health check response from bridge
struct HealthResponse: Codable {
    let status: String
    let version: String
    let uptime: Double
}

/// Proxy status response
struct ProxyStatus: Codable {
    let running: Bool
    let port: Int?
    let detectedApps: [DetectedApp]
    let totalRequests: Int
    let activeConnections: Int
    let uptime: Double
    let version: String
}

/// Detected application info
struct DetectedApp: Codable, Identifiable {
    let name: String
    let confidence: Double
    let userAgent: String
    let lastSeen: String
    let requestCount: Int

    var id: String { name }
}

/// Log entry
struct LogEntry: Codable, Identifiable {
    let timestamp: String
    let app: String
    let confidence: Double
    let requestedModel: String
    let targetModel: String
    let status: Int
    let latency: Int
    let inputTokens: Int
    let outputTokens: Int
    let cost: Double

    var id: String { timestamp }
}

/// Log response
struct LogResponse: Codable {
    let logs: [LogEntry]
    let total: Int
    let hasMore: Bool
    let nextOffset: Int?
}

/// Raw traffic entry for all intercepted requests
struct RawTrafficEntry: Codable, Identifiable {
    let timestamp: String
    let method: String
    let host: String
    let path: String
    let userAgent: String
    let origin: String?
    let contentType: String?
    let contentLength: Int?
    let detectedApp: String
    let confidence: Double

    var id: String { timestamp + path }
}

/// Traffic response
struct TrafficResponse: Codable {
    let traffic: [RawTrafficEntry]
    let total: Int
}

/// Generic API response
struct ApiResponse: Codable {
    let success: Bool
    let error: String?
}

// MARK: - Configuration Types

/// Bridge configuration
struct BridgeConfig: Codable {
    var defaultModel: String?
    var apps: [String: AppModelMapping]
    var enabled: Bool
}

/// Per-app model mapping
struct AppModelMapping: Codable {
    var modelMap: [String: String]
    var enabled: Bool
    var notes: String?
}

/// API keys for enabling proxy
struct ApiKeys: Codable {
    var openrouter: String?
    var openai: String?
    var gemini: String?
    var anthropic: String?
    var minimax: String?
    var kimi: String?
    var glm: String?
}

/// Options for starting the bridge proxy
struct BridgeStartOptions: Codable {
    let apiKeys: ApiKeys
    var port: Int?
}

// MARK: - Model Constants

/// Known Claude model names for mapping
enum ClaudeModel: String, CaseIterable {
    case opus = "claude-3-opus-20240229"
    case sonnet = "claude-3-sonnet-20240229"
    case haiku = "claude-3-haiku-20240307"
    case opus4 = "claude-sonnet-4-20250514"  // Claude 4 naming

    var displayName: String {
        switch self {
        case .opus: return "Claude 3 Opus"
        case .sonnet: return "Claude 3 Sonnet"
        case .haiku: return "Claude 3 Haiku"
        case .opus4: return "Claude 4 Sonnet"
        }
    }
}

/// Common target models for mapping
enum TargetModel: String, CaseIterable, Identifiable {
    // Passthrough (no routing)
    case passthrough = "internal"

    // Direct API models
    case minimaxM2 = "mm/minimax-m2.1"
    case glm47 = "z-ai/glm-4.7"
    case gemini3Pro = "g/gemini-3-pro-preview"
    case gpt52Codex = "oai/gpt-5.2-codex"
    case grokCodeFast = "x-ai/grok-code-fast-1"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .passthrough: return "Passthrough (Claude)"
        case .minimaxM2: return "MiniMax M2.1"
        case .glm47: return "GLM-4.7"
        case .gemini3Pro: return "Gemini 3 Pro"
        case .gpt52Codex: return "GPT-5.2 Codex"
        case .grokCodeFast: return "Grok Code Fast"
        }
    }
}

// MARK: - Profile Types

/// Model slots that can be remapped in a profile
struct ProfileSlots: Codable, Equatable {
    var opus: String
    var sonnet: String
    var haiku: String
    var subagent: String

    /// Create default passthrough slots (identity mapping)
    static var passthrough: ProfileSlots {
        ProfileSlots(
            opus: "claude-opus-4-5-20251101",
            sonnet: "claude-sonnet-4-5-20250929",
            haiku: "claude-3-haiku-20240307",
            subagent: "claude-sonnet-4-5-20250929"
        )
    }

    /// Create cost-optimized slots
    static var costSaver: ProfileSlots {
        ProfileSlots(
            opus: "g/gemini-3-pro-preview",
            sonnet: "mm/minimax-m2.1",
            haiku: "mm/minimax-m2.1",
            subagent: "mm/minimax-m2.1"
        )
    }

    /// Create performance-optimized slots
    static var performance: ProfileSlots {
        ProfileSlots(
            opus: "openai/gpt-4o",
            sonnet: "g/gemini-2.0-flash-exp",
            haiku: "g/gemini-2.0-flash-exp",
            subagent: "g/gemini-2.0-flash-exp"
        )
    }

    /// Create balanced slots
    static var balanced: ProfileSlots {
        ProfileSlots(
            opus: "openai/gpt-4o",
            sonnet: "g/gemini-2.0-flash-exp",
            haiku: "openai/gpt-4o-mini",
            subagent: "openai/gpt-4o-mini"
        )
    }
}

/// A model profile defining how Claude models are remapped
struct ModelProfile: Codable, Identifiable, Equatable {
    let id: UUID
    var name: String
    var description: String?
    let isPreset: Bool
    var slots: ProfileSlots
    let createdAt: Date
    var modifiedAt: Date

    init(
        id: UUID = UUID(),
        name: String,
        description: String? = nil,
        isPreset: Bool = false,
        slots: ProfileSlots,
        createdAt: Date = Date(),
        modifiedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.isPreset = isPreset
        self.slots = slots
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
    }

    /// Create a preset profile
    static func preset(
        name: String,
        description: String,
        slots: ProfileSlots
    ) -> ModelProfile {
        ModelProfile(
            name: name,
            description: description,
            isPreset: true,
            slots: slots
        )
    }

    /// Create a custom profile
    static func custom(
        name: String,
        description: String? = nil,
        slots: ProfileSlots
    ) -> ModelProfile {
        ModelProfile(
            name: name,
            description: description,
            isPreset: false,
            slots: slots
        )
    }
}

extension ModelProfile {
    // Fixed UUIDs for preset profiles to ensure selection persistence
    private static let passthroughId = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    private static let costSaverId = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
    private static let performanceId = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!
    private static let balancedId = UUID(uuidString: "00000000-0000-0000-0000-000000000004")!

    /// Default preset profiles
    static let presets: [ModelProfile] = [
        ModelProfile(
            id: passthroughId,
            name: "Passthrough",
            description: "Use original Claude models (no remapping)",
            isPreset: true,
            slots: .passthrough
        ),
        ModelProfile(
            id: costSaverId,
            name: "Cost Saver",
            description: "Route to cheaper models",
            isPreset: true,
            slots: .costSaver
        ),
        ModelProfile(
            id: performanceId,
            name: "Performance",
            description: "Route to fastest models",
            isPreset: true,
            slots: .performance
        ),
        ModelProfile(
            id: balancedId,
            name: "Balanced",
            description: "Mixed performance and cost",
            isPreset: true,
            slots: .balanced
        )
    ]
}

// MARK: - Statistics Types

/// A recorded request statistic
struct RequestStat: Codable, Identifiable {
    let id: UUID
    let timestamp: Date
    let sourceModel: String  // e.g., "claude-opus-4-5"
    let targetModel: String  // e.g., "g/gemini-3-pro-preview" or "internal"
    let inputTokens: Int
    let outputTokens: Int
    let durationMs: Int
    let success: Bool

    init(
        id: UUID = UUID(),
        timestamp: Date = Date(),
        sourceModel: String,
        targetModel: String,
        inputTokens: Int,
        outputTokens: Int,
        durationMs: Int,
        success: Bool
    ) {
        self.id = id
        self.timestamp = timestamp
        self.sourceModel = sourceModel
        self.targetModel = targetModel
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.durationMs = durationMs
        self.success = success
    }
}

/// Manages request statistics with SQLite persistence
@MainActor
class StatsManager: ObservableObject {
    @Published var recentRequests: [RequestStat] = []
    @Published var todayStats: (requests: Int, inputTokens: Int, outputTokens: Int, cost: Double) = (0, 0, 0, 0)
    @Published var periodStats: (requests: Int, inputTokens: Int, outputTokens: Int, cost: Double) = (0, 0, 0, 0)
    @Published var selectedPeriod: StatsPeriod = .thirtyDays

    private let db = StatsDatabase.shared

    enum StatsPeriod: String, CaseIterable {
        case sevenDays = "7 Days"
        case thirtyDays = "30 Days"
        case ninetyDays = "90 Days"
        case allTime = "All Time"

        var days: Int? {
            switch self {
            case .sevenDays: return 7
            case .thirtyDays: return 30
            case .ninetyDays: return 90
            case .allTime: return nil
            }
        }
    }

    init() {
        refreshStats()
    }

    // MARK: - Computed Properties

    /// Recent activity (last 10 requests)
    var recentActivity: [RequestStat] {
        Array(recentRequests.prefix(10))
    }

    /// Requests today (convenience accessor)
    var requestsToday: Int {
        todayStats.requests
    }

    /// Total input tokens for selected period
    var totalInputTokens: Int {
        periodStats.inputTokens
    }

    /// Total output tokens for selected period
    var totalOutputTokens: Int {
        periodStats.outputTokens
    }

    /// Total tokens for selected period
    var totalTokens: Int {
        periodStats.inputTokens + periodStats.outputTokens
    }

    /// Total cost for selected period
    var totalCost: Double {
        periodStats.cost
    }

    // MARK: - Recording

    /// Record a new request stat
    func recordRequest(_ stat: RequestStat, appName: String? = nil, cost: Double = 0) {
        // Save to SQLite
        db.recordRequest(stat, appName: appName, cost: cost)

        // Refresh UI
        refreshStats()
    }

    /// Record a request from log entry
    func recordFromLogEntry(_ entry: LogEntry) {
        let stat = RequestStat(
            timestamp: parseTimestamp(entry.timestamp),
            sourceModel: entry.requestedModel,
            targetModel: entry.targetModel,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            durationMs: entry.latency,
            success: entry.status >= 200 && entry.status < 300
        )
        recordRequest(stat, appName: entry.app, cost: entry.cost)
    }

    // MARK: - Data Refresh

    /// Refresh all stats from database
    func refreshStats() {
        // Load recent requests
        recentRequests = db.getRecentRequests(limit: 100)

        // Load today's stats
        todayStats = db.getTodayStats()

        // Load period stats based on selection
        if let days = selectedPeriod.days {
            periodStats = db.getStatsForLastDays(days)
        } else {
            periodStats = db.getAllTimeStats()
        }
    }

    /// Change the selected time period
    func setPeriod(_ period: StatsPeriod) {
        selectedPeriod = period
        refreshStats()
    }

    /// Get model usage breakdown
    func getModelUsage() -> [(model: String, count: Int, tokens: Int)] {
        db.getModelUsage(days: selectedPeriod.days)
    }

    // MARK: - Maintenance

    /// Clear all statistics
    func clearStats() {
        db.clearAllStats()
        refreshStats()
    }

    /// Get database size
    func getDatabaseSize() -> String {
        let bytes = db.getDatabaseSize()
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }

    // MARK: - Helpers

    private func parseTimestamp(_ timestamp: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: timestamp) ?? Date()
    }
}
