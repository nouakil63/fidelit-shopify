import { RewardStatus, RewardType } from "@prisma/client";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { syncAutomaticOrderDiscount } from "../services/automatic-discount.server";
import {
  getOrCreateSettings,
  retryRewardIssuance,
  retryRewardEmail,
  startProgramFromZero,
  syncRecentOrders,
} from "../services/loyalty.server";
import { syncAllCustomers } from "../services/sync.server";
import "../styles/loyalty-admin.css";

function numberValue(form: FormData, key: string, minimum: number) {
  const value = Number(form.get(key));
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`Valeur invalide pour ${key}.`);
  }
  return value;
}

function emailDeliveryConfigured() {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  const from = process.env.REWARD_EMAIL_FROM?.trim() ?? "";
  return (
    /^re_[A-Za-z0-9_-]+$/.test(apiKey) &&
    !/x{4,}/i.test(apiKey) &&
    /<[^<>\s]+@[^<>\s]+>|^[^\s@]+@[^\s@]+$/.test(from) &&
    !/@example\.com>?$/i.test(from)
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getOrCreateSettings(session.shop);
  const [
    customers,
    rewards,
    emailedRewards,
    qualifiedReferrals,
    recentRewards,
  ] = await Promise.all([
    prisma.loyaltyCustomer.count({ where: { shop: session.shop } }),
    prisma.reward.count({ where: { shop: session.shop } }),
    prisma.reward.count({
      where: { shop: session.shop, status: RewardStatus.EMAILED },
    }),
    prisma.referral.count({
      where: { shop: session.shop, status: "QUALIFIED" },
    }),
    prisma.reward.findMany({
      where: { shop: session.shop },
      include: { customer: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";

  return {
    shop: session.shop,
    settings: {
      ...settings,
      threshold: settings.threshold.toString(),
      rewardValue: settings.rewardValue.toString(),
      referralAdvocateRewardValue:
        settings.referralAdvocateRewardValue.toString(),
      referralFriendRewardValue: settings.referralFriendRewardValue.toString(),
      programStartedAt: settings.programStartedAt?.toISOString() ?? null,
      createdAt: settings.createdAt.toISOString(),
      updatedAt: settings.updatedAt.toISOString(),
    },
    stats: { customers, rewards, emailedRewards, qualifiedReferrals },
    emailConfigured: emailDeliveryConfigured(),
    recentRewards: recentRewards.map((reward) => ({
      id: reward.id,
      customer: reward.customer.email ?? reward.customer.shopifyCustomerId,
      code: reward.discountCode,
      status: reward.status,
      failureReason: reward.failureReason,
      createdAt: reward.createdAt.toISOString(),
    })),
    themeEditorUrl: `https://${session.shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/loyalty-popup`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "sync") {
    const result = await syncAllCustomers(admin, session.shop);
    return {
      ok: true,
      message: `${result.synced} client(s) synchronisé(s)${result.truncated ? ". Relancez la synchronisation pour la suite." : "."}`,
    };
  }

  if (intent === "sync_orders") {
    const result = await syncRecentOrders(admin, session.shop);
    return {
      ok: true,
      message: `${result.synced} commande(s) synchronisée(s) sur ${result.found}${result.ignored ? ` (${result.ignored} commande(s) invité ignorée(s))` : ""}.`,
    };
  }

  if (intent === "start_program") {
    try {
      const result = await startProgramFromZero(session.shop);
      return {
        ok: true,
        message: `Compteurs démarrés à zéro pour ${result.resetCustomers} client(s). Seuls les nouveaux achats seront comptés.`,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (intent === "evaluate") {
    const settings = await getOrCreateSettings(session.shop);
    if (!settings.enabled) {
      return {
        ok: false,
        message:
          "Activez d'abord le programme avant d'émettre les récompenses.",
      };
    }

    await syncAutomaticOrderDiscount(admin, session.shop, settings);
    return {
      ok: true,
      message: "La remise automatique Shopify est synchronisée.",
    };
  }

  if (intent === "retry_emails") {
    const pendingRewards = await prisma.reward.findMany({
      where: {
        shop: session.shop,
        status: RewardStatus.ISSUED,
        emailedAt: null,
        discountCode: { not: null },
      },
      orderBy: { createdAt: "asc" },
      take: 25,
    });

    let sent = 0;
    for (const reward of pendingRewards) {
      const result = await retryRewardEmail(session.shop, reward.id);
      if (result.sent) sent += 1;
    }

    if (pendingRewards.length === 0) {
      return { ok: true, message: "Aucun e-mail en attente." };
    }

    return {
      ok: sent === pendingRewards.length,
      message: `${sent} e-mail(s) envoyé(s) sur ${pendingRewards.length}.`,
    };
  }

  if (intent === "retry_rewards") {
    const staleBefore = new Date(Date.now() - 15 * 60 * 1000);
    const failedRewards = await prisma.reward.findMany({
      where: {
        shop: session.shop,
        OR: [
          { status: RewardStatus.FAILED },
          { status: RewardStatus.PENDING },
          { status: RewardStatus.PROCESSING, updatedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 25,
    });

    let retried = 0;
    for (const reward of failedRewards) {
      const result = await retryRewardIssuance(admin, session.shop, reward.id);
      if (result.retried) retried += 1;
    }

    return {
      ok: retried === failedRewards.length,
      message:
        failedRewards.length === 0
          ? "Aucune récompense à relancer."
          : `${retried} récompense(s) relancée(s) sur ${failedRewards.length}.`,
    };
  }

  if (intent !== "save") {
    return { ok: false, message: "Action inconnue." };
  }

  try {
    const currentSettings = await getOrCreateSettings(session.shop);
    if (form.has("enabled") && !currentSettings.programStartedAt) {
      throw new Error("Cliquez d'abord sur « Démarrer les compteurs à zéro ».");
    }
    const rewardType = String(form.get("rewardType"));
    const referralAdvocateRewardType = String(
      form.get("referralAdvocateRewardType"),
    );
    const referralFriendRewardType = String(
      form.get("referralFriendRewardType"),
    );
    if (!Object.values(RewardType).includes(rewardType as RewardType)) {
      throw new Error("Type de récompense invalide.");
    }
    if (
      !Object.values(RewardType).includes(
        referralAdvocateRewardType as RewardType,
      ) ||
      !Object.values(RewardType).includes(
        referralFriendRewardType as RewardType,
      )
    ) {
      throw new Error("Type de récompense de parrainage invalide.");
    }

    const rewardValue = numberValue(form, "rewardValue", 0.01);
    const referralAdvocateRewardValue = numberValue(
      form,
      "referralAdvocateRewardValue",
      0.01,
    );
    const referralFriendRewardValue = numberValue(
      form,
      "referralFriendRewardValue",
      0.01,
    );
    if (rewardType === RewardType.PERCENTAGE && rewardValue > 100) {
      throw new Error("Une remise en pourcentage ne peut pas dépasser 100 %.");
    }
    if (
      (referralAdvocateRewardType === RewardType.PERCENTAGE &&
        referralAdvocateRewardValue > 100) ||
      (referralFriendRewardType === RewardType.PERCENTAGE &&
        referralFriendRewardValue > 100)
    ) {
      throw new Error(
        "Une remise de parrainage en pourcentage ne peut pas dépasser 100 %.",
      );
    }

    const savedSettings = await prisma.programSettings.update({
      where: { shop: session.shop },
      data: {
        enabled: form.has("enabled"),
        threshold: numberValue(form, "threshold", 0.01),
        rewardType: rewardType as RewardType,
        rewardValue,
        repeatRewards: true,
        validityDays: Math.round(numberValue(form, "validityDays", 1)),
        combineOrderDiscounts: false,
        combineProductDiscounts: false,
        combineShippingDiscounts: false,
        popupEnabled: form.has("popupEnabled"),
        popupTitle: String(form.get("popupTitle") ?? "").trim(),
        popupText: String(form.get("popupText") ?? "").trim(),
        popupButtonLabel: String(form.get("popupButtonLabel") ?? "").trim(),
        popupDelaySeconds: Math.round(
          numberValue(form, "popupDelaySeconds", 0),
        ),
        referralEnabled: form.has("referralEnabled"),
        referralAdvocateRewardType:
          referralAdvocateRewardType as RewardType,
        referralAdvocateRewardValue,
        referralFriendRewardType: referralFriendRewardType as RewardType,
        referralFriendRewardValue,
      },
    });
    await syncAutomaticOrderDiscount(admin, session.shop, savedSettings);
    return {
      ok: true,
      message: "Paramètres enregistrés et remise automatique synchronisée.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="loyalty-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Checkbox({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="loyalty-toggle-row">
      <input
        className="loyalty-toggle-input"
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
      />
      <span className="loyalty-toggle" aria-hidden="true" />
      <span className="loyalty-toggle-label">{label}</span>
    </label>
  );
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const settings = data.settings;
  const busy = navigation.state !== "idle";
  const [popupPreview, setPopupPreview] = useState({
    title: settings.popupTitle,
    text: settings.popupText,
    buttonLabel: settings.popupButtonLabel,
  });

  return (
    <s-page heading="Programme de fidélité">
      <div className="loyalty-admin">
        <section className="loyalty-hero">
          <div>
            <span className="loyalty-eyebrow">KATMIKKO · FIDÉLITÉ</span>
            <h2>Transformez chaque achat en nouvelle visite.</h2>
            <p>
              Pilotez les récompenses, le parrainage et l’expérience client
              depuis un seul espace.
            </p>
          </div>
          <span
            className={`loyalty-program-pill ${settings.enabled ? "is-active" : "is-inactive"}`}
          >
            <span aria-hidden="true" />
            {settings.enabled ? "Programme actif" : "Programme en préparation"}
          </span>
        </section>

        {actionData?.message ? (
          <div
            role="status"
            className={`loyalty-notice ${actionData.ok ? "is-success" : "is-error"}`}
          >
            {actionData.message}
          </div>
        ) : null}

        {!data.emailConfigured ? (
          <div role="status" className="loyalty-notice is-warning">
            Les codes sont disponibles dans l’espace Fidélité du client, mais
            l’envoi automatique par e-mail reste désactivé tant que Resend et
            l’adresse d’expédition ne sont pas configurés.
          </div>
        ) : null}

        <s-section heading="Vue d'ensemble">
          <div className="loyalty-metrics">
            {[
              ["Clients", data.stats.customers],
              ["Récompenses", data.stats.rewards],
              ["E-mails envoyés", data.stats.emailedRewards],
              ["Parrainages validés", data.stats.qualifiedReferrals],
            ].map(([label, value]) => (
              <div key={String(label)} className="loyalty-metric-card">
                <div className="loyalty-metric-label">{label}</div>
                <div className="loyalty-metric-value">{value}</div>
              </div>
            ))}
          </div>
          <div className="loyalty-actions">
            <Form method="post">
              <input type="hidden" name="intent" value="sync" />
              <button
                className="loyalty-button is-secondary"
                type="submit"
                disabled={busy}
              >
                Synchroniser les clients Shopify
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="sync_orders" />
              <button
                className="loyalty-button is-secondary"
                type="submit"
                disabled={busy}
              >
                Synchroniser les commandes récentes
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="evaluate" />
              <button
                className="loyalty-button is-accent"
                type="submit"
                disabled={busy}
              >
                Synchroniser la remise automatique
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="retry_emails" />
              <button
                className="loyalty-button is-primary"
                type="submit"
                disabled={busy}
              >
                Envoyer les e-mails en attente
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="retry_rewards" />
              <button
                className="loyalty-button is-danger"
                type="submit"
                disabled={busy}
              >
                Relancer les récompenses en échec
              </button>
            </Form>
            <a
              href={data.themeEditorUrl}
              target="_top"
              className="loyalty-button is-secondary"
            >
              Activer le pop-up dans le thème
            </a>
          </div>

          <div className="loyalty-start-card">
            <div>
              <strong>Date d’activation du programme</strong>
              <p>
                {settings.programStartedAt
                  ? `Programme démarré le ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date(settings.programStartedAt))}.`
                  : "Choisissez la date à partir de laquelle la remise automatique sera active."}
              </p>
            </div>
            {!settings.programStartedAt ? (
              <Form method="post">
                <input type="hidden" name="intent" value="start_program" />
                <button
                  className="loyalty-start-button"
                  type="submit"
                  disabled={busy}
                >
                  Activer à partir de maintenant
                </button>
              </Form>
            ) : (
              <span className="loyalty-ready-badge">Prêt</span>
            )}
          </div>
        </s-section>

        <Form method="post">
          <input type="hidden" name="intent" value="save" />

          <s-section heading="Palier et récompense">
            <div className="loyalty-section-stack">
              <Checkbox
                name="enabled"
                label="Remise automatique active dans le panier et au paiement"
                defaultChecked={settings.enabled}
              />
              <input type="hidden" name="validityDays" value={settings.validityDays} />
              <div className="loyalty-field-grid is-three-columns">
                <Field label="Montant minimum d'une commande">
                  <input
                    name="threshold"
                    type="number"
                    step="0.01"
                    min="0.01"
                    defaultValue={settings.threshold}
                  />
                </Field>
                <Field label="Type de remise">
                  <select name="rewardType" defaultValue={settings.rewardType}>
                    <option value="FIXED">Montant fixe</option>
                    <option value="PERCENTAGE">Pourcentage</option>
                  </select>
                </Field>
                <Field label="Valeur de la remise">
                  <input
                    name="rewardValue"
                    type="number"
                    step="0.01"
                    min="0.01"
                    defaultValue={settings.rewardValue}
                  />
                </Field>
              </div>
              <p className="loyalty-rule-summary">
                Règle actuelle : dès que le panier atteint {settings.threshold} €, une remise de {settings.rewardValue}
                {settings.rewardType === "PERCENTAGE" ? " %" : " €"}
                est appliquée immédiatement et automatiquement. Elle ne se cumule avec aucune autre promotion.
              </p>
            </div>
          </s-section>

          <s-section heading="Pop-up boutique">
            <div className="loyalty-section-stack">
              <Checkbox
                name="popupEnabled"
                label="Afficher le pop-up"
                defaultChecked={settings.popupEnabled}
              />
              <Field label="Titre">
                <input
                  name="popupTitle"
                  value={popupPreview.title}
                  onChange={(event) =>
                    setPopupPreview((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  required
                />
              </Field>
              <Field label="Texte">
                <textarea
                  className="loyalty-textarea"
                  name="popupText"
                  value={popupPreview.text}
                  onChange={(event) =>
                    setPopupPreview((current) => ({
                      ...current,
                      text: event.target.value,
                    }))
                  }
                  required
                />
              </Field>
              <div className="loyalty-field-grid is-popup-grid">
                <Field label="Libellé du bouton">
                  <input
                    name="popupButtonLabel"
                    value={popupPreview.buttonLabel}
                    onChange={(event) =>
                      setPopupPreview((current) => ({
                        ...current,
                        buttonLabel: event.target.value,
                      }))
                    }
                    required
                  />
                </Field>
                <Field label="Délai (secondes)">
                  <input
                    name="popupDelaySeconds"
                    type="number"
                    min="0"
                    defaultValue={settings.popupDelaySeconds}
                  />
                </Field>
              </div>
              <div
                className="loyalty-popup-preview"
                aria-label="Aperçu du pop-up"
              >
                <div className="loyalty-preview-header">
                  <span>Aperçu boutique</span>
                  <span className="loyalty-preview-dot" />
                </div>
                <div className="loyalty-preview-window">
                  <span className="loyalty-preview-kicker">
                    Programme fidélité
                  </span>
                  <strong>{popupPreview.title || "Titre du pop-up"}</strong>
                  <p>{popupPreview.text || "Texte du pop-up"}</p>
                  <span className="loyalty-preview-button">
                    {popupPreview.buttonLabel || "Libellé du bouton"}
                  </span>
                </div>
              </div>
            </div>
          </s-section>

          <s-section heading="Parrainage">
            <div className="loyalty-section-stack">
              <Checkbox
                name="referralEnabled"
                label="Activer le parrainage"
                defaultChecked={settings.referralEnabled}
              />
              <div className="loyalty-field-grid is-two-columns">
                <Field label="Type de récompense du parrain">
                  <select
                    name="referralAdvocateRewardType"
                    defaultValue={settings.referralAdvocateRewardType}
                  >
                    <option value="FIXED">Montant fixe</option>
                    <option value="PERCENTAGE">Pourcentage</option>
                  </select>
                </Field>
                <Field label="Récompense du parrain">
                  <input
                    name="referralAdvocateRewardValue"
                    type="number"
                    step="0.01"
                    min="0.01"
                    defaultValue={settings.referralAdvocateRewardValue}
                  />
                </Field>
                <Field label="Type de récompense du filleul">
                  <select
                    name="referralFriendRewardType"
                    defaultValue={settings.referralFriendRewardType}
                  >
                    <option value="FIXED">Montant fixe</option>
                    <option value="PERCENTAGE">Pourcentage</option>
                  </select>
                </Field>
                <Field label="Récompense du filleul">
                  <input
                    name="referralFriendRewardValue"
                    type="number"
                    step="0.01"
                    min="0.01"
                    defaultValue={settings.referralFriendRewardValue}
                  />
                </Field>
              </div>
              <p className="loyalty-help-text">
                Dès que le filleul crée son compte depuis le lien, son code de
                réduction et celui du parrain sont générés. Chaque personne
                reçoit son code par e-mail lorsque l’envoi est configuré.
              </p>
            </div>
          </s-section>

          <div className="loyalty-save-bar">
            <button
              className="loyalty-button is-save"
              type="submit"
              disabled={busy}
            >
              {busy ? "Enregistrement…" : "Enregistrer les paramètres"}
            </button>
          </div>
        </Form>

        <s-section heading="Dernières récompenses">
          {data.recentRewards.length === 0 ? (
            <s-paragraph>Aucune récompense créée pour le moment.</s-paragraph>
          ) : (
            <div className="loyalty-table-wrap">
              <table className="loyalty-table">
                <thead>
                  <tr>
                    {["Client", "Code", "Statut", "Détail", "Date"].map(
                      (heading) => (
                        <th key={heading}>{heading}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.recentRewards.map((reward) => (
                    <tr key={reward.id}>
                      <td>{reward.customer}</td>
                      <td className="loyalty-code-cell">
                        {reward.code ?? "—"}
                      </td>
                      <td>
                        <span
                          className={`loyalty-status is-${reward.status.toLowerCase()}`}
                        >
                          {reward.status}
                        </span>
                      </td>
                      <td className="loyalty-detail-cell">
                        {reward.failureReason ?? "—"}
                      </td>
                      <td>
                        {new Intl.DateTimeFormat("fr-FR").format(
                          new Date(reward.createdAt),
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </s-section>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
