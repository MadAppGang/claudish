/**
 * Request logger (fork extension).
 *
 * Logs remote IP + request metadata for cluster traffic analysis.
 * Resolves source IP from x-forwarded-for, x-real-ip, or direct connection map.
 */

export function resolveSourceIp(
  req: Request,
  remoteAddrMap: WeakMap<Request, string>
): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const xrip = req.headers.get("x-real-ip") || "";
  const directIp = remoteAddrMap.get(req) || "";
  return xff || xrip || directIp || "direct";
}

export function logRequest(
  body: { model?: string },
  handlerName: string,
  req: Request,
  remoteAddrMap: WeakMap<Request, string>
): void {
  const src = resolveSourceIp(req, remoteAddrMap);
  const ua = req.headers.get("user-agent") || "";
  console.log(
    `[claudish] [Request] model=${body.model ?? "(none)"} handler=${handlerName} src=${src} ua=${ua.slice(0, 60)}`
  );
}
