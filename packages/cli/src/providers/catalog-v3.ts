export const CATALOG_V3_ACCEPT = "application/vnd.models-index.catalog+json;version=3";

export interface CatalogV3Envelope<T> {
  contractVersion: 3;
  generationId: string;
  generatedAt: string;
  data: T;
}

export function parseCatalogV3Envelope<T>(value: unknown): CatalogV3Envelope<T> | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  if (
    envelope.contractVersion !== 3 ||
    typeof envelope.generationId !== "string" ||
    envelope.generationId.length === 0 ||
    typeof envelope.generatedAt !== "string" ||
    !envelope.data ||
    typeof envelope.data !== "object"
  ) {
    return null;
  }
  return envelope as unknown as CatalogV3Envelope<T>;
}
