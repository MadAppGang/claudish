import Foundation
import Security

/// Manages API keys with secure Keychain storage
///
/// Responsibilities:
/// - Store/retrieve API keys from macOS Keychain
/// - Manage per-key mode (environment vs manual)
/// - Provide unified API key resolution with fallback logic
/// - Persist user preferences for key modes
@MainActor
class ApiKeyManager: ObservableObject {
    // MARK: - Published State

    @Published var keys: [ApiKeyConfig] = []

    // MARK: - Constants

    private let keychainService = "com.claudish.proxy.apikeys"
    private let modesPrefKey = "com.claudish.proxy.apiKeyModes"

    // MARK: - Initialization

    init() {
        // Initialize keys array with all supported types
        keys = ApiKeyType.allCases.map { keyType in
            let mode = loadMode(for: keyType)
            let hasManualValue = (try? loadFromKeychain(for: keyType)) != nil
            let hasEnvironmentValue = ProcessInfo.processInfo.environment[keyType.rawValue] != nil

            return ApiKeyConfig(
                id: keyType,
                mode: mode,
                hasManualValue: hasManualValue,
                hasEnvironmentValue: hasEnvironmentValue
            )
        }
    }

    // MARK: - Public API

    /// Get API key for a given type, respecting mode and fallback logic
    func getApiKey(for keyType: ApiKeyType) -> String? {
        guard let config = keys.first(where: { $0.id == keyType }) else {
            return nil
        }

        switch config.mode {
        case .manual:
            // Try manual key first
            if let manualKey = try? loadFromKeychain(for: keyType), !manualKey.isEmpty {
                return manualKey
            }
            // Fallback to environment
            return ProcessInfo.processInfo.environment[keyType.rawValue]

        case .environment:
            // Use environment variable only
            return ProcessInfo.processInfo.environment[keyType.rawValue]
        }
    }

    /// Set a manual API key (stores in Keychain)
    func setManualKey(for keyType: ApiKeyType, value: String) async throws {
        guard !value.isEmpty else {
            throw KeychainError.invalidValue
        }

        try saveToKeychain(value: value, for: keyType)

        // Update state
        if let index = keys.firstIndex(where: { $0.id == keyType }) {
            keys[index].hasManualValue = true
        }
    }

    /// Clear manual API key (removes from Keychain)
    func clearManualKey(for keyType: ApiKeyType) async throws {
        try deleteFromKeychain(for: keyType)

        // Update state
        if let index = keys.firstIndex(where: { $0.id == keyType }) {
            keys[index].hasManualValue = false
        }
    }

    /// Set the mode for a key type
    func setMode(for keyType: ApiKeyType, mode: ApiKeyMode) {
        saveMode(mode, for: keyType)

        // Update state
        if let index = keys.firstIndex(where: { $0.id == keyType }) {
            keys[index].mode = mode
        }
    }

    /// Refresh environment key availability (call after environment changes)
    func refreshEnvironmentKeys() {
        for i in 0..<keys.count {
            let keyType = keys[i].id
            keys[i].hasEnvironmentValue = ProcessInfo.processInfo.environment[keyType.rawValue] != nil
        }
    }

    /// Validate key format (basic validation)
    func validateKey(_ value: String, for keyType: ApiKeyType) -> Bool {
        // Basic validation: non-empty and reasonable length
        guard !value.isEmpty && value.count > 10 else {
            return false
        }

        // Optional: Add provider-specific prefix validation
        switch keyType {
        case .openrouter:
            return value.hasPrefix("sk-or-")
        case .openai:
            return value.hasPrefix("sk-")
        case .gemini:
            return value.hasPrefix("AIza")
        case .anthropic:
            return value.hasPrefix("sk-ant-")
        default:
            return true // No specific validation for others
        }
    }

    // MARK: - Keychain Operations

    /// Load API key from Keychain
    private func loadFromKeychain(for keyType: ApiKeyType) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keyType.rawValue,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }

        guard status == errSecSuccess else {
            throw KeychainError.loadFailed(status)
        }

        guard let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            throw KeychainError.invalidData
        }

        return value
    }

    /// Save API key to Keychain
    private func saveToKeychain(value: String, for keyType: ApiKeyType) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.invalidValue
        }

        // Try to update existing item first
        let updateQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keyType.rawValue
        ]

        let attributes: [String: Any] = [
            kSecValueData as String: data
        ]

        var status = SecItemUpdate(updateQuery as CFDictionary, attributes as CFDictionary)

        // If item doesn't exist, add it
        if status == errSecItemNotFound {
            var addQuery = updateQuery
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
            addQuery[kSecAttrSynchronizable as String] = false  // Don't sync to iCloud

            status = SecItemAdd(addQuery as CFDictionary, nil)
        }

        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }

    /// Delete API key from Keychain
    private func deleteFromKeychain(for keyType: ApiKeyType) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keyType.rawValue
        ]

        let status = SecItemDelete(query as CFDictionary)

        // Don't throw error if item doesn't exist
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.deleteFailed(status)
        }
    }

    // MARK: - Mode Persistence

    /// Load mode from UserDefaults
    private func loadMode(for keyType: ApiKeyType) -> ApiKeyMode {
        guard let data = UserDefaults.standard.data(forKey: modesPrefKey),
              let modes = try? JSONDecoder().decode([String: ApiKeyMode].self, from: data),
              let mode = modes[keyType.rawValue] else {
            return .environment  // Default to environment mode
        }
        return mode
    }

    /// Save mode to UserDefaults
    private func saveMode(_ mode: ApiKeyMode, for keyType: ApiKeyType) {
        var modes: [String: ApiKeyMode] = [:]

        // Load existing modes
        if let data = UserDefaults.standard.data(forKey: modesPrefKey),
           let existingModes = try? JSONDecoder().decode([String: ApiKeyMode].self, from: data) {
            modes = existingModes
        }

        // Update mode
        modes[keyType.rawValue] = mode

        // Save back
        if let data = try? JSONEncoder().encode(modes) {
            UserDefaults.standard.set(data, forKey: modesPrefKey)
        }
    }
}

// MARK: - Types

/// API key type enumeration
enum ApiKeyType: String, CaseIterable, Codable {
    case openrouter = "OPENROUTER_API_KEY"
    case openai = "OPENAI_API_KEY"
    case gemini = "GEMINI_API_KEY"
    case anthropic = "ANTHROPIC_API_KEY"
    case minimax = "MINIMAX_API_KEY"
    case kimi = "MOONSHOT_API_KEY"
    case glm = "ZHIPU_API_KEY"

    var displayName: String {
        switch self {
        case .openrouter: return "OpenRouter"
        case .openai: return "OpenAI"
        case .gemini: return "Google Gemini"
        case .anthropic: return "Anthropic"
        case .minimax: return "MiniMax"
        case .kimi: return "Moonshot (Kimi)"
        case .glm: return "Zhipu (GLM)"
        }
    }

    var apiKeyURL: URL? {
        switch self {
        case .openrouter: return URL(string: "https://openrouter.ai/settings/keys")
        case .openai: return URL(string: "https://platform.openai.com/api-keys")
        case .gemini: return URL(string: "https://aistudio.google.com/apikey")
        case .anthropic: return URL(string: "https://console.anthropic.com/settings/keys")
        case .minimax: return URL(string: "https://platform.minimax.io")
        case .kimi: return URL(string: "https://platform.moonshot.ai/console/api-keys")
        case .glm: return URL(string: "https://open.bigmodel.cn")
        }
    }
}

/// API key mode (environment vs manual entry)
enum ApiKeyMode: String, Codable {
    case environment  // Use ProcessInfo.processInfo.environment
    case manual       // Use Keychain
}

/// API key configuration state
struct ApiKeyConfig: Identifiable {
    let id: ApiKeyType
    var mode: ApiKeyMode
    var hasManualValue: Bool      // Whether manual key is stored in Keychain
    var hasEnvironmentValue: Bool  // Whether env var is present
}

// MARK: - Errors

enum KeychainError: Error, LocalizedError {
    case saveFailed(OSStatus)
    case loadFailed(OSStatus)
    case deleteFailed(OSStatus)
    case invalidData
    case invalidValue

    var errorDescription: String? {
        switch self {
        case .saveFailed(let status):
            return "Failed to save to Keychain: \(status)"
        case .loadFailed(let status):
            return "Failed to load from Keychain: \(status)"
        case .deleteFailed(let status):
            return "Failed to delete from Keychain: \(status)"
        case .invalidData:
            return "Invalid data in Keychain"
        case .invalidValue:
            return "Invalid API key value"
        }
    }
}
