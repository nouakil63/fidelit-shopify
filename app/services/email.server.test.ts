import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendRewardEmail } from "./email.server";

describe("sendRewardEmail", () => {
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.REWARD_EMAIL_FROM;

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.REWARD_EMAIL_FROM = "Katmikko <fidelite@katmikko.com>";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousApiKey;
    if (previousFrom === undefined) delete process.env.REWARD_EMAIL_FROM;
    else process.env.REWARD_EMAIL_FROM = previousFrom;
  });

  it("sends the referrer a dedicated email with the code and apply link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "email-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendRewardEmail({
      idempotencyKey: "reward-123",
      to: "parrain@example.com",
      firstName: "Camille",
      code: "FID-TEST-123",
      expiresAt: new Date("2026-08-20T12:00:00.000Z"),
      rewardLabel: "15 % de remise",
      kind: "REFERRER",
      applyUrl:
        "https://example.myshopify.com/discount/FID-TEST-123?redirect=%2F%3Floyalty_reward%3Dapplied",
    });

    expect(result).toEqual({ sent: true, providerId: "email-123" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0];
    const body = JSON.parse(String(request[1]?.body));
    expect(body.subject).toBe("Votre parrainage Katmikko est récompensé");
    expect(body.text).toContain("FID-TEST-123");
    expect(body.text).toContain("/discount/FID-TEST-123");
    expect(body.text).toContain("loyalty_reward%3Dapplied");
    expect(body.html).toContain("Activer ma remise");
    expect(body.html.indexOf("Activer ma remise")).toBeLessThan(
      body.html.indexOf("Votre avantage"),
    );
    expect(body.html).toContain('name="color-scheme" content="light only"');
    expect(body.html).toContain("-webkit-text-fill-color:#ffffff!important");
    expect(body.html).toContain("FROM INDIA TO PARIS");
  });

  it("encodes the euro symbol safely in HTML", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "email-euro" }), { status: 200 }),
    );

    await sendRewardEmail({
      idempotencyKey: "reward-euro",
      to: "client@example.com",
      code: "FID-EURO",
      expiresAt: new Date("2026-08-19T00:00:00.000Z"),
      rewardLabel: "15,00 € offerts",
      kind: "REFERRED",
      applyUrl: "https://katmikko.com/discount/FID-EURO",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.html).toContain("15,00 &euro; offerts");
  });

  it("reports missing production email configuration", async () => {
    process.env.RESEND_API_KEY = "";
    process.env.REWARD_EMAIL_FROM = "";

    const result = await sendRewardEmail({
      idempotencyKey: "reward-456",
      to: "filleul@example.com",
      code: "FID-TEST-456",
      expiresAt: new Date("2026-08-20T12:00:00.000Z"),
      rewardLabel: "15.00 EUR de remise",
      kind: "REFERRED",
      applyUrl:
        "https://example.myshopify.com/discount/FID-TEST-456?redirect=%2F%3Floyalty_reward%3Dapplied",
    });

    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toContain("RESEND_API_KEY");
  });
});
