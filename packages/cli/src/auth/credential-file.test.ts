import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log";
import {
  CredentialFileState,
  refreshAndCommit,
  statCredentialFile,
  writeCredentialFileAtomic,
} from "./credential-file";

interface Login {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

const first: Login = {
  access_token: "OPAQUE_TEST_TOKEN_abc",
  refresh_token: "OPAQUE_TEST_TOKEN_refresh",
  expires_at: 1,
};
const newer: Login = {
  access_token: "OPAQUE_TEST_TOKEN_new_login",
  refresh_token: "OPAQUE_TEST_TOKEN_new_lineage",
  expires_at: Number.MAX_SAFE_INTEGER,
};
const rotated: Login = {
  access_token: "OPAQUE_TEST_TOKEN_rotated",
  refresh_token: "OPAQUE_TEST_TOKEN_rotated_refresh",
  expires_at: Number.MAX_SAFE_INTEGER,
};
const opts = {
  isValid: (login: Login) => login.expires_at > Date.now(),
  noCredentials: () => new Error("No test credentials found"),
};

let root: string;
let path: string;

function state(
  validate: (data: unknown) => boolean = (data: unknown) => {
    const value = data as Partial<Login> | null;
    return typeof value?.access_token === "string" && typeof value?.refresh_token === "string";
  }
) {
  return new CredentialFileState<Login>({
    path: () => path,
    validate: (data: unknown): data is Login => validate(data),
    label: "W1",
  });
}

function replace(login: Login) {
  const next = join(root, "new-login.json");
  writeFileSync(next, JSON.stringify(login));
  renameSync(next, path);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w1-credential-file-"));
  path = join(root, "login.json");
  startLogCapture();
});

afterEach(async () => {
  try {
    const lines = (await capturedLines()).join("\n");
    for (const login of [first, newer, rotated]) {
      expect(lines).not.toContain(login.access_token);
      expect(lines).not.toContain(login.refresh_token);
    }
  } finally {
    stopLogCapture();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("W1 credential file public contract", () => {
  test("G1 1.1 lazy first load and rename replacement adopt the new login", () => {
    const file = state();
    expect(file.value).toBeNull();
    writeFileSync(path, JSON.stringify(first));
    expect(file.syncFromDisk()).toBe("reloaded");
    expect(file.value).toEqual(first);
    replace(newer);
    expect(file.syncFromDisk()).toBe("reloaded");
    expect(file.value).toEqual(newer);
  }, 5_000);

  test("G1 1.2 an in-place rewrite on the same inode is reloaded", () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    const ino = statSync(path).ino;
    writeFileSync(path, JSON.stringify(newer));
    expect(statSync(path).ino).toBe(ino);
    expect(file.syncFromDisk()).toBe("reloaded");
    expect(file.value).toEqual(newer);
  }, 5_000);

  test("G1 the stamp is keyed by path, not just the file identity", () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    const previous = path;
    path = join(root, "other.json");
    writeFileSync(path, JSON.stringify(newer));
    expect(file.syncFromDisk()).toBe("reloaded");
    expect(file.value).toEqual(newer);
    expect(existsSync(previous)).toBe(true);
  }, 5_000);

  test("G1 1.8 only removal clears the last good credentials", () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    unlinkSync(path);
    expect(statCredentialFile(path)).toBeNull();
    expect(file.syncFromDisk()).toBe("removed");
    expect(file.value).toBeNull();
  }, 5_000);

  test("G3 a non-ENOENT stat failure never signs out the last good login", () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    unlinkSync(path);
    symlinkSync(path, path);
    expect(statCredentialFile(path)).toMatchObject({ error: "ELOOP" });
    expect(file.syncFromDisk()).toBe("unreadable");
    expect(file.value).toEqual(first);
    unlinkSync(path);
    writeFileSync(path, JSON.stringify(newer));
    expect(file.syncFromDisk()).toBe("reloaded");
    expect(file.value).toEqual(newer);
  }, 5_000);

  test("G5 unchanged files skip file reads, parsing and validation", () => {
    writeFileSync(path, JSON.stringify(first));
    const validate = mock((value: unknown): value is Login => Boolean(value));
    const file = state(validate);
    expect(file.syncFromDisk()).toBe("reloaded");
    expect(validate).toHaveBeenCalledTimes(1);
    const reads = spyOn(fs, "readFileSync");
    try {
      for (let i = 0; i < 4; i++) expect(file.syncFromDisk()).toBe("unchanged");
      expect(reads).not.toHaveBeenCalled();
      expect(validate).toHaveBeenCalledTimes(1);
      expect(file.value).toEqual(first);
    } finally {
      reads.mockRestore();
    }
  }, 5_000);

  test("G3 1.16/1.17 unreadable files keep the value and retry the SAME stamp", () => {
    writeFileSync(path, JSON.stringify(first));
    let allow = true;
    const validate = mock((value: unknown): value is Login => allow && Boolean(value));
    const file = state(validate);
    file.syncFromDisk();
    writeFileSync(path, JSON.stringify(newer));
    allow = false;
    expect(file.syncFromDisk()).toBe("unreadable");
    expect(file.value).toEqual(first);
    const stamp = statCredentialFile(path);
    allow = true;
    expect(file.syncFromDisk()).toBe("reloaded");
    expect(statCredentialFile(path)).toEqual(stamp);
    expect(file.value).toEqual(newer);
    expect(validate).toHaveBeenCalledTimes(3);
  }, 5_000);

  for (const torn of ["", '{"access_token":"OPAQUE_TEST_TOKEN_abc"']) {
    test(`G3 1.16/1.19 torn JSON (${torn.length} bytes) keeps the last good value`, () => {
      writeFileSync(path, JSON.stringify(first));
      const file = state();
      file.syncFromDisk();
      writeFileSync(path, torn);
      expect(file.syncFromDisk()).toBe("unreadable");
      expect(file.value).toEqual(first);
      expect(file.syncFromDisk()).toBe("unreadable");
      writeFileSync(path, JSON.stringify(newer));
      expect(file.syncFromDisk()).toBe("reloaded");
      expect(file.value).toEqual(newer);
      const fresh = state();
      writeFileSync(path, torn);
      expect(fresh.syncFromDisk()).toBe("unreadable");
      expect(fresh.value).toBeNull();
    }, 5_000);
  }

  test("G2 1.6 saveRefreshed never overwrites a newer refresh-token lineage", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    replace(newer);
    const bytes = readFileSync(path, "utf8");
    expect(await file.saveRefreshed(first, rotated)).toEqual({
      outcome: "newer-on-disk",
      onDisk: newer,
    });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(file.value).toEqual(newer);
  }, 5_000);

  test("G2 the refresh-token lineage, not the access token, controls the commit", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    replace({ ...first, access_token: newer.access_token });
    expect(await file.saveRefreshed(first, rotated)).toEqual({ outcome: "saved" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(rotated);
  }, 5_000);

  test("G2 1.7/1.10b uncontended refresh writes atomically with mode 0600", async () => {
    writeFileSync(path, JSON.stringify(first), { mode: 0o644 });
    const file = state();
    file.syncFromDisk();
    const oldInode = statSync(path).ino;
    expect(await file.saveRefreshed(first, rotated)).toEqual({ outcome: "saved" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(rotated);
    expect(statSync(path).ino).not.toBe(oldInode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }, 5_000);

  test("G2 an in-flight refresh never recreates a logout file", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    unlinkSync(path);
    expect(await file.saveRefreshed(first, rotated)).toEqual({ outcome: "removed" });
    expect(existsSync(path)).toBe(false);
  }, 5_000);

  test("G2 1.11 a rejected login cannot delete another writer's login", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    replace(newer);
    const bytes = readFileSync(path, "utf8");
    expect(await file.deleteIfUnchanged(first)).toBe("newer-on-disk");
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(file.value).toEqual(newer);
  }, 5_000);

  test("G2 a rejection deletes only an unchanged login", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    expect(await file.deleteIfUnchanged(first)).toBe("deleted");
    expect(existsSync(path)).toBe(false);
    expect(file.value).toBeNull();
  }, 5_000);

  test("G3 1.18 an unreadable file is not overwritten by a successful refresh", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    writeFileSync(path, "");
    expect(await file.saveRefreshed(first, rotated)).toEqual({ outcome: "unreadable" });
    expect(readFileSync(path, "utf8")).toBe("");
  }, 5_000);

  test("G3 1.19b rejection never deletes an unreadable file", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    writeFileSync(path, "");
    expect(await file.deleteIfUnchanged(first)).toBe("unreadable");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(file.value).toEqual(first);
  }, 5_000);

  test("G1 1.4 a failed exchange adopts a valid login written during the exchange", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    const refresh = mock(async () => {
      replace(newer);
      throw new Error("Refresh token has been revoked");
    });
    expect(await refreshAndCommit(file, refresh, opts, "W1")).toBe(newer.access_token);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(file.value).toEqual(newer);
  }, 5_000);

  test("G1 1.5 an unchanged failed exchange rethrows the SAME error, without retry", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    const failure = new Error("Refresh token has been revoked");
    const refresh = mock(async () => {
      throw failure;
    });
    await expect(refreshAndCommit(file, refresh, opts)).rejects.toBe(failure);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(file.value).toEqual(first);
  }, 5_000);

  test("G2 1.6 a successful exchange returns the newer login and preserves its bytes", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    const refresh = mock(async () => {
      replace(newer);
      return rotated;
    });
    expect(await refreshAndCommit(file, refresh, opts)).toBe(newer.access_token);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(newer);
    expect(refresh).toHaveBeenCalledTimes(1);
  }, 5_000);

  test("G3 1.18 a successful refresh is retained in memory while the file is torn", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    const refresh = mock(async () => {
      writeFileSync(path, "");
      return rotated;
    });
    expect(await refreshAndCommit(file, refresh, opts, "W1")).toBe(rotated.access_token);
    expect(file.value).toEqual(rotated);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(file.syncFromDisk()).toBe("unreadable");
    expect(file.value).toEqual(rotated);
    replace(newer);
    expect(file.syncFromDisk()).toBe("reloaded");
    expect(file.value).toEqual(newer);
  }, 5_000);

  test("G3 a failed exchange on an unreadable file preserves its original error", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    const failure = new Error("Refresh token has been revoked");
    await expect(
      refreshAndCommit(
        file,
        async () => {
          writeFileSync(path, "");
          throw failure;
        },
        opts
      )
    ).rejects.toBe(failure);
    expect(file.value).toEqual(first);
    expect(readFileSync(path, "utf8")).toBe("");
  }, 5_000);

  test("G4 unreadable debug logs contain the path and label, never credential values", async () => {
    writeFileSync(path, JSON.stringify(first));
    const file = state();
    file.syncFromDisk();
    writeFileSync(path, '{"OPAQUE_TEST_TOKEN_abc":');
    file.syncFromDisk();
    expect((await capturedLines()).join("\n")).toContain(
      `[W1] credential file unreadable (${path}); kept the last good credentials`
    );
  }, 5_000);

  test("G2 atomic login writes replace the inode and use mode 0600", () => {
    writeFileSync(path, JSON.stringify(first), { mode: 0o644 });
    const previous = statSync(path).ino;
    const stamp = writeCredentialFileAtomic(path, newer);
    expect(statCredentialFile(path)).toEqual(stamp);
    expect(statSync(path).ino).not.toBe(previous);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(newer);
  }, 5_000);
});
