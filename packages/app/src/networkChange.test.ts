import { expect, test } from "bun:test";
import { NetworkChange } from "./networkChange";

const wifi = (ipAddress = "192.168.1.20") => ({
  type: "wifi",
  isConnected: true,
  details: { ipAddress },
});
const cellular = (ipAddress = "10.64.3.9") => ({
  type: "cellular",
  isConnected: true,
  details: { ipAddress },
});
const offline = { type: "none", isConnected: false, details: null };

test("the network the app starts on is not a change", () => {
  expect(new NetworkChange().next(wifi())).toBe(false);
});

test("walking out of the house is a change", () => {
  // Wifi to cellular leaves the socket bound to an interface that is gone,
  // with nothing to tell it so for minutes.
  const change = new NetworkChange();
  change.next(wifi());
  expect(change.next(cellular())).toBe(true);
});

test("a new access point on the same transport is a change", () => {
  const change = new NetworkChange();
  change.next(wifi("192.168.1.20"));
  expect(change.next(wifi("10.0.0.7"))).toBe(true);
});

test("a refresh that changes nothing is not a change", () => {
  // NetInfo re-reports the same network for reachability flickers; a
  // reconnect on each would cost a working connection for nothing.
  const change = new NetworkChange();
  change.next(wifi());
  expect(change.next(wifi())).toBe(false);
  expect(change.next({ ...wifi(), details: { ipAddress: "192.168.1.20", strength: 40 } })).toBe(false);
});

test("losing the network waits; getting it back is the change", () => {
  const change = new NetworkChange();
  change.next(wifi());
  expect(change.next(offline)).toBe(false);
  expect(change.next(wifi())).toBe(true);
});

test("starting offline and then connecting is a change", () => {
  const change = new NetworkChange();
  change.next(offline);
  expect(change.next(cellular())).toBe(true);
});
