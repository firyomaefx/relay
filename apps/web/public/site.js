/* Relay Cloud public pages: mobile menu and sticky call to action. */
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    var nav = document.querySelector("nav.nav");
    var toggle = nav && nav.querySelector(".nav-toggle");
    if (nav && toggle) {
      var setOpen = function (open) {
        nav.classList.toggle("open", open);
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      };
      toggle.addEventListener("click", function () {
        setOpen(!nav.classList.contains("open"));
      });
      nav.addEventListener("click", function (event) {
        if (event.target.closest && event.target.closest(".nav-links a")) setOpen(false);
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") setOpen(false);
      });
      document.addEventListener("click", function (event) {
        if (!nav.contains(event.target)) setOpen(false);
      });
      window.addEventListener("resize", function () {
        if (window.innerWidth > 720) setOpen(false);
      });
    }

    var cta = document.querySelector(".sticky-cta");
    if (cta) {
      document.body.classList.add("has-sticky");
      var hideOn = document.querySelectorAll("[data-hide-sticky]");
      var ticking = false;
      var update = function () {
        ticking = false;
        var past = window.scrollY > 360;
        var covered = false;
        for (var i = 0; i < hideOn.length; i += 1) {
          var r = hideOn[i].getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0) covered = true;
        }
        cta.classList.toggle("show", past && !covered);
      };
      window.addEventListener(
        "scroll",
        function () {
          if (!ticking) {
            ticking = true;
            window.requestAnimationFrame(update);
          }
        },
        { passive: true },
      );
      window.addEventListener("resize", update);
      update();
    }
  });
})();
