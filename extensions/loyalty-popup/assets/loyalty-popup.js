(() => {
  const root = document.querySelector("[data-loyalty-root]");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";

  const backdrop = root.querySelector("[data-loyalty-backdrop]");
  const openButton = root.querySelector("[data-loyalty-open]");
  const closeButton = root.querySelector("[data-loyalty-close]");
  const guest = root.querySelector("[data-loyalty-guest]");
  const member = root.querySelector("[data-loyalty-member]");
  const status = root.querySelector("[data-loyalty-status]");
  const proxyUrl = root.dataset.proxyUrl;
  const isAuthenticated = root.dataset.authenticated === "true";
  let config = null;

  const referralCookieName = "loyalty_referral";
  const normalizeReferral = (value) => value?.trim().toUpperCase() || "";
  const rememberReferral = (value) => {
    const code = normalizeReferral(value);
    if (!code) return;
    localStorage.setItem(referralCookieName, code);
    document.cookie = `${referralCookieName}=${encodeURIComponent(code)}; Max-Age=2592000; Path=/; SameSite=Lax; Secure`;
  };
  const referralFromCookie = () => {
    const prefix = `${referralCookieName}=`;
    const entry = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
  };
  const savedReferral = () =>
    normalizeReferral(
      localStorage.getItem(referralCookieName) || referralFromCookie(),
    );
  const forgetReferral = () => {
    localStorage.removeItem(referralCookieName);
    document.cookie = `${referralCookieName}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
  };

  const params = new URLSearchParams(window.location.search);
  const referralFromUrl = params.get("ref");
  if (referralFromUrl) {
    rememberReferral(referralFromUrl);
    const accountLink = root.querySelector("[data-loyalty-account]");
    if (accountLink) {
      const destination = new URL(accountLink.href, window.location.origin);
      destination.searchParams.set(
        "return_url",
        `${window.location.pathname}${window.location.search}`,
      );
      accountLink.href = destination.toString();
    }
  }

  const open = () => {
    backdrop.hidden = false;
    closeButton.focus();
  };
  const close = () => {
    backdrop.hidden = true;
    localStorage.setItem("loyalty_popup_closed_at", String(Date.now()));
    openButton.focus();
  };

  openButton.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !backdrop.hidden) close();
  });

  async function attachReferral() {
    const code = savedReferral();
    if (!isAuthenticated || !code) return;
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ referralCode: code }),
    });
    const result = await response.json().catch(() => ({
      error: "Réponse de parrainage invalide.",
    }));
    if (response.ok) {
      forgetReferral();
      status.textContent = result.created
        ? "Votre parrainage a bien été enregistré."
        : "Votre parrainage était déjà enregistré.";
    } else {
      status.textContent =
        result.error || "Le parrainage n'a pas pu être enregistré.";
    }
    open();
  }

  async function load() {
    try {
      const response = await fetch(proxyUrl, { headers: { Accept: "application/json" } });
      config = await response.json();
      if (!response.ok) throw new Error(config.error || "Service indisponible");
      if (!config.enabled) {
        root.hidden = true;
        return;
      }

      root.querySelector("[data-loyalty-title]").textContent = config.popupTitle;
      root.querySelector("[data-loyalty-text]").textContent = config.popupText;
      root.querySelector("[data-loyalty-account]").textContent = config.popupButtonLabel;

      guest.hidden = Boolean(config.authenticated);
      member.hidden = !config.authenticated;

      if (config.authenticated) {
        root.querySelector("[data-loyalty-spend]").textContent =
          `${config.customer.lifetimeSpend} ${config.customer.currencyCode}`;
        root.querySelector("[data-loyalty-next]").textContent =
          `${config.customer.toNextReward} ${config.customer.currencyCode}`;

        if (config.referralEnabled) {
          const referralPanel = root.querySelector("[data-loyalty-referral]");
          const referralInput = root.querySelector("[data-loyalty-referral-link]");
          referralInput.value = `${window.location.origin}/?ref=${encodeURIComponent(config.customer.referralCode)}`;
          referralPanel.hidden = false;
          root.querySelector("[data-loyalty-copy]").addEventListener("click", async () => {
            await navigator.clipboard.writeText(referralInput.value);
            status.textContent = "Lien copié.";
          });
        }
        await attachReferral();
      } else if (config.enabled && config.popupEnabled) {
        const closedAt = Number(localStorage.getItem("loyalty_popup_closed_at") || 0);
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        if (Date.now() - closedAt > sevenDays) {
          window.setTimeout(open, Math.max(0, config.popupDelaySeconds) * 1000);
        }
      }
    } catch (error) {
      status.textContent = "L'espace fidélité est momentanément indisponible.";
      console.error("[loyalty]", error);
    }
  }

  load();
})();
