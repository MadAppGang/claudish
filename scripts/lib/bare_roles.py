"""Canonical bare-role vocabulary, shared by the traffic instruments.

#555/#583: a bare role name (`opus`, `fable`, `sonnet`, `haiku`) as the
requested/served model only ever rides the native lane — the budget lanes
always serve their resolved target id. Instruments must classify with THIS
constant so the vocabulary cannot drift between them; mutating it reddens
both suites (test_harness_injection_native, test_traffic_consumption_lanes).
"""
import re

BARE_ROLES = ("opus", "fable", "sonnet", "haiku")
BARE_ROLE_RE = re.compile(r"^(?:%s)$" % "|".join(BARE_ROLES), re.I)
