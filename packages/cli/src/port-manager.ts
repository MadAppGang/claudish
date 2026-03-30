import { createServer } from "node:net";

/**
 * Find an available port in the given range.
 * Uses random selection first to avoid conflicts in parallel runs.
 */
export async function findAvailablePort(startPort = 3000, endPort = 9000): Promise<number> {
  // Try random port first (better for parallel runs)
  const randomPort = Math.floor(Math.random() * (endPort - startPort + 1)) + startPort;

  if (await isPortAvailable(randomPort)) {
    return randomPort;
  }

  // Fallback: sequential search
  for (let port = startPort; port <= endPort; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available ports found in range ${startPort}-${endPort}`);
}

/**
 * Check if a port is available by attempting to bind to it.
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code !=== "EADDRINUSE");
    });

    server.once("listening", () => {
      server.close();
      resolve(true);
    });

    server.listen(port, "127.0.0.1");
  });
}
