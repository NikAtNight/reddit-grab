import assert from "node:assert/strict";
import test from "node:test";
import "../download-recovery.js";

const first = { kind: "direct", url: "https://i.redd.it/first.jpg", suffix: "_01" };
const second = { kind: "direct", url: "https://i.redd.it/second.jpg", suffix: "_02" };
const job = { postId: "fixture", subreddit: "examples", items: [first, second] };

function setup(runRetry = async () => ({ ok: true }), seed = {}) {
  const data = structuredClone(seed);
  const storage = {
    get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => Object.assign(data, structuredClone(values)),
  };
  return { data, storage, recovery: globalThis.RedditGrabRecovery.create({ storage, retry: runRetry }) };
}

test("partial failures persist only the failed item and survive a worker restart", async () => {
  const { recovery, storage } = setup();
  await recovery.recordStarted(1, job, first);
  await recovery.changed({ id: 1, state: { current: "complete" } });
  const id = await recovery.recordFailure(job, second, "Network unavailable");
  const restarted = globalThis.RedditGrabRecovery.create({ storage, retry: async () => {} });
  const items = await restarted.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, id);
  assert.deepEqual(items[0].job.items, [second]);
  assert.deepEqual(await restarted.pending(), []);
});

test("concurrent retries of one item start one download and wait for browser completion", async () => {
  let calls = 0;
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const { recovery } = setup(async (retryJob, { recoveryId }) => {
    calls++;
    assert.deepEqual(retryJob.items, [second]);
    entered();
    await wait;
    await recovery.recordStarted(2, retryJob, second, recoveryId);
    return { ok: true };
  });
  const id = await recovery.recordFailure(job, second, "Offline");
  const pending = recovery.retry(id);
  await started;
  await assert.rejects(recovery.retry(id), /already being retried/);
  await assert.rejects(recovery.dismiss(id), /active download/);
  release();
  await pending;
  assert.equal(calls, 1);
  assert.equal((await recovery.list())[0].status, "downloading");
  await assert.rejects(recovery.retry(id), /already in progress/);
  await recovery.changed({ id: 2, state: { current: "complete" } });
  assert.deepEqual(await recovery.list(), []);
});

test("an interrupted browser transfer becomes recoverable after restart", async () => {
  const { recovery, storage } = setup();
  await recovery.recordStarted(3, job, second);
  const restarted = globalThis.RedditGrabRecovery.create({ storage, retry: async () => {} });
  assert.deepEqual(await restarted.pending(), [3]);
  await restarted.changed({ id: 3, state: { current: "interrupted" }, error: { current: "NETWORK_FAILED" } });
  await restarted.changed({ id: 3, state: { current: "interrupted" } });
  const items = await restarted.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].error, "NETWORK_FAILED");
  assert.deepEqual(items[0].job.items, [second]);
  assert.deepEqual(await restarted.pending(), []);
});

test("a lost retry response after download start cannot repeat a completed download", async () => {
  const { recovery } = setup(async (retryJob, { recoveryId }) => {
    await recovery.recordStarted(9, retryJob, first, recoveryId);
    throw new Error("The message port closed");
  });
  const id = await recovery.recordFailure(job, first, "Offline");
  await assert.rejects(recovery.retry(id), /message port closed/);
  assert.equal((await recovery.list())[0].status, "downloading");
  await assert.rejects(recovery.retry(id), /already in progress/);
  await recovery.changed({ id: 9, state: { current: "complete" } });
  assert.deepEqual(await recovery.list(), []);
  await assert.rejects(recovery.retry(id), /no longer exists/);
});

test("a failed audio fallback retries only audio after video completed", async () => {
  const source = { kind: "reddit-video", videoUrl: "https://v.redd.it/example/DASH_720.mp4" };
  const video = { kind: "direct", url: source.videoUrl, suffix: "" };
  const audio = { kind: "direct", url: "https://v.redd.it/example/DASH_audio.mp4", suffix: "_audio" };
  const { recovery } = setup(async (_job, { recoveryId }) => {
    await recovery.recordStarted(4, job, video, recoveryId);
    await recovery.recordStarted(5, job, audio, recoveryId);
    await recovery.changed({ id: 4, state: { current: "complete" } });
    await recovery.changed({ id: 5, state: { current: "interrupted" } });
    return { ok: true, saved: 1, failed: 1 };
  });
  const id = await recovery.recordFailure(job, source, "Merge failed");
  await recovery.retry(id);
  const items = await recovery.list();
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].job.items, [audio]);
  assert.equal(items[0].status, "failed");
});

test("separate failed fallback streams stay separate recovery items", async () => {
  const source = { kind: "reddit-video", videoUrl: "https://v.redd.it/example/DASH_720.mp4" };
  const { recovery } = setup(async (_job, { recoveryId }) => {
    await recovery.recordFailure(job, first, "First failed", recoveryId);
    await recovery.recordFailure(job, second, "Second failed", recoveryId);
    return { ok: true, failed: 2 };
  });
  const id = await recovery.recordFailure(job, source, "Merge failed");
  await recovery.retry(id);
  const items = await recovery.list();
  assert.equal(items.length, 2);
  assert.deepEqual(new Set(items.map(item => item.job.items[0].url)), new Set([first.url, second.url]));
});

test("callback failure stays recoverable and dismissal prevents future retries", async () => {
  let calls = 0;
  const { recovery } = setup(async () => { calls++; throw new Error("Still offline"); });
  const id = await recovery.recordFailure(job, first, "Offline");
  await assert.rejects(recovery.retry(id), /Still offline/);
  assert.equal((await recovery.list())[0].status, "failed");
  await recovery.dismiss(id);
  await assert.rejects(recovery.retry(id), /no longer exists/);
  assert.equal(calls, 1);
});

test("serial writes preserve concurrent failures and cap retained records", async () => {
  const { recovery } = setup();
  await Promise.all(Array.from({ length: 105 }, (_, index) => recovery.recordFailure(job,
    { kind: "direct", url: `https://i.redd.it/fixture${index}.jpg` }, "Offline")));
  assert.equal((await recovery.list()).length, 100);
});

test("stored sources exclude request credentials and preserve required media signatures", async () => {
  const { recovery, data } = setup();
  const item = { ...first, url: `${first.url}?token=media-signature`, headers: { Authorization: "private-value" }, modhash: "private-value" };
  await recovery.recordFailure({ ...job, cookie: "private-value" }, item, `Could not load ${item.url}`);
  const text = JSON.stringify(data);
  assert.ok(!text.includes("private-value"));
  const saved = (await recovery.list())[0];
  assert.equal(saved.job.items[0].url, item.url);
  assert.equal(saved.error, "Could not load [media URL]");
  await assert.rejects(recovery.recordFailure(job, { ...first, url: "https://user:password@i.redd.it/test.jpg" }, "Failed"), /invalid source URL/);
});

test("post extraction failures store a canonical Reddit permalink for explicit retry", async () => {
  let retried;
  const { recovery } = setup(async retryJob => { retried = retryJob; return { ok: false, error: "Sign in on the Reddit tab" }; });
  const id = await recovery.recordFailure(job, { kind: "post", url: "https://www.reddit.com/r/examples/comments/abc/title/?token=discard#comments" }, "HTTP 429");
  await assert.rejects(recovery.retry(id), /Sign in/);
  assert.equal(retried.items[0].url, "https://www.reddit.com/r/examples/comments/abc/title/");
  await assert.rejects(recovery.recordFailure(job, { kind: "post", url: "https://example.com/comments/abc" }, "Failed"), /invalid source URL/);
});
