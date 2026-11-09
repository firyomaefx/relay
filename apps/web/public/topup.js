// Relay Cloud self-serve top-up. The API key is sent once to Relay to start a
// Stripe Checkout Session and is never stored in the browser.
(function () {
  const form = document.getElementById("topupForm");
  const status = document.getElementById("status");
  const button = document.getElementById("payButton");
  const keyInput = document.getElementById("apiKey");
  if (!form || !status || !button || !keyInput) return;

  function show(message, isError) {
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
  }

  fetch("/api/billing/topup", { headers: { accept: "application/json" } })
    .then((response) => response.json())
    .then((data) => {
      if (!data || !data.available) {
        button.disabled = true;
        show("Card top-ups aren't switched on yet. Please check back soon or use the contact page.", true);
      }
    })
    .catch(() => undefined);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = keyInput.value.trim();
    const selected = form.querySelector('input[name="plan"]:checked');
    const plan = selected ? selected.value : "";
    if (!key.startsWith("rly_")) {
      show("That doesn't look like a Relay API key. It starts with rly_.", true);
      return;
    }
    button.disabled = true;
    show("Opening secure checkout...");
    try {
      const response = await fetch("/api/billing/topup", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({ plan }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) {
        const message = data && typeof data.error === "string" ? data.error : "Checkout couldn't start. Please try again.";
        throw new Error(message);
      }
      keyInput.value = "";
      window.location.assign(data.url);
    } catch (error) {
      show(error instanceof Error ? error.message : String(error), true);
      button.disabled = false;
    }
  });
})();
