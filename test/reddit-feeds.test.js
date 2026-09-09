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

function setup(responses) {
  const calls = [];
  const client = createClient(async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(responses.length, `Unexpected request: ${url}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  });
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

test("loads editable feeds and resolves the profile's actual Reddit community", async () => {
  const { client, calls } = setup([user, { data: { children: [{ data: { name: "t5_example", display_name: "u_example-user" } }] } }, [feed(), feed([], { can_edit: false })]]);
  const result = await client.open(target);
  assert.equal(result.feeds.length, 1);
  assert.equal(result.user, "tester");
  assert.match(calls[1].url, /sr_name=u_example-user/);
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
  const info = { data: { children: [{ data: { name: "t5_example", display_name: "u_example-user" } }] } };
  const { client, calls } = setup([
    user, feed(), {}, feed(["u_example-user"]),
    user, info, [feed()], feed(["u_example-user"]),
    user, info, [feed(["u_example-user"])], feed(),
  ]);
  await client.add(session, path, target);
  assert.ok(contains((await client.open(target)).feeds[0], target));
  assert.equal(contains((await client.open(target)).feeds[0], target), false);
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
