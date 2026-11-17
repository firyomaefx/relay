(function () {
  "use strict";
  const form = document.getElementById("setupForm");
  const error = document.getElementById("setupError");
  const button = document.getElementById("setupBtn");
  const label = document.getElementById("setupLabel");
  const title = document.getElementById("setupTitle");
  const lede = document.getElementById("setupLede");
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const defaultMode = document.body.dataset.inviteMode === "reset" ? "reset" : "setup";
  if (!token) {
    error.textContent = "This link is missing its token.";
    error.hidden = false;
    button.disabled = true;
  }
  function applyPurpose(purpose) {
    if (purpose === "reset") {
      if (title) title.textContent = "Choose a new password";
      if (lede) lede.textContent = "Use at least 10 characters. This link expires in 24 hours.";
      label.textContent = "Update password";
    } else {
      if (title) title.textContent = "Set your password";
      if (lede) lede.textContent = "Choose a password for your Relay Cloud account. Use at least 10 characters.";
      label.textContent = "Create account";
    }
  }
  applyPurpose(defaultMode);
  async function loadPreview() {
    if (!token) return;
    try {
      const response = await fetch(`/api/customer/invite-preview?token=${encodeURIComponent(token)}`, { credentials: "same-origin" });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.purpose) applyPurpose(data.purpose);
      else if (!response.ok) {
        error.textContent = data.error || "This link is invalid or has expired.";
        error.hidden = false;
        button.disabled = true;
      }
    } catch {
      /* keep default copy */
    }
  }
  void loadPreview();
  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    button.disabled = false;
    label.textContent = defaultMode === "reset" ? "Update password" : "Create account";
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (form.password.value.length < 10) return fail("Use at least 10 characters.");
    if (form.password.value !== form.confirm.value) return fail("The passwords do not match.");
    button.disabled = true;
    label.textContent = "Saving…";
    try {
      const response = await fetch("/api/customer/accept-invite", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: form.password.value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return fail(data.error || "This link is invalid or has expired.");
      window.location.replace(data.purpose === "reset" ? "/login?reset=1" : "/?welcome=1#compose");
    } catch {
      fail("Cannot reach Relay Cloud. Try again.");
    }
  });
})();