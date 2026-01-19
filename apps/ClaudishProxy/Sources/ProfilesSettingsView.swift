import SwiftUI
import UniformTypeIdentifiers

/// Wrapper for sheet binding - nil means new profile, non-nil means edit
struct ProfileEditorBinding: Identifiable {
    let id = UUID()
    let profile: ModelProfile?
}

/// Profiles tab in Settings window - ultra compact design
struct ProfilesSettingsView: View {
    @ObservedObject var profileManager: ProfileManager
    @State private var editorBinding: ProfileEditorBinding?
    @State private var showingImportDialog = false
    @State private var showingExportDialog = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ThemeCard {
                    VStack(spacing: 0) {
                        // Compact header
                        HStack {
                            Text("PROFILES")
                                .font(.system(size: 10, weight: .semibold))
                                .tracking(0.5)
                                .foregroundColor(.themeTextMuted)

                            Spacer()

                            HStack(spacing: 6) {
                                Button(action: { showingImportDialog = true }) {
                                    Image(systemName: "square.and.arrow.down")
                                        .font(.system(size: 11))
                                        .foregroundColor(.themeTextMuted)
                                }
                                .buttonStyle(.plain)

                                Button(action: { showingExportDialog = true }) {
                                    Image(systemName: "square.and.arrow.up")
                                        .font(.system(size: 11))
                                        .foregroundColor(.themeTextMuted)
                                }
                                .buttonStyle(.plain)

                                Button(action: {
                                    editorBinding = ProfileEditorBinding(profile: nil)
                                }) {
                                    Image(systemName: "plus")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundColor(.themeAccent)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)

                        Divider().background(Color.themeBorder)

                        // Ultra-compact profile list
                        ForEach(profileManager.profiles) { profile in
                            UltraCompactProfileRow(
                                profile: profile,
                                isSelected: profileManager.selectedProfileId == profile.id,
                                onSelect: { profileManager.selectProfile(id: profile.id) },
                                onEdit: profile.isPreset ? nil : {
                                    editorBinding = ProfileEditorBinding(profile: profile)
                                },
                                onDuplicate: {
                                    if let duplicate = profileManager.duplicateProfile(id: profile.id) {
                                        editorBinding = ProfileEditorBinding(profile: duplicate)
                                    }
                                },
                                onDelete: profile.isPreset ? nil : {
                                    profileManager.deleteProfile(id: profile.id)
                                }
                            )

                            if profile.id != profileManager.profiles.last?.id {
                                Divider().background(Color.themeBorder.opacity(0.5))
                                    .padding(.leading, 36)
                            }
                        }
                    }
                }

                // Slot legend (compact)
                HStack(spacing: 16) {
                    SlotLegendItem(letter: "O", label: "Opus", color: .purple)
                    SlotLegendItem(letter: "S", label: "Sonnet", color: .blue)
                    SlotLegendItem(letter: "H", label: "Haiku", color: .green)
                }
                .padding(.horizontal, 4)
            }
            .padding(20)
        }
        .background(Color.themeBg)
        .sheet(item: $editorBinding) { binding in
            CompactProfileEditor(profileManager: profileManager, profile: binding.profile)
        }
        .fileImporter(isPresented: $showingImportDialog, allowedContentTypes: [.json]) { result in
            if case .success(let url) = result { try? profileManager.importProfiles(from: url) }
        }
        .fileExporter(isPresented: $showingExportDialog, document: ProfilesDocument(profiles: profileManager.profiles), contentType: .json, defaultFilename: "claudish-profiles.json") { _ in }
    }
}

/// Ultra compact single-line profile row
struct UltraCompactProfileRow: View {
    let profile: ModelProfile
    let isSelected: Bool
    let onSelect: () -> Void
    let onEdit: (() -> Void)?
    let onDuplicate: () -> Void
    let onDelete: (() -> Void)?

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 8) {
            // Radio button
            Button(action: onSelect) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 14))
                    .foregroundColor(isSelected ? .themeAccent : .themeTextMuted.opacity(0.5))
            }
            .buttonStyle(.plain)

            // Name + badge
            Text(profile.name)
                .font(.system(size: 12, weight: isSelected ? .semibold : .medium))
                .foregroundColor(isSelected ? .themeText : .themeText.opacity(0.8))

            if profile.isPreset {
                Text("•")
                    .font(.system(size: 8))
                    .foregroundColor(.themeTextMuted)
            }

            Spacer()

            // Colored slot dots (O S H)
            HStack(spacing: 4) {
                SlotDot(model: profile.slots.opus, letter: "O", color: .purple)
                SlotDot(model: profile.slots.sonnet, letter: "S", color: .blue)
                SlotDot(model: profile.slots.haiku, letter: "H", color: .green)
            }

            // Actions on hover
            if isHovered || isSelected {
                HStack(spacing: 2) {
                    if let onEdit = onEdit {
                        IconButton(icon: "pencil", action: onEdit)
                    }
                    IconButton(icon: "doc.on.doc", action: onDuplicate)
                    if let onDelete = onDelete {
                        IconButton(icon: "trash", color: .themeDestructive, action: onDelete)
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(isSelected ? Color.themeAccent.opacity(0.1) : (isHovered ? Color.themeHover.opacity(0.5) : Color.clear))
        .onHover { isHovered = $0 }
        .animation(.easeOut(duration: 0.15), value: isHovered)
        .animation(.easeOut(duration: 0.15), value: isSelected)
    }
}

/// Colored dot showing model type
struct SlotDot: View {
    let model: String
    let letter: String
    let color: Color

    var body: some View {
        Text(letter)
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .foregroundColor(modelColor)
            .frame(width: 14, height: 14)
            .background(modelColor.opacity(0.15))
            .cornerRadius(3)
            .help("\(slotName): \(shortModel)")
    }

    private var slotName: String {
        switch letter {
        case "O": return "Opus"
        case "S": return "Sonnet"
        case "H": return "Haiku"
        default: return letter
        }
    }

    private var shortModel: String {
        if model.contains("claude") { return "Claude" }
        if model.contains("gemini") { return "Gemini" }
        if model.contains("gpt") { return "GPT" }
        if model.contains("grok") { return "Grok" }
        if model.contains("minimax") || model.contains("mm/") { return "MiniMax" }
        if model.contains("glm") { return "GLM" }
        if let last = model.split(separator: "/").last { return String(last) }
        return model
    }

    private var modelColor: Color {
        if model.contains("claude") { return .purple }
        if model.contains("gemini") { return .blue }
        if model.contains("gpt") { return .green }
        if model.contains("grok") { return .orange }
        if model.contains("minimax") || model.contains("mm/") { return .pink }
        if model.contains("glm") { return .cyan }
        return color
    }
}

/// Small icon button
struct IconButton: View {
    let icon: String
    var color: Color = .themeTextMuted
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundColor(color)
                .frame(width: 20, height: 20)
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
    }
}

/// Slot legend item
struct SlotLegendItem: View {
    let letter: String
    let label: String
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Text(letter)
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .foregroundColor(color)
                .frame(width: 12, height: 12)
                .background(color.opacity(0.15))
                .cornerRadius(2)
            Text(label)
                .font(.system(size: 9))
                .foregroundColor(.themeTextMuted)
        }
    }
}

/// Profile editor sheet with searchable model pickers
struct CompactProfileEditor: View {
    @ObservedObject var profileManager: ProfileManager
    let profile: ModelProfile?
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var opusSlot: String
    @State private var sonnetSlot: String
    @State private var haikuSlot: String
    @State private var subagentSlot: String

    init(profileManager: ProfileManager, profile: ModelProfile?) {
        self.profileManager = profileManager
        self.profile = profile
        _name = State(initialValue: profile?.name ?? "New Profile")
        _opusSlot = State(initialValue: profile?.slots.opus ?? "g/gemini-2.5-flash")
        _sonnetSlot = State(initialValue: profile?.slots.sonnet ?? "g/gemini-2.5-flash")
        _haikuSlot = State(initialValue: profile?.slots.haiku ?? "g/gemini-2.5-flash-lite")
        _subagentSlot = State(initialValue: profile?.slots.subagent ?? "g/gemini-2.5-flash-lite")
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(profile == nil ? "New Profile" : "Edit Profile")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.themeText)
                    Text("Configure model routing for each slot")
                        .font(.system(size: 11))
                        .foregroundColor(.themeTextMuted)
                }
                Spacer()
                Button(action: { dismiss() }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundColor(.themeTextMuted)
                }
                .buttonStyle(.plain)
            }
            .padding(16)
            .background(Color.themeCard)

            Divider().background(Color.themeBorder)

            // Form content
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Name field
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Profile Name", systemImage: "tag")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.themeTextMuted)

                        TextField("Enter profile name", text: $name)
                            .textFieldStyle(.plain)
                            .font(.system(size: 13))
                            .padding(10)
                            .background(Color.themeHover)
                            .cornerRadius(6)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color.themeBorder, lineWidth: 1)
                            )
                    }

                    Divider().background(Color.themeBorder)

                    // Model slots section
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Model Slots", systemImage: "cpu")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.themeTextMuted)

                        Text("Search and select which model handles each Claude tier")
                            .font(.system(size: 10))
                            .foregroundColor(.themeTextMuted.opacity(0.7))

                        // 2x2 grid of slot pickers
                        VStack(spacing: 12) {
                            HStack(spacing: 12) {
                                SearchableSlotPicker(label: "Opus", icon: "o.circle.fill", color: .purple, selection: $opusSlot)
                                SearchableSlotPicker(label: "Sonnet", icon: "s.circle.fill", color: .blue, selection: $sonnetSlot)
                            }
                            HStack(spacing: 12) {
                                SearchableSlotPicker(label: "Haiku", icon: "h.circle.fill", color: .green, selection: $haikuSlot)
                                SearchableSlotPicker(label: "Subagent", icon: "a.circle.fill", color: .orange, selection: $subagentSlot)
                            }
                        }
                    }
                }
                .padding(16)
            }

            Divider().background(Color.themeBorder)

            // Footer
            HStack {
                Button(action: { dismiss() }) {
                    Text("Cancel")
                        .font(.system(size: 12))
                        .foregroundColor(.themeTextMuted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.plain)

                Spacer()

                Button(action: { save(); dismiss() }) {
                    HStack(spacing: 4) {
                        Image(systemName: profile == nil ? "plus.circle" : "checkmark.circle")
                            .font(.system(size: 11))
                        Text(profile == nil ? "Create Profile" : "Save Changes")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(name.isEmpty ? Color.themeTextMuted : Color.themeAccent)
                    .cornerRadius(6)
                }
                .buttonStyle(.plain)
                .disabled(name.isEmpty)
            }
            .padding(16)
            .background(Color.themeCard)
        }
        .frame(width: 480, height: 520)
        .background(Color.themeBg)
    }

    private func save() {
        let slots = ProfileSlots(opus: opusSlot, sonnet: sonnetSlot, haiku: haikuSlot, subagent: subagentSlot)
        if let profile = profile {
            profileManager.updateProfile(id: profile.id, name: name, description: nil, slots: slots)
        } else {
            profileManager.createProfile(name: name, description: nil, slots: slots)
        }
    }
}

/// Searchable slot picker with inline dropdown
struct SearchableSlotPicker: View {
    let label: String
    let icon: String
    let color: Color
    @Binding var selection: String
    @StateObject private var modelProvider = ModelProvider.shared
    @State private var isExpanded = false
    @State private var searchText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Label with icon
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                    .foregroundColor(color)
                Text(label.uppercased())
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(.themeTextMuted)
            }

            // Picker button
            Button(action: {
                withAnimation(.easeOut(duration: 0.15)) { isExpanded.toggle(); searchText = "" }
            }) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(modelColor)
                        .frame(width: 6, height: 6)

                    Text(displayName)
                        .font(.system(size: 11))
                        .foregroundColor(.themeText)
                        .lineLimit(1)

                    Spacer()

                    if modelProvider.isLoading {
                        ProgressView()
                            .scaleEffect(0.5)
                            .frame(width: 12, height: 12)
                    } else {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundColor(.themeTextMuted)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(Color.themeHover)
                .cornerRadius(5)
                .overlay(
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(isExpanded ? color.opacity(0.5) : Color.themeBorder, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)

            // Expanded dropdown
            if isExpanded {
                VStack(spacing: 0) {
                    // Search bar
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 11))
                            .foregroundColor(.themeTextMuted)
                        TextField("Search models...", text: $searchText)
                            .textFieldStyle(.plain)
                            .font(.system(size: 11))
                        if !searchText.isEmpty {
                            Button(action: { searchText = "" }) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 10))
                                    .foregroundColor(.themeTextMuted)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(8)
                    .background(Color.themeBg)

                    Divider().background(Color.themeBorder)

                    // Loading indicator
                    if modelProvider.isLoading && filteredGroups.isEmpty {
                        HStack {
                            Spacer()
                            VStack(spacing: 8) {
                                ProgressView()
                                Text("Loading models...")
                                    .font(.system(size: 11))
                                    .foregroundColor(.themeTextMuted)
                            }
                            .padding(20)
                            Spacer()
                        }
                        .frame(height: 140)
                    } else {
                        // Results list
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(filteredGroups, id: \.provider) { group in
                                    // Provider header
                                    HStack(spacing: 4) {
                                        Image(systemName: group.provider.icon)
                                            .font(.system(size: 8))
                                            .foregroundColor(.themeTextMuted)
                                        Text(group.provider.rawValue)
                                            .font(.system(size: 9, weight: .bold))
                                            .foregroundColor(.themeTextMuted)
                                        Text("(\(group.models.count))")
                                            .font(.system(size: 8))
                                            .foregroundColor(.themeTextMuted.opacity(0.6))
                                        Rectangle()
                                            .fill(Color.themeBorder)
                                            .frame(height: 1)
                                    }
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 6)
                                    .background(Color.themeBg.opacity(0.5))

                                    // Models in group
                                    ForEach(group.models) { model in
                                        Button(action: {
                                            selection = model.id
                                            isExpanded = false
                                            searchText = ""
                                        }) {
                                            HStack(spacing: 8) {
                                                Circle()
                                                    .fill(colorFor(model.id))
                                                    .frame(width: 6, height: 6)
                                                VStack(alignment: .leading, spacing: 1) {
                                                    Text(model.displayName)
                                                        .font(.system(size: 11))
                                                        .foregroundColor(.themeText)
                                                    if let desc = model.description, !desc.isEmpty {
                                                        Text(desc)
                                                            .font(.system(size: 9))
                                                            .foregroundColor(.themeTextMuted)
                                                            .lineLimit(1)
                                                    }
                                                }
                                                Spacer()
                                                if selection == model.id {
                                                    Image(systemName: "checkmark")
                                                        .font(.system(size: 10, weight: .semibold))
                                                        .foregroundColor(.themeAccent)
                                                }
                                            }
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 5)
                                            .background(selection == model.id ? Color.themeAccent.opacity(0.1) : Color.clear)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }

                                if filteredGroups.isEmpty && !modelProvider.isLoading {
                                    HStack {
                                        Spacer()
                                        VStack(spacing: 4) {
                                            Image(systemName: "magnifyingglass")
                                                .font(.system(size: 16))
                                                .foregroundColor(.themeTextMuted)
                                            Text("No models found")
                                                .font(.system(size: 11))
                                                .foregroundColor(.themeTextMuted)
                                        }
                                        .padding(16)
                                        Spacer()
                                    }
                                }
                            }
                        }
                        .frame(height: 160)
                    }
                }
                .background(Color.themeCard)
                .cornerRadius(6)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.themeBorder, lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.15), radius: 8, x: 0, y: 4)
                .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .top)))
                .zIndex(100)
            }
        }
    }

    private var displayName: String {
        modelProvider.allModels.first { $0.id == selection }?.displayName
            ?? selection.split(separator: "/").last.map(String.init)
            ?? selection
    }

    private var modelColor: Color {
        colorFor(selection)
    }

    private func colorFor(_ modelId: String) -> Color {
        if modelId.contains("claude") { return .purple }
        if modelId.contains("gemini") { return .blue }
        if modelId.contains("gpt") { return .green }
        if modelId.contains("grok") { return .orange }
        if modelId.contains("minimax") || modelId.contains("mm/") { return .pink }
        if modelId.contains("glm") { return .cyan }
        return .gray
    }

    private var filteredGroups: [(provider: ModelProviderType, models: [AvailableModel])] {
        if searchText.isEmpty {
            return modelProvider.modelsByProvider
        }
        let query = searchText.lowercased()
        return modelProvider.modelsByProvider.compactMap { group in
            let filtered = group.models.filter {
                $0.displayName.lowercased().contains(query) ||
                $0.id.lowercased().contains(query) ||
                ($0.description?.lowercased().contains(query) ?? false)
            }
            return filtered.isEmpty ? nil : (group.provider, filtered)
        }
    }
}

/// Searchable slot picker with dropdown
struct MiniSlotPicker: View {
    let label: String
    @Binding var selection: String
    @StateObject private var modelProvider = ModelProvider.shared
    @State private var isExpanded = false
    @State private var searchText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 8, weight: .semibold))
                .foregroundColor(.themeTextMuted)

            // Trigger button
            Button(action: { withAnimation(.easeOut(duration: 0.15)) { isExpanded.toggle() } }) {
                HStack {
                    Text(displayName)
                        .font(.system(size: 11))
                        .foregroundColor(.themeText)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8))
                        .foregroundColor(.themeTextMuted)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(Color.themeHover)
                .cornerRadius(3)
            }
            .buttonStyle(.plain)

            // Expanded search dropdown
            if isExpanded {
                VStack(spacing: 0) {
                    // Search field
                    HStack(spacing: 4) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 10))
                            .foregroundColor(.themeTextMuted)
                        TextField("Search models...", text: $searchText)
                            .textFieldStyle(.plain)
                            .font(.system(size: 11))
                    }
                    .padding(6)
                    .background(Color.themeBg)

                    Divider().background(Color.themeBorder)

                    // Filtered results
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(filteredGroups, id: \.provider) { group in
                                // Provider header
                                Text(group.provider.rawValue)
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundColor(.themeTextMuted)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 4)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.themeBg.opacity(0.5))

                                // Models
                                ForEach(group.models) { model in
                                    Button(action: {
                                        selection = model.id
                                        isExpanded = false
                                        searchText = ""
                                    }) {
                                        HStack {
                                            Text(model.displayName)
                                                .font(.system(size: 11))
                                                .foregroundColor(.themeText)
                                            Spacer()
                                            if selection == model.id {
                                                Image(systemName: "checkmark")
                                                    .font(.system(size: 9))
                                                    .foregroundColor(.themeAccent)
                                            }
                                        }
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 4)
                                        .background(selection == model.id ? Color.themeAccent.opacity(0.1) : Color.clear)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }

                            if filteredGroups.isEmpty {
                                Text("No models found")
                                    .font(.system(size: 11))
                                    .foregroundColor(.themeTextMuted)
                                    .padding(8)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                    }
                    .frame(maxHeight: 150)
                }
                .background(Color.themeCard)
                .cornerRadius(4)
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(Color.themeBorder, lineWidth: 1)
                )
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var displayName: String {
        modelProvider.allModels.first { $0.id == selection }?.displayName
            ?? selection.split(separator: "/").last.map(String.init)
            ?? selection
    }

    private var filteredGroups: [(provider: ModelProviderType, models: [AvailableModel])] {
        if searchText.isEmpty {
            return modelProvider.modelsByProvider
        }
        let query = searchText.lowercased()
        return modelProvider.modelsByProvider.compactMap { group in
            let filtered = group.models.filter {
                $0.displayName.lowercased().contains(query) ||
                $0.id.lowercased().contains(query)
            }
            return filtered.isEmpty ? nil : (group.provider, filtered)
        }
    }
}

/// Document for export
struct ProfilesDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let profiles: [ModelProfile]

    init(profiles: [ModelProfile]) { self.profiles = profiles }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        profiles = try JSONDecoder().decode([ModelProfile].self, from: data)
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        return FileWrapper(regularFileWithContents: try encoder.encode(profiles))
    }
}
