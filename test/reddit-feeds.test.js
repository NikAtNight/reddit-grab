import assert from "node:assert/strict";
import test from "node:test";
import "../reddit-feeds.js";

const { targetFromUrl, createClient, contains } = globalThis.RedditGrabFeeds;
const target = targetFromUrl("https://www.reddit.com/user/example-user/");
const path = "/user/tester/m/favorites";
const user = { data: { name: "tester", modhash: "test-only" } };
const feed = (names = [], overrides = {}) => ({ data: {
  path, display_name: "Favorites", visibility: "private", can_edit: true,
  subreddits: names.map((name) => ({ name })), ...overrides,
} });
const session = { user: "tester", feeds: [{ path, editable: true }] };

function setup(responses, storage) {
  const calls = [];
  const client = createClient(async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(responses.length, `Unexpected request: ${url}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  }, storage);
  return { client, calls };
}

test("recognizes profile aliases and community listings, excludes posts and aggregate feeds", () => {
  for (const url of ["https://old.reddit.com/u/example-user", "https://www.reddit.com/user/example-user/submitted/?sort=new"]) {
    assert.equal(targetFromUrl(url).subredditName, "u_example-user");
  }
  assert.equal(targetFromUrl("https://www.reddit.com/r/Example_Community/top/?t=all").subredditName, "Example_Community");
  for (const route of ["/", "/r/all", "/r/popular", "/r/friends", "/r/mod", "/r/a+b", "/r/example/comments/abc/title", "/user/example/comments/abc/title", "/user/example/m/feed", "/settings", "/user/me", "/r/example/wiki/page"]) {
    assert.equal(targetFromUrl(`https://www.reddit.com${route}`), null, route);
  }
  assert.equal(targetFromUrl("https://reddit.com.evil.test/r/example"), null);
});

test("loads editable feeds without a per-target Reddit request", async () => {
  const { client, calls } = setup([user, [feed(), feed([], { can_edit: false })]]);
  const result = await client.open(target);
  assert.equal(result.feeds.length, 1);
  assert.equal(result.user, "tester");
  assert.deepEqual(calls.map(call => call.url), ["/api/me.json", "/api/multi/mine?raw_json=1"]);
  assert.ok(calls.every((call) => call.credentials === "same-origin"));
});

test("adding a profile uses the single-member endpoint, preserves settings, and verifies membership", async () => {
  const { client, calls } = setup([user, feed(["existing"]), {}, feed(["existing", "u_example-user"])]);
  const result = await client.add(session, path, target);
  assert.equal(result.alreadyPresent, false);
  assert.ok(contains(result.feed, target));
  const writes = calls.filter((call) => call.method);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PUT");
  assert.equal(writes[0].url, `/api/multi${path}/r/u_example-user`);
  assert.deepEqual(JSON.parse(writes[0].body.get("model")), { name: "u_example-user" });
  assert.equal(writes[0].headers["X-Modhash"], "test-only");
  assert.equal(calls.at(-1).url, `/api/multi${path}?raw_json=1`);
  assert.ok(!calls.some((call) => call.url.includes("subscribe")));
});

test("adding a community uses its own name, without the profile prefix", async () => {
  const community = targetFromUrl("https://www.reddit.com/r/example/");
  const { client, calls } = setup([user, feed(), {}, feed(["example"])]);
  await client.add(session, path, community);
  assert.equal(calls[2].url, `/api/multi${path}/r/example`);
});

test("existing membership is case insensitive and never sends a write, even in a full feed", async () => {
  const names = ["U_EXAMPLE-USER", ...Array.from({ length: 99 }, (_, i) => `other${i}`)];
  const { client, calls } = setup([user, feed(names)]);
  assert.equal((await client.add(session, path, target)).alreadyPresent, true);
  assert.ok(calls.every((call) => !call.method));
});

test("full feeds, changed accounts, lost edit access, and route changes prevent writes", async () => {
  const cases = [
    { responses: [user, feed(Array.from({ length: 100 }, (_, i) => `other${i}`))], error: /full/ },
    { responses: [{ data: { name: "different", modhash: "test-only" } }], error: /account changed/ },
    { responses: [user, feed([], { can_edit: false })], error: /no longer edit/ },
    { responses: [user, feed()], error: /page changed/, current: () => false },
  ];
  for (const { responses, error, current } of cases) {
    const { client, calls } = setup(responses);
    await assert.rejects(client.add(session, path, target, current), error);
    assert.ok(calls.every((call) => !call.method));
  }
});

test("only a feed selected from the authenticated list can be changed", async () => {
  const { client, calls } = setup([]);
  await assert.rejects(client.add(session, "/user/another/m/other", target), /editable/);
  assert.equal(calls.length, 0);
});

test("verification failure reports uncertainty; another attempt checks membership instead of re-adding", async () => {
  const { client, calls } = setup([user, feed(), {}, new Error("Network disconnected"), user, feed(["u_example-user"])]);
  await assert.rejects(client.add(session, path, target), /could not be verified/);
  assert.equal((await client.add(session, path, target)).alreadyPresent, true);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
});

test("successful write without membership on readback is not reported as success", async () => {
  const { client } = setup([user, feed(), {}, feed()]);
  await assert.rejects(client.add(session, path, target), /could not be verified/);
});

test("lost PUT response leaves an uncertain outcome and a retry does not duplicate the member", async () => {
  const { client, calls } = setup([user, feed(), new TypeError("Failed to fetch"), user, feed(["u_example-user"])]);
  await assert.rejects(client.add(session, path, target), /not confirmed.*check membership/);
  assert.equal((await client.add(session, path, target)).alreadyPresent, true);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
});

test("a stale feed listing cannot erase a verified addition, but a confirmed removal can", async () => {
  const { client, calls } = setup([
    user, feed(), {}, feed(["u_example-user"]),
    user, [feed()], feed(["u_example-user"]),
    user, [feed()], feed(),
  ]);
  await client.add(session, path, target);
  assert.ok(contains((await client.open(target, { refresh: true })).feeds[0], target));
  assert.equal(contains((await client.open(target, { refresh: true })).feeds[0], target), false);
  assert.equal(calls.filter(call => call.method === "PUT").length, 1);
});

test("rate limiting stops requests without automatic retries", async () => {
  const { client, calls } = setup([new Response("Too many requests", { status: 429, headers: { "Retry-After": "120" } })]);
  await assert.rejects(client.open(target), /rate limit/);
  await assert.rejects(client.open(target), /rate limit/);
  assert.equal(calls.length, 1);
});

test("logged-out, unavailable, malformed, and API-error responses do not mutate feeds", async () => {
  const cases = [
    [new Response("Login", { status: 401 })],
    [new Response("<html>Login</html>")],
    [{}],
    [user, { data: { children: [] } }],
    [user, { json: { errors: [["BAD_REQUEST", "Invalid request", ""]] } }],
  ];
  for (const responses of cases) {
    const { client, calls } = setup(responses);
    await assert.rejects(client.open(target));
    assert.ok(calls.every((call) => !call.method));
  }
});


test("membership can load without a profile or community target", async () => {
  const { client, calls } = setup([user, [feed(["already", "u_example-user"])]]);
  const result = await client.open();
  assert.deepEqual(result.feeds[0].names, ["already", "u_example-user"]);
  assert.deepEqual(calls.map(call => call.url), ["/api/me.json", "/api/multi/mine?raw_json=1"]);
  assert.ok(calls.every(call => !call.method));
});


test("persistent membership is reused after one account check and refresh is explicit", async () => {
  const data = {};
  const storage = { get: async keys => Object.fromEntries((keys === null ? Object.keys(data) : [].concat(keys)).map(key => [key, data[key]])),
    set: async values => Object.assign(data, structuredClone(values)) };
  const first = setup([user, [feed(["example"])]]);
  const client = createClient(async (url, options) => {
    first.calls.push({ url, ...options });
    return Response.json(url === "/api/me.json" ? user : [feed(["example"])]);
  }, storage);
  await client.open();
  let accountChecks = 0;
  const offline = createClient(url => {
    if (url === "/api/me.json") { accountChecks++; return Response.json(user); }
    throw new Error("Unexpected network request");
  }, storage);
  assert.equal((await offline.open(target)).feeds[0].names[0], "example");
  await offline.open(target);
  assert.equal(accountChecks, 1);
  assert.equal(first.calls.length, 2);
  assert.ok(!JSON.stringify(data).includes("modhash"));
  const fallback = await offline.open(undefined, { refresh: true });
  assert.match(fallback.warning, /Using saved feeds.*Unexpected network/);
  assert.equal(fallback.feeds[0].names[0], "example");
});

test("verified additions update persistent membership for another tab", async () => {
  const data = {};
  const storage = { get: async keys => Object.fromEntries((keys === null ? Object.keys(data) : [].concat(keys)).map(key => [key, data[key]])),
    set: async values => Object.assign(data, structuredClone(values)) };
  const responses = [user, [feed()], user, {}, feed(["u_example-user"])];
  const client = createClient(async () => Response.json(responses.shift()), storage);
  const loaded = await client.open();
  await client.add(loaded, path, target);
  const next = createClient(url => {
    if (url === "/api/me.json") return Response.json(user);
    throw new Error("Unexpected network");
  }, storage);
  assert.ok(contains((await next.open()).feeds[0], target));
});

test("rate-limit cooldown persists across clients", async () => {
  const data = {};
  const storage = { get: async key => ({ [key]: data[key] }), set: async values => Object.assign(data, values) };
  const first = createClient(async () => new Response("Limited", { status: 429 }), storage);
  await assert.rejects(first.open(), /rate limit/);
  const second = createClient(() => { throw new Error("Should not request"); }, storage);
  await assert.rejects(second.open(), /rate limit/);
});


test("a listing started before another tab's add cannot overwrite its verified membership", async () => {
  const data = {};
  const storage = { get: async keys => Object.fromEntries((keys === null ? Object.keys(data) : [].concat(keys)).map(key => [key, data[key]])),
    set: async values => Object.assign(data, structuredClone(values)) };
  let release;
  const client = createClient(async url => {
    if (url === "/api/me.json") return Response.json(user);
    return new Promise(resolve => { release = () => resolve(Response.json([feed()])); });
  }, storage);
  const opening = client.open();
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  data[`redditGrabFeed:tester:${path}`] = { savedAt: Date.now() + 1, feed: {
    path, label: "Favorites", editable: true, visibility: "private", names: ["u_example-user"],
  } };
  release();
  assert.ok(contains((await opening).feeds[0], target));
});

test("saved feeds do not expire and simultaneous opens share the account check", async () => {
  const data = { redditGrabFeedCache: { user: "tester", savedAt: Date.now() - 31 * 60 * 1000, feeds: [] } };
  const storage = { get: async keys => Object.fromEntries((keys === null ? Object.keys(data) : [].concat(keys)).map(key => [key, data[key]])),
    set: async values => Object.assign(data, structuredClone(values)) };
  const calls = [];
  const client = createClient(async url => { calls.push(url); return Response.json(url === "/api/me.json" ? user : [feed()]); }, storage);
  const results = await Promise.all([client.open(), client.open()]);
  assert.deepEqual(calls, ["/api/me.json"]);
  assert.equal(results[0].feeds.length, 0);
  assert.equal((await client.open(undefined, { refresh: true })).feeds.length, 1);
  assert.equal(calls.length, 3);
});


test("a new tab does not reuse another account's cached feeds", async () => {
  const data = { redditGrabFeedCache: { user: "previous", savedAt: Date.now(), feeds: [] } };
  const storage = { get: async keys => Object.fromEntries((keys === null ? Object.keys(data) : [].concat(keys)).map(key => [key, data[key]])),
    set: async values => Object.assign(data, structuredClone(values)) };
  const client = createClient(async url => Response.json(url === "/api/me.json" ? user : [feed()]), storage);
  const result = await client.open();
  assert.equal(result.user, "tester");
  assert.equal(result.feeds.length, 1);
});


test("passive membership lookup never requests Reddit, even with expired cache or cooldown", async () => {
  const data = { redditGrabFeedCooldown: Date.now() + 60000 };
  const storage = { get: async keys => Object.fromEntries((keys === null ? Object.keys(data) : [].concat(keys)).map(key => [key, data[key]])), set: async values => Object.assign(data, values) };
  const client = createClient(() => { throw new Error("Unexpected network"); }, storage);
  assert.equal((await client.open(target, { cachedOnly: true })).cacheMissing, true);
  data.redditGrabFeedCache = { user: "tester", savedAt: 1, feeds: [{ path, names: ["u_example-user"] }] };
  assert.ok(contains((await client.open(target, { cachedOnly: true })).feeds[0], target));
});

function savedFeeds(names = []) {
  const data = { redditGrabFeedCache: { user: "tester", savedAt: 1, feeds: [{
    path, label: "Favorites", editable: true, visibility: "private", names,
  }] } };
  const storage = {
    get: async keys => Object.fromEntries((keys === null ? Object.keys(data) : [].concat(keys)).map(key => [key, structuredClone(data[key])])),
    set: async values => Object.assign(data, structuredClone(values)),
  };
  return { data, storage };
}

const markerPrefix = `redditGrabFeed:tester:${path}:needs-reconciliation:`;
const markerKey = `${markerPrefix}earlier`;
const markers = data => Object.entries(data).filter(([key, value]) => key.startsWith(markerPrefix) && value);

test("known feeds avoid pre-add reads and unchanged refreshed feeds avoid extra reads", async () => {
  const { storage } = savedFeeds();
  const { client, calls } = setup([user, {}, feed(["u_example-user"]), user, [feed(["u_example-user"])]], storage);
  await client.add(session, path, target);
  assert.deepEqual(calls.map(call => [call.url, call.method || "GET"]), [
    ["/api/me.json", "GET"],
    [`/api/multi${path}/r/u_example-user`, "PUT"],
    [`/api/multi${path}?raw_json=1`, "GET"],
  ]);
  const refreshed = await client.open(target, { refresh: true });
  assert.ok(contains(refreshed.feeds[0], target));
  assert.equal(calls.length, 5);
});

test("uncertain writes persist a checkpoint before PUT and reconcile after restart without duplicate writes", async () => {
  for (const failure of ["put", "readback"]) {
    const { data, storage } = savedFeeds();
    let putCount = 0;
    const responses = [user, ...(failure === "put" ? [new Error("Disconnected")] : [{}, new Error("Disconnected")])];
    const first = createClient(async (_url, options) => {
      if (options.method === "PUT") { putCount++; assert.equal(markers(data).length, 1); }
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return Response.json(next);
    }, storage);
    await assert.rejects(first.add(session, path, target), /not confirmed|could not be verified/);
    assert.equal(markers(data).length, 1);
    assert.equal(markers(data)[0][1].settled, true);
    const second = setup([user, feed(["u_example-user"])], storage);
    assert.equal((await second.client.add(session, path, target)).alreadyPresent, true);
    assert.deepEqual(second.calls.map(call => call.url), ["/api/me.json", `/api/multi${path}?raw_json=1`]);
    assert.equal(putCount, 1);
    assert.equal(markers(data).length, 0);
    assert.ok(contains((await second.client.open(target, { cachedOnly: true })).feeds[0], target));
  }
});

test("reconciliation of an absent member permits one new write and clears only after verification", async () => {
  const { data, storage } = savedFeeds();
  data[markerKey] = { settled: true, community: target.subredditName };
  const { client, calls } = setup([user, feed(), {}, feed(["u_example-user"])], storage);
  await client.add(session, path, target);
  assert.equal(calls[1].url, `/api/multi${path}?raw_json=1`);
  assert.equal(calls.filter(call => call.method === "PUT").length, 1);
  assert.equal(markers(data).length, 0);
});

test("checkpoint failure blocks writes and a failed reconciliation keeps the checkpoint", async () => {
  const { data, storage } = savedFeeds();
  const broken = { ...storage, set: async values => {
    if (Object.keys(values).some(key => key.startsWith(markerPrefix))) throw new Error("Storage unavailable");
    await storage.set(values);
  } };
  const first = setup([user], broken);
  await assert.rejects(first.client.add(session, path, target), /Storage unavailable/);
  assert.ok(first.calls.every(call => !call.method));
  data[markerKey] = { settled: true, community: target.subredditName };
  const second = setup([user, new Error("Disconnected")], storage);
  await assert.rejects(second.client.add(session, path, target), /Disconnected/);
  assert.equal(data[markerKey].settled, true);
  assert.ok(second.calls.every(call => !call.method));
});

test("a newer uncertain operation is not cleared by an older operation's verification", async () => {
  const { data, storage } = savedFeeds();
  const client = createClient(async (url, options) => {
    if (url === "/api/me.json") return Response.json(user);
    if (options.method === "PUT") return Response.json({});
    data[markerKey] = { settled: false, community: "another-community" };
    return Response.json(feed(["u_example-user"]));
  }, storage);
  await client.add(session, path, target);
  assert.equal(markers(data).length, 1);
  assert.equal(data[markerKey].community, "another-community");
});

test("manual refresh reconciles marked feeds even when the aggregate matches saved membership", async () => {
  const { data, storage } = savedFeeds();
  data[markerKey] = { settled: true, community: target.subredditName };
  const { client, calls } = setup([user, [feed()], feed(["u_example-user"])], storage);
  assert.ok(contains((await client.open(target, { refresh: true })).feeds[0], target));
  assert.equal(calls.length, 3);
  assert.equal(markers(data).length, 0);
});

test("network and rate limits return saved feeds with a warning, without repeating requests", async () => {
  for (const failure of [new Error("Offline"), new Response("Limited", { status: 429 })]) {
    const { storage } = savedFeeds(["u_example-user"]);
    const { client, calls } = setup([failure], storage);
    const result = await client.open(target, { refresh: true });
    assert.match(result.warning, /Using saved feeds/);
    assert.ok(contains(result.feeds[0], target));
    assert.equal(calls.length, 1);
  }
});

test("auth failures and a known changed account never fall back to saved feeds", async () => {
  for (const status of [401, 403]) {
    const { storage } = savedFeeds(["u_example-user"]);
    const { client } = setup([new Response("Sign in", { status })], storage);
    await assert.rejects(client.open(target, { refresh: true }), /Sign in/);
    assert.equal((await client.open(target, { cachedOnly: true })).cacheMissing, true);
  }
  const { storage } = savedFeeds();
  const { client } = setup([{ data: { name: "different", modhash: "test-only" } }, new Error("Offline")], storage);
  await assert.rejects(client.open(target), /Offline/);
});

test("two tabs writing one feed keep separate checkpoints until each request settles", async () => {
  const { data, storage } = savedFeeds();
  let releaseFirst;
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const firstWait = new Promise(resolve => { releaseFirst = resolve; });
  const first = createClient(async (url, options) => {
    if (url === "/api/me.json") return Response.json(user);
    assert.equal(options.method, "PUT");
    started();
    await firstWait;
    throw new Error("Lost first response");
  }, storage);
  const firstResult = first.add(session, path, target);
  const firstRejection = assert.rejects(firstResult, /not confirmed/);
  await firstStarted;
  const [[firstKey]] = markers(data);

  const other = targetFromUrl("https://www.reddit.com/r/other_community/");
  const second = setup([user, feed(), {}, feed([other.subredditName])], storage);
  await second.client.add(session, path, other);
  assert.equal(second.calls.filter(call => call.method === "PUT").length, 1);
  assert.equal(markers(data).length, 1);
  assert.equal(data[firstKey].settled, false, "second tab must not clear first tab's in-flight marker");

  releaseFirst();
  await firstRejection;
  assert.equal(data[firstKey].settled, true);
  const restarted = setup([user, feed([target.subredditName, other.subredditName])], storage);
  assert.equal((await restarted.client.add(session, path, target)).alreadyPresent, true);
  assert.ok(restarted.calls.every(call => !call.method));
  assert.equal(markers(data).length, 0);
  assert.equal((await restarted.client.open(target, { cachedOnly: true })).feeds[0].names.length, 2);
});

test("a read started while another write was pending cannot clear its later settled marker", async () => {
  const { data, storage } = savedFeeds();
  data[markerKey] = { settled: false, community: target.subredditName };
  let release;
  let entered;
  const readStarted = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const client = createClient(async url => {
    if (url === "/api/me.json") return Response.json(user);
    entered();
    await wait;
    return Response.json(feed([target.subredditName]));
  }, storage);
  const result = client.add(session, path, target);
  await readStarted;
  data[markerKey] = { settled: true, community: target.subredditName };
  release();
  assert.equal((await result).alreadyPresent, true);
  assert.equal(data[markerKey].settled, true, "only a later read can reconcile the settled write");
});

test("navigation after checkpoint persistence removes only the unqueued write's marker", async () => {
  const { data, storage } = savedFeeds();
  let current = true;
  let removals = 0;
  const interrupted = {
    ...storage,
    set: async values => {
      await storage.set(values);
      if (Object.keys(values).some(key => key.startsWith(markerPrefix))) current = false;
    },
    remove: async key => { removals++; delete data[key]; },
  };
  const { client, calls } = setup([user], interrupted);
  await assert.rejects(client.add(session, path, target, () => current), /page changed/);
  assert.equal(removals, 1);
  assert.equal(markers(data).length, 0);
  assert.ok(calls.every(call => !call.method));
});
