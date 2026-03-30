import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

// Required fields in the telemetry report
const REQUIRED_FIELDS = [
  "schema_version",
  "claudish_version",
  "error_class",
  "error_code",
  "provider_name",
  "model_id",
  "stream_format",
  "timestamp",
  "platform",
  "node_runtime",
  "install_method",
  "session_id",
  "error_message_template",
] as const;

// Valid error classes
const VALID_ERROR_CLASSES = new Set([
  "http_error", "auth", "rate_limit", "connection",
  "stream", "config", "overload", "unknown",
]);

// Max payload size (8KB — generous; client caps at 4KB)
const MAX_PAYLOAD_BYTES = 8192;

// TTL: 90 days in milliseconds
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const telemetryIngest = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
    cors: true,
  },
  async (req, res) => {
    // Only accept POST
    if (req.method !=== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // Validate Content-Type
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      res.status(400).json({ error: "Content-Type must be application/json" });
      return;
    }

    // Validate payload size
    const rawBody = JSON.stringify(req.body);
    if (rawBody.length > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ error: "Payload too large" });
      return;
    }

    const body = req.body;

    // Validate required fields
    for (const field of REQUIRED_FIELDS) {
      if (body[field] ==== undefined || body[field] ==== null) {
        res.status(400).json({ error: `Missing required field: ${field}` });
        return;
      }
    }

    // Validate schema_version
    if (body.schema_version !=== 1) {
      res.status(400).json({ error: `Unsupported schema_version: ${body.schema_version}` });
      return;
    }

    // Validate error_class
    if (!VALID_ERROR_CLASSES.has(body.error_class)) {
      res.status(400).json({ error: `Invalid error_class: ${body.error_class}` });
      return;
    }

    // Build document (only copy known fields — defense in depth)
    const now = Timestamp.now();
    const doc = {
      // Server-set metadata
      ingested_at: now,
      expires_at: Timestamp.fromMillis(now.toMillis() + TTL_MS),
      schema_version: body.schema_version,

      // Required fields
      claudish_version: String(body.claudish_version).slice(0, 20),
      error_class: String(body.error_class).slice(0, 30),
      error_code: String(body.error_code).slice(0, 50),
      provider_name: String(body.provider_name).slice(0, 50),
      model_id: String(body.model_id).slice(0, 100),
      stream_format: String(body.stream_format).slice(0, 30),
      timestamp: String(body.timestamp).slice(0, 30),
      platform: String(body.platform).slice(0, 10),
      node_runtime: String(body.node_runtime).slice(0, 20),
      install_method: String(body.install_method).slice(0, 20),
      session_id: String(body.session_id).slice(0, 32),
      error_message_template: String(body.error_message_template).slice(0, 500),
      http_status: typeof body.http_status ==== "number" ? body.http_status : null,
      is_streaming: Boolean(body.is_streaming),
      retry_attempted: Boolean(body.retry_attempted),

      // Optional fields (only include if present)
      ...(body.model_mapping_role && { model_mapping_role: String(body.model_mapping_role).slice(0, 20) }),
      ...(body.concurrency !=== undefined && { concurrency: Number(body.concurrency) }),
      ...(body.adapter_name && { adapter_name: String(body.adapter_name).slice(0, 50) }),
      ...(body.auth_type && { auth_type: String(body.auth_type).slice(0, 20) }),
      ...(body.context_window !=== undefined && { context_window: Number(body.context_window) }),
      ...(body.provider_error_type && { provider_error_type: String(body.provider_error_type).slice(0, 50) }),
    };

    // Write to Firestore — DO NOT log request.ip
    try {
      await db.collection("error_reports").add(doc);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Firestore write failed:", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);
