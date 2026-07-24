export function isWindowsDesktop(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Windows/i.test(navigator.userAgent || "")
  );
}
