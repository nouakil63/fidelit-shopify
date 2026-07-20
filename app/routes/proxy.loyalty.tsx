import { Prisma } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  ensureReferralSignupRewards,
  getOrCreateSettings,
  registerReferral,
  syncCustomerFromAdmin,
} from "../services/loyalty.server";

function loggedInCustomerId(request: Request) {
  const legacyId = new URL(request.url).searchParams.get("logged_in_customer_id");
  return legacyId ? `gid://shopify/Customer/${legacyId}` : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  const shopifyCustomerId = loggedInCustomerId(request);

  if (!admin || !session) {
    return Response.json({ authenticated: false }, { status: 401 });
  }

  const settings = await getOrCreateSettings(session.shop);
  const storefrontSettings = {
    enabled: settings.enabled,
    popupEnabled: settings.popupEnabled,
    popupTitle: settings.popupTitle,
    popupText: settings.popupText,
    popupButtonLabel: settings.popupButtonLabel,
    popupDelaySeconds: settings.popupDelaySeconds,
    referralEnabled: settings.referralEnabled,
    referralFriendRewardType: settings.referralFriendRewardType,
    referralFriendRewardValue: settings.referralFriendRewardValue.toString(),
  };

  if (!shopifyCustomerId) {
    return Response.json({ authenticated: false, ...storefrontSettings });
  }

  const customer = await syncCustomerFromAdmin(
    admin,
    session.shop,
    shopifyCustomerId,
  );
  // This also upgrades referrals created by older versions of the app: the
  // first authenticated loyalty request creates both signup rewards once.
  await ensureReferralSignupRewards(admin, session.shop, customer, settings);
  const threshold = new Prisma.Decimal(settings.threshold);
  const rewards = await prisma.reward.findMany({
    where: {
      shop: session.shop,
      customerId: customer.id,
      discountCode: { not: null },
      expiresAt: { gt: new Date() },
      status: { in: ["ISSUED", "EMAILED"] },
    },
    select: {
      id: true,
      discountCode: true,
      kind: true,
      rewardType: true,
      rewardValue: true,
      currencyCode: true,
      expiresAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({
    authenticated: true,
    ...storefrontSettings,
    customer: {
      firstName: customer.firstName,
      lifetimeSpend: new Prisma.Decimal(customer.lifetimeSpend).toFixed(2),
      currencyCode: customer.currencyCode,
      referralCode: customer.referralCode,
      orderThreshold: threshold.toFixed(2),
      rewards: rewards.map((reward) => ({
        id: reward.id,
        code: reward.discountCode,
        kind: reward.kind,
        type: reward.rewardType,
        value: reward.rewardValue.toString(),
        currencyCode: reward.currencyCode,
        expiresAt: reward.expiresAt?.toISOString() ?? null,
      })),
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  const shopifyCustomerId = loggedInCustomerId(request);
  if (!admin || !session || !shopifyCustomerId) {
    return Response.json({ error: "Connexion client requise." }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? ((await request.json()) as { referralCode?: string })
    : Object.fromEntries(await request.formData());
  const code = typeof body.referralCode === "string" ? body.referralCode.trim() : "";
  if (!code) {
    return Response.json({ error: "Code de parrainage manquant." }, { status: 400 });
  }

  const customer = await syncCustomerFromAdmin(
    admin,
    session.shop,
    shopifyCustomerId,
  );

  try {
    const result = await registerReferral(
      admin,
      session.shop,
      customer,
      code,
      customer.shopifyLifetimeSpend,
    );
    return Response.json({
      ok: true,
      created: result.created,
      rewardReady: Boolean(result.friendReward?.discountCode),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
};
