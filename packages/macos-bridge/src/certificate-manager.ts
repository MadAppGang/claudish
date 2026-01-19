import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as forge from "node-forge";

interface CertKeyPair {
  cert: string;
  key: string;
}

// Maximum number of leaf certificates to cache (prevents memory exhaustion)
const MAX_LEAF_CERT_CACHE_SIZE = 100;

/**
 * Manages CA and leaf certificates for HTTPS interception
 *
 * Responsibilities:
 * - Generate root CA certificate on first run
 * - Store CA in certDir with secure permissions
 * - Generate leaf certificates for domains (cached in memory)
 * - Provide leaf certificate via SNI callback
 */
export class CertificateManager {
  private certDir: string;
  private caCert: forge.pki.Certificate | null = null;
  private caKey: forge.pki.rsa.PrivateKey | null = null;
  private leafCertCache: Map<string, CertKeyPair> = new Map();

  constructor(certDir: string) {
    this.certDir = certDir;
  }

  /**
   * Initialize CA (generates if missing)
   */
  async initialize(): Promise<void> {
    try {
      // Create cert directory if missing
      await fs.mkdir(this.certDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new Error(
        `CERT_DIR_CREATE_FAILED: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const caCertPath = path.join(this.certDir, "ca.pem");
    const caKeyPath = path.join(this.certDir, "ca-key.pem");

    // Check if CA already exists
    if ((await this.fileExists(caCertPath)) && (await this.fileExists(caKeyPath))) {
      try {
        // Load existing CA
        const caCertPEM = await fs.readFile(caCertPath, "utf-8");
        const caKeyPEM = await fs.readFile(caKeyPath, "utf-8");

        const loadedCert = forge.pki.certificateFromPem(caCertPEM);

        // Check if CA is expired
        const now = new Date();
        if (loadedCert.validity.notAfter < now) {
          console.error("[CertificateManager] CA certificate has expired, regenerating");
        } else {
          this.caCert = loadedCert;
          this.caKey = forge.pki.privateKeyFromPem(caKeyPEM);
          return;
        }
      } catch (err) {
        // If loading fails, regenerate CA
        console.error("Failed to load existing CA, regenerating:", err);
      }
    }

    // Generate new CA
    try {
      await this.generateCA();
      await this.saveCA(caCertPath, caKeyPath);
    } catch (err) {
      throw new Error(`CA_GENERATION_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get CA certificate PEM for installation
   */
  getCACertPEM(): string {
    if (!this.caCert) {
      throw new Error("CA not initialized. Call initialize() first.");
    }
    return forge.pki.certificateToPem(this.caCert);
  }

  /**
   * Get CA fingerprint (SHA-256)
   */
  getCACertFingerprint(): string {
    if (!this.caCert) {
      throw new Error("CA not initialized. Call initialize() first.");
    }

    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(this.caCert)).getBytes();
    const md = forge.md.sha256.create();
    md.update(der);
    return md.digest().toHex();
  }

  /**
   * Get leaf certificate for domain (generates if missing, caches)
   */
  async getCertForDomain(domain: string): Promise<CertKeyPair> {
    // Check cache first
    if (this.leafCertCache.has(domain)) {
      return this.leafCertCache.get(domain)!;
    }

    // Generate new leaf certificate
    try {
      const certPair = await this.generateLeafCert(domain);

      // Enforce cache size limit (LRU-style: evict oldest entry)
      if (this.leafCertCache.size >= MAX_LEAF_CERT_CACHE_SIZE) {
        const oldestKey = this.leafCertCache.keys().next().value;
        if (oldestKey) {
          this.leafCertCache.delete(oldestKey);
        }
      }

      this.leafCertCache.set(domain, certPair);
      return certPair;
    } catch (err) {
      throw new Error(
        `LEAF_GENERATION_FAILED: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Pre-generate certificates for known domains
   */
  async preGenerateCerts(domains: string[]): Promise<void> {
    await Promise.all(domains.map((domain) => this.getCertForDomain(domain)));
  }

  /**
   * Check if CA already exists
   */
  hasCA(): boolean {
    return this.caCert !== null && this.caKey !== null;
  }

  /**
   * Get CA metadata (fingerprint, validity dates)
   */
  getCAMetadata(): { fingerprint: string; validFrom: Date; validTo: Date } {
    if (!this.caCert) {
      throw new Error("CA not initialized. Call initialize() first.");
    }
    return {
      fingerprint: this.getCACertFingerprint(),
      validFrom: this.caCert.validity.notBefore,
      validTo: this.caCert.validity.notAfter,
    };
  }

  /**
   * Get number of cached leaf certificates
   */
  getLeafCertCount(): number {
    return this.leafCertCache.size;
  }

  /**
   * Get certificate directory path
   */
  getCertDir(): string {
    return this.certDir;
  }

  /**
   * Generate CA certificate (2048-bit RSA, 10 year validity)
   */
  private async generateCA(): Promise<void> {
    // Generate 2048-bit RSA key pair
    const keys = forge.pki.rsa.generateKeyPair(2048);
    this.caKey = keys.privateKey;

    // Create CA certificate
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";

    // 10 year validity
    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(now.getFullYear() + 10);

    // Set subject and issuer (self-signed)
    const attrs = [
      { name: "commonName", value: "Claudish Proxy CA" },
      { name: "organizationName", value: "Claudish" },
      { name: "countryName", value: "US" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    // Set extensions
    cert.setExtensions([
      {
        name: "basicConstraints",
        cA: true,
      },
      {
        name: "keyUsage",
        keyCertSign: true,
        cRLSign: true,
        digitalSignature: true,
      },
    ]);

    // Sign certificate
    cert.sign(keys.privateKey, forge.md.sha256.create());

    this.caCert = cert;
  }

  /**
   * Save CA certificate and private key to disk
   */
  private async saveCA(certPath: string, keyPath: string): Promise<void> {
    if (!this.caCert || !this.caKey) {
      throw new Error("CA not generated");
    }

    try {
      const certPEM = forge.pki.certificateToPem(this.caCert);
      const keyPEM = forge.pki.privateKeyToPem(this.caKey);

      // Write private key with 0600 permissions (owner read/write only)
      await fs.writeFile(keyPath, keyPEM, { mode: 0o600 });

      // Write certificate
      await fs.writeFile(certPath, certPEM, { mode: 0o644 });
    } catch (err) {
      throw new Error(`FILE_WRITE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Generate leaf certificate for domain (1 year validity)
   */
  private async generateLeafCert(domain: string): Promise<CertKeyPair> {
    if (!this.caCert || !this.caKey) {
      throw new Error("CA not initialized. Call initialize() first.");
    }

    // Generate 2048-bit RSA key pair for leaf
    const keys = forge.pki.rsa.generateKeyPair(2048);

    // Create leaf certificate
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    // Use cryptographically secure random serial number (16 hex chars = 64 bits)
    cert.serialNumber = crypto.randomBytes(8).toString("hex");

    // 1 year validity
    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(now.getFullYear() + 1);

    // Set subject
    cert.setSubject([
      { name: "commonName", value: domain },
      { name: "organizationName", value: "Claudish" },
      { name: "countryName", value: "US" },
    ]);

    // Set issuer (CA)
    cert.setIssuer(this.caCert.subject.attributes);

    // Set extensions
    cert.setExtensions([
      {
        name: "basicConstraints",
        cA: false,
      },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
      },
      {
        name: "extKeyUsage",
        serverAuth: true,
      },
      {
        name: "subjectAltName",
        altNames: [
          {
            type: 2, // DNS
            value: domain,
          },
        ],
      },
    ]);

    // Sign with CA
    cert.sign(this.caKey, forge.md.sha256.create());

    // Return PEM strings
    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
