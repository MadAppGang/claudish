import SwiftUI
import AppKit

/// App version and metadata
enum AppInfo {
    static let version = "1.0.0"
    static let build = "1"
}

/// App delegate to handle termination cleanup (Layer 3 defense)
class AppDelegate: NSObject, NSApplicationDelegate {
    var bridgeManager: BridgeManager?

    func applicationWillTerminate(_ notification: Notification) {
        print("[AppDelegate] App terminating, cleaning up...")
        // Synchronously clean up - we can't use async here as the app is terminating
        // Use a semaphore to wait for the async cleanup
        let semaphore = DispatchSemaphore(value: 0)

        Task {
            await bridgeManager?.shutdown()
            semaphore.signal()
        }

        // Wait up to 2 seconds for cleanup
        _ = semaphore.wait(timeout: .now() + 2)
        print("[AppDelegate] Cleanup complete")
    }
}

/// Claudish Proxy - macOS Menu Bar Application
///
/// This app lives in the macOS status bar and provides:
/// - Dynamic model switching for AI requests
/// - Per-app model remapping configuration
/// - Request logging and statistics
///
/// Architecture:
/// - Swift/SwiftUI frontend for native macOS experience
/// - Spawns claudish-bridge Node.js process for proxy logic
/// - Communicates via HTTP API with token-based auth

@main
struct ClaudishProxyApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var apiKeyManager = ApiKeyManager()
    @StateObject private var bridgeManager: BridgeManager
    @StateObject private var profileManager = ProfileManager()
    @StateObject private var certificateManager: CertificateManager

    init() {
        // Initialize state objects with proper dependencies
        let apiKeyManager = ApiKeyManager()
        let bridgeManager = BridgeManager(apiKeyManager: apiKeyManager)
        let profileManager = ProfileManager()
        let certificateManager = CertificateManager(bridgeManager: bridgeManager)

        _apiKeyManager = StateObject(wrappedValue: apiKeyManager)
        _bridgeManager = StateObject(wrappedValue: bridgeManager)
        _profileManager = StateObject(wrappedValue: profileManager)
        _certificateManager = StateObject(wrappedValue: certificateManager)
    }

    var body: some Scene {
        // Menu bar extra (status bar icon)
        MenuBarExtra {
            MenuBarContent(bridgeManager: bridgeManager, profileManager: profileManager, certificateManager: certificateManager)
                .onAppear {
                    // Connect app delegate to bridge manager for termination cleanup (Layer 3)
                    appDelegate.bridgeManager = bridgeManager

                    // Connect profile manager to bridge manager
                    profileManager.setBridgeManager(bridgeManager)
                    // Apply profile when bridge connects
                    if bridgeManager.bridgeConnected {
                        profileManager.applySelectedProfile()
                    }
                }
        } label: {
            // Status bar icon
            if bridgeManager.isProxyEnabled {
                Image(systemName: "arrow.left.arrow.right.circle.fill")
            } else {
                Image(systemName: "arrow.left.arrow.right.circle")
            }
        }
        .menuBarExtraStyle(.window)

        // Settings window (using Window instead of Settings for menu bar apps)
        Window("Claudish Proxy Settings", id: "settings") {
            SettingsView(bridgeManager: bridgeManager, profileManager: profileManager, certificateManager: certificateManager, apiKeyManager: apiKeyManager)
        }
        .defaultSize(width: 550, height: 450)
        .windowResizability(.contentSize)

        // Logs window
        Window("Request Logs", id: "logs") {
            LogsView(bridgeManager: bridgeManager)
        }
        .defaultSize(width: 800, height: 600)
    }
}

/// Menu bar dropdown content using StatsPanel implementation
struct MenuBarContent: View {
    @ObservedObject var bridgeManager: BridgeManager
    @ObservedObject var profileManager: ProfileManager
    @ObservedObject var certificateManager: CertificateManager
    @Environment(\.openWindow) private var openWindow
    @State private var showErrorAlert = false
    @State private var showCleanupAlert = false
    @State private var timeRange = "30 Days"
    @State private var isInstallingCert = false

    // Access stats manager from bridge manager
    private var statsManager: StatsManager {
        bridgeManager.statsManager
    }

    // Calculate usage percentage based on tokens used
    private var usagePercentage: Double {
        // Use token-based calculation (arbitrary 1M token limit for display)
        min(Double(statsManager.totalTokens) / 1_000_000.0, 1.0)
    }

    // Recent activity from stats manager
    private var recentActivity: [RequestStat] {
        statsManager.recentActivity
    }

    // Determine if we need to show setup (certificate not installed OR bridge not connected)
    private var needsSetup: Bool {
        !certificateManager.isCAInstalled || !bridgeManager.bridgeConnected
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Show loading while checking certificate status
            if certificateManager.isCheckingStatus {
                loadingView
            }
            // Certificate Setup Banner - shows when CA is not installed OR bridge disconnected
            else if needsSetup {
                certificateSetupBanner
            } else {
                mainContent
            }
        }
        .background(Color.themeCard)
        .cornerRadius(12)
        .frame(width: 380)
        .alert("Error", isPresented: $showErrorAlert) {
            Button("OK") {
                showErrorAlert = false
                bridgeManager.errorMessage = nil
            }
        } message: {
            Text(bridgeManager.errorMessage ?? "Unknown error")
        }
        .alert("Proxy Cleanup Failed", isPresented: $showCleanupAlert) {
            Button("Open Network Settings") {
                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.network") {
                    NSWorkspace.shared.open(url)
                }
            }
            Button("Quit Anyway", role: .destructive) {
                NSApplication.shared.terminate(nil)
            }
        } message: {
            Text("Failed to disable system proxy. Your internet may not work until you manually disable the proxy in System Settings > Network.")
        }
    }

    // MARK: - Loading View

    private var loadingView: some View {
        VStack(spacing: 20) {
            Spacer()

            ProgressView()
                .scaleEffect(1.5)
                .progressViewStyle(CircularProgressViewStyle(tint: .themeAccent))

            Text("Checking certificate status...")
                .font(.system(size: 14))
                .foregroundColor(.themeTextMuted)

            Spacer()
        }
        .frame(width: 380, height: 200)
    }

    // MARK: - Certificate Setup Banner

    private var certificateSetupBanner: some View {
        VStack(spacing: 0) {
            // Main content area
            VStack(spacing: 16) {
                // Icon based on state
                if !bridgeManager.bridgeConnected {
                    if bridgeManager.isAttemptingRecovery {
                        ProgressView()
                            .scaleEffect(1.5)
                            .frame(width: 48, height: 48)
                    } else {
                        Image(systemName: "bolt.slash.circle.fill")
                            .font(.system(size: 48))
                            .foregroundColor(.themeDestructive)
                    }
                } else {
                    Image(systemName: "shield.lefthalf.filled.badge.checkmark")
                        .font(.system(size: 48))
                        .foregroundColor(.themeAccent)
                }

                // Title
                Text(!bridgeManager.bridgeConnected
                    ? (bridgeManager.isAttemptingRecovery ? "Reconnecting..." : "Bridge Disconnected")
                    : "Setup Required")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(.themeText)

                // Description based on state
                VStack(spacing: 6) {
                    if !bridgeManager.bridgeConnected {
                        if bridgeManager.isAttemptingRecovery {
                            Text("Attempting to Reconnect")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.themeText)

                            Text("Please wait while the bridge service restarts...")
                                .font(.system(size: 12))
                                .foregroundColor(.themeTextMuted)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            Text("Proxy Service Unavailable")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.themeText)

                            Text("The background bridge process is not running. Try restarting the app.")
                                .font(.system(size: 12))
                                .foregroundColor(.themeTextMuted)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else if !certificateManager.isCAInstalled {
                        Text("HTTPS Certificate Not Installed")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(.themeText)

                        Text("Claudish Proxy needs to install a root certificate to intercept HTTPS traffic from Claude Desktop.")
                            .font(.system(size: 12))
                            .foregroundColor(.themeTextMuted)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 24)

                // Install button (only if bridge connected and cert not installed)
                if bridgeManager.bridgeConnected && !certificateManager.isCAInstalled {
                    Button(action: {
                        isInstallingCert = true
                        Task {
                            do {
                                try await certificateManager.installCA()
                            } catch {
                                print("[MenuBarContent] Certificate installation failed: \(error)")
                            }
                            await MainActor.run {
                                isInstallingCert = false
                            }
                        }
                    }) {
                        HStack(spacing: 8) {
                            if isInstallingCert {
                                ProgressView()
                                    .scaleEffect(0.8)
                                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            } else {
                                Image(systemName: "checkmark.shield.fill")
                                    .font(.system(size: 14))
                            }
                            Text(isInstallingCert ? "Installing..." : "Install Certificate")
                                .font(.system(size: 14, weight: .semibold))
                        }
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                    }
                    .buttonStyle(.plain)
                    .background(Color.themeSuccess)
                    .cornerRadius(8)
                    .padding(.horizontal, 24)
                    .disabled(isInstallingCert)
                }

                // Error message
                if let error = certificateManager.error {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 11))
                            .foregroundColor(.themeDestructive)
                        Text(error)
                            .font(.system(size: 11))
                            .foregroundColor(.themeDestructive)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 24)
                }

                // Connection status indicator
                HStack(spacing: 6) {
                    Circle()
                        .fill(bridgeManager.bridgeConnected
                            ? Color.themeSuccess
                            : (bridgeManager.isAttemptingRecovery ? Color.themeAccent : Color.themeDestructive))
                        .frame(width: 6, height: 6)
                    Text(bridgeManager.bridgeConnected
                        ? "Bridge Connected"
                        : (bridgeManager.isAttemptingRecovery ? "Reconnecting..." : "Bridge Disconnected"))
                        .font(.system(size: 11))
                        .foregroundColor(.themeTextMuted)
                }
            }
            .padding(.top, 32)
            .padding(.bottom, 24)

            Spacer(minLength: 0)

            // Footer
            VStack(spacing: 0) {
                Rectangle()
                    .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .foregroundColor(.themeBorder)
                    .frame(height: 1)
                    .padding(.horizontal, 20)

                HStack {
                    Button(action: {
                        NSApp.setActivationPolicy(.regular)
                        openWindow(id: "settings")
                        NSApp.activate(ignoringOtherApps: true)
                    }) {
                        Image(systemName: "gearshape")
                            .font(.system(size: 14))
                    }
                    .buttonStyle(PlainButtonStyle())
                    .foregroundColor(.themeTextMuted)

                    Spacer()

                    PillButton(title: "Quit") {
                        NSApplication.shared.terminate(nil)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
        }
        .frame(width: 380)
    }

    // MARK: - Main Content (when certificate is installed)

    private var mainContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header with time range and proxy toggle
            HStack {
                Text("REQUESTS TODAY")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(1.0)
                    .foregroundColor(.themeTextMuted)

                Spacer()

                // Proxy toggle
                Toggle("", isOn: $bridgeManager.isProxyEnabled)
                    .toggleStyle(SwitchToggleStyle(tint: .themeSuccess))
                    .labelsHidden()
                    .disabled(!bridgeManager.bridgeConnected)
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 12)

            // Big number display
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(statsManager.requestsToday)")
                    .font(.system(size: 48, weight: .bold))
                    .foregroundColor(.themeText)
                    .monospacedDigit()

                Text("requests")
                    .font(.system(size: 14))
                    .foregroundColor(.themeTextMuted)
            }
            .padding(.horizontal, 20)

            // Token stats row
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("INPUT TOKENS")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(.themeTextMuted)
                    Text("\(statsManager.totalInputTokens.formatted())")
                        .font(.system(size: 14, weight: .semibold).monospacedDigit())
                        .foregroundColor(.themeAccent)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("OUTPUT TOKENS")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundColor(.themeTextMuted)
                    Text("\(statsManager.totalOutputTokens.formatted())")
                        .font(.system(size: 14, weight: .semibold).monospacedDigit())
                        .foregroundColor(.themeAccent)
                }

                Spacer()

                if bridgeManager.bridgeConnected {
                    Circle()
                        .fill(Color.themeSuccess)
                        .frame(width: 6, height: 6)
                    Text("CONNECTED")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.5)
                        .foregroundColor(.themeSuccess)
                } else {
                    Circle()
                        .fill(Color.themeDestructive)
                        .frame(width: 6, height: 6)
                    Text("DISCONNECTED")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.5)
                        .foregroundColor(.themeDestructive)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 16)

            // Dashed divider
            Rectangle()
                .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundColor(.themeBorder)
                .frame(height: 1)
                .padding(.horizontal, 20)

            // Recent activity table
            VStack(alignment: .leading, spacing: 12) {
                Text("RECENT ACTIVITY")
                    .font(.system(size: 11, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(1.0)
                    .foregroundColor(.themeTextMuted)

                if recentActivity.isEmpty {
                    // Empty state
                    HStack {
                        Spacer()
                        VStack(spacing: 8) {
                            Image(systemName: "tray")
                                .font(.system(size: 24))
                                .foregroundColor(.themeTextMuted)
                            Text("No activity yet")
                                .font(.system(size: 12))
                                .foregroundColor(.themeTextMuted)
                        }
                        .padding(.vertical, 20)
                        Spacer()
                    }
                } else {
                    // Table header
                    HStack(spacing: 12) {
                        Text("TIME")
                            .frame(width: 50, alignment: .leading)
                        Text("SOURCE → TARGET")
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text("TOKENS")
                            .frame(width: 70, alignment: .trailing)
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.themeTextMuted)

                    // Table rows
                    ForEach(recentActivity) { stat in
                        HStack(spacing: 12) {
                            Text(formatTime(stat.timestamp))
                                .font(.system(size: 11))
                                .foregroundColor(.themeTextMuted)
                                .frame(width: 50, alignment: .leading)

                            HStack(spacing: 4) {
                                Text(formatModelName(stat.sourceModel))
                                    .font(.system(size: 11))
                                    .foregroundColor(.themeText)
                                Image(systemName: "arrow.right")
                                    .font(.system(size: 8))
                                    .foregroundColor(.themeTextMuted)
                                Text(formatModelName(stat.targetModel))
                                    .font(.system(size: 11))
                                    .foregroundColor(stat.targetModel == "internal" ? .themeTextMuted : .themeAccent)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(1)

                            Text("\(stat.inputTokens + stat.outputTokens)")
                                .font(.system(size: 11).monospacedDigit())
                                .foregroundColor(.themeText)
                                .frame(width: 70, alignment: .trailing)
                        }
                        .padding(.vertical, 4)
                        .opacity(stat.success ? 1.0 : 0.5)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)

            // Dashed divider
            Rectangle()
                .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundColor(.themeBorder)
                .frame(height: 1)
                .padding(.horizontal, 20)

            // Unified Model/Profile Picker
            UnifiedModelPicker(profileManager: profileManager, bridgeManager: bridgeManager)

            // Error message banner (if any)
            if let errorMessage = bridgeManager.errorMessage {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.themeAccent)
                    Text(errorMessage)
                        .font(.system(size: 11))
                        .foregroundColor(.themeTextMuted)
                        .lineLimit(2)
                }
                .padding(12)
                .background(Color.themeAccent.opacity(0.1))
                .cornerRadius(6)
                .padding(.horizontal, 20)
                .onTapGesture {
                    showErrorAlert = true
                }
            }

            // Dashed divider
            Rectangle()
                .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundColor(.themeBorder)
                .frame(height: 1)
                .padding(.horizontal, 20)

            // Footer with actions (matches StatsPanel footer style)
            HStack {
                HStack(spacing: 12) {
                    Button(action: {
                        NSApp.setActivationPolicy(.regular)
                        openWindow(id: "settings")
                        NSApp.activate(ignoringOtherApps: true)
                    }) {
                        Image(systemName: "gearshape")
                            .font(.system(size: 14))
                    }
                    .buttonStyle(PlainButtonStyle())
                    .keyboardShortcut(",", modifiers: .command)

                    Button(action: {
                        NSApp.setActivationPolicy(.regular)
                        openWindow(id: "logs")
                        NSApp.activate(ignoringOtherApps: true)
                    }) {
                        Image(systemName: "list.bullet.rectangle")
                            .font(.system(size: 14))
                    }
                    .buttonStyle(PlainButtonStyle())
                }
                .foregroundColor(.themeTextMuted)

                Spacer()

                PillButton(title: "Quit") {
                    Task {
                        let cleanupSuccess = await bridgeManager.shutdown()
                        if !cleanupSuccess {
                            await MainActor.run {
                                showCleanupAlert = true
                            }
                            try? await Task.sleep(nanoseconds: 500_000_000)
                        }
                        NSApplication.shared.terminate(nil)
                    }
                }
                .keyboardShortcut("q", modifiers: .command)
            }
            .padding(20)
        }
    }

    // MARK: - Helpers

    /// Format timestamp as relative time or short time
    private func formatTime(_ date: Date) -> String {
        let now = Date()
        let interval = now.timeIntervalSince(date)

        if interval < 60 {
            return "now"
        } else if interval < 3600 {
            let minutes = Int(interval / 60)
            return "\(minutes)m"
        } else if interval < 86400 {
            let hours = Int(interval / 3600)
            return "\(hours)h"
        } else {
            let formatter = DateFormatter()
            formatter.dateFormat = "MMM d"
            return formatter.string(from: date)
        }
    }

    /// Format model name (extract just the model name part)
    private func formatModelName(_ model: String) -> String {
        if model == "internal" {
            return "Claude"
        }

        // Extract after the last slash (e.g., "g/gemini-3-pro" -> "gemini-3-pro")
        if let lastSlash = model.lastIndex(of: "/") {
            let name = String(model[model.index(after: lastSlash)...])
            // Truncate if too long
            return name.count > 20 ? String(name.prefix(17)) + "..." : name
        }

        // Truncate long model names
        return model.count > 20 ? String(model.prefix(17)) + "..." : model
    }
}
