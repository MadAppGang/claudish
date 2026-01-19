import Foundation
import Security

/// Manages certificate installation and keychain operations for HTTPS interception
@MainActor
class CertificateManager: ObservableObject {
    // MARK: - Published State

    @Published var isCAInstalled: Bool = false
    @Published var isCheckingStatus: Bool = true  // Start in checking state
    @Published var caFingerprint: String = ""
    @Published var error: String? = nil

    // MARK: - Private State

    private let bridgeManager: BridgeManager
    private let keychainLabel = "Claudish Proxy CA"

    // MARK: - Initialization

    init(bridgeManager: BridgeManager) {
        self.bridgeManager = bridgeManager

        // Don't check immediately - wait for bridge to connect
        Task {
            // Wait for bridge to be ready (max 5 seconds)
            var attempts = 0
            while !bridgeManager.bridgeConnected && attempts < 50 {
                try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
                attempts += 1
            }

            await checkCAStatus()

            await MainActor.run {
                isCheckingStatus = false
            }
        }
    }

    // MARK: - Public API

    /// Fetch CA certificate from bridge and install in keychain
    func installCA() async throws {
        guard bridgeManager.bridgeConnected else {
            throw CertificateError.bridgeNotConnected
        }

        do {
            // Get CA certificate from bridge
            let response: CACertificateResponse = try await bridgeManager.apiRequest(
                method: "GET",
                path: "/certificates/ca"
            )

            guard let certData = response.data else {
                throw CertificateError.invalidResponse
            }

            // Convert PEM to DER
            guard let derData = pemToDer(certData.cert) else {
                throw CertificateError.invalidPEM
            }

            // Create SecCertificate from DER
            guard let secCert = SecCertificateCreateWithData(nil, derData as CFData) else {
                throw CertificateError.invalidPEM
            }

            // Add to keychain
            try addToKeychain(secCert)

            // Trust certificate for SSL
            try trustCertificateForSSL(secCert)

            // Update state
            await MainActor.run {
                isCAInstalled = true
                caFingerprint = certData.fingerprint
                error = nil
            }

            print("[CertificateManager] CA certificate installed successfully")
        } catch let certError as CertificateError {
            await MainActor.run {
                error = certError.errorDescription
                isCAInstalled = false
            }
            throw certError
        } catch {
            await MainActor.run {
                self.error = "Failed to install certificate: \(error.localizedDescription)"
                isCAInstalled = false
            }
            throw CertificateError.installFailed(errSecSuccess)
        }
    }

    /// Check if CA is installed in keychain AND bridge has generated it
    func checkCAStatus() async {
        print("[CertificateManager] Checking CA status...")

        // First check if bridge has a CA certificate
        guard bridgeManager.bridgeConnected else {
            print("[CertificateManager] Bridge not connected, cannot verify CA")
            await MainActor.run {
                isCAInstalled = false
            }
            return
        }

        // Try to get CA from bridge
        do {
            let caResponse: CACertificateResponse = try await bridgeManager.apiRequest(
                method: "GET",
                path: "/certificates/ca"
            )

            guard let bridgeCertData = caResponse.data else {
                print("[CertificateManager] Bridge has no CA certificate")
                await MainActor.run {
                    isCAInstalled = false
                }
                return
            }

            // Bridge has a CA, now check if it's in the keychain
            let query: [String: Any] = [
                kSecClass as String: kSecClassCertificate,
                kSecAttrLabel as String: keychainLabel,
                kSecReturnRef as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne
            ]

            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            let inKeychain = (status == errSecSuccess)

            print("[CertificateManager] CA in keychain: \(inKeychain), bridge fingerprint: \(bridgeCertData.fingerprint.prefix(16))...")

            await MainActor.run {
                isCAInstalled = inKeychain
                caFingerprint = inKeychain ? bridgeCertData.fingerprint : ""
            }

        } catch {
            print("[CertificateManager] Failed to check CA status: \(error)")
            await MainActor.run {
                isCAInstalled = false
            }
        }
    }

    /// Remove CA from keychain
    func uninstallCA() async throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassCertificate,
            kSecAttrLabel as String: keychainLabel
        ]

        let status = SecItemDelete(query as CFDictionary)

        if status != errSecSuccess && status != errSecItemNotFound {
            throw CertificateError.uninstallFailed(status)
        }

        await MainActor.run {
            isCAInstalled = false
            caFingerprint = ""
            error = nil
        }

        print("[CertificateManager] CA certificate uninstalled")
    }

    /// Open Keychain Access showing the certificate
    func showInKeychain() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", "Keychain Access"]

        do {
            try process.run()
        } catch {
            print("[CertificateManager] Failed to open Keychain Access: \(error)")
            Task { @MainActor in
                self.error = "Failed to open Keychain Access"
            }
        }
    }

    // MARK: - Private Helpers

    /// Convert PEM to DER format
    private func pemToDer(_ pem: String) -> Data? {
        let stripped = pem
            .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return Data(base64Encoded: stripped)
    }

    /// Add certificate to keychain
    private func addToKeychain(_ cert: SecCertificate) throws {
        // First check if it already exists
        let checkQuery: [String: Any] = [
            kSecClass as String: kSecClassCertificate,
            kSecAttrLabel as String: keychainLabel,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var existingItem: CFTypeRef?
        let checkStatus = SecItemCopyMatching(checkQuery as CFDictionary, &existingItem)

        // If it exists, remove it first to allow re-installation
        if checkStatus == errSecSuccess {
            let deleteQuery: [String: Any] = [
                kSecClass as String: kSecClassCertificate,
                kSecAttrLabel as String: keychainLabel
            ]
            SecItemDelete(deleteQuery as CFDictionary)
        }

        // Add the certificate
        let query: [String: Any] = [
            kSecClass as String: kSecClassCertificate,
            kSecValueRef as String: cert,
            kSecAttrLabel as String: keychainLabel
        ]

        let status = SecItemAdd(query as CFDictionary, nil)

        if status != errSecSuccess {
            throw CertificateError.installFailed(status)
        }
    }

    /// Trust certificate for SSL using Security framework
    private func trustCertificateForSSL(_ cert: SecCertificate) throws {
        // Note: Setting trust settings requires admin privileges and will prompt for password
        // We attempt to set trust settings for the user domain
        // SecTrustSettingsResult: kSecTrustSettingsResultTrustAsRoot = 1
        let trustSettings: CFTypeRef = [
            kSecTrustSettingsPolicy as String: SecPolicyCreateSSL(true, nil),
            kSecTrustSettingsResult as String: 1  // kSecTrustSettingsResultTrustAsRoot
        ] as CFDictionary

        let status = SecTrustSettingsSetTrustSettings(
            cert,
            .user,  // User domain (requires password)
            trustSettings
        )

        // If we can't set trust settings, that's okay - user can manually trust in Keychain Access
        if status != errSecSuccess {
            print("[CertificateManager] Warning: Could not set trust settings (status: \(status)). User may need to manually trust certificate in Keychain Access.")
            // Don't throw - installation was successful, just trust settings failed
        }
    }
}

// MARK: - Error Types

enum CertificateError: LocalizedError {
    case invalidPEM
    case installFailed(OSStatus)
    case trustFailed(OSStatus)
    case uninstallFailed(OSStatus)
    case notFound
    case bridgeNotConnected
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidPEM:
            return "Invalid certificate format"
        case .installFailed(let status):
            return "Failed to install certificate (status: \(status))"
        case .trustFailed(let status):
            return "Failed to trust certificate (status: \(status))"
        case .uninstallFailed(let status):
            return "Failed to uninstall certificate (status: \(status))"
        case .notFound:
            return "Certificate not found"
        case .bridgeNotConnected:
            return "Bridge not connected"
        case .invalidResponse:
            return "Invalid response from bridge"
        }
    }
}

// MARK: - API Response Types

struct CACertificateResponse: Codable {
    let success: Bool
    let data: CACertificateData?
}

struct CACertificateData: Codable {
    let cert: String
    let fingerprint: String
    let validFrom: String
    let validTo: String
}

struct CertificateStatusResponse: Codable {
    let success: Bool
    let data: CertificateStatusData?
}

struct CertificateStatusData: Codable {
    let caInstalled: Bool
    let leafCerts: [String]
    let certDir: String
    let fingerprint: String?
}
