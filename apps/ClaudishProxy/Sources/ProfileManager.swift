import Foundation
import SwiftUI
import Combine

/// Manager for model profiles with storage and bridge integration
@MainActor
class ProfileManager: ObservableObject {
    // MARK: - Published State

    @Published var profiles: [ModelProfile] = []
    @Published var selectedProfileId: UUID?

    // MARK: - Dependencies

    private let defaults = UserDefaults.standard
    private let profilesKey = "modelProfiles"
    private let selectedProfileKey = "selectedProfileId"
    private weak var bridgeManager: BridgeManager?
    private var cancellables = Set<AnyCancellable>()
    private var hasAppliedInitialProfile = false

    // MARK: - Initialization

    init() {
        loadProfiles()
    }

    /// Set bridge manager reference for applying profiles
    /// Also sets up observers to apply profile when bridge connects
    func setBridgeManager(_ manager: BridgeManager) {
        self.bridgeManager = manager
        hasAppliedInitialProfile = false
        cancellables.removeAll()

        // Observe bridge connection state and config changes
        manager.$bridgeConnected
            .combineLatest(manager.$config)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] (connected, config) in
                guard let self = self else { return }
                // Apply profile when bridge connects and config is available
                if connected && config != nil && !self.hasAppliedInitialProfile {
                    print("[ProfileManager] Bridge connected with config, applying initial profile")
                    self.hasAppliedInitialProfile = true
                    self.applySelectedProfile()
                }
            }
            .store(in: &cancellables)

        // Also re-apply profile when proxy is enabled (connectHandler is created at that point)
        manager.$isProxyEnabled
            .dropFirst() // Skip initial value
            .filter { $0 } // Only when enabled (true)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self = self else { return }
                print("[ProfileManager] Proxy enabled, re-applying profile for routing")
                // Small delay to ensure connectHandler is fully initialized
                Task {
                    try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
                    await self.applySelectedProfile()
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - Profile Loading

    /// Load profiles from storage
    func loadProfiles() {
        var loadedProfiles: [ModelProfile] = []

        // Try to load from UserDefaults
        if let data = defaults.data(forKey: profilesKey) {
            do {
                loadedProfiles = try JSONDecoder().decode([ModelProfile].self, from: data)
            } catch {
                print("[ProfileManager] Failed to decode profiles: \(error)")
            }
        }

        // If no profiles exist, initialize with presets
        if loadedProfiles.isEmpty {
            loadedProfiles = ModelProfile.presets
            saveProfiles(loadedProfiles)
        }

        // Ensure presets are always present and up-to-date
        for preset in ModelProfile.presets {
            if !loadedProfiles.contains(where: { $0.id == preset.id }) {
                loadedProfiles.insert(preset, at: 0)
            }
        }

        self.profiles = loadedProfiles

        // Load selected profile ID
        if let uuidString = defaults.string(forKey: selectedProfileKey),
           let selectedId = UUID(uuidString: uuidString),
           profiles.contains(where: { $0.id == selectedId }) {
            self.selectedProfileId = selectedId
        } else {
            // Default to first preset (Passthrough)
            self.selectedProfileId = ModelProfile.presets.first?.id
            if let id = selectedProfileId {
                defaults.set(id.uuidString, forKey: selectedProfileKey)
            }
        }
    }

    // MARK: - Profile Selection

    /// Select a profile and apply it to the bridge
    func selectProfile(id: UUID) {
        guard profiles.contains(where: { $0.id == id }) else {
            print("[ProfileManager] Profile not found: \(id)")
            return
        }

        selectedProfileId = id
        defaults.set(id.uuidString, forKey: selectedProfileKey)

        // Apply profile to bridge
        applySelectedProfile()
    }

    /// Get currently selected profile
    var selectedProfile: ModelProfile? {
        guard let id = selectedProfileId else { return nil }
        return profiles.first(where: { $0.id == id })
    }

    // MARK: - Profile CRUD Operations

    /// Create a new custom profile
    @discardableResult
    func createProfile(
        name: String,
        description: String?,
        slots: ProfileSlots
    ) -> ModelProfile {
        let profile = ModelProfile.custom(
            name: name,
            description: description,
            slots: slots
        )

        profiles.append(profile)
        saveProfiles(profiles)

        return profile
    }

    /// Update an existing profile
    func updateProfile(id: UUID, name: String, description: String?, slots: ProfileSlots) {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else {
            print("[ProfileManager] Profile not found for update: \(id)")
            return
        }

        // Prevent editing presets
        guard !profiles[index].isPreset else {
            print("[ProfileManager] Cannot edit preset profile")
            return
        }

        profiles[index].name = name
        profiles[index].description = description
        profiles[index].slots = slots
        profiles[index].modifiedAt = Date()

        saveProfiles(profiles)

        // Re-apply if this is the selected profile
        if selectedProfileId == id {
            applySelectedProfile()
        }
    }

    /// Delete a profile
    func deleteProfile(id: UUID) {
        guard let index = profiles.firstIndex(where: { $0.id == id }) else {
            print("[ProfileManager] Profile not found for deletion: \(id)")
            return
        }

        // Prevent deleting presets
        guard !profiles[index].isPreset else {
            print("[ProfileManager] Cannot delete preset profile")
            return
        }

        profiles.remove(at: index)
        saveProfiles(profiles)

        // If deleted profile was selected, switch to first preset
        if selectedProfileId == id {
            selectedProfileId = ModelProfile.presets.first?.id
            if let newId = selectedProfileId {
                defaults.set(newId.uuidString, forKey: selectedProfileKey)
                applySelectedProfile()
            }
        }
    }

    /// Duplicate an existing profile
    @discardableResult
    func duplicateProfile(id: UUID) -> ModelProfile? {
        guard let source = profiles.first(where: { $0.id == id }) else {
            return nil
        }

        let duplicate = ModelProfile.custom(
            name: "\(source.name) Copy",
            description: source.description,
            slots: source.slots
        )

        profiles.append(duplicate)
        saveProfiles(profiles)

        return duplicate
    }

    // MARK: - Storage

    private func saveProfiles(_ profiles: [ModelProfile]) {
        do {
            let data = try JSONEncoder().encode(profiles)
            defaults.set(data, forKey: profilesKey)
        } catch {
            print("[ProfileManager] Failed to encode profiles: \(error)")
        }
    }

    // MARK: - Import/Export

    /// Export all profiles to a file
    func exportProfiles(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(profiles)
        try data.write(to: url)
    }

    /// Import profiles from a file (merges with existing)
    func importProfiles(from url: URL) throws {
        let data = try Data(contentsOf: url)
        let importedProfiles = try JSONDecoder().decode([ModelProfile].self, from: data)

        // Merge: skip presets, add custom profiles that don't exist
        for imported in importedProfiles where !imported.isPreset {
            if !profiles.contains(where: { $0.id == imported.id }) {
                profiles.append(imported)
            }
        }

        saveProfiles(profiles)
    }

    // MARK: - Bridge Integration

    /// Apply selected profile to bridge manager
    func applySelectedProfile() {
        guard let profile = selectedProfile else {
            print("[ProfileManager] No profile selected")
            return
        }

        applyProfile(profile)
    }

    /// Apply a specific profile to the bridge
    func applyProfile(_ profile: ModelProfile) {
        guard let bridgeManager = bridgeManager else {
            print("[ProfileManager] BridgeManager not set")
            return
        }

        Task {
            await applyProfileToBridge(profile, manager: bridgeManager)
        }
    }

    /// Apply profile slots to bridge configuration
    private func applyProfileToBridge(
        _ profile: ModelProfile,
        manager: BridgeManager
    ) async {
        guard var config = manager.config else {
            print("[ProfileManager] Bridge config not available")
            return
        }

        // Build model map from profile slots
        let modelMap: [String: String] = [
            "claude-opus-4-5-20251101": profile.slots.opus,
            "claude-sonnet-4-5-20250929": profile.slots.sonnet,
            "claude-3-haiku-20240307": profile.slots.haiku,
            // Subagent mapping (used by Claude Code)
            "claude-3-5-sonnet-20241022": profile.slots.subagent
        ]

        // Update configuration for all apps
        for (appName, var appConfig) in config.apps {
            appConfig.modelMap = modelMap
            config.apps[appName] = appConfig
        }

        // Also set default model (use opus slot as default)
        config.defaultModel = profile.slots.opus

        // Apply to bridge
        await manager.updateConfig(config)

        print("[ProfileManager] Applied profile: \(profile.name)")
    }
}
