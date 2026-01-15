import SwiftUI

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
    @StateObject private var bridgeManager = BridgeManager()

    var body: some Scene {
        // Menu bar extra (status bar icon)
        MenuBarExtra {
            MenuBarContent(bridgeManager: bridgeManager)
        } label: {
            // Status bar icon
            if bridgeManager.isProxyEnabled {
                Image(systemName: "arrow.left.arrow.right.circle.fill")
            } else {
                Image(systemName: "arrow.left.arrow.right.circle")
            }
        }
        .menuBarExtraStyle(.menu)

        // Settings window (using Window instead of Settings for menu bar apps)
        Window("Claudish Proxy Settings", id: "settings") {
            SettingsView(bridgeManager: bridgeManager)
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

/// Menu bar dropdown content
struct MenuBarContent: View {
    @ObservedObject var bridgeManager: BridgeManager
    @Environment(\.openWindow) private var openWindow
    @State private var showErrorAlert = false
    @State private var showCleanupAlert = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Status header
            HStack {
                Circle()
                    .fill(bridgeManager.bridgeConnected ? .green : .red)
                    .frame(width: 8, height: 8)
                Text(bridgeManager.bridgeConnected ? "Bridge Connected" : "Bridge Disconnected")
                    .font(.headline)
            }
            .padding(.bottom, 4)

            // Error message banner
            if let errorMessage = bridgeManager.errorMessage {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.orange)
                    Text(errorMessage)
                        .font(.caption)
                        .lineLimit(2)
                }
                .padding(8)
                .background(Color.orange.opacity(0.1))
                .cornerRadius(4)
                .onTapGesture {
                    showErrorAlert = true
                }
            }

            Divider()

            // Proxy toggle
            Toggle("Enable Proxy", isOn: $bridgeManager.isProxyEnabled)
                .toggleStyle(.switch)
                .disabled(!bridgeManager.bridgeConnected)

            // Stats
            if bridgeManager.isProxyEnabled {
                HStack {
                    Text("Requests:")
                    Spacer()
                    Text("\(bridgeManager.totalRequests)")
                        .monospacedDigit()
                }
                .font(.caption)

                if let lastApp = bridgeManager.lastDetectedApp {
                    HStack {
                        Text("Last App:")
                        Spacer()
                        Text(lastApp)
                            .lineLimit(1)
                    }
                    .font(.caption)
                }

                if let lastModel = bridgeManager.lastTargetModel {
                    HStack {
                        Text("Last Model:")
                        Spacer()
                        Text(lastModel)
                            .lineLimit(1)
                            .foregroundColor(.blue)
                    }
                    .font(.caption)
                }
            }

            Divider()

            // Detected Apps
            if !bridgeManager.detectedApps.isEmpty {
                Text("Detected Apps")
                    .font(.caption)
                    .foregroundColor(.secondary)

                ForEach(bridgeManager.detectedApps, id: \.name) { app in
                    HStack {
                        Text(app.name)
                        Spacer()
                        Text("\(app.requestCount) reqs")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    .font(.caption)
                }

                Divider()
            }

            // Actions
            Button("Settings...") {
                NSApp.setActivationPolicy(.regular)
                openWindow(id: "settings")
                NSApp.activate(ignoringOtherApps: true)
            }
            .keyboardShortcut(",", modifiers: .command)

            Button("View Logs...") {
                NSApp.setActivationPolicy(.regular)
                openWindow(id: "logs")
                NSApp.activate(ignoringOtherApps: true)
            }

            Divider()

            Button("Quit Claudish Proxy") {
                Task {
                    let cleanupSuccess = await bridgeManager.shutdown()
                    if !cleanupSuccess {
                        await MainActor.run {
                            showCleanupAlert = true
                        }
                        // Brief delay to show alert before quitting
                        try? await Task.sleep(nanoseconds: 500_000_000) // 0.5 seconds
                    }
                    NSApplication.shared.terminate(nil)
                }
            }
            .keyboardShortcut("q", modifiers: .command)
        }
        .padding()
        .frame(width: 250)
        .alert("Error", isPresented: $showErrorAlert) {
            Button("OK") {
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
                // Alert will auto-dismiss and app will quit
            }
        } message: {
            Text("Failed to disable system proxy. Your internet may not work until you manually disable the proxy in System Settings > Network.")
        }
    }
}
