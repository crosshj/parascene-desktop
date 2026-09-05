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

  const closeHelp = () => {
    if (typeof window.__parasceneCloseHelp === "function") {
      window.__parasceneCloseHelp();
      return;
    }
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke("close_help_window");
        return;
      }
    } catch {
      /* ignore */
    }
    try {
      window.close();
    } catch {
      /* ignore */
    }
  };

  let bar = document.querySelector(".help-top");
  if (!bar) {
    bar = document.createElement("header");
    bar.className = "help-top";
    document.body.insertBefore(bar, document.body.firstChild);
  }
  if (!bar.querySelector("[data-help-close]")) {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.dataset.helpClose = "1";
    closeBtn.className = "help-close";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closeHelp);
    bar.appendChild(closeBtn);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeHelp();
    }
  });

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
})();
