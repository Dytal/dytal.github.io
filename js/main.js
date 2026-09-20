/* ============================================================
   NeuraX Launcher — dytal.github.io
   Vanilla JS, zero dependencies. Loaded with `defer`.
   ============================================================ */
(function () {
  "use strict";

  var d = document;

  /* ---------- 1. Sticky header state ---------- */
  var header = d.querySelector(".site-header");
  function onScrollHeader() {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 12);
  }
  window.addEventListener("scroll", onScrollHeader, { passive: true });
  onScrollHeader();

  /* ---------- 2. Mobile navigation ---------- */
  var toggle = d.getElementById("nav-toggle");
  var menu = d.getElementById("nav-menu");
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var open = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    // close the menu when a link inside it is clicked
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        menu.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
    d.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.classList.contains("open")) {
        menu.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    });
  }

  /* ---------- 3. Scroll-reveal animations ---------- */
  var revealEls = Array.prototype.slice.call(d.querySelectorAll(".reveal"));
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!("IntersectionObserver" in window) || reduceMotion) {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        // small stagger between siblings that enter together
        var delay = Math.min(120, (el.dataset.i || 0) * 60);
        el.style.transitionDelay = delay + "ms";
        el.classList.add("in");
        io.unobserve(el);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    revealEls.forEach(function (el, i) { el.dataset.i = i % 4; io.observe(el); });
  }

  /* ---------- 4. Active nav link while scrolling ---------- */
  var navLinks = Array.prototype.slice.call(d.querySelectorAll(".nav-link[href^='#']"));
  var sections = navLinks
    .map(function (a) { return d.querySelector(a.getAttribute("href")); })
    .filter(Boolean);
  if ("IntersectionObserver" in window && sections.length) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var id = "#" + entry.target.id;
        navLinks.forEach(function (a) {
          a.classList.toggle("active", a.getAttribute("href") === id);
        });
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    sections.forEach(function (s) { spy.observe(s); });
  }

  /* ---------- 5. Screenshot lightbox ---------- */
  var shots = Array.prototype.slice.call(d.querySelectorAll(".shot"));
  var lb = d.getElementById("lightbox");
  var lbImg = d.getElementById("lb-img");
  var lbCap = d.getElementById("lb-cap");
  var lbClose = d.getElementById("lb-close");
  var lbPrev = d.getElementById("lb-prev");
  var lbNext = d.getElementById("lb-next");
  var current = -1;
  var lastFocus = null;

  function openLightbox(index) {
    if (!lb || !shots.length) return;
    current = (index + shots.length) % shots.length;
    var img = shots[current].querySelector("img");
    var cap = shots[current].querySelector("figcaption");
    if (!img) return;
    lbImg.src = img.src;
    lbImg.alt = img.alt;
    lbCap.textContent = cap ? cap.textContent : "";
    lastFocus = d.activeElement;
    lb.hidden = false;
    d.body.style.overflow = "hidden";
    lbClose && lbClose.focus();
  }
  function closeLightbox() {
    if (!lb) return;
    lb.hidden = true;
    lbImg.src = "";
    d.body.style.overflow = "";
    if (lastFocus) lastFocus.focus();
  }
  function step(dir) { openLightbox(current + dir); }

  shots.forEach(function (shot, i) {
    shot.addEventListener("click", function () { openLightbox(i); });
    shot.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openLightbox(i);
      }
    });
  });
  if (lb) {
    lb.addEventListener("click", function (e) {
      if (e.target === lb) closeLightbox(); // backdrop click
    });
  }
  lbClose && lbClose.addEventListener("click", closeLightbox);
  lbPrev && lbPrev.addEventListener("click", function () { step(-1); });
  lbNext && lbNext.addEventListener("click", function () { step(1); });
  d.addEventListener("keydown", function (e) {
    if (lb && !lb.hidden) {
      if (e.key === "Escape") closeLightbox();
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    }
  });

  /* ---------- 6. FAQ: close other items when one opens ---------- */
  var faqs = Array.prototype.slice.call(d.querySelectorAll(".faq"));
  faqs.forEach(function (item) {
    item.addEventListener("toggle", function () {
      if (!item.open) return;
      faqs.forEach(function (other) {
        if (other !== item) other.open = false;
      });
    });
  });

  /* ---------- 7. Back-to-top button ---------- */
  var toTop = d.getElementById("to-top");
  if (toTop) {
    toTop.hidden = false;
    toTop.style.opacity = "0";
    toTop.style.pointerEvents = "none";
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        var show = window.scrollY > 640;
        toTop.style.opacity = show ? "1" : "0";
        toTop.style.pointerEvents = show ? "auto" : "none";
        ticking = false;
      });
    }, { passive: true });
    toTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    });
  }

  /* ---------- 8. Footer year ---------- */
  var year = d.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
