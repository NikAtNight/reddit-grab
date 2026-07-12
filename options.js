const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULTS = { folder: "PhotoVault Inbox", bySubreddit: false };

const folderInput = document.getElementById("folder");
const bySubredditInput = document.getElementById("bySubreddit");
const status = document.getElementById("status");

api.storage.sync.get(DEFAULTS).then(({ folder, bySubreddit }) => {
  folderInput.value = folder;
  bySubredditInput.checked = bySubreddit;
});

document.getElementById("save").addEventListener("click", async () => {
  await api.storage.sync.set({
    folder: folderInput.value.trim(),
    bySubreddit: bySubredditInput.checked,
  });
  status.textContent = "Saved";
  setTimeout(() => (status.textContent = ""), 1500);
});
