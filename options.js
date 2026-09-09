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
