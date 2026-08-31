const form = document.querySelector("#shorten-form");
const urlInput = document.querySelector("#url");
const slugInput = document.querySelector("#slug");
const toggle = document.querySelector("#custom-toggle");
const customField = document.querySelector("#custom-field");
const domainPrefix = document.querySelector("#domain-prefix");
const message = document.querySelector("#message");
const result = document.querySelector("#result");
const shortLink = document.querySelector("#short-link");
const copyButton = document.querySelector("#copy-button");
const submitButton = form.querySelector("button[type='submit']");

domainPrefix.textContent = `${window.location.host}/`;

toggle.addEventListener("click", () => {
  const opening = customField.hidden;
  customField.hidden = !opening;
  toggle.setAttribute("aria-expanded", String(opening));
  toggle.textContent = opening ? "− Remove custom name" : "+ Add a custom name";
  if (opening) slugInput.focus();
  else slugInput.value = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  result.hidden = true;
  if (!urlInput.checkValidity() || (!customField.hidden && !slugInput.checkValidity())) {
    message.textContent = "Please check the link and custom name, then try again.";
    return;
  }

  submitButton.disabled = true;
  submitButton.querySelector("span").textContent = "Working…";
  try {
    const response = await fetch("/api/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlInput.value, slug: slugInput.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not shorten this link");
    shortLink.href = data.shortUrl;
    shortLink.textContent = data.shortUrl.replace(/^https?:\/\//, "");
    result.hidden = false;
    copyButton.textContent = "Copy link";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.querySelector("span").textContent = "Shorten it";
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shortLink.href);
    copyButton.textContent = "Copied!";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(shortLink);
    selection.removeAllRanges();
    selection.addRange(range);
    copyButton.textContent = "Selected";
  }
});
