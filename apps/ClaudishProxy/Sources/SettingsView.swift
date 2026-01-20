import SwiftUI

/// Settings window for configuring model mappings
struct SettingsView: View {
    @ObservedObject var bridgeManager: BridgeManager
    @ObservedObject var profileManager: ProfileManager
    @ObservedObject var certificateManager: CertificateManager
    @ObservedObject var apiKeyManager: ApiKeyManager
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            // General settings
            GeneralSettingsView(bridgeManager: bridgeManager, certificateManager: certificateManager)
                .tabItem {
                    Label("General", systemImage: "gearshape")
                }
                .tag(0)

            // Profiles tab
            ProfilesSettingsView(profileManager: profileManager)
                .tabItem {
                    Label("Profiles", systemImage: "slider.horizontal.3")
                }
                .tag(1)

            // API Keys
            ApiKeysView(apiKeyManager: apiKeyManager)
                .tabItem {
                    Label("API Keys", systemImage: "key")
                }
                .tag(2)

            // About
            AboutView()
                .tabItem {
                    Label("About", systemImage: "info.circle")
                }
                .tag(3)
        }
        .frame(width: 600, height: 500)
        .background(Color.themeBg)
    }
}

/// General settings tab
struct GeneralSettingsView: View {
    @ObservedObject var bridgeManager: BridgeManager
    @ObservedObject var certificateManager: CertificateManager
    @AppStorage("enableProxyOnLaunch") private var enableProxyOnLaunch = false
    @AppStorage("launchAtLogin") private var launchAtLogin = false
    @AppStorage("debugMode") private var debugMode = false
    @State private var selectedDefaultModel = TargetModel.passthrough.rawValue
    @State private var showCopiedToast = false
    @State private var currentLogPath: String? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ThemeCard {
                    VStack(alignment: .leading, spacing: 0) {
                        // Certificate Status Row
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("HTTPS Certificate")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundColor(.themeText)
                                Text(certificateManager.isCAInstalled ? "Installed" : "Not installed")
                                    .font(.system(size: 11))
                                    .foregroundColor(certificateManager.isCAInstalled ? .themeSuccess : .themeDestructive)
                            }
                            Spacer()

                            // Status icon + action buttons
                            HStack(spacing: 8) {
                                Image(systemName: certificateManager.isCAInstalled ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                                    .font(.system(size: 18))
                                    .foregroundColor(certificateManager.isCAInstalled ? .themeSuccess : .themeAccent)

                                if certificateManager.isCAInstalled {
                                    Button(action: {
                                        certificateManager.showInKeychain()
                                    }) {
                                        Text("Keychain")
                                            .font(.system(size: 12))
                                            .foregroundColor(.themeText)
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 5)
                                    }
                                    .buttonStyle(.plain)
                                    .background(Color.themeHover)
                                    .cornerRadius(4)

                                    Button(action: {
                                        Task {
                                            try? await certificateManager.uninstallCA()
                                            try? await certificateManager.installCA()
                                        }
                                    }) {
                                        Text("Reinstall")
                                            .font(.system(size: 12))
                                            .foregroundColor(.themeDestructive)
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 5)
                                    }
                                    .buttonStyle(.plain)
                                    .background(Color.themeDestructive.opacity(0.1))
                                    .cornerRadius(4)
                                } else {
                                    Button(action: {
                                        Task {
                                            try? await certificateManager.installCA()
                                        }
                                    }) {
                                        Text("Install")
                                            .font(.system(size: 12, weight: .medium))
                                            .foregroundColor(.white)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 5)
                                    }
                                    .buttonStyle(.plain)
                                    .background(Color.themeSuccess)
                                    .cornerRadius(4)
                                }
                            }
                        }
                        .padding(.vertical, 12)

                        // Error display if present
                        if let error = certificateManager.error {
                            HStack(spacing: 6) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 11))
                                    .foregroundColor(.themeDestructive)
                                Text(error)
                                    .font(.system(size: 11))
                                    .foregroundColor(.themeDestructive)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.themeDestructive.opacity(0.1))
                            .cornerRadius(4)
                            .padding(.bottom, 12)
                        }

                        Divider().background(Color.themeBorder)

                        // Enable on Launch Row
                        HStack {
                            Text("Enable proxy on launch")
                                .font(.system(size: 13))
                                .foregroundColor(.themeText)
                            Spacer()
                            Toggle("", isOn: $enableProxyOnLaunch)
                                .toggleStyle(.switch)
                                .tint(.themeSuccess)
                        }
                        .padding(.vertical, 12)

                        Divider().background(Color.themeBorder)

                        // Launch at Login Row
                        HStack {
                            Text("Launch at login")
                                .font(.system(size: 13))
                                .foregroundColor(.themeTextMuted)
                            Spacer()
                            Toggle("", isOn: $launchAtLogin)
                                .toggleStyle(.switch)
                                .tint(.themeSuccess)
                                .disabled(true)
                        }
                        .padding(.vertical, 12)

                        Divider().background(Color.themeBorder)

                        // Default Model Row
                        HStack {
                            Text("Default model")
                                .font(.system(size: 13))
                                .foregroundColor(.themeText)
                            Spacer()
                            Picker("", selection: $selectedDefaultModel) {
                                ForEach(TargetModel.allCases) { model in
                                    Text(model.displayName).tag(model.rawValue)
                                }
                            }
                            .pickerStyle(.menu)
                            .frame(width: 200)
                            .onChange(of: selectedDefaultModel) { _, newValue in
                                Task {
                                    await updateDefaultModel(newValue)
                                }
                            }
                            .onAppear {
                                if let config = bridgeManager.config,
                                   let defaultModel = config.defaultModel,
                                   !defaultModel.isEmpty,
                                   TargetModel.allCases.contains(where: { $0.rawValue == defaultModel }) {
                                    selectedDefaultModel = defaultModel
                                } else {
                                    selectedDefaultModel = TargetModel.passthrough.rawValue
                                }
                            }
                        }
                        .padding(.vertical, 12)

                        Divider().background(Color.themeBorder)

                        // Debug Mode Row
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Debug mode")
                                    .font(.system(size: 13))
                                    .foregroundColor(.themeText)
                                Text("Save all traffic to log file")
                                    .font(.system(size: 11))
                                    .foregroundColor(.themeTextMuted)
                            }
                            Spacer()
                            if debugMode, currentLogPath != nil {
                                Button(action: {
                                    copyLogPath()
                                }) {
                                    HStack(spacing: 4) {
                                        Image(systemName: showCopiedToast ? "checkmark" : "doc.on.doc")
                                            .font(.system(size: 10))
                                        Text(showCopiedToast ? "Copied!" : "Copy Path")
                                            .font(.system(size: 11))
                                    }
                                    .foregroundColor(.themeAccent)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                }
                                .buttonStyle(.plain)
                                .background(Color.themeAccent.opacity(0.1))
                                .cornerRadius(4)
                            }
                            Toggle("", isOn: $debugMode)
                                .toggleStyle(.switch)
                                .tint(.themeAccent)
                                .onChange(of: debugMode) { _, newValue in
                                    Task {
                                        let logPath = await bridgeManager.setDebugMode(newValue)
                                        await MainActor.run {
                                            currentLogPath = logPath
                                        }
                                    }
                                }
                        }
                        .padding(.vertical, 12)
                    }
                    .padding(.horizontal, 16)
                }
            }
            .padding(24)
        }
        .background(Color.themeBg)
    }

    private func copyLogPath() {
        guard let logPath = currentLogPath else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(logPath, forType: .string)

        withAnimation {
            showCopiedToast = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            withAnimation {
                showCopiedToast = false
            }
        }
    }

    private func updateDefaultModel(_ model: String) async {
        guard var config = bridgeManager.config else { return }
        config.defaultModel = model
        await bridgeManager.updateConfig(config)
    }
}

/// API Keys configuration tab
struct ApiKeysView: View {
    @ObservedObject var apiKeyManager: ApiKeyManager
    @State private var expandedKey: ApiKeyType? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Compact table container
                ThemeCard {
                    VStack(spacing: 0) {
                        // Table header
                        HStack(spacing: 12) {
                            Text("")
                                .frame(width: 40, alignment: .leading)
                            Text("SERVICE")
                                .frame(minWidth: 100, alignment: .leading)
                            Text("SOURCE")
                                .frame(minWidth: 120, alignment: .leading)
                            Text("ENV VARIABLE")
                                .frame(minWidth: 140, alignment: .leading)
                            Text("LINK")
                                .frame(width: 50, alignment: .leading)
                            Spacer()
                        }
                        .font(.system(size: 10, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(0.5)
                        .foregroundColor(.themeTextMuted)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color.themeHover.opacity(0.5))

                        // Divider
                        Divider()
                            .background(Color.themeBorder)

                        // Key rows
                        ForEach(apiKeyManager.keys, id: \.id) { keyConfig in
                            CompactApiKeyRow(
                                keyConfig: keyConfig,
                                apiKeyManager: apiKeyManager,
                                isExpanded: expandedKey == keyConfig.id,
                                onToggleExpand: {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        expandedKey = (expandedKey == keyConfig.id) ? nil : keyConfig.id
                                    }
                                }
                            )

                            if keyConfig.id != apiKeyManager.keys.last?.id {
                                Divider()
                                    .background(Color.themeBorder)
                            }
                        }
                    }
                }
            }
            .padding(24)
        }
        .background(Color.themeBg)
    }
}

/// Compact row for API key - collapsed: ~60px, expanded: ~120px
struct CompactApiKeyRow: View {
    let keyConfig: ApiKeyConfig
    @ObservedObject var apiKeyManager: ApiKeyManager
    let isExpanded: Bool
    let onToggleExpand: () -> Void

    @State private var manualValue: String = ""
    @State private var isSaving: Bool = false
    @State private var error: String? = nil
    @State private var showClearConfirmation: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            // Main row (always visible) - ~60px
            Button(action: onToggleExpand) {
                HStack(spacing: 12) {
                    // Status indicator (icon only)
                    statusIcon
                        .font(.system(size: 16))
                        .frame(width: 40, alignment: .leading)

                    // Service name (100px)
                    Text(keyConfig.id.displayName)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.themeText)
                        .frame(minWidth: 100, alignment: .leading)

                    // Source mode (120px)
                    Picker("", selection: binding(for: keyConfig.id)) {
                        Text("Env").tag(ApiKeyMode.environment)
                        Text("Manual").tag(ApiKeyMode.manual)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 120)
                    .onChange(of: keyConfig.mode) { _, _ in
                        // Close expansion when mode changes
                        if isExpanded {
                            onToggleExpand()
                        }
                    }

                    // Env variable name (140px)
                    Text(keyConfig.id.rawValue)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.themeTextMuted)
                        .frame(minWidth: 140, alignment: .leading)

                    // Link button (50px)
                    if let url = keyConfig.id.apiKeyURL {
                        Button(action: {
                            NSWorkspace.shared.open(url)
                        }) {
                            Image(systemName: "arrow.up.right.square")
                                .font(.system(size: 13))
                                .foregroundColor(.themeTextMuted)
                        }
                        .buttonStyle(.plain)
                        .help("Get API key")
                        .frame(width: 50, alignment: .leading)
                    } else {
                        Spacer()
                            .frame(width: 50)
                    }

                    Spacer()

                    // Expand indicator
                    if keyConfig.mode == .manual {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(.themeTextMuted)
                            .animation(.easeInOut(duration: 0.2), value: isExpanded)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(isExpanded ? Color.themeHover.opacity(0.3) : Color.clear)

            // Expanded manual entry section - ~60px when shown
            if isExpanded && keyConfig.mode == .manual {
                VStack(alignment: .leading, spacing: 12) {
                    Divider()
                        .background(Color.themeBorder)

                    HStack(spacing: 8) {
                        SecureField("Enter API key...", text: $manualValue)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12, design: .monospaced))
                            .padding(8)
                            .background(Color.themeBg)
                            .cornerRadius(4)
                            .disabled(isSaving)

                        Button(action: { saveKey() }) {
                            HStack(spacing: 4) {
                                if isSaving {
                                    ProgressView()
                                        .scaleEffect(0.6)
                                        .frame(width: 12, height: 12)
                                } else {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 10))
                                }
                            }
                            .foregroundColor(.white)
                            .frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .background(Color.themeSuccess)
                        .cornerRadius(4)
                        .disabled(manualValue.isEmpty || isSaving)
                        .help("Save API key")

                        Button(action: { showClearConfirmation = true }) {
                            Image(systemName: "trash")
                                .font(.system(size: 10))
                                .foregroundColor(.themeDestructive)
                                .frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .background(Color.themeDestructive.opacity(0.1))
                        .cornerRadius(4)
                        .disabled(!keyConfig.hasManualValue || isSaving)
                        .help("Clear saved key")
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)

                    // Error display
                    if let error = error {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 10))
                                .foregroundColor(.themeDestructive)
                            Text(error)
                                .font(.system(size: 11))
                                .foregroundColor(.themeDestructive)
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 12)
                    }
                }
                .background(Color.themeHover.opacity(0.3))
            }
        }
        .alert("Clear API Key", isPresented: $showClearConfirmation) {
            Button("Cancel", role: .cancel) { }
            Button("Clear", role: .destructive) { clearKey() }
        } message: {
            Text("Are you sure you want to clear the saved API key for \(keyConfig.id.displayName)?")
        }
    }

    private var statusIcon: some View {
        Group {
            if keyConfig.mode == .environment {
                if keyConfig.hasEnvironmentValue {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.themeSuccess)
                } else {
                    Image(systemName: "xmark.circle")
                        .foregroundColor(.themeDestructive)
                }
            } else {
                if keyConfig.hasManualValue {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.themeSuccess)
                } else {
                    Image(systemName: "circle")
                        .foregroundColor(.themeTextMuted)
                }
            }
        }
    }

    private func binding(for keyType: ApiKeyType) -> Binding<ApiKeyMode> {
        Binding(
            get: {
                apiKeyManager.keys.first(where: { $0.id == keyType })?.mode ?? .environment
            },
            set: { newMode in
                apiKeyManager.setMode(for: keyType, mode: newMode)
            }
        )
    }

    private func saveKey() {
        guard !manualValue.isEmpty else { return }

        if !apiKeyManager.validateKey(manualValue, for: keyConfig.id) {
            error = "Invalid API key format"
            return
        }

        isSaving = true
        error = nil

        Task {
            do {
                try await apiKeyManager.setManualKey(for: keyConfig.id, value: manualValue)
                await MainActor.run {
                    manualValue = ""
                    isSaving = false
                    onToggleExpand() // Auto-collapse after save
                }
            } catch {
                await MainActor.run {
                    self.error = error.localizedDescription
                    isSaving = false
                }
            }
        }
    }

    private func clearKey() {
        isSaving = true
        error = nil

        Task {
            do {
                try await apiKeyManager.clearManualKey(for: keyConfig.id)
                await MainActor.run {
                    manualValue = ""
                    isSaving = false
                }
            } catch {
                await MainActor.run {
                    self.error = error.localizedDescription
                    isSaving = false
                }
            }
        }
    }
}

/// About tab
struct AboutView: View {
    // Brand colors from claudish.com
    private let brandCoral = Color(hex: "#D98B6D")
    private let brandGreen = Color(hex: "#5BBA8F")

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Spacer()
                    .frame(height: 16)

                // Logo area - simplified version of the website logo
                HStack(alignment: .lastTextBaseline, spacing: 0) {
                    Text("CLAUD")
                        .font(.system(size: 32, weight: .heavy, design: .rounded))
                        .foregroundColor(brandCoral)
                    Text("ish")
                        .font(.system(size: 24, weight: .medium, design: .serif))
                        .italic()
                        .foregroundColor(brandGreen)
                }

                // Tagline
                HStack(spacing: 6) {
                    Text("Claude.")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.themeText)
                    Text("Any Model.")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(brandGreen)
                }

                Text("Version \(AppInfo.version)")
                    .font(.system(size: 12))
                    .foregroundColor(.themeTextMuted)

                // About card
                ThemeCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("ABOUT")
                            .font(.system(size: 10, weight: .semibold))
                            .textCase(.uppercase)
                            .tracking(1.0)
                            .foregroundColor(.themeTextMuted)

                        Text("A macOS menu bar app for dynamic AI model switching. Reroute Claude Desktop requests to any model via OpenRouter.")
                            .font(.system(size: 13))
                            .foregroundColor(.themeText)
                            .fixedSize(horizontal: false, vertical: true)

                        Divider()
                            .background(Color.themeBorder)
                            .padding(.vertical, 4)

                        Text("CLI TOOL")
                            .font(.system(size: 10, weight: .semibold))
                            .textCase(.uppercase)
                            .tracking(1.0)
                            .foregroundColor(.themeTextMuted)

                        Text("A CLI tool is also available for Claude Code users.")
                            .font(.system(size: 13))
                            .foregroundColor(.themeText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                // Link buttons
                VStack(spacing: 10) {
                    AboutLinkButton(
                        title: "claudish.com",
                        icon: "globe",
                        color: brandCoral,
                        url: "https://claudish.com/"
                    )

                    AboutLinkButton(
                        title: "GitHub Repository",
                        icon: "chevron.left.forwardslash.chevron.right",
                        color: .themeTextMuted,
                        url: "https://github.com/MadAppGang/claudish"
                    )
                }
                .padding(.horizontal, 24)

                // Credits section
                VStack(spacing: 6) {
                    HStack(spacing: 4) {
                        Text("Developed by")
                            .font(.system(size: 12))
                            .foregroundColor(.themeTextMuted)
                        Button(action: {
                            if let url = URL(string: "https://madappgang.com/") {
                                NSWorkspace.shared.open(url)
                            }
                        }) {
                            Text("MadAppGang")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(brandCoral)
                        }
                        .buttonStyle(.plain)
                        .onHover { hovering in
                            if hovering {
                                NSCursor.pointingHand.push()
                            } else {
                                NSCursor.pop()
                            }
                        }
                    }

                    Text("Jack Rudenko")
                        .font(.system(size: 11))
                        .foregroundColor(.themeTextMuted)
                }
                .padding(.top, 8)

                Spacer()
            }
            .padding(24)
        }
        .background(Color.themeBg)
    }
}

/// Reusable link button for About view
struct AboutLinkButton: View {
    let title: String
    let icon: String
    let color: Color
    let url: String
    @State private var isHovered = false

    var body: some View {
        Button(action: {
            if let linkUrl = URL(string: url) {
                NSWorkspace.shared.open(linkUrl)
            }
        }) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 13))
                Text(title)
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundColor(.themeText)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .background(isHovered ? color.opacity(0.9) : color.opacity(0.8))
        .cornerRadius(8)
        .onHover { hovering in
            isHovered = hovering
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }
}

/// Logs viewer window
struct LogsView: View {
    @ObservedObject var bridgeManager: BridgeManager
    @State private var traffic: [RawTrafficEntry] = []
    @State private var isLoading = false
    @State private var autoRefresh = true

    var body: some View {
        VStack(spacing: 0) {
            // Header with controls
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Raw Traffic")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(.themeText)
                    Text("\(traffic.count) entries")
                        .font(.system(size: 12))
                        .foregroundColor(.themeTextMuted)
                }

                Spacer()

                Toggle("Auto-refresh", isOn: $autoRefresh)
                    .toggleStyle(SwitchToggleStyle(tint: .themeSuccess))
                    .font(.system(size: 13))
                    .foregroundColor(.themeText)

                Button(action: {
                    Task {
                        await fetchData()
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 12))
                        Text("Refresh")
                            .font(.system(size: 13))
                    }
                    .foregroundColor(.themeText)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .background(Color.themeHover)
                .cornerRadius(6)
                .disabled(isLoading)

                Button(action: {
                    Task {
                        await clearServerData()
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "trash")
                            .font(.system(size: 12))
                        Text("Clear")
                            .font(.system(size: 13))
                    }
                    .foregroundColor(.themeDestructive)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .background(Color.themeDestructive.opacity(0.1))
                .cornerRadius(6)
            }
            .padding(16)
            .background(Color.themeCard)

            Divider()
                .background(Color.themeBorder)

            // Raw Traffic table
                if traffic.isEmpty {
                    VStack(spacing: 16) {
                        Image(systemName: "network")
                            .font(.system(size: 48))
                            .foregroundColor(.themeTextMuted)
                        Text("No traffic yet")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(.themeText)
                        Text("Traffic will appear here when Claude Desktop sends requests")
                            .font(.system(size: 13))
                            .foregroundColor(.themeTextMuted)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.themeBg)
                } else {
                    Table(traffic) {
                        TableColumn("Time") { entry in
                            Text(formatTimestamp(entry.timestamp))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundColor(.themeTextMuted)
                        }
                        .width(80)

                        TableColumn("App") { entry in
                            HStack(spacing: 4) {
                                Text(entry.detectedApp)
                                    .foregroundColor(.themeText)
                                Text("\(Int(entry.confidence * 100))%")
                                    .font(.system(size: 10))
                                    .foregroundColor(.themeSuccess)
                            }
                        }
                        .width(140)

                        TableColumn("Method") { entry in
                            Text(entry.method)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundColor(.themeAccent)
                        }
                        .width(60)

                        TableColumn("Host") { entry in
                            Text(entry.host)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundColor(.themeText)
                                .lineLimit(1)
                        }
                        .width(160)

                        TableColumn("Path") { entry in
                            Text(entry.path)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundColor(.themeText)
                                .lineLimit(1)
                        }
                        .width(120)

                        TableColumn("Size") { entry in
                            if let size = entry.contentLength {
                                Text("\(size)")
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundColor(.themeTextMuted)
                            } else {
                                Text("-")
                                    .foregroundColor(.themeTextMuted)
                            }
                        }
                        .width(60)
                    }
                    .background(Color.themeBg)
                }
        }
        .background(Color.themeBg)
        .frame(minWidth: 800, minHeight: 400)
        .onAppear {
            Task {
                await fetchData()
            }
        }
        .task {
            // Auto-refresh every 2 seconds
            while autoRefresh {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if autoRefresh && bridgeManager.bridgeConnected {
                    await fetchData()
                }
            }
        }
    }

    private func fetchData() async {
        await fetchTraffic()
    }

    private func fetchTraffic() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let trafficResponse: TrafficResponse = try await bridgeManager.apiRequest(
                method: "GET",
                path: "/traffic?limit=100"
            )
            await MainActor.run {
                traffic = trafficResponse.traffic.reversed()  // Show newest first
            }
        } catch {
            print("[LogsView] Failed to fetch traffic: \(error)")
        }
    }

    private func formatTimestamp(_ timestamp: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        guard let date = formatter.date(from: timestamp) else {
            return timestamp
        }

        let displayFormatter = DateFormatter()
        displayFormatter.dateFormat = "HH:mm:ss"
        return displayFormatter.string(from: date)
    }

    private func clearServerData() async {
        do {
            let _: ApiResponse = try await bridgeManager.apiRequest(method: "DELETE", path: "/traffic")
            await MainActor.run {
                traffic = []
            }
        } catch {
            print("[LogsView] Failed to clear data: \(error)")
        }
    }
}

#Preview {
    let bridgeManager = BridgeManager(apiKeyManager: ApiKeyManager())
    let certificateManager = CertificateManager(bridgeManager: bridgeManager)
    return SettingsView(bridgeManager: bridgeManager, profileManager: ProfileManager(), certificateManager: certificateManager, apiKeyManager: ApiKeyManager())
}
