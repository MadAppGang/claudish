import { describe, expect, test } from "bun:test";
import {
  type AccountRecord,
  type Check,
  type NoSwitchInput,
  type SwitchInput,
  type V17Input,
  bearerOf,
  noSwitchAgreement,
  recordsCheck,
  requestIds,
  sig,
  switchAgreement,
  v17Agreement,
} from "./agree.ts";
import type { LoggedRequest } from "./fake-upstream.ts";

// REQ-2.2a: every positive sameSession case uses the required session-id format.
const SESSION_ONE = "claudish_" + "a".repeat(32);
const SESSION_TWO = "claudish_" + "b".repeat(32);

function record(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    requestId: "request-one",
    provider: "openai-codex",
    accountId: "test-account-alpha",
    label: "alpha",
    outcome: "selected",
    arm: "oauth",
    ...overrides,
  };
}

function request(overrides: Partial<LoggedRequest> = {}): LoggedRequest {
  return {
    seq: 1,
    at: 1_000,
    method: "POST",
    path: "/backend-api/codex/responses",
    kind: "main",
    mainIndex: 1,
    bytes: 32,
    bodySha256: "a".repeat(64),
    bearer: "Bearer access-alpha",
    chatgptAccountId: null,
    sessionId: SESSION_ONE,
    status: 200,
    ...overrides,
  };
}

function third(): Check[] {
  return [{ name: "third-answer", ok: true, detail: "normal answer observed" }];
}

function switchRow(attempts = 2): SwitchInput {
  const input: SwitchInput = {
    main: [
      request({ status: 429 }),
      request({ seq: 2, mainIndex: 2, bearer: "Bearer access-beta" }),
    ],
    recs: [
      record(),
      record({
        label: "beta",
        accountId: "test-account-beta",
        reason: "quota-switch",
      }),
    ],
    expectedAttempts: 2,
    bearers: ["Bearer access-alpha", "Bearer access-beta"],
    sameBody: true,
    sameSession: true,
    expectedRecords: ["alpha:-:selected", "beta:quota-switch:selected"],
    third: third(),
  };
  if (attempts === 1) {
    input.main.pop();
    input.recs.pop();
    input.bearers.pop();
    input.expectedRecords.pop();
    input.expectedAttempts = 1;
  }
  if (attempts === 3) {
    input.main.push(request({ seq: 3, mainIndex: 3, bearer: "Bearer access-gamma" }));
    input.recs.push(
      record({
        label: "gamma",
        accountId: "test-account-gamma",
        reason: "quota-switch",
      })
    );
    input.bearers.push("Bearer access-gamma");
    input.expectedRecords.push("gamma:quota-switch:selected");
    input.expectedAttempts = 3;
  }
  return input;
}

function noSwitchRow(): NoSwitchInput {
  return {
    main: [request({ status: 503 }), request({ seq: 2, mainIndex: 2 })],
    recs: [record(), record({ outcome: "completed" })],
    expectedAttempts: 2,
    bearers: ["Bearer access-alpha", "Bearer access-alpha"],
    forbiddenBearers: ["Bearer access-forbidden"],
    expectedRecords: ["alpha:-:selected", "alpha:-:completed"],
    third: third(),
  };
}

function v17Row(): V17Input {
  return {
    key: "sk-canary-must-never-be-used",
    canaryHits: [
      {
        at: 1_000,
        method: "POST",
        path: "/v1/responses",
        authorization: "Bearer sk-canary-must-never-be-used",
      },
    ],
    main: [],
    recs: [],
    third: third(),
  };
}

function expectPass(checks: Check[]): void {
  // Reject an empty result rather than allowing [].every(...) to pass vacuously.
  expect(checks.length).toBeGreaterThan(0);
  for (const check of checks) expect(check.ok).toBe(true);
}

function expectFailure(checks: Check[]): void {
  expect(checks.filter((check) => check.ok === false).length).toBeGreaterThan(0);
}

function expectRecordFailure(checks: Check[]): void {
  expectFailure(checks);
  for (const check of checks.filter((entry) => entry.ok === false)) {
    expect(typeof check.detail).toBe("string");
    expect(check.detail.trim().length).toBeGreaterThan(0);
  }
}

const recordChanges: Array<{
  name: string;
  change: (records: AccountRecord[]) => void;
}> = [
  {
    name: "wrong label",
    change: (records) => {
      records[0]!.label = "other";
    },
  },
  {
    name: "wrong reason",
    change: (records) => {
      records[0]!.reason = "other";
    },
  },
  {
    name: "wrong outcome",
    change: (records) => {
      records[0]!.outcome = "other";
    },
  },
  {
    name: "missing record",
    change: (records) => {
      records.pop();
    },
  },
  {
    name: "extra record",
    change: (records) => {
      records.push({ ...records[0]! });
    },
  },
  {
    name: "reversed order",
    change: (records) => {
      records.reverse();
    },
  },
];

describe("record and bearer evidence", () => {
  // REQ-1.1
  test.each([
    { name: "absent", value: record(), expected: "alpha:-:selected" },
    {
      name: "present",
      value: record({ reason: "quota-switch" }),
      expected: "alpha:quota-switch:selected",
    },
    { name: "empty but present", value: record({ reason: "" }), expected: "alpha::selected" },
  ])("TEST-1 REQ-1.1 formats a $name reason literally", ({ value, expected }) => {
    expect(sig(value)).toBe(expected);
  });

  test.each(["alpha", "a-2", ""])(
    "TEST-2 REQ-1.2 returns the exact bearer for label %p",
    (label) => {
      expect(bearerOf(label)).toBe("Bearer access-" + label);
    }
  );

  test("TEST-3 REQ-1.3 returns distinct request ids without imposing order", () => {
    expect(requestIds([])).toEqual([]);
    const result = requestIds([
      record({ requestId: "second" }),
      record({ requestId: "first" }),
      record({ requestId: "second" }),
      record({ requestId: "third" }),
      record({ requestId: "first" }),
    ]);

    expect(result).toHaveLength(3);
    expect([...result].sort()).toEqual(["first", "second", "third"]);
  });

  test("TEST-4 REQ-1.4 accepts no records for none or an empty list without singleRequestId", () => {
    expectPass(recordsCheck("empty-none", [], "none"));
    expectPass(recordsCheck("empty-list", [], []));
  });

  test("TEST-4 REQ-1.4 ignores singleRequestId when none is expected", () => {
    expectPass(recordsCheck("empty-single-id", [], "none", { singleRequestId: true }));
  });

  test("TEST-4 REQ-1.4 rejects empty list evidence when singleRequestId is required", () => {
    expectRecordFailure(recordsCheck("empty-single-id", [], [], { singleRequestId: true }));
  });

  test("TEST-4 REQ-1.4 accepts exact ordered signatures under one request id", () => {
    const records = [record(), record({ label: "beta", reason: "quota-switch" })];

    expectPass(
      recordsCheck("records", records, ["alpha:-:selected", "beta:quota-switch:selected"], {
        singleRequestId: true,
      })
    );
  });

  test("TEST-4 REQ-1.4 permits multiple ids when singleRequestId is not required", () => {
    const records = [record(), record({ requestId: "request-two", label: "beta" })];
    const expected = ["alpha:-:selected", "beta:-:selected"];

    expectPass(recordsCheck("default", records, expected));
    expectPass(recordsCheck("disabled", records, expected, { singleRequestId: false }));
  });

  test.each(recordChanges)(
    "TEST-5 REQ-1.4 rejects $name with nonempty diagnostics",
    ({ change }) => {
      const records = [record(), record({ label: "beta", reason: "quota-switch" })];
      change(records);

      expectRecordFailure(
        recordsCheck("records", records, ["alpha:-:selected", "beta:quota-switch:selected"])
      );
    }
  );

  test("TEST-5 REQ-1.4 rejects any record when none is expected", () => {
    expectRecordFailure(recordsCheck("unexpected", [record()], "none"));
  });

  test("TEST-5 REQ-1.4 rejects records when the signature list is empty", () => {
    expectRecordFailure(recordsCheck("unexpected", [record()], []));
  });

  test("TEST-5 REQ-1.4 rejects empty records when a signature is expected", () => {
    expectRecordFailure(recordsCheck("missing", [], ["alpha:-:selected"]));
  });

  test("TEST-5 REQ-1.4 rejects duplicate signatures in place of distinct records", () => {
    expectRecordFailure(
      recordsCheck("duplicate", [record(), record()], ["alpha:-:selected", "beta:-:selected"])
    );
  });

  test("TEST-5 REQ-1.4 rejects exact signatures spread over request ids when required", () => {
    expectRecordFailure(
      recordsCheck(
        "request-identity",
        [record(), record({ label: "beta", requestId: "request-two" })],
        ["alpha:-:selected", "beta:-:selected"],
        { singleRequestId: true }
      )
    );
  });
});

describe("switch row agreement", () => {
  test.each([
    { name: "retry", sameBody: true, sameSession: false },
    { name: "threshold", sameBody: false, sameSession: true },
    { name: "both equalities", sameBody: true, sameSession: true },
  ])("TEST-6 REQ-2.1 accepts consistent $name evidence", ({ sameBody, sameSession }) => {
    const input = switchRow();
    input.sameBody = sameBody;
    input.sameSession = sameSession;

    expectPass(switchAgreement(input));
  });

  test("TEST-7 REQ-2.3 rejects three entries in main when two attempts are expected", () => {
    const input = switchRow(3);
    // The caller filters main; a non-main entry supplied here still counts as an attempt.
    input.main[2]!.kind = "title";
    input.main[2]!.mainIndex = null;
    input.expectedAttempts = 2;

    expectFailure(switchAgreement(input));
  });

  test.each([1, 3])(
    "TEST-8 REQ-2.2 rejects two actual attempts when %i are expected",
    (expectedAttempts) => {
      const input = switchRow();
      input.expectedAttempts = expectedAttempts;

      expectFailure(switchAgreement(input));
    }
  );

  test.each([0, 1])("TEST-9 REQ-2.2 rejects a bearer mismatch at attempt index %i", (index) => {
    const input = switchRow();
    input.main[index]!.bearer = "Bearer wrong-access";

    expectFailure(switchAgreement(input));
  });

  test.each([2, 3])(
    "TEST-10 REQ-2.2 rejects the last differing body across %i attempts",
    (attempts) => {
      const input = switchRow(attempts);
      input.main[attempts - 1]!.bodySha256 = "b".repeat(64);

      expectFailure(switchAgreement(input));
    }
  );

  test("TEST-10 REQ-2.2a rejects sameBody evidence with only one attempt", () => {
    const input = switchRow(1);
    delete input.sameSession;

    expectFailure(switchAgreement(input));
  });

  test.each([
    { attempts: 2, session: SESSION_TWO },
    { attempts: 2, session: null },
    { attempts: 3, session: SESSION_TWO },
    { attempts: 3, session: null },
  ])(
    "TEST-11 REQ-2.2 REQ-2.2a rejects a differing or missing last session (%p)",
    ({ attempts, session }) => {
      const input = switchRow(attempts);
      input.main[attempts - 1]!.sessionId = session;

      expectFailure(switchAgreement(input));
    }
  );

  test.each([
    { name: "all absent", session: null },
    { name: "legacy spelling", session: "session-one" },
    { name: "uppercase hex", session: "claudish_" + "A".repeat(32) },
    { name: "non-hex characters", session: "claudish_" + "g".repeat(32) },
    { name: "31 hex characters", session: "claudish_" + "a".repeat(31) },
    { name: "33 hex characters", session: "claudish_" + "a".repeat(33) },
    { name: "wrong prefix", session: "session_" + "a".repeat(32) },
  ])("TEST-11 REQ-2.2a rejects equal but nonconforming sessions: $name", ({ session }) => {
    const input = switchRow();
    for (const attempt of input.main) attempt.sessionId = session;

    expectFailure(switchAgreement(input));
  });

  test("TEST-11 REQ-2.2a rejects sameSession evidence with only one attempt", () => {
    const input = switchRow(1);
    delete input.sameBody;

    expectFailure(switchAgreement(input));
  });

  test("TEST-12 REQ-2.1 does not require equality when the flags are absent", () => {
    const input = switchRow();
    delete input.sameBody;
    delete input.sameSession;
    input.main[1]!.bodySha256 = "b".repeat(64);
    input.main[1]!.sessionId = SESSION_TWO;

    expectPass(switchAgreement(input));
  });

  test.each(recordChanges)("TEST-13 REQ-2.2 rejects record evidence with $name", ({ change }) => {
    const input = switchRow();
    change(input.recs);

    expectFailure(switchAgreement(input));
  });

  test("TEST-14 REQ-2.2 rejects otherwise matching records with two request ids", () => {
    const input = switchRow();
    input.recs[1]!.requestId = "request-two";

    expectFailure(switchAgreement(input));
  });

  test("TEST-15 REQ-2.2 rejects a false third-source check with other sources consistent", () => {
    const input = switchRow();
    input.third[0]!.ok = false;

    expectFailure(switchAgreement(input));
  });

  test.each([true, false])(
    "TEST-16 REQ-2.4 retains complete third-source checks when the last verdict is %p",
    (lastVerdict) => {
      const input = switchRow();
      input.third = [
        { name: "transcript-content", ok: true, detail: "literal answer ✓" },
        { name: "transcript-stop", ok: lastVerdict, detail: "distinct stop diagnostic" },
      ];
      const expected = input.third.map((check) => ({ ...check }));

      const result = switchAgreement(input);

      for (const check of expected) expect(result).toContainEqual(check);
      expect(input.third).toEqual(expected);
      if (lastVerdict) expectPass(result);
      else expectFailure(result);
    }
  );
});

describe("no-switch row agreement", () => {
  test("TEST-17 REQ-3.1 accepts consistent ordered records and safe bearers", () => {
    expectPass(noSwitchAgreement(noSwitchRow()));
  });

  test.each([0, 1])("TEST-17 REQ-3.1 accepts none with %i expected attempts", (attempts) => {
    const input: NoSwitchInput = {
      main: attempts === 0 ? [] : [request()],
      recs: [],
      expectedAttempts: attempts,
      expectedRecords: "none",
      third: third(),
    };

    expectPass(noSwitchAgreement(input));
  });

  test.each([1, 3])(
    "TEST-18 REQ-3.2 rejects two actual attempts when %i are expected",
    (expectedAttempts) => {
      const input = noSwitchRow();
      input.expectedAttempts = expectedAttempts;

      expectFailure(noSwitchAgreement(input));
    }
  );

  test.each([0, 1])("TEST-19 REQ-3.2 rejects a forbidden bearer at request index %i", (index) => {
    const input = noSwitchRow();
    input.main[index]!.bearer = "Bearer access-forbidden";
    input.bearers![index] = "Bearer access-forbidden";

    expectFailure(noSwitchAgreement(input));
  });

  test("TEST-19 REQ-3.2 checks every forbidden-list entry, not just the first", () => {
    const input = noSwitchRow();
    input.forbiddenBearers = ["Bearer not-present", "Bearer access-alpha"];

    expectFailure(noSwitchAgreement(input));
  });

  test.each(recordChanges)("TEST-20 REQ-3.2 rejects record evidence with $name", ({ change }) => {
    const input = noSwitchRow();
    change(input.recs);

    expectFailure(noSwitchAgreement(input));
  });

  test("TEST-20 REQ-3.2 rejects any record when none is expected", () => {
    const input = noSwitchRow();
    input.expectedRecords = "none";

    expectFailure(noSwitchAgreement(input));
  });

  test("TEST-20 REQ-3.2 rejects an empty record list when signatures are expected", () => {
    const input = noSwitchRow();
    input.recs = [];

    expectFailure(noSwitchAgreement(input));
  });

  test.each([
    { name: "absent", flag: undefined, passes: false },
    { name: "false", flag: false, passes: false },
    { name: "true", flag: true, passes: true },
  ])(
    "TEST-21 REQ-3.3 checks quota-switch records with switchAttempted $name",
    ({ flag, passes }) => {
      const switched = switchRow();
      const input: NoSwitchInput = {
        main: switched.main,
        recs: switched.recs,
        expectedAttempts: switched.expectedAttempts,
        bearers: switched.bearers,
        expectedRecords: switched.expectedRecords,
        third: switched.third,
      };
      if (flag !== undefined) input.switchAttempted = flag;

      const result = noSwitchAgreement(input);

      if (passes) expectPass(result);
      else expectFailure(result);
    }
  );

  test("TEST-22 REQ-3.2 rejects a failing third source alone", () => {
    const input = noSwitchRow();
    input.third[0]!.ok = false;

    expectFailure(noSwitchAgreement(input));
  });

  // Contract/agree.d.ts: optional bearers are per attempt, in order.
  test.each([0, 1])(
    "TEST-23 REQ-3.1 rejects a supplied expected-bearer mismatch at index %i",
    (index) => {
      const input = noSwitchRow();
      input.main[index]!.bearer = "Bearer unexpected-not-forbidden";

      expectFailure(noSwitchAgreement(input));
    }
  );
});

describe("V17 API-key-only agreement", () => {
  test("TEST-24 REQ-4.1 accepts one correctly signed canary hit with no pool activity", () => {
    expectPass(v17Agreement(v17Row()));
  });

  const deviations: Array<{ name: string; change: (input: V17Input) => void }> = [
    {
      name: "zero canary hits",
      change: (input) => {
        input.canaryHits = [];
      },
    },
    {
      name: "two correctly signed hits",
      change: (input) => {
        input.canaryHits.push({ ...input.canaryHits[0]!, at: 2_000 });
      },
    },
    {
      name: "wrong API key",
      change: (input) => {
        input.canaryHits[0]!.authorization = "Bearer another-fake-key";
      },
    },
    {
      name: "absent authorization",
      change: (input) => {
        input.canaryHits[0]!.authorization = null;
      },
    },
    {
      name: "missing Bearer scheme",
      change: (input) => {
        input.canaryHits[0]!.authorization = input.key;
      },
    },
    {
      name: "OAuth bearer instead of API key",
      change: (input) => {
        input.canaryHits[0]!.authorization = "Bearer access-alpha";
      },
    },
    {
      name: "a fake upstream main request",
      change: (input) => {
        input.main.push(request());
      },
    },
    {
      name: "an account record",
      change: (input) => {
        input.recs.push(record());
      },
    },
    {
      name: "a false third-source check",
      change: (input) => {
        input.third[0]!.ok = false;
      },
    },
  ];

  test.each(deviations)(
    "TEST-25 REQ-4.2 rejects $name with every other source consistent",
    ({ change }) => {
      const input = v17Row();
      change(input);

      expectFailure(v17Agreement(input));
    }
  );
});
