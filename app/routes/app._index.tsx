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
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  evaluateMilestones,
  getOrCreateSettings,
  retryRewardEmail,
  startProgramFromZero,
  syncRecentOrders,
} from "../services/loyalty.server";
import { syncAllCustomers } from "../services/sync.server";
import "../styles/loyalty-admin.css";

const fieldStyle = {
  display: "grid",
  gap: "6px",
} as const;

const inputStyle = {
  border: "1px solid #8a8a8a",
  borderRadius: "8px",
  fontSize: "14px",
  minHeight: "40px",
  padding: "8px 10px",
  width: "100%",
} as const;

const buttonStyle = {
  background: "#303030",
  border: 0,
  borderRadius: "8px",
  color: "white",
  cursor: "pointer",
  fontWeight: 600,
  minHeight: "40px",
  padding: "8px 16px",
} as const;

function numberValue(form: FormData, key: string, minimum: number) {
  const value = Number(form.get(key));
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`Valeur invalide pour ${key}.`);
  }
  return value;
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

    const customers = await prisma.loyaltyCustomer.findMany({
      where: { shop: session.shop },
      orderBy: { id: "asc" },
      take: 25,
      ...(settings.rewardEvaluationCursor
        ? { cursor: { id: settings.rewardEvaluationCursor }, skip: 1 }
        : {}),
    });
    let created = 0;
    for (const customer of customers) {
      const rewards = await evaluateMilestones(
        admin,
        session.shop,
        customer,
        settings,
      );
      created += rewards.length;
    }

    const hasNextBatch = customers.length === 25;
    await prisma.programSettings.update({
      where: { shop: session.shop },
      data: {
        rewardEvaluationCursor: hasNextBatch ? customers.at(-1)?.id : null,
      },
    });
    return {
      ok: true,
      message: `${created} récompense(s) émise(s) sur ce lot${hasNextBatch ? ". Relancez pour traiter le lot suivant." : ". Tous les clients ont été évalués."}`,
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

  if (intent !== "save") {
    return { ok: false, message: "Action inconnue." };
  }

  try {
    const currentSettings = await getOrCreateSettings(session.shop);
    if (form.has("enabled") && !currentSettings.programStartedAt) {
      throw new Error("Cliquez d'abord sur « Démarrer les compteurs à zéro ».");
    }
    const rewardType = String(form.get("rewardType"));
    const referralRewardType = String(form.get("referralRewardType"));
    if (!Object.values(RewardType).includes(rewardType as RewardType)) {
      throw new Error("Type de récompense invalide.");
    }
    if (!Object.values(RewardType).includes(referralRewardType as RewardType)) {
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
      referralRewardType === RewardType.PERCENTAGE &&
      Math.max(referralAdvocateRewardValue, referralFriendRewardValue) > 100
    ) {
      throw new Error(
        "Une remise de parrainage en pourcentage ne peut pas dépasser 100 %.",
      );
    }

    await prisma.programSettings.update({
      where: { shop: session.shop },
      data: {
        enabled: form.has("enabled"),
        threshold: numberValue(form, "threshold", 0.01),
        rewardType: rewardType as RewardType,
        rewardValue,
        repeatRewards: form.has("repeatRewards"),
        validityDays: Math.round(numberValue(form, "validityDays", 1)),
        combineOrderDiscounts: form.has("combineOrderDiscounts"),
        combineProductDiscounts: form.has("combineProductDiscounts"),
        combineShippingDiscounts: form.has("combineShippingDiscounts"),
        popupEnabled: form.has("popupEnabled"),
        popupTitle: String(form.get("popupTitle") ?? "").trim(),
        popupText: String(form.get("popupText") ?? "").trim(),
        popupButtonLabel: String(form.get("popupButtonLabel") ?? "").trim(),
        popupDelaySeconds: Math.round(
          numberValue(form, "popupDelaySeconds", 0),
        ),
        referralEnabled: form.has("referralEnabled"),
        referralRewardType: referralRewardType as RewardType,
        referralAdvocateRewardValue,
        referralFriendRewardValue,
      },
    });
    return { ok: true, message: "Paramètres enregistrés." };
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
    <label style={fieldStyle}>
      <span style={{ fontWeight: 600 }}>{label}</span>
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
    <label style={{ alignItems: "center", display: "flex", gap: "8px" }}>
      <input name={name} type="checkbox" defaultChecked={defaultChecked} />
      <span>{label}</span>
    </label>
  );
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const settings = data.settings;
  const busy = navigation.state !== "idle";

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
              <button style={buttonStyle} type="submit" disabled={busy}>
                Synchroniser les clients Shopify
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="sync_orders" />
              <button style={buttonStyle} type="submit" disabled={busy}>
                Synchroniser les commandes récentes
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="evaluate" />
              <button
                style={{ ...buttonStyle, background: "#6b4f00" }}
                type="submit"
                disabled={busy}
              >
                Émettre les récompenses déjà acquises
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="retry_emails" />
              <button
                style={{ ...buttonStyle, background: "#005bd3" }}
                type="submit"
                disabled={busy}
              >
                Envoyer les e-mails en attente
              </button>
            </Form>
            <a
              href={data.themeEditorUrl}
              target="_top"
              style={{
                ...buttonStyle,
                display: "inline-grid",
                placeItems: "center",
                textDecoration: "none",
              }}
            >
              Activer le pop-up dans le thème
            </a>
          </div>

          <div className="loyalty-start-card">
            <div>
              <strong>Point de départ du programme</strong>
              <p>
                {settings.programStartedAt
                  ? `Compteurs démarrés le ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date(settings.programStartedAt))}.`
                  : "Les achats antérieurs seront exclus et tous les clients commenceront à 0 €."}
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
                  Démarrer les compteurs à zéro
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
            <div style={{ display: "grid", gap: "14px" }}>
              <Checkbox
                name="enabled"
                label="Programme actif (les prochains événements peuvent créer des codes)"
                defaultChecked={settings.enabled}
              />
              <Checkbox
                name="repeatRewards"
                label="Répéter la récompense à chaque nouveau palier (sinon une seule fois)"
                defaultChecked={settings.repeatRewards}
              />
              <div
                style={{
                  display: "grid",
                  gap: 14,
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                }}
              >
                <Field label="Palier d'achats cumulés">
                  <input
                    style={inputStyle}
                    name="threshold"
                    type="number"
                    step="0.01"
                    min="0.01"
                    defaultValue={settings.threshold}
                  />
                </Field>
                <Field label="Type de remise">
                  <select
                    style={inputStyle}
                    name="rewardType"
                    defaultValue={settings.rewardType}
                  >
                    <option value="FIXED">Montant fixe</option>
                    <option value="PERCENTAGE">Pourcentage</option>
                  </select>
                </Field>
                <Field label="Valeur de la remise">
                  <input
                    style={inputStyle}
                    name="rewardValue"
                    type="number"
                    step="0.01"
                    min="0.01"
                    defaultValue={settings.rewardValue}
                  />
                </Field>
                <Field label="Validité du code (jours)">
                  <input
                    style={inputStyle}
                    name="validityDays"
                    type="number"
                    min="1"
                    defaultValue={settings.validityDays}
                  />
                </Field>
              </div>
              <Checkbox
                name="combineOrderDiscounts"
                label="Cumulable avec les remises sur commande"
                defaultChecked={settings.combineOrderDiscounts}
              />
              <Checkbox
                name="combineProductDiscounts"
                label="Cumulable avec les remises produit"
                defaultChecked={settings.combineProductDiscounts}
              />
              <Checkbox
                name="combineShippingDiscounts"
                label="Cumulable avec les remises de livraison"
                defaultChecked={settings.combineShippingDiscounts}
              />
            </div>
          </s-section>

          <s-section heading="Pop-up boutique">
            <div style={{ display: "grid", gap: "14px" }}>
              <Checkbox
                name="popupEnabled"
                label="Afficher le pop-up"
                defaultChecked={settings.popupEnabled}
              />
              <Field label="Titre">
                <input
                  style={inputStyle}
                  name="popupTitle"
                  defaultValue={settings.popupTitle}
                  required
                />
              </Field>
              <Field label="Texte">
                <textarea
                  style={{ ...inputStyle, minHeight: 90 }}
                  name="popupText"
                  defaultValue={settings.popupText}
                  required
                />
              </Field>
              <div
                style={{
                  display: "grid",
                  gap: 14,
                  gridTemplateColumns: "2fr 1fr",
                }}
              >
                <Field label="Libellé du bouton">
                  <input
                    style={inputStyle}
                    name="popupButtonLabel"
                    defaultValue={settings.popupButtonLabel}
                    required
                  />
                </Field>
                <Field label="Délai (secondes)">
                  <input
                    style={inputStyle}
                    name="popupDelaySeconds"
                    type="number"
                    min="0"
                    defaultValue={settings.popupDelaySeconds}
                  />
                </Field>
              </div>
            </div>
          </s-section>

          <s-section heading="Parrainage">
            <div style={{ display: "grid", gap: "14px" }}>
              <Checkbox
                name="referralEnabled"
                label="Activer le parrainage"
                defaultChecked={settings.referralEnabled}
              />
              <div
                style={{
                  display: "grid",
                  gap: 14,
                  gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                }}
              >
                <Field label="Type de récompense">
                  <select
                    style={inputStyle}
                    name="referralRewardType"
                    defaultValue={settings.referralRewardType}
                  >
                    <option value="FIXED">Montant fixe</option>
                    <option value="PERCENTAGE">Pourcentage</option>
                  </select>
                </Field>
                <Field label="Récompense du parrain">
                  <input
                    style={inputStyle}
                    name="referralAdvocateRewardValue"
                    type="number"
                    step="0.01"
                    min="0.01"
                    defaultValue={settings.referralAdvocateRewardValue}
                  />
                </Field>
                <Field label="Récompense du filleul">
                  <input
                    style={inputStyle}
                    name="referralFriendRewardValue"
                    type="number"
                    step="0.01"
                    min="0.01"
                    defaultValue={settings.referralFriendRewardValue}
                  />
                </Field>
              </div>
              <p style={{ color: "#616161", margin: 0 }}>
                Le parrainage est validé lors de la première commande payée du
                filleul.
              </p>
            </div>
          </s-section>

          <div style={{ padding: "16px 0 28px" }}>
            <button style={buttonStyle} type="submit" disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer les paramètres"}
            </button>
          </div>
        </Form>

        <s-section heading="Dernières récompenses">
          {data.recentRewards.length === 0 ? (
            <s-paragraph>Aucune récompense créée pour le moment.</s-paragraph>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    {["Client", "Code", "Statut", "Détail", "Date"].map(
                      (heading) => (
                        <th
                          key={heading}
                          style={{
                            borderBottom: "1px solid #ddd",
                            padding: 10,
                            textAlign: "left",
                          }}
                        >
                          {heading}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.recentRewards.map((reward) => (
                    <tr key={reward.id}>
                      <td
                        style={{ borderBottom: "1px solid #eee", padding: 10 }}
                      >
                        {reward.customer}
                      </td>
                      <td
                        style={{ borderBottom: "1px solid #eee", padding: 10 }}
                      >
                        {reward.code ?? "—"}
                      </td>
                      <td
                        style={{ borderBottom: "1px solid #eee", padding: 10 }}
                      >
                        {reward.status}
                      </td>
                      <td
                        style={{ borderBottom: "1px solid #eee", padding: 10 }}
                      >
                        {reward.failureReason ?? "—"}
                      </td>
                      <td
                        style={{ borderBottom: "1px solid #eee", padding: 10 }}
                      >
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
