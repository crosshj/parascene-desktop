/** Kept so Vite HMR can resolve stale imports after the grid-replica switch. */
export function fitTextareaHeight(el: HTMLTextAreaElement): void {
  const prevMinHeight = el.style.minHeight;
  const prevOverflowY = el.style.overflowY;
  const computed = getComputedStyle(el);
  const borderY =
    parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);

  el.style.minHeight = "0px";
  el.style.overflowY = "hidden";
  el.style.height = "0px";

  let next = el.scrollHeight;
  if (computed.boxSizing === "border-box") next += borderY;
  el.style.height = `${next}px`;
  el.style.minHeight = prevMinHeight;
  el.style.overflowY = prevOverflowY;
}
