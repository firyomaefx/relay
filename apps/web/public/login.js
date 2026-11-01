/* Relay console — login page. */
(() => {
  "use strict";

  const form = document.getElementById("loginForm");
  const passwordInput = document.getElementById("password");
  const errorBox = document.getElementById("loginError");
  const submitButton = document.getElementById("loginBtn");
  const submitLabel = document.getElementById("loginLabel");

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
    passwordInput?.focus();
    passwordInput?.select();
  }

  function hideError() {
    if (!errorBox) return;
    errorBox.hidden = true;
  }

  async function openIfAlreadyAuthenticated() {
    try {
      const response = await fetch("/api/session", { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const session = await response.json();
      if (!session.protected || session.authenticated) window.location.replace("/");
    } catch {
      /* The form still works if the probe fails. */
    }
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideError();
    const password = passwordInput?.value ?? "";
    if (!password) {
      showError("Enter the console password.");
      return;
    }
    submitButton.disabled = true;
    if (submitLabel) submitLabel.textContent = "Unlocking…";
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ password }),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (response.ok) {
        window.location.replace("/");
        return;
      }
      showError(payload?.error || "That password did not work. Try again.");
    } catch {
      showError("Cannot reach the console. Is the server still running?");
    } finally {
      submitButton.disabled = false;
      if (submitLabel) submitLabel.textContent = "Continue";
    }
  });

  passwordInput?.addEventListener("input", hideError);

  void openIfAlreadyAuthenticated();
})();
