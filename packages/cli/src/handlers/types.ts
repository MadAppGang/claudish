import type { Context } from "hono";

export interface ModelHandler {
  handle(c: Context, payload: any): Promise<Response>;
  shutdown(): Promise<void>;
}
