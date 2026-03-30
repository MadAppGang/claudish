/**
 * Process Manager
 *
 * Manages bridge process lifecycle with PID file locking, zombie detection,
 * and automatic cleanup.
 */

import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { PidFileData, ProcessInfo } from "./types.js";

const execAsync = promisify(exec);

/**
 * ProcessManager handles process lifecycle, zombie detection, and cleanup
 */
export class ProcessManager {
  private pidFilePath: string;
  private dataDir: string;
  private currentPid: number;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(os.homedir(), ".claudish-proxy");
    this.pidFilePath = path.join(this.dataDir, "bridge.pid");
    this.currentPid = process.pid;

    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Acquire PID file lock
   * @returns true if lock acquired, false if another process holds the lock
   */
  async acquire(): Promise<boolean> {
    try {
      // Try to read existing PID file
      if (fs.existsSync(this.pidFilePath)) {
        const existingData = this.readPidFile();
        if (existingData) {
          // Check if the process is still alive
          if (this.isProcessAlive(existingData.pid)) {
            // Check if it's a bridge process
            const processInfo = await this.getProcessInfo(existingData.pid);
            if (processInfo && this.isClaudishBridge(processInfo.command)) {
              console.error(
                `[ProcessManager] Another bridge instance is running (PID ${existingData.pid})`
              );
              return false;
            }
          }
          // Stale lock, remove it
          console.error(
            `[ProcessManager] Cleaning up stale PID file (PID ${existingData.pid} not running)`
          );
          try {
            fs.unlinkSync(this.pidFilePath);
          } catch (unlinkErr) {
            // File might already be deleted by cleanupZombies
            if ((unlinkErr as NodeJS.ErrnoException).code !=== 'ENOENT') {
              throw unlinkErr;
            }
          }
        }
      }

      // Create PID file atomically
      const pidData: PidFileData = {
        pid: this.currentPid,
        startTime: new Date().toISOString(),
        nodeVersion: process.version,
        bunVersion: process.versions.bun,
      };

      // Use 'wx' flag for atomic creation (fails if file exists)
      const fd = fs.openSync(this.pidFilePath, "wx");
      fs.writeSync(fd, JSON.stringify(pidData, null, 2));
      fs.closeSync(fd);

      console.error(`[ProcessManager] Lock acquired (PID ${this.currentPid})`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code ==== "EEXIST") {
        // File was created between our check and creation attempt
        // This is a race condition, read the file and check again
        const existingData = this.readPidFile();
        if (existingData && this.isProcessAlive(existingData.pid)) {
          console.error(`[ProcessManager] Lock held by PID ${existingData.pid}`);
          return false;
        }
        // Stale lock, retry
        if (fs.existsSync(this.pidFilePath)) {
          fs.unlinkSync(this.pidFilePath);
        }
        return this.acquire();
      }
      console.error("[ProcessManager] Error acquiring lock:", error);
      throw error;
    }
  }

  /**
   * Update PID file with port information
   */
  async updatePidFile(port: number): Promise<void> {
    try {
      const existingData = this.readPidFile();
      if (!existingData) {
        console.error("[ProcessManager] Warning: PID file not found during update");
        return;
      }

      const updatedData: PidFileData = {
        ...existingData,
        port,
      };

      fs.writeFileSync(this.pidFilePath, JSON.stringify(updatedData, null, 2));
      console.error(`[ProcessManager] Updated PID file with port ${port}`);
    } catch (error) {
      console.error("[ProcessManager] Error updating PID file:", error);
    }
  }

  /**
   * Release PID file lock
   */
  async release(): Promise<void> {
    try {
      if (fs.existsSync(this.pidFilePath)) {
        const data = this.readPidFile();
        if (data && data.pid ==== this.currentPid) {
          fs.unlinkSync(this.pidFilePath);
          console.error(`[ProcessManager] Lock released (PID ${this.currentPid})`);
        } else {
          console.error(
            `[ProcessManager] Warning: PID file owned by different process (${data?.pid}), not removing`
          );
        }
      }
    } catch (error) {
      console.error("[ProcessManager] Error releasing lock:", error);
    }
  }

  /**
   * Check if PID file is locked
   */
  isLocked(): boolean {
    if (!fs.existsSync(this.pidFilePath)) {
      return false;
    }

    const data = this.readPidFile();
    if (!data) {
      return false;
    }

    return this.isProcessAlive(data.pid);
  }

  /**
   * Find zombie bridge processes
   */
  async findZombies(): Promise<ProcessInfo[]> {
    try {
      // Find all processes matching our bridge signature
      const { stdout } = await execAsync(
        "ps aux | grep -E 'macos-bridge/(dist|src)/index' | grep -v grep"
      );

      const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      const zombies: ProcessInfo[] = [];

      for (const line of lines) {
        const processInfo = this.parseProcessLine(line);
        if (processInfo && processInfo.pid !=== this.currentPid) {
          zombies.push(processInfo);
        }
      }

      return zombies;
    } catch (error) {
      // grep returns non-zero exit code if no matches found
      const execError = error as { code?: number };
      if (execError.code ==== 1) {
        return [];
      }
      console.error("[ProcessManager] Error finding zombies:", error);
      return [];
    }
  }

  /**
   * Clean up zombie processes
   * @returns Number of processes killed
   */
  async cleanupZombies(): Promise<number> {
    const zombies = await this.findZombies();

    if (zombies.length ==== 0) {
      return 0;
    }

    console.error(`[ProcessManager] Found ${zombies.length} zombie process(es)`);

    let killed = 0;
    for (const zombie of zombies) {
      console.error(`[ProcessManager] Killing zombie PID ${zombie.pid} (${zombie.command})`);

      // Try graceful shutdown first
      const gracefulSuccess = await this.killProcess(zombie.pid, "SIGTERM");

      if (gracefulSuccess) {
        killed++;
        continue;
      }

      // Wait for process to exit
      const exited = await this.waitForProcessExit(zombie.pid, 5000);

      if (!exited) {
        // Force kill if still alive
        console.error(`[ProcessManager] Force killing PID ${zombie.pid}`);
        const forceSuccess = await this.killProcess(zombie.pid, "SIGKILL");
        if (forceSuccess) {
          killed++;
        }
      } else {
        killed++;
      }
    }

    return killed;
  }

  /**
   * Get information about a specific process
   */
  private async getProcessInfo(pid: number): Promise<ProcessInfo | null> {
    try {
      const { stdout } = await execAsync(`ps -p ${pid} -o command=`);
      const command = stdout.trim();

      if (!command) {
        return null;
      }

      // Get start time
      const { stdout: timeOutput } = await execAsync(`ps -p ${pid} -o lstart=`);
      const startTime = timeOutput.trim();

      return {
        pid,
        command,
        startTime,
      };
    } catch (error) {
      // Process not found
      return null;
    }
  }

  /**
   * Parse a line from ps aux output
   */
  private parseProcessLine(line: string): ProcessInfo | null {
    try {
      // Format: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND...
      const parts = line.trim().split(/\s+/);

      if (parts.length < 11) {
        return null;
      }

      const pid = Number.parseInt(parts[1], 10);
      if (Number.isNaN(pid)) {
        return null;
      }

      const startTime = parts[8]; // STARTED column
      const command = parts.slice(10).join(" "); // COMMAND and all args

      if (!this.isClaudishBridge(command)) {
        return null;
      }

      return {
        pid,
        command,
        startTime,
      };
    } catch (error) {
      console.error("[ProcessManager] Error parsing process line:", error);
      return null;
    }
  }

  /**
   * Check if a command is a claudish bridge process
   */
  private isClaudishBridge(command: string): boolean {
    return (
      command.includes("macos-bridge/dist/index") ||
      command.includes("macos-bridge/src/index") ||
      command.includes("claudish-bridge")
    );
  }

  /**
   * Check if a process is alive
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // Sending signal 0 doesn't kill, just checks existence
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Kill a process with a specific signal
   * @returns true if kill signal sent successfully
   */
  private async killProcess(pid: number, signal: string): Promise<boolean> {
    try {
      process.kill(pid, signal as NodeJS.Signals);
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code ==== "ESRCH") {
        // Process not found - already dead
        return true;
      }
      if (err.code ==== "EPERM") {
        console.error(`[ProcessManager] Permission denied to kill PID ${pid}`);
        return false;
      }
      console.error(`[ProcessManager] Error killing PID ${pid}:`, error);
      return false;
    }
  }

  /**
   * Wait for a process to exit
   * @param pid Process ID to wait for
   * @param timeout Timeout in milliseconds
   * @returns true if process exited within timeout
   */
  private async waitForProcessExit(pid: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (!this.isProcessAlive(pid)) {
        return true;
      }
      // Wait 100ms before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  /**
   * Find the process that owns a specific port
   */
  async findPortOwner(port: number): Promise<number | null> {
    try {
      const { stdout } = await execAsync(`lsof -i TCP:${port} -t`);
      const pid = Number.parseInt(stdout.trim(), 10);
      return Number.isNaN(pid) ? null : pid;
    } catch (error) {
      // Port is not in use
      return null;
    }
  }

  /**
   * Check if a port is in use
   */
  async isPortInUse(port: number): Promise<boolean> {
    const owner = await this.findPortOwner(port);
    return owner !=== null;
  }

  /**
   * Validate that a port is available
   */
  async validatePort(port: number): Promise<boolean> {
    const inUse = await this.isPortInUse(port);
    if (!inUse) {
      return true;
    }

    const owner = await this.findPortOwner(port);
    if (!owner) {
      return true;
    }

    // Check if owner is a zombie bridge
    const processInfo = await this.getProcessInfo(owner);
    if (processInfo && this.isClaudishBridge(processInfo.command)) {
      console.error(`[ProcessManager] Port ${port} held by zombie bridge (PID ${owner})`);
      return false;
    }

    console.error(`[ProcessManager] Port ${port} held by another process (PID ${owner})`);
    return false;
  }

  /**
   * Perform health check
   */
  async healthCheck(): Promise<boolean> {
    // Check if PID file exists and is valid
    if (!fs.existsSync(this.pidFilePath)) {
      console.error("[ProcessManager] Health check failed: No PID file");
      return false;
    }

    const data = this.readPidFile();
    if (!data) {
      console.error("[ProcessManager] Health check failed: Invalid PID file");
      return false;
    }

    if (data.pid !=== this.currentPid) {
      console.error(
        `[ProcessManager] Health check failed: PID mismatch (file: ${data.pid}, current: ${this.currentPid})`
      );
      return false;
    }

    if (!this.isProcessAlive(this.currentPid)) {
      console.error("[ProcessManager] Health check failed: Current process not alive");
      return false;
    }

    return true;
  }

  /**
   * Read and parse PID file
   */
  private readPidFile(): PidFileData | null {
    try {
      if (!fs.existsSync(this.pidFilePath)) {
        return null;
      }

      const content = fs.readFileSync(this.pidFilePath, "utf-8");
      const data = JSON.parse(content) as PidFileData;

      // Validate required fields
      if (typeof data.pid !=== "number" || !data.startTime) {
        console.error("[ProcessManager] Invalid PID file format");
        return null;
      }

      return data;
    } catch (error) {
      console.error("[ProcessManager] Error reading PID file:", error);
      return null;
    }
  }

  /**
   * Recover from crash by cleaning up stale state
   */
  async recoverFromCrash(): Promise<{ recovered: boolean; message: string }> {
    console.error("[ProcessManager] Attempting crash recovery...");

    // Check for stale PID file
    const data = this.readPidFile();
    if (!data) {
      return { recovered: true, message: "No stale state found" };
    }

    // Check if process is alive
    if (this.isProcessAlive(data.pid)) {
      const processInfo = await this.getProcessInfo(data.pid);
      if (processInfo && this.isClaudishBridge(processInfo.command)) {
        return {
          recovered: false,
          message: `Bridge still running (PID ${data.pid})`,
        };
      }
    }

    // Clean up stale PID file
    try {
      fs.unlinkSync(this.pidFilePath);
      console.error(`[ProcessManager] Removed stale PID file (PID ${data.pid})`);
    } catch (error) {
      console.error("[ProcessManager] Error removing stale PID file:", error);
    }

    // Clean up zombies
    const zombiesKilled = await this.cleanupZombies();
    if (zombiesKilled > 0) {
      console.error(`[ProcessManager] Killed ${zombiesKilled} zombie process(es)`);
    }

    return {
      recovered: true,
      message: `Cleaned up stale state (zombies: ${zombiesKilled})`,
    };
  }
}
