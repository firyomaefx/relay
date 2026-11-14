(() => {
  "use strict";
  const form = document.getElementById("waitlistForm");
  const message = document.getElementById("message");
  const submit = document.getElementById("submit");
  const submitLabel = document.getElementById("submitLabel");
  const successCard = document.getElementById("successCard");
  const successTitle = document.getElementById("successTitle");
  const position = document.getElementById("position");
  const successText = document.getElementById("successText");
  const badge = document.getElementById("batchBadge");

  function setMessage(text, isError = false) {
    if (!message) return;
    message.textContent = text;
    message.className = isError ? "form-msg error" : "form-msg";
  }

  function setBatch(batch, remaining) {
    if (!badge) return;
    if (batch === "next") badge.textContent = "Founding batch full · next batch open";
    else if (Number.isFinite(remaining)) badge.textContent = remaining + (remaining === 1 ? " founding spot left" : " founding spots left");
    else badge.textContent = "No card";
  }

  async function loadStatus() {
    try {
      const response = await fetch("/api/waitlist", { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const data = await response.json();
      setBatch(data.batch, data.remaining);
    } catch {
      // The form remains usable if the status call is unavailable.
    }
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage("");
      const name = String(form.elements.namedItem("name")?.value ?? "").trim();
      const email = String(form.elements.namedItem("email")?.value ?? "").trim();
      if (!name) {
        setMessage("Add your name so we know who to expect.", true);
        form.elements.namedItem("name")?.focus?.();
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setMessage("Add a valid email so we can send your setup link.", true);
        form.elements.namedItem("email")?.focus?.();
        return;
      }
      submit.disabled = true;
      if (submitLabel) submitLabel.textContent = "Sending…";
      try {
        const response = await fetch("/api/waitlist", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            name,
            email,
            website: form.elements.namedItem("website")?.value ?? "",
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not save your request. Try again.");
        form.hidden = true;
        successCard.hidden = false;
        position.textContent = data.position ? "#" + data.position : "Received";
        if (data.duplicate) {
          successTitle.textContent = "You're already on the list.";
          successText.textContent = "We already have your request. We will email you when your spot opens.";
        } else if (data.batch === "next") {
          successTitle.textContent = "Next batch saved.";
          successText.textContent = "The founding batch is full. You're on the next-batch list; we will email you when a spot opens.";
        } else if (data.emailSent === false) {
          successTitle.textContent = "Request saved.";
          successText.textContent = "Your request is safe. The confirmation email is delayed, but we will contact you when your spot opens.";
        } else {
          successTitle.textContent = "You're in line.";
          successText.textContent = "Check your inbox for a confirmation. We will email you again when your private setup link is ready.";
        }
        successCard.focus({ preventScroll: true });
        requestAnimationFrame(() => {
          const top = window.scrollY + successCard.getBoundingClientRect().top - 96;
          window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not save your request.", true);
        submit.disabled = false;
        if (submitLabel) submitLabel.textContent = "Request early access";
      }
    });
  }

  loadStatus();
})();
