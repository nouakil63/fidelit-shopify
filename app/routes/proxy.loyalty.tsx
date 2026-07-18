import { Prisma } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
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
  };

  if (!shopifyCustomerId) {
    return Response.json({ authenticated: false, ...storefrontSettings });
  }

  const customer = await syncCustomerFromAdmin(
    admin,
    session.shop,
    shopifyCustomerId,
  );
  const spent = new Prisma.Decimal(customer.lifetimeSpend);
  const threshold = new Prisma.Decimal(settings.threshold);
  const remainder = threshold.greaterThan(0) ? spent.modulo(threshold) : spent;
  const toNextReward = threshold.greaterThan(0)
    ? threshold.minus(remainder).toFixed(2)
    : "0.00";

  return Response.json({
    authenticated: true,
    ...storefrontSettings,
    customer: {
      firstName: customer.firstName,
      lifetimeSpend: spent.toFixed(2),
      currencyCode: customer.currencyCode,
      referralCode: customer.referralCode,
      toNextReward,
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
    const result = await registerReferral(session.shop, customer, code);
    return Response.json({ ok: true, created: result.created });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
};
