import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import "../reddit-requests.js";
const { createBroker, validate } = globalThis.RedditGrabRequests;
const origin = "https://www.reddit.com";
const context = { tabId: 1, scope: "normal:default" };
const get = path => ({ origin, path, method: "GET" });
const response = (status = 200, headers = {}) => ({ status, headers, body: "{}" });
const makeStorage = (data = {}) => ({ data, get: async key => ({ [key]: data[key] }), set: async values => Object.assign(data, values) });

test("shared queue serializes and spaces requests from different tabs", async () => {
  let time = 10000;
  let active = 0;
  const starts = [];
  const broker = createBroker({ storage: makeStorage(), now: () => time, sleep: async ms => { time += ms; },
    execute: async () => { assert.equal(active++, 0); starts.push(time); await Promise.resolve(); active--; return response(); } });
  await Promise.all([broker.enqueue(get("/api/me.json"), context), broker.enqueue(get("/api/multi/mine"), { ...context, tabId: 2 })]);
  assert.deepEqual(starts, [10000, 11500]);
});

test("identical reads share one request within a session but not across containers", async () => {
  let calls = 0;
  const broker = createBroker({ spacing: 0, storage: makeStorage(), execute: async () => { calls++; return response(); } });
  await Promise.all([broker.enqueue(get("/api/me.json"), context), broker.enqueue(get("/api/me.json"), { ...context, tabId: 2 }),
    broker.enqueue(get("/api/me.json"), { ...context, scope: "normal:other-container" })]);
  assert.equal(calls, 2);
});

test("worker restart preserves spacing and clears stale in-flight status", async () => {
  let time = 10500;
  const storage = makeStorage({ redditGrabRequestStatus: { lastRequestAt: 10000, queued: 4, inFlight: 1 } });
  const starts = [];
  const broker = createBroker({ storage, now: () => time, sleep: async ms => { time += ms; }, execute: async () => {
    starts.push(time); return response();
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.data.redditGrabRequestStatus.inFlight, 0);
  assert.equal(storage.data.redditGrabRequestStatus.queued, 0);
  await broker.enqueue(get("/api/me.json"), context);
  assert.deepEqual(starts, [11500]);
});

test("per-feed verification reads are not combined with older reads", async () => {
  let calls = 0;
  const broker = createBroker({ spacing: 0, storage: makeStorage(), execute: async () => { calls++; return response(); } });
  await Promise.all([broker.enqueue(get("/api/multi/user/tester/m/feed"), context), broker.enqueue(get("/api/multi/user/tester/m/feed"), context)]);
  assert.equal(calls, 2);
});

test("429 pauses queued requests and persists cooldown across broker restarts without retry", async () => {
  let calls = 0;
  const storage = makeStorage();
  const broker = createBroker({ spacing: 0, now: () => 1000, storage,
    execute: async () => { calls++; return response(429, { "retry-after": "120" }); } });
  const results = await Promise.all([broker.enqueue(get("/api/me.json"), context), broker.enqueue(get("/api/multi/mine"), context)]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.status === 429));
  assert.equal(storage.data.redditGrabFeedCooldown, 121000);
  const restarted = createBroker({ now: () => 2000, storage, execute: () => { throw new Error("Unexpected request"); } });
  assert.equal((await restarted.enqueue(get("/api/me.json"), context)).status, 429);
  assert.equal(storage.data.redditGrabRequestStatus.inFlight, 0);
});

test("exhausted quota headers pause the queue before another429", async () => {
  let calls = 0;
  const broker = createBroker({ spacing: 0, storage: makeStorage(), execute: async () => {
    calls++; return response(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "90" });
  } });
  const results = await Promise.all([broker.enqueue(get("/api/me.json"), context), broker.enqueue(get("/api/multi/mine"), context)]);
  assert.equal(calls, 1);
  assert.equal(results[1].status, 429);
});

test("failed tab request does not stall later requests", async () => {
  let calls = 0;
  const broker = createBroker({ spacing: 0, storage: makeStorage(), execute: async () => {
    if (++calls === 1) throw new Error("Tab closed"); return response();
  } });
  const results = await Promise.allSettled([broker.enqueue(get("/api/me.json"), context), broker.enqueue(get("/api/multi/mine"), context)]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
});

test("request allowlist rejects unrelated URLs and mutations", () => {
  for (const path of ["https://evil.example/api/me.json", "/api/subscribe", "/api/delete_user", "//evil.example/"]) {
    assert.throws(() => validate(get(path)));
  }
  assert.throws(() => validate({ ...get("/api/me.json"), method: "POST" }));
  const put = { origin, path: "/api/multi/user/tester/m/feed/r/example", method: "PUT",
    body: new URLSearchParams({ api_type: "json", model: JSON.stringify({ name: "example" }) }).toString() };
  assert.equal(validate(put).method, "PUT");
  assert.throws(() => validate({ ...put, body: put.body.replace("example", "wrong") }));
  assert.equal(validate(get("/r/pics/comments/abc/title.json?raw_json=1")).method, "GET");
  for (const path of ["/comments/abc.json", "/user/name_here/comments/abc/title.json", "/u/name_here/comments/abc/title/.json"]) {
    assert.equal(validate(get(path)).method, "GET");
  }
});

test("tab executor rejects navigated writes and forwards same-origin GET credentials", async () => {
  let listener;
  const calls = [];
  const sandbox = { URL, URLSearchParams, AbortSignal, location: { origin, href: origin + "/r/current/" }, document: {},
    fetch: async (url, options) => { calls.push({ url, options }); return new Response("{}", { status: 200 }); },
    chrome: { runtime: { id: "extension", onMessage: { addListener: value => { listener = value; } } } } };
  vm.runInNewContext(await readFile("reddit-requests.js", "utf8"), sandbox);
  const invoke = request => new Promise(resolve => listener({ type: "reddit-grab-execute-request", request }, { id: "extension" }, resolve));
  const result = await invoke({ ...get("/api/me.json"), pageUrl: origin + "/r/current/" });
  assert.equal(result.ok, true);
  assert.equal(calls[0].options.credentials, "same-origin");
  const invalid = await invoke({ origin, path: "/api/multi/user/tester/m/feed/r/example", method: "PUT", pageUrl: origin + "/r/previous/",
    body: new URLSearchParams({ api_type: "json", model: JSON.stringify({ name: "example" }) }).toString() });
  assert.equal(invalid.ok, false);
  assert.equal(calls.length, 1);
});
