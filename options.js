const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULTS = { folder: "Reddit Media", bySubreddit: false };

const form = document.querySelector("form");
const folder = document.getElementById("folder");
const bySubreddit = document.getElementById("by-subreddit");
const status = document.getElementById("status");

api.storage.sync.get(DEFAULTS).then((settings) => {
  folder.value = settings.folder;
  bySubreddit.checked = settings.bySubreddit;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await api.storage.sync.set({
    folder: folder.value.trim(),
    bySubreddit: bySubreddit.checked,
  });
  status.textContent = "Saved";
  setTimeout(() => {
    status.textContent = "";
  }, 1500);
});

const recoveryList = document.getElementById("recovery-list");
const recoveryStatus = document.getElementById("recovery-status");
const recoveryRefresh = document.getElementById("recovery-refresh");
let recoveryBusy = false;

async function recoveryRequest(type, id) {
  const response = await api.runtime.sendMessage({ type, ...(id ? { id } : {}) });
  if (!response?.ok) throw new Error(response?.error || "Could not load download recovery.");
  return response;
}

async function loadRecovery() {
  const response = await recoveryRequest("recovery-list");
  recoveryList.replaceChildren();
  for (const item of response.items) {
    const row = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `r/${item.job.subreddit} · Post ${item.job.postId}`;
    const detail = document.createElement("p");
    detail.textContent = item.status === "failed" ? item.error : item.status === "retrying" ? "Preparing retry…" : "Downloading…";
    row.append(title, detail);
    for (const [label, type] of [["Retry", "recovery-retry"], ["Dismiss", "recovery-dismiss"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled = item.status !== "failed";
      button.setAttribute("aria-label", `${label} failed download from post ${item.job.postId}`);
      button.addEventListener("click", () => changeRecovery(type, item.id));
      row.append(button);
    }
    recoveryList.append(row);
  }
  if (!response.items.length) recoveryStatus.textContent = "No failed downloads.";
}

async function changeRecovery(type, id) {
  if (recoveryBusy) return;
  recoveryBusy = true;
  recoveryRefresh.disabled = true;
  for (const button of recoveryList.querySelectorAll("button")) button.disabled = true;
  recoveryStatus.textContent = type === "recovery-retry" ? "Retrying failed download…" : "Dismissing…";
  try {
    await recoveryRequest(type, id);
    recoveryStatus.textContent = type === "recovery-retry" ? "Retry requested. Refresh to check the result." : "Dismissed.";
  } catch (error) {
    recoveryStatus.textContent = error.message;
  } finally {
    try { await loadRecovery(); } catch (error) { recoveryStatus.textContent = error.message; }
    recoveryBusy = false;
    recoveryRefresh.disabled = false;
  }
}

recoveryRefresh.addEventListener("click", async () => {
  if (recoveryBusy) return;
  recoveryStatus.textContent = "Loading…";
  try { await loadRecovery(); if (recoveryList.children.length) recoveryStatus.textContent = "List updated."; }
  catch (error) { recoveryStatus.textContent = error.message; }
});
loadRecovery().catch(error => { recoveryStatus.textContent = error.message; });
