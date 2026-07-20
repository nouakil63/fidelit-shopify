(() => {
  const root = document.querySelector("[data-loyalty-root]");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";

  const backdrop = root.querySelector("[data-loyalty-backdrop]");
  const openButton = root.querySelector("[data-loyalty-open]");
  const closeButton = root.querySelector("[data-loyalty-close]");
  const guest = root.querySelector("[data-loyalty-guest]");
  const member = root.querySelector("[data-loyalty-member]");
  const invite = root.querySelector("[data-loyalty-invite]");
  const inviteText = root.querySelector("[data-loyalty-invite-text]");
  const inviteAccount = root.querySelector("[data-loyalty-invite-account]");
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
  const rewardSignal = params.get("loyalty_reward");
  const rewardWasApplied =
    ["applied", "ready", "1"].includes(rewardSignal) ||
    window.location.hash === "#loyalty-reward-applied" ||
    sessionStorage.getItem("loyalty_reward_pending") === "applied";
  if (referralFromUrl) {
    rememberReferral(referralFromUrl);
    root
      .querySelectorAll("[data-loyalty-account], [data-loyalty-invite-account]")
      .forEach((accountLink) => {
      const destination = new URL(accountLink.href, window.location.origin);
      destination.searchParams.set(
        "return_url",
        `${window.location.pathname}${window.location.search}`,
      );
      accountLink.href = destination.toString();
      });
  }

  const clearParameterFromAddress = (name) => {
    const url = new URL(window.location.href);
    url.searchParams.delete(name);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const clearReferralFromAddress = () => clearParameterFromAddress("ref");

  const copyText = async (value, successMessage) => {
    try {
      await navigator.clipboard.writeText(value);
      status.textContent = successMessage;
    } catch {
      status.textContent = "La copie automatique a échoué. Sélectionnez le code manuellement.";
    }
  };

  const rewardLabel = (reward) =>
    reward.type === "PERCENTAGE"
      ? `${reward.value} % de remise`
      : `${Number(reward.value).toFixed(2)} ${reward.currencyCode} de remise`;

  const renderRewards = (rewards = []) => {
    const panel = root.querySelector("[data-loyalty-rewards]");
    const list = root.querySelector("[data-loyalty-reward-list]");
    list.replaceChildren();
    panel.hidden = rewards.length === 0;
    if (!rewards.length) return;

    rewards.forEach((reward) => {
      const card = document.createElement("div");
      card.className = "loyalty-reward-card";

      const label = document.createElement("strong");
      label.textContent = rewardLabel(reward);

      const codeRow = document.createElement("div");
      codeRow.className = "loyalty-reward-code-row";
      const code = document.createElement("span");
      code.className = "loyalty-reward-code";
      code.textContent = reward.code;
      const copy = document.createElement("button");
      copy.className = "loyalty-reward-copy";
      copy.type = "button";
      copy.textContent = "Copier";
      copy.addEventListener("click", () =>
        copyText(reward.code, "Code de réduction copié."),
      );
      codeRow.append(code, copy);

      const apply = document.createElement("a");
      apply.className = "loyalty-reward-apply";
      apply.textContent = "Activer ma remise";
      apply.href = `/discount/${encodeURIComponent(reward.code)}?redirect=${encodeURIComponent("/?loyalty_reward=applied")}`;
      apply.addEventListener("click", () => {
        sessionStorage.setItem("loyalty_reward_pending", "applied");
      });

      const expiry = document.createElement("span");
      expiry.className = "loyalty-reward-expiry";
      expiry.textContent = reward.expiresAt
        ? `Valable jusqu’au ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(reward.expiresAt))}.`
        : "";

      card.append(label, codeRow, apply, expiry);
      list.append(card);
    });
  };

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
    if (!isAuthenticated || !code) return null;
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
      return {
        ok: true,
        rewardReady: Boolean(result.rewardReady),
        message: result.created
          ? result.rewardReady
            ? "Votre invitation et votre récompense ont bien été enregistrées."
            : "Votre invitation est enregistrée. La création de votre code est en cours."
          : "Cette invitation était déjà enregistrée sur votre compte.",
      };
    }
    forgetReferral();
    return {
      ok: false,
      message: result.error || "Le parrainage n'a pas pu être enregistré.",
    };
  }

  const referralOfferLabel = () =>
    config.referralFriendRewardType === "PERCENTAGE"
      ? `${config.referralFriendRewardValue} %`
      : `${Number(config.referralFriendRewardValue).toFixed(2)} €`;

  const showInvite = ({
    title,
    description,
    detail,
    showAccount = false,
    delay = 0,
  }) => {
    root.querySelector("[data-loyalty-title]").textContent = title;
    root.querySelector("[data-loyalty-text]").textContent = description;
    guest.hidden = true;
    member.hidden = true;
    invite.hidden = false;
    inviteText.textContent = detail;
    inviteAccount.hidden = !showAccount;
    status.textContent = "";
    if (delay > 0) window.setTimeout(open, delay);
    else open();
  };

  const renderMember = (customer, { title, description } = {}) => {
    root.querySelector("[data-loyalty-title]").textContent =
      title || config.popupTitle;
    root.querySelector("[data-loyalty-text]").textContent =
      description || config.popupText;
    guest.hidden = true;
    invite.hidden = true;
    member.hidden = false;

    root.querySelector("[data-loyalty-spend]").textContent =
      `${customer.orderThreshold} ${customer.currencyCode}`;
    renderRewards(customer.rewards);

    const referralPanel = root.querySelector("[data-loyalty-referral]");
    referralPanel.hidden = !config.referralEnabled;
    if (!config.referralEnabled) return;

    const referralInput = root.querySelector("[data-loyalty-referral-link]");
    referralInput.value = `${window.location.origin}/?ref=${encodeURIComponent(customer.referralCode)}`;
    root.querySelector("[data-loyalty-copy]").onclick = () =>
      copyText(referralInput.value, "Lien de parrainage copié.");
    const shareMessage = `Je vous invite à découvrir Katmikko. Utilisez mon lien de parrainage : ${referralInput.value}`;
    root.querySelector("[data-loyalty-whatsapp]").href =
      `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;
    root.querySelector("[data-loyalty-email]").href =
      `mailto:?subject=${encodeURIComponent("Votre invitation Katmikko")}&body=${encodeURIComponent(shareMessage)}`;
  };

  async function load() {
    try {
      const response = await fetch(proxyUrl, { headers: { Accept: "application/json" } });
      config = await response.json();
      if (!response.ok) throw new Error(config.error || "Service indisponible");
      if (!config.enabled) {
        root.hidden = true;
        return;
      }

      // Liquid keeps the widget hidden until the signed app proxy confirms
      // that the loyalty program is active. This prevents the launcher from
      // flashing briefly and disappearing on inactive shops.
      root.hidden = false;

      root.querySelector("[data-loyalty-title]").textContent = config.popupTitle;
      root.querySelector("[data-loyalty-text]").textContent = config.popupText;
      root.querySelector("[data-loyalty-account]").textContent = config.popupButtonLabel;

      guest.hidden = Boolean(config.authenticated);
      member.hidden = !config.authenticated;
      invite.hidden = true;

      if (rewardWasApplied) {
        const popupDelay = 1800;
        if (config.authenticated) {
          renderMember(config.customer, {
            title: "Votre remise est activée",
            description:
              "Elle est maintenant associée à votre panier et sera calculée automatiquement lors du paiement.",
          });
          status.textContent =
            "Vous pouvez poursuivre vos achats ou consulter votre panier.";
          window.setTimeout(() => {
            open();
            sessionStorage.removeItem("loyalty_reward_pending");
            clearParameterFromAddress("loyalty_reward");
          }, popupDelay);
        } else {
          const destination = new URL(
            inviteAccount.href,
            window.location.origin,
          );
          destination.searchParams.set(
            "return_url",
            `${window.location.pathname}${window.location.search}`,
          );
          inviteAccount.href = destination.toString();
          inviteAccount.textContent = "Me connecter à mon compte";
          showInvite({
            title: "Votre remise est prête",
            description:
              "Votre code a été ajouté à cette session sur la boutique Katmikko.",
            detail:
              "Connectez-vous avec le compte qui a reçu la récompense pour l’utiliser lors du paiement.",
            showAccount: true,
            delay: popupDelay,
          });
          window.setTimeout(() => {
            sessionStorage.removeItem("loyalty_reward_pending");
            clearParameterFromAddress("loyalty_reward");
          }, popupDelay + 100);
        }
        return;
      }

      const requestedReferral =
        normalizeReferral(referralFromUrl) || savedReferral();
      if (requestedReferral && config.referralEnabled) {
        if (!config.authenticated) {
          showInvite({
            title: "Vous avez été invité(e)",
            description: "Un proche vous invite à rejoindre le programme fidélité Katmikko.",
            detail: `Créez votre compte avant votre première commande. Votre code de ${referralOfferLabel()} sera généré immédiatement après votre inscription.`,
            showAccount: true,
          });
          return;
        }

        if (
          requestedReferral === normalizeReferral(config.customer.referralCode)
        ) {
          forgetReferral();
          clearReferralFromAddress();
          showInvite({
            title: "C’est votre propre lien",
            description: "Vous êtes encore connecté(e) avec le compte du parrain.",
            detail: "Pour tester le parcours du filleul, ouvrez ce lien dans une fenêtre de navigation privée ou déconnectez-vous d’abord.",
          });
          return;
        }

        const referralResult = await attachReferral();
        clearReferralFromAddress();
        if (referralResult?.ok) {
          const refreshedResponse = await fetch(proxyUrl, {
            headers: { Accept: "application/json" },
          });
          const refreshed = await refreshedResponse.json();
          if (refreshedResponse.ok && refreshed.authenticated) {
            config = refreshed;
            const referredReward = refreshed.customer.rewards.find(
              (reward) => reward.kind === "REFERRED",
            );
            renderMember(refreshed.customer, {
              title: referredReward
                ? "Votre récompense est prête"
                : "Invitation enregistrée",
              description: referredReward
                ? `Bienvenue chez Katmikko. Vos ${rewardLabel(referredReward)} sont disponibles.`
                : "Bienvenue chez Katmikko. Votre code est en cours de préparation.",
            });
            status.textContent = referredReward
              ? "Utilisez « Activer ma remise » pour l’ajouter automatiquement à votre session."
              : referralResult.message;
            open();
            return;
          }
        }
        showInvite({
          title: referralResult?.ok
            ? "Invitation enregistrée"
            : "Invitation non enregistrée",
          description: referralResult?.ok
            ? "Bienvenue dans le programme fidélité Katmikko."
            : "Ce lien ne peut pas être associé à ce compte.",
          detail:
            referralResult?.message ||
            "Le parrainage n'a pas pu être enregistré.",
        });
        return;
      }

      if (config.authenticated) {
        renderMember(config.customer);
      } else if (config.enabled && config.popupEnabled) {
        const closedAt = Number(localStorage.getItem("loyalty_popup_closed_at") || 0);
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        if (Date.now() - closedAt > sevenDays) {
          window.setTimeout(open, Math.max(0, config.popupDelaySeconds) * 1000);
        }
      }
    } catch (error) {
      if (rewardWasApplied) {
        root.hidden = false;
        showInvite({
          title: isAuthenticated
            ? "Votre remise est activée"
            : "Votre remise est prête",
          description:
            "Votre code a bien été ajouté à votre session Katmikko.",
          detail: isAuthenticated
            ? "Vous pouvez poursuivre vos achats. La remise apparaîtra automatiquement lors du paiement."
            : "Connectez-vous avec le compte qui a reçu la récompense pour l’utiliser.",
          showAccount: !isAuthenticated,
          delay: 1800,
        });
        window.setTimeout(() => {
          sessionStorage.removeItem("loyalty_reward_pending");
          clearParameterFromAddress("loyalty_reward");
        }, 1900);
      }
      if (!rewardWasApplied) {
        status.textContent = "L'espace fidélité est momentanément indisponible.";
      }
      console.error("[loyalty]", error);
    }
  }

  load();
})();
