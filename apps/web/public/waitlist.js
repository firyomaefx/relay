(() => {
  "use strict";
  const body = document.body;
  const navToggle = document.getElementById("navToggle");
  const mobilePanel = document.getElementById("mobilePanel");
  const mobileLinks = mobilePanel ? [...mobilePanel.querySelectorAll("a")] : [];
  const form = document.getElementById("waitlistForm");
  const message = document.getElementById("message");
  const submit = document.getElementById("submit");
  const submitLabel = document.getElementById("submitLabel");
  const successCard = document.getElementById("successCard");
  const fullCard = document.getElementById("fullCard");
  const position = document.getElementById("position");
  const successText = document.getElementById("successText");
  const badge = document.querySelector(".form-badge");
  const joinGrid = document.querySelector(".join-grid");
  const joinCopy = document.querySelector(".join-copy");

  function closeNav({ restoreFocus = true } = {}) {
    body.classList.remove("nav-open");
    if (navToggle) navToggle.setAttribute("aria-expanded", "false");
    if (mobilePanel) {
      mobilePanel.setAttribute("aria-hidden", "true");
      mobilePanel.inert = true;
    }
    if (restoreFocus && navToggle) navToggle.focus({ preventScroll: true });
  }
  function openNav() {
    body.classList.add("nav-open");
    if (navToggle) navToggle.setAttribute("aria-expanded", "true");
    if (mobilePanel) {
      mobilePanel.setAttribute("aria-hidden", "false");
      mobilePanel.inert = false;
      window.setTimeout(() => mobilePanel.focus({ preventScroll: true }), 80);
    }
  }
  if (navToggle && mobilePanel) {
    mobilePanel.inert = true;
    navToggle.addEventListener("click", () => body.classList.contains("nav-open") ? closeNav() : openNav());
    mobileLinks.forEach((link) => link.addEventListener("click", closeNav));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && body.classList.contains("nav-open")) closeNav();
    });
    window.addEventListener("resize", () => {
      if (window.innerWidth > 980 && body.classList.contains("nav-open")) closeNav();
    }, { passive: true });
  }

  function setMessage(text, isError = false) {
    if (!message) return;
    message.textContent = text;
    message.className = isError ? "form-msg error" : "form-msg";
  }

  async function loadStatus() {
    try {
      const response = await fetch("/api/waitlist", { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const data = await response.json();
      if (!data.open) {
        if (form) form.hidden = true;
        if (fullCard) fullCard.hidden = false;
        if (joinCopy) joinCopy.hidden = true;
        joinGrid?.classList.add("is-success");
        if (badge) badge.textContent = "Batch full";
        return;
      }
      if (badge && Number.isFinite(data.remaining)) badge.textContent = data.remaining + " places left";
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
        setMessage("Add your name so we know who to let in.", true);
        form.elements.namedItem("name")?.focus?.();
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setMessage("Add a valid email so we can send your setup link.", true);
        form.elements.namedItem("email")?.focus?.();
        return;
      }
      submit.disabled = true;
      if (submitLabel) submitLabel.textContent = "Reserving…";
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
        if (!response.ok) throw new Error(data.error || "Could not reserve your spot. Try again.");
        form.hidden = true;
        successCard.hidden = false;
        if (joinCopy) joinCopy.hidden = true;
        joinGrid?.classList.add("is-success");
        position.textContent = data.position ? "#" + data.position : "Received";
        successText.textContent = data.duplicate
          ? "You were already on the list. We have your request and will email you when your spot opens."
          : data.emailSent
            ? "Check your inbox. We sent a confirmation. We will email you again when your private setup link is ready."
            : "We have your request. We will contact you when your Relay Cloud account is ready.";
        successCard.focus({ preventScroll: true });
        requestAnimationFrame(() => {
          const top = window.scrollY + successCard.getBoundingClientRect().top - 96;
          window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not reserve your spot.", true);
        submit.disabled = false;
        if (submitLabel) submitLabel.textContent = "Join the waitlist";
      }
    });
  }

  const reveals = [...document.querySelectorAll("[data-reveal]")];
  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach((element) => observer.observe(element));
  } else {
    reveals.forEach((element) => element.classList.add("in"));
  }

  loadStatus();
})();
