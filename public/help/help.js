(function () {
  const bar = document.querySelector(".help-top");
  if (!bar) return;

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
