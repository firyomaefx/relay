(function () {
  "use strict";
  const form = document.getElementById("customerLoginForm");
  const error = document.getElementById("customerLoginError");
  const button = document.getElementById("customerLoginBtn");
  const label = document.getElementById("customerLoginLabel");
  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    button.disabled = false;
    label.textContent = "Continue";
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    button.disabled = true;
    label.textContent = "Signing in…";
    try {
      const response = await fetch("/api/customer/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.email.value.trim(),
          password: form.password.value,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return fail(data.error || "Email or password is incorrect.");
      window.location.replace("/#compose");
    } catch {
      fail("Cannot reach Relay Cloud. Try again.");
    }
  });
})();
