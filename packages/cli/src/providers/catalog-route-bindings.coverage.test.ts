import { expect, test } from "bun:test";
import routes from "../test-fixtures/catalog-v3/routes-g-20261021063612126-17350b71.json";
import {
  CATALOG_ROUTE_BINDINGS,
  type CatalogRouteBinding,
  UNBOUND_SUBSCRIPTION_PROFILES,
} from "./catalog-route-bindings.js";

// MTL-189 follow-up: E — account for every subscription profile (generation g-20261021063612126-17350b71).
const subscriptions = Object.entries(routes).flatMap(([routeId, route]) =>
  Object.entries(route.profiles)
    .filter(([, profile]) => profile.kind === "subscription")
    .map(([routeProfileId]) => ({ routeId, routeProfileId }))
);

function matches(left: CatalogRouteBinding, right: CatalogRouteBinding): boolean {
  return left.routeId === right.routeId && left.routeProfileId === right.routeProfileId;
}

test("the real routes registry publishes subscription profiles", () => {
  expect(subscriptions.length).toBeGreaterThan(0);
});

test("deliberately unbound subscription profiles have reasons and no route binding", () => {
  for (const binding of UNBOUND_SUBSCRIPTION_PROFILES) {
    expect(binding.reason.trim().length).toBeGreaterThan(0);
    expect(
      Object.values(CATALOG_ROUTE_BINDINGS).some((candidate) => matches(candidate, binding))
    ).toBe(false);
  }
});

for (const binding of subscriptions) {
  test(`${binding.routeId}/${binding.routeProfileId} is bound or explicitly deliberately unbound`, () => {
    const bound = Object.values(CATALOG_ROUTE_BINDINGS).some((candidate) =>
      matches(candidate, binding)
    );
    const deliberatelyUnbound = UNBOUND_SUBSCRIPTION_PROFILES.some(
      (candidate: CatalogRouteBinding) => matches(candidate, binding)
    );
    expect(bound || deliberatelyUnbound).toBe(true);
  });
}
