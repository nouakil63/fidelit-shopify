type RewardEmailInput = {
  idempotencyKey: string;
  to: string;
  firstName?: string | null;
  code: string;
  expiresAt: Date;
  rewardLabel: string;
  kind: "MILESTONE" | "REFERRER" | "REFERRED";
  applyUrl: string;
};

type RewardEmailResult =
  | { sent: true; providerId: string }
  | { sent: false; reason: string };

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

export async function sendRewardEmail(
  input: RewardEmailInput,
): Promise<RewardEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.REWARD_EMAIL_FROM?.trim();

  if (!apiKey || !from) {
    return {
      sent: false,
      reason: "E-mail non envoyé : RESEND_API_KEY ou REWARD_EMAIL_FROM absent.",
    };
  }

  if (!/^re_[A-Za-z0-9_-]+$/.test(apiKey)) {
    return {
      sent: false,
      reason:
        "Clé Resend mal formée : recopiez uniquement la valeur commençant par re_.",
    };
  }

  const displayName = input.firstName?.trim() || "bonjour";
  const safeName = escapeHtml(displayName);
  const safeCode = escapeHtml(input.code);
  // Use an HTML entity so the currency symbol survives every mail transport
  // and does not depend on the encoding selected by the receiving client.
  const safeReward = escapeHtml(input.rewardLabel).replace(/€/g, "&euro;");
  const safeApplyUrl = escapeHtml(input.applyUrl);
  const expiry = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeZone: "Europe/Paris",
  }).format(input.expiresAt);
  const copy =
    input.kind === "REFERRER"
      ? {
          subject: "Votre parrainage Katmikko est récompensé",
          heading: "Votre filleul a rejoint Katmikko",
          introduction:
            "Votre lien de parrainage a été utilisé. Votre récompense est disponible dès maintenant.",
        }
      : input.kind === "REFERRED"
        ? {
            subject: "Bienvenue chez Katmikko : votre récompense est prête",
            heading: "Bienvenue dans le programme fidélité",
            introduction:
              "Votre inscription avec un lien de parrainage est confirmée. Votre récompense est disponible dès maintenant.",
          }
        : {
            subject: "Votre récompense fidélité est arrivée",
            heading: "Votre fidélité est récompensée",
            introduction: "Vous venez de débloquer une nouvelle récompense.",
          };

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
        "User-Agent": "shopify-loyalty/1.0",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: copy.subject,
        text: `Bonjour ${displayName}, ${copy.introduction} Avantage : ${input.rewardLabel}. Code : ${input.code}. Activer ma remise : ${input.applyUrl}. Valable jusqu'au ${expiry}.`,
        html: `<!doctype html>
          <html lang="fr" style="color-scheme:light only;supported-color-schemes:light only">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <meta name="color-scheme" content="light only">
            <meta name="supported-color-schemes" content="light only">
            <style>
              :root { color-scheme: light only; supported-color-schemes: light only; }
              .katmikko-page { background-color:#f7f4f8 !important; color:#242124 !important; }
              .katmikko-card { background-color:#ffffff !important; color:#242124 !important; }
              .katmikko-panel { background-color:#faf7fb !important; color:#242124 !important; }
              .katmikko-code { background-color:#ffffff !important; color:#6f4691 !important; }
              .katmikko-button, .katmikko-button span { background-color:#8f5ab8 !important; color:#ffffff !important; -webkit-text-fill-color:#ffffff !important; }
              @media only screen and (max-width:480px) {
                .katmikko-page { padding:14px 8px !important; }
                .katmikko-header { padding:22px 20px 14px !important; }
                .katmikko-content { padding:24px 20px 28px !important; }
                .katmikko-heading { font-size:27px !important; margin-bottom:16px !important; }
                .katmikko-intro { line-height:1.5 !important; margin-bottom:16px !important; }
                .katmikko-action { margin:18px 0 20px !important; }
                .katmikko-panel { padding:17px 14px !important; }
                .katmikko-code { font-size:16px !important; letter-spacing:.6px !important; }
              }
            </style>
          </head>
          <body class="katmikko-page" bgcolor="#f7f4f8" style="margin:0;padding:0;background:#f7f4f8;color:#242124;font-family:Arial,Helvetica,sans-serif">
          <div class="katmikko-page" style="margin:0;padding:36px 16px;background:#f7f4f8;color:#242124;font-family:Arial,Helvetica,sans-serif">
            <div class="katmikko-card" style="max-width:600px;margin:0 auto;background:#ffffff;color:#242124;border:1px solid #eadff0;border-top:5px solid #b889df">
              <div class="katmikko-header" style="padding:34px 36px 18px;text-align:center;border-bottom:1px solid #eee7f1">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:35px;letter-spacing:1px;color:#b889df">katmikko</div>
                <div style="margin-top:10px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#665b6b">Programme fidélité</div>
              </div>
              <div class="katmikko-content" style="padding:34px 36px 38px">
                <h1 class="katmikko-heading" style="margin:0 0 22px;font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.2;font-weight:400;text-align:center;color:#242124">${escapeHtml(copy.heading)}</h1>
                <p style="margin:0 0 14px;font-size:16px;line-height:1.65">Bonjour ${safeName},</p>
                <p class="katmikko-intro" style="margin:0 0 24px;font-size:16px;line-height:1.65">${escapeHtml(copy.introduction)}</p>
                <div class="katmikko-action" style="text-align:center;margin:22px 0 24px">
                  <a class="katmikko-button" href="${safeApplyUrl}" style="display:inline-block;background:#8f5ab8;color:#ffffff!important;-webkit-text-fill-color:#ffffff!important;padding:15px 26px;text-decoration:none;font-size:15px;font-weight:700;letter-spacing:.2px"><span style="color:#ffffff!important;-webkit-text-fill-color:#ffffff!important">Activer ma remise</span></a>
                </div>
                <div class="katmikko-panel" style="padding:22px;text-align:center;background:#faf7fb;color:#242124;border:1px solid #eadff0">
                  <div style="font-size:13px;text-transform:uppercase;letter-spacing:1.4px;color:#665b6b">Votre avantage</div>
                  <div style="margin-top:8px;font-family:Georgia,'Times New Roman',serif;font-size:27px;color:#242124">${safeReward}</div>
                  <div class="katmikko-code" style="margin-top:18px;padding:13px 8px;background:#ffffff;border:1px dashed #b889df;font-size:18px;font-weight:700;letter-spacing:1px;white-space:nowrap;color:#6f4691">${safeCode}</div>
                </div>
                <p style="margin:20px 0 0;text-align:center;font-size:13px;line-height:1.6;color:#746b78">La remise sera ajoutée automatiquement puis vous reviendrez sur la boutique. Code personnel utilisable une fois, jusqu'au ${expiry}.</p>
              </div>
              <div style="padding:20px 30px;text-align:center;background:#242124;color:#ffffff;font-size:12px;letter-spacing:.8px">KATMIKKO · FROM INDIA TO PARIS</div>
            </div>
          </div>
          </body>
          </html>`,
      }),
    });
  } catch (error) {
    const cause =
      error instanceof Error
        ? (error as Error & { cause?: unknown }).cause
        : undefined;
    const causeMessage =
      cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
    const causeCode =
      cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code ?? "")
        : "";

    return {
      sent: false,
      reason: `Connexion à Resend impossible${causeCode ? ` (${causeCode})` : ""} : ${causeMessage}`,
    };
  }

  const payload = (await response.json().catch(() => null)) as
    | { id?: string; message?: string }
    | null;

  if (!response.ok || !payload?.id) {
    return {
      sent: false,
      reason: `Échec Resend (${response.status}) : ${payload?.message ?? "réponse invalide"}`,
    };
  }

  return { sent: true, providerId: payload.id };
}
