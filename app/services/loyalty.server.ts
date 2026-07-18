import { randomBytes } from "node:crypto";
import {
  Prisma,
  ReferralStatus,
  RewardKind,
  RewardStatus,
  RewardType,
  type LoyaltyCustomer,
  type ProgramSettings,
} from "@prisma/client";

import prisma from "../db.server";
import { sendRewardEmail } from "./email.server";
import {
  createRewardDiscountCode,
  isRewardRetryable,
} from "./reward-utils.server";
import type {
  AdminGraphqlClient,
  ShopifyCustomerSnapshot,
  ShopifyOrderSnapshot,
} from "./shopify-types.server";

const CUSTOMER_QUERY = `#graphql
  query LoyaltyCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      defaultEmailAddress { emailAddress }
      amountSpent { amount currencyCode }
    }
  }
`;

const ORDER_QUERY = `#graphql
  query LoyaltyOrder($id: ID!) {
    order(id: $id) {
      id
      name
      processedAt
      cancelledAt
      displayFinancialStatus
      currentTotalPriceSet {
        shopMoney { amount currencyCode }
      }
      customer {
        id
        firstName
        lastName
        defaultEmailAddress { emailAddress }
        amountSpent { amount currencyCode }
      }
    }
  }
`;

const RECENT_ORDERS_QUERY = `#graphql
  query RecentLoyaltyOrders($first: Int!) {
    orders(first: $first, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        name
        processedAt
        cancelledAt
        displayFinancialStatus
        currentTotalPriceSet {
          shopMoney { amount currencyCode }
        }
        customer {
          id
          firstName
          lastName
          defaultEmailAddress { emailAddress }
          amountSpent { amount currencyCode }
        }
      }
    }
  }
`;

const CREATE_DISCOUNT_MUTATION = `#graphql
  mutation CreateLoyaltyDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

const FIND_DISCOUNT_BY_CODE_QUERY = `#graphql
  query LoyaltyDiscountByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) { id }
  }
`;

type CustomerNode = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  defaultEmailAddress: { emailAddress: string } | null;
  amountSpent: { amount: string; currencyCode: string };
};

type OrderNode = {
  id: string;
  name: string;
  processedAt: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string;
  currentTotalPriceSet: {
    shopMoney: { amount: string; currencyCode: string };
  };
  customer: CustomerNode | null;
};

type CustomerGraphql = {
  data?: {
    customer?: CustomerNode | null;
  };
  errors?: Array<{ message: string }>;
};

type OrderGraphql = {
  data?: {
    order?: OrderNode | null;
  };
  errors?: Array<{ message: string }>;
};

type RecentOrdersGraphql = {
  data?: { orders?: { nodes: OrderNode[] } };
  errors?: Array<{ message: string }>;
};

function referralCode() {
  return randomBytes(5).toString("hex").toUpperCase();
}

function customerSnapshot(customer: CustomerNode): ShopifyCustomerSnapshot {
  return {
    id: customer.id,
    email: customer.defaultEmailAddress?.emailAddress ?? null,
    firstName: customer.firstName,
    lastName: customer.lastName,
    amountSpent: customer.amountSpent.amount,
    currencyCode: customer.amountSpent.currencyCode,
  };
}

function orderSnapshot(order: OrderNode): ShopifyOrderSnapshot {
  return {
    id: order.id,
    name: order.name,
    processedAt: order.processedAt,
    cancelledAt: order.cancelledAt,
    displayFinancialStatus: order.displayFinancialStatus,
    currentTotalAmount: order.currentTotalPriceSet.shopMoney.amount,
    currencyCode: order.currentTotalPriceSet.shopMoney.currencyCode,
    customer: order.customer ? customerSnapshot(order.customer) : null,
  };
}

export async function getOrCreateSettings(shop: string) {
  return prisma.programSettings.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });
}

export async function startProgramFromZero(shop: string) {
  const settings = await getOrCreateSettings(shop);
  if (settings.programStartedAt) {
    return { startedAt: settings.programStartedAt, resetCustomers: 0 };
  }
  if (settings.enabled) {
    throw new Error("Désactivez le programme avant de démarrer les compteurs.");
  }

  const existingRewards = await prisma.reward.count({ where: { shop } });
  if (existingRewards > 0) {
    throw new Error(
      "Des récompenses existent déjà. Le démarrage à zéro a été annulé par sécurité.",
    );
  }

  const startedAt = new Date();
  const [customers] = await prisma.$transaction([
    prisma.loyaltyCustomer.updateMany({
      where: { shop },
      data: { lifetimeSpend: new Prisma.Decimal(0) },
    }),
    prisma.loyaltyOrder.deleteMany({ where: { shop } }),
    prisma.programSettings.update({
      where: { shop },
      data: {
        programStartedAt: startedAt,
        rewardEvaluationCursor: null,
      },
    }),
  ]);

  return { startedAt, resetCustomers: customers.count };
}

export async function upsertLoyaltyCustomer(
  shop: string,
  input: ShopifyCustomerSnapshot,
) {
  const existing = await prisma.loyaltyCustomer.findUnique({
    where: {
      shop_shopifyCustomerId: { shop, shopifyCustomerId: input.id },
    },
  });

  const data = {
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    currencyCode: input.currencyCode,
  };

  if (existing) {
    return prisma.loyaltyCustomer.update({ where: { id: existing.id }, data });
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.loyaltyCustomer.create({
        data: {
          shop,
          shopifyCustomerId: input.id,
          referralCode: referralCode(),
          ...data,
        },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002" ||
        attempt === 2
      ) {
        throw error;
      }
    }
  }

  throw new Error("Impossible de générer un code de parrainage unique.");
}

export async function syncCustomerFromAdmin(
  admin: AdminGraphqlClient,
  shop: string,
  shopifyCustomerId: string,
) {
  const response = await admin.graphql(CUSTOMER_QUERY, {
    variables: { id: shopifyCustomerId },
  });
  const json = (await response.json()) as CustomerGraphql;
  const customer = json.data?.customer;

  if (!customer) {
    throw new Error(
      json.errors?.map((error) => error.message).join(", ") ||
        "Client Shopify introuvable.",
    );
  }

  return upsertLoyaltyCustomer(shop, customerSnapshot(customer));
}

function rewardLabel(
  type: RewardType,
  value: Prisma.Decimal,
  currency: string,
) {
  if (type === RewardType.PERCENTAGE) return `${value.toString()} % de remise`;
  return `${value.toFixed(2)} ${currency} de remise`;
}

async function createShopifyDiscount(
  admin: AdminGraphqlClient,
  customer: LoyaltyCustomer,
  settings: ProgramSettings,
  type: RewardType,
  value: Prisma.Decimal,
  code: string,
  expiresAt: Date,
  kind: RewardKind,
) {
  const customerGetsValue =
    type === RewardType.PERCENTAGE
      ? { percentage: value.dividedBy(100).toNumber() }
      : {
          discountAmount: {
            amount: value.toFixed(2),
            appliesOnEachItem: false,
          },
        };

  const response = await admin.graphql(CREATE_DISCOUNT_MUTATION, {
    variables: {
      basicCodeDiscount: {
        title: `Fidélité - ${customer.email ?? customer.shopifyCustomerId}`,
        code,
        startsAt: new Date().toISOString(),
        endsAt: expiresAt.toISOString(),
        context: { customers: { add: [customer.shopifyCustomerId] } },
        customerGets: {
          value: customerGetsValue,
          items: { all: true },
        },
        combinesWith: {
          orderDiscounts: settings.combineOrderDiscounts,
          productDiscounts: settings.combineProductDiscounts,
          shippingDiscounts: settings.combineShippingDiscounts,
        },
        appliesOncePerCustomer: true,
        usageLimit: 1,
        tags: ["loyalty", kind.toLowerCase()],
      },
    },
  });
  const json = (await response.json()) as {
    data?: {
      discountCodeBasicCreate?: {
        codeDiscountNode?: { id: string } | null;
        userErrors: Array<{ field?: string[]; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  const result = json.data?.discountCodeBasicCreate;

  if (!result?.codeDiscountNode || result.userErrors.length > 0) {
    const errors = [
      ...(json.errors?.map((error) => error.message) ?? []),
      ...(result?.userErrors.map((error) => error.message) ?? []),
    ];

    // A previous attempt may have created the Shopify discount before the
    // local database update failed. The deterministic code lets us recover
    // that discount instead of creating a duplicate.
    const existingResponse = await admin.graphql(FIND_DISCOUNT_BY_CODE_QUERY, {
      variables: { code },
    });
    const existingJson = (await existingResponse.json()) as {
      data?: { codeDiscountNodeByCode?: { id: string } | null };
    };
    const existing = existingJson.data?.codeDiscountNodeByCode;
    if (existing) return existing.id;
    throw new Error(errors.join(", ") || "Shopify n'a pas créé le code promo.");
  }

  return result.codeDiscountNode.id;
}

type IssueRewardInput = {
  admin: AdminGraphqlClient;
  shop: string;
  customer: LoyaltyCustomer;
  settings: ProgramSettings;
  kind: RewardKind;
  milestone?: number;
  type: RewardType;
  value: Prisma.Decimal;
  dedupeKey: string;
};

async function issueReward(input: IssueRewardInput) {
  let reward;
  try {
    reward = await prisma.reward.create({
      data: {
        shop: input.shop,
        customerId: input.customer.id,
        kind: input.kind,
        milestone: input.milestone,
        dedupeKey: input.dedupeKey,
        rewardType: input.type,
        rewardValue: input.value,
        currencyCode: input.customer.currencyCode,
        status: RewardStatus.PROCESSING,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await prisma.reward.findUnique({
        where: { dedupeKey: input.dedupeKey },
      });
      if (!existing || existing.status !== RewardStatus.FAILED) return existing;

      const claimed = await prisma.reward.updateMany({
        where: { id: existing.id, status: RewardStatus.FAILED },
        data: { status: RewardStatus.PROCESSING, failureReason: null },
      });
      if (claimed.count !== 1) {
        return prisma.reward.findUnique({ where: { id: existing.id } });
      }
      reward = { ...existing, status: RewardStatus.PROCESSING };
    } else {
      throw error;
    }
  }

  const code = createRewardDiscountCode(
    input.customer.shopifyCustomerId,
    reward.id,
  );
  const expiresAt = new Date(
    Date.now() + input.settings.validityDays * 24 * 60 * 60 * 1000,
  );

  try {
    const shopifyDiscountId = await createShopifyDiscount(
      input.admin,
      input.customer,
      input.settings,
      input.type,
      input.value,
      code,
      expiresAt,
      input.kind,
    );

    await prisma.reward.update({
      where: { id: reward.id },
      data: {
        status: RewardStatus.ISSUED,
        discountCode: code,
        shopifyDiscountId,
        expiresAt,
      },
    });

    if (!input.customer.email) {
      return prisma.reward.update({
        where: { id: reward.id },
        data: {
          failureReason: "Code créé, mais le client n'a pas d'adresse e-mail.",
        },
      });
    }

    const email = await sendRewardEmail({
      idempotencyKey: `reward-${reward.id}`,
      to: input.customer.email,
      firstName: input.customer.firstName,
      code,
      expiresAt,
      rewardLabel: rewardLabel(
        input.type,
        input.value,
        input.customer.currencyCode,
      ),
    });

    return prisma.reward.update({
      where: { id: reward.id },
      data: email.sent
        ? {
            status: RewardStatus.EMAILED,
            emailedAt: new Date(),
            emailProviderId: email.providerId,
            failureReason: null,
          }
        : { failureReason: email.reason },
    });
  } catch (error) {
    return prisma.reward.update({
      where: { id: reward.id },
      data: {
        status: RewardStatus.FAILED,
        failureReason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export async function retryRewardIssuance(
  admin: AdminGraphqlClient,
  shop: string,
  rewardId: string,
) {
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000);
  const reward = await prisma.reward.findFirst({
    where: { id: rewardId, shop },
    include: { customer: true },
  });
  if (!reward) {
    return { retried: false as const, reason: "Récompense introuvable." };
  }

  const retryable = isRewardRetryable(
    reward.status,
    reward.updatedAt,
    staleBefore,
  );
  if (!retryable) {
    return {
      retried: false as const,
      reason: "Cette récompense n'a pas besoin d'être relancée.",
    };
  }

  // Older failures may already have a valid Shopify discount. In that case,
  // only retry the email and keep the original code.
  if (reward.discountCode && reward.expiresAt) {
    const email = await retryRewardEmail(shop, reward.id);
    return { retried: true as const, email };
  }

  const prepared = await prisma.reward.updateMany({
    where: {
      id: reward.id,
      shop,
      OR: [
        { status: RewardStatus.FAILED },
        { status: RewardStatus.PENDING },
        { status: RewardStatus.PROCESSING, updatedAt: { lt: staleBefore } },
      ],
    },
    data: { status: RewardStatus.FAILED },
  });
  if (prepared.count !== 1) {
    return { retried: false as const, reason: "Relance déjà en cours." };
  }

  const settings = await getOrCreateSettings(shop);
  const result = await issueReward({
    admin,
    shop,
    customer: reward.customer,
    settings,
    kind: reward.kind,
    milestone: reward.milestone ?? undefined,
    type: reward.rewardType,
    value: reward.rewardValue,
    dedupeKey: reward.dedupeKey,
  });
  return { retried: true as const, reward: result };
}

export async function retryRewardEmail(shop: string, rewardId: string) {
  const reward = await prisma.reward.findFirst({
    where: { id: rewardId, shop },
    include: { customer: true },
  });

  if (!reward) {
    return { sent: false, reason: "Récompense introuvable." };
  }
  if (reward.status === RewardStatus.EMAILED) {
    return { sent: false, reason: "E-mail déjà envoyé." };
  }
  if (!reward.discountCode || !reward.expiresAt) {
    return {
      sent: false,
      reason: "Le code Shopify n'a pas encore été créé.",
    };
  }
  if (!reward.customer.email) {
    const reason = "Code créé, mais le client n'a pas d'adresse e-mail.";
    await prisma.reward.update({
      where: { id: reward.id },
      data: { failureReason: reason },
    });
    return { sent: false, reason };
  }

  const result = await sendRewardEmail({
    idempotencyKey: `reward-${reward.id}`,
    to: reward.customer.email,
    firstName: reward.customer.firstName,
    code: reward.discountCode,
    expiresAt: reward.expiresAt,
    rewardLabel: rewardLabel(
      reward.rewardType,
      reward.rewardValue,
      reward.currencyCode,
    ),
  });

  await prisma.reward.update({
    where: { id: reward.id },
    data: result.sent
      ? {
          status: RewardStatus.EMAILED,
          emailedAt: new Date(),
          emailProviderId: result.providerId,
          failureReason: null,
        }
      : { failureReason: result.reason },
  });

  return result;
}

export async function evaluateMilestones(
  admin: AdminGraphqlClient,
  shop: string,
  customer: LoyaltyCustomer,
  suppliedSettings?: ProgramSettings,
) {
  const settings = suppliedSettings ?? (await getOrCreateSettings(shop));
  if (!settings.enabled || settings.threshold.lessThanOrEqualTo(0)) return [];

  const calculatedMilestones = Math.min(
    1000,
    Math.floor(
      new Prisma.Decimal(customer.lifetimeSpend)
        .dividedBy(settings.threshold)
        .toNumber(),
    ),
  );
  const unlocked = settings.repeatRewards
    ? calculatedMilestones
    : Math.min(1, calculatedMilestones);
  if (unlocked < 1) return [];

  const existing = await prisma.reward.findMany({
    where: { customerId: customer.id, kind: RewardKind.MILESTONE },
    select: { milestone: true },
  });
  const issuedMilestones = new Set(existing.map((reward) => reward.milestone));
  const rewards = [];

  for (let milestone = 1; milestone <= unlocked; milestone += 1) {
    if (issuedMilestones.has(milestone)) continue;
    rewards.push(
      await issueReward({
        admin,
        shop,
        customer,
        settings,
        kind: RewardKind.MILESTONE,
        milestone,
        type: settings.rewardType,
        value: settings.rewardValue,
        dedupeKey: `${shop}:${customer.id}:milestone:${milestone}`,
      }),
    );
  }

  return rewards;
}

async function qualifyReferral(
  admin: AdminGraphqlClient,
  shop: string,
  referred: LoyaltyCustomer,
  settings: ProgramSettings,
) {
  if (!settings.referralEnabled) return;

  const referral = await prisma.referral.findUnique({
    where: { referredId: referred.id },
    include: { advocate: true },
  });
  if (!referral || referral.status !== ReferralStatus.SIGNED_UP) return;

  const updated = await prisma.referral.updateMany({
    where: { id: referral.id, status: ReferralStatus.SIGNED_UP },
    data: { status: ReferralStatus.QUALIFIED, qualifiedAt: new Date() },
  });
  if (updated.count !== 1) return;

  await Promise.all([
    issueReward({
      admin,
      shop,
      customer: referral.advocate,
      settings,
      kind: RewardKind.REFERRER,
      type: settings.referralRewardType,
      value: settings.referralAdvocateRewardValue,
      dedupeKey: `${shop}:referral:${referral.id}:advocate`,
    }),
    issueReward({
      admin,
      shop,
      customer: referred,
      settings,
      kind: RewardKind.REFERRED,
      type: settings.referralRewardType,
      value: settings.referralFriendRewardValue,
      dedupeKey: `${shop}:referral:${referral.id}:friend`,
    }),
  ]);
}

export async function applyOrderSnapshot(
  admin: AdminGraphqlClient,
  shop: string,
  order: ShopifyOrderSnapshot,
) {
  if (!order.customer) return { ignored: true as const, reason: "guest" };

  const settings = await getOrCreateSettings(shop);
  const customer = await upsertLoyaltyCustomer(shop, order.customer);
  const eligible =
    !order.cancelledAt &&
    ["PAID", "PARTIALLY_REFUNDED"].includes(order.displayFinancialStatus);
  const processedAt = order.processedAt ? new Date(order.processedAt) : null;

  await prisma.loyaltyOrder.upsert({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId: order.id } },
    create: {
      shop,
      shopifyOrderId: order.id,
      orderName: order.name,
      customerId: customer.id,
      eligibleAmount: eligible
        ? new Prisma.Decimal(order.currentTotalAmount)
        : new Prisma.Decimal(0),
      currencyCode: order.currencyCode,
      financialStatus: order.displayFinancialStatus,
      processedAt,
      cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    },
    update: {
      customerId: customer.id,
      eligibleAmount: eligible
        ? new Prisma.Decimal(order.currentTotalAmount)
        : new Prisma.Decimal(0),
      currencyCode: order.currencyCode,
      financialStatus: order.displayFinancialStatus,
      processedAt,
      cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    },
  });

  const eligibleSinceProgramStart = Boolean(
    settings.programStartedAt &&
    processedAt &&
    processedAt >= settings.programStartedAt,
  );
  const total = settings.programStartedAt
    ? await prisma.loyaltyOrder.aggregate({
        where: {
          shop,
          customerId: customer.id,
          processedAt: { gte: settings.programStartedAt },
        },
        _sum: { eligibleAmount: true },
      })
    : null;
  const refreshed = await prisma.loyaltyCustomer.update({
    where: { id: customer.id },
    data: {
      lifetimeSpend: total?._sum.eligibleAmount ?? new Prisma.Decimal(0),
      currencyCode: order.customer.currencyCode,
    },
  });

  await evaluateMilestones(admin, shop, refreshed, settings);
  if (eligible && eligibleSinceProgramStart) {
    await qualifyReferral(admin, shop, refreshed, settings);
  }

  return { ignored: false as const, customer: refreshed };
}

export async function syncOrderFromAdmin(
  admin: AdminGraphqlClient,
  shop: string,
  shopifyOrderId: string,
) {
  const response = await admin.graphql(ORDER_QUERY, {
    variables: { id: shopifyOrderId },
  });
  const json = (await response.json()) as OrderGraphql;
  const order = json.data?.order;
  if (!order) {
    throw new Error(
      json.errors?.map((error) => error.message).join(", ") ||
        "Commande Shopify introuvable.",
    );
  }

  return applyOrderSnapshot(admin, shop, orderSnapshot(order));
}

export async function syncRecentOrders(
  admin: AdminGraphqlClient,
  shop: string,
  limit = 10,
) {
  const first = Math.max(1, Math.min(100, Math.round(limit)));
  const response = await admin.graphql(RECENT_ORDERS_QUERY, {
    variables: { first },
  });
  const json = (await response.json()) as RecentOrdersGraphql;
  const orders = json.data?.orders;
  if (!orders) {
    throw new Error(
      json.errors?.map((error) => error.message).join(", ") ||
        "Shopify n'a pas renvoyé les commandes récentes.",
    );
  }

  let synced = 0;
  let ignored = 0;
  for (const order of orders.nodes) {
    const result = await applyOrderSnapshot(admin, shop, orderSnapshot(order));
    if (result.ignored) ignored += 1;
    else synced += 1;
  }

  return { found: orders.nodes.length, synced, ignored };
}

export async function registerReferral(
  shop: string,
  referred: LoyaltyCustomer,
  code: string,
) {
  const settings = await getOrCreateSettings(shop);
  if (!settings.referralEnabled)
    throw new Error("Le parrainage est désactivé.");
  if (referred.referredById) return { created: false as const };

  const advocate = await prisma.loyaltyCustomer.findUnique({
    where: { shop_referralCode: { shop, referralCode: code.toUpperCase() } },
  });
  if (!advocate || advocate.id === referred.id) {
    throw new Error("Code de parrainage invalide.");
  }

  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.referral.findUnique({
      where: { referredId: referred.id },
    });
    if (existing) return { created: false as const };

    await transaction.loyaltyCustomer.update({
      where: { id: referred.id },
      data: { referredById: advocate.id },
    });
    await transaction.referral.create({
      data: { shop, advocateId: advocate.id, referredId: referred.id },
    });
    return { created: true as const };
  });
}
