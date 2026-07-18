type RewardEmailInput = {
  idempotencyKey: string;
  to: string;
  firstName?: string | null;
  code: string;
  expiresAt: Date;
  rewardLabel: string;
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
  const safeReward = escapeHtml(input.rewardLabel);
  const expiry = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeZone: "Europe/Paris",
  }).format(input.expiresAt);

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
        subject: "Votre récompense fidélité est arrivée",
        text: `Bonjour ${displayName}, votre récompense ${input.rewardLabel} est disponible. Code : ${input.code}. Valable jusqu'au ${expiry}.`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#222">
            <h1 style="font-size:24px">Votre fidélité est récompensée</h1>
            <p>Bonjour ${safeName},</p>
            <p>Vous avez débloqué <strong>${safeReward}</strong>.</p>
            <p style="font-size:24px;letter-spacing:2px;background:#f4f4f4;padding:16px;text-align:center"><strong>${safeCode}</strong></p>
            <p>Ce code personnel est utilisable une fois, jusqu'au ${expiry}.</p>
          </div>`,
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
