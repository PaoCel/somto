export function showErrorBanner(container, message, onRetry) {
  let banner = container.querySelector(".error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "error-banner";
    banner.setAttribute("role", "alert");
    container.prepend(banner);
  }
  banner.innerHTML = `
    <p class="error-banner__msg">${message}</p>
    ${onRetry ? '<button class="btn btn--small error-banner__retry">Riprova</button>' : ""}`;
  if (onRetry) banner.querySelector(".error-banner__retry").addEventListener("click", onRetry);
  banner.hidden = false;
}

export function hideErrorBanner(container) {
  const banner = container.querySelector(".error-banner");
  if (banner) banner.hidden = true;
}
