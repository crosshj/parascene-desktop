(function () {
  const detectOs = () => {
    try {
      const nav = navigator;
      const platform =
        (nav.userAgentData && nav.userAgentData.platform) || nav.platform || "";
      const ua = nav.userAgent || "";
      if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
    } catch {
      /* keep default */
    }
    return "mac";
  };

  const applyOs = (os) => {
    document.body.dataset.os = os;
    document.querySelectorAll("[data-os]").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-os") === os ? "true" : "false");
    });
  };

  const buttons = document.querySelectorAll("[data-os]");
  if (buttons.length) {
    let stored = "";
    try {
      stored = sessionStorage.getItem("help-os") || "";
    } catch {
      stored = "";
    }
    const initial = stored === "mac" || stored === "windows" ? stored : detectOs();
    applyOs(initial);
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const os = btn.getAttribute("data-os");
        if (os !== "mac" && os !== "windows") return;
        try {
          sessionStorage.setItem("help-os", os);
        } catch {
          /* ignore quota */
        }
        applyOs(os);
      });
    });
  }

  const bar = document.querySelector(".help-top");
  if (bar) {
    let lastY = window.scrollY;
    let away = false;

    const setAway = (next) => {
      if (next === away) return;
      away = next;
      bar.classList.toggle("is-away", away);
    };

    const onScroll = () => {
      const y = Math.max(0, window.scrollY);
      if (y < bar.offsetHeight) {
        setAway(false);
      } else if (y > lastY) {
        setAway(true);
      } else if (y < lastY) {
        setAway(false);
      }
      lastY = y;
    };

    window.addEventListener("scroll", onScroll, { passive: true });
  }

  document.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (!/^(https?:)?\/\//i.test(href)) return;
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  });

  const images = Array.from(document.querySelectorAll("main figure img"));
  if (!images.length) return;

  const root = document.createElement("div");
  root.className = "help-lightbox";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Image");
  root.innerHTML =
    '<button type="button" class="help-lightbox-close" aria-label="Close">Close</button>' +
    '<button type="button" class="help-lightbox-nav help-lightbox-prev" aria-label="Previous image">‹</button>' +
    '<figure class="help-lightbox-stage">' +
    '<img class="help-lightbox-img" alt="" />' +
    "<figcaption class=\"help-lightbox-caption\"></figcaption>" +
    "</figure>" +
    '<button type="button" class="help-lightbox-nav help-lightbox-next" aria-label="Next image">›</button>';
  document.body.appendChild(root);

  const imgEl = root.querySelector(".help-lightbox-img");
  const captionEl = root.querySelector(".help-lightbox-caption");
  const prevBtn = root.querySelector(".help-lightbox-prev");
  const nextBtn = root.querySelector(".help-lightbox-next");
  const closeBtn = root.querySelector(".help-lightbox-close");
  let index = 0;
  let lastFocus = null;

  const captionFor = (image) => {
    const figure = image.closest("figure");
    const caption = figure && figure.querySelector("figcaption");
    return (caption && caption.textContent.trim()) || image.getAttribute("alt") || "";
  };

  const show = (nextIndex) => {
    index = (nextIndex + images.length) % images.length;
    const image = images[index];
    imgEl.src = image.currentSrc || image.src;
    imgEl.alt = image.alt || "";
    captionEl.textContent = captionFor(image);
    const many = images.length > 1;
    prevBtn.hidden = !many;
    nextBtn.hidden = !many;
    root.hidden = false;
    root.classList.add("is-open");
    document.body.classList.add("help-lightbox-open");
    closeBtn.focus();
  };

  const openAt = (image) => {
    const next = images.indexOf(image);
    if (next < 0) return;
    lastFocus = document.activeElement;
    show(next);
  };

  const close = () => {
    if (root.hidden) return;
    root.hidden = true;
    root.classList.remove("is-open");
    document.body.classList.remove("help-lightbox-open");
    imgEl.removeAttribute("src");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    lastFocus = null;
  };

  images.forEach((image) => {
    image.classList.add("help-lightbox-src");
    image.addEventListener("click", () => openAt(image));
    image.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openAt(image);
      }
    });
    if (!image.hasAttribute("tabindex")) image.tabIndex = 0;
    if (!image.getAttribute("role")) image.setAttribute("role", "button");
  });

  closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    close();
  });
  prevBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    show(index - 1);
  });
  nextBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    show(index + 1);
  });
  root.addEventListener("click", (event) => {
    if (event.target === root) close();
  });

  document.addEventListener("keydown", (event) => {
    if (root.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      show(index + 1);
    }
  });

  let touchX = null;
  root.addEventListener(
    "touchstart",
    (event) => {
      touchX = event.changedTouches[0] ? event.changedTouches[0].clientX : null;
    },
    { passive: true },
  );
  root.addEventListener(
    "touchend",
    (event) => {
      if (touchX == null || !event.changedTouches[0]) return;
      const delta = event.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(delta) < 40) return;
      show(index + (delta < 0 ? 1 : -1));
    },
    { passive: true },
  );
})();
