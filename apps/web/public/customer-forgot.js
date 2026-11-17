(function () {
  "use strict";
  const form = document.getElementById("forgotForm");
  const error = document.getElementById("forgotError");
  const success = document.getElementById("forgotSuccess");
  const button = document.getElementById("forgotBtn");
  const label = document.getElementById("forgotLabel");
  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    success.hidden = true;
    button.disabled = false;
    label.textContent = "Email me a link";
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    success.hidden = true;
    const turnstileToken = document.querySelector('[name="cf-turnstile-response"]')?.value ?? "";
    if (!turnstileToken) return fail("Complete the verification challenge.");
    button.disabled = true;
    label.textContent = "Sending…";
    try {
      const response = await fetch("/api/customer/forgot-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.email.value.trim(),
          turnstileToken,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return fail(data.error || "Could not send the reset link.");
      success.textContent = data.message || "If that email is on file, we sent a password reset link.";
      success.hidden = false;
      button.disabled = true;
      label.textContent = "Sent";
    } catch {
      fail("Cannot reach Relay Cloud. Try again.");
    }
  });
})();