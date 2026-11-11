(function () {
  "use strict";
  const form = document.getElementById("setupForm");
  const error = document.getElementById("setupError");
  const button = document.getElementById("setupBtn");
  const label = document.getElementById("setupLabel");
  const token = new URLSearchParams(window.location.search).get("token") || "";
  if (!token) {
    error.textContent = "This setup link is missing its token.";
    error.hidden = false;
    button.disabled = true;
  }
  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    button.disabled = false;
    label.textContent = "Create account";
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (form.password.value.length < 10) return fail("Use at least 10 characters.");
    if (form.password.value !== form.confirm.value) return fail("The passwords do not match.");
    button.disabled = true;
    label.textContent = "Creating…";
    try {
      const response = await fetch("/api/customer/accept-invite", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: form.password.value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return fail(data.error || "This setup link is invalid or has expired.");
      window.location.replace("/?welcome=1#compose");
    } catch {
      fail("Cannot reach Relay Cloud. Try again.");
    }
  });
})();
