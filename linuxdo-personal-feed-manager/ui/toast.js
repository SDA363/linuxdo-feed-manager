(() => {
  let container;

  function ensureContainer() {
    if (container) return container;

    container = document.createElement("div");
    container.id = "ldfc-toast-container";
    document.body.appendChild(container);
    return container;
  }

  function show(message, actionLabel, actionCallback, duration = 4000) {
    const toast = document.createElement("div");
    toast.className = "ldfc-toast";
    toast.textContent = message;

    if (actionLabel && actionCallback) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = actionLabel;
      button.addEventListener("click", () => {
        actionCallback();
        toast.remove();
      });
      toast.appendChild(button);
    }

    ensureContainer().appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  window.LDFCToast = { show };
})();
