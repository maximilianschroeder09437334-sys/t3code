export function notificationAppLinks(path) {
  if (path === "/") return { native: "t3code-maxi://", web: "/" };
  if (
    typeof path !== "string" ||
    path.length > 4096 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[?#\\]/.test(path)
  )
    return null;
  const segments = path.slice(1).split("/");
  if (segments.length !== 2 || segments.some((segment) => !segment)) return null;
  let ids;
  try {
    ids = segments.map(decodeURIComponent);
  } catch {
    return null;
  }
  if (ids.some((id) => id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id))) return null;
  const encoded = ids.map(encodeURIComponent);
  return { native: `t3code-maxi://threads/${encoded.join("/")}`, web: `/${encoded.join("/")}` };
}

function openNotification() {
  const links = notificationAppLinks(new URLSearchParams(location.hash.slice(1)).get("path"));
  const open = document.getElementById("open-app");
  const browser = document.getElementById("open-browser");
  if (links) {
    open.hidden = false;
    open.href = links.native;
    browser.href = links.web;
    document.getElementById("status").textContent =
      "Your chat is ready in the app. If iOS asks, choose Open. If nothing happens, tap below.";
    // iOS may require its own confirmation or a fresh tap. Keep both actions
    // visible and never loop, launch commands, or silently change the target.
    try {
      location.replace(links.native);
    } catch {
      /* The Open button remains available. */
    }
  } else {
    open.hidden = true;
    open.removeAttribute("href");
    browser.href = "/";
    document.getElementById("status").textContent =
      "This notification link could not be opened. Return to T3 Code to choose the chat.";
  }
}

if (typeof document !== "undefined") {
  openNotification();
  // A second notification can navigate an existing companion window by hash.
  window.addEventListener("hashchange", openNotification);
}
