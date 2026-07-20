import { RewardType, type ProgramSettings } from "@prisma/client";

import prisma from "../db.server";
import type { AdminGraphqlClient } from "./shopify-types.server";

const CREATE_AUTOMATIC_DISCOUNT = `#graphql
  mutation LoyaltyAutomaticDiscountCreate($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode { id }
      userErrors { field code message }
    }
  }
`;

const UPDATE_AUTOMATIC_DISCOUNT = `#graphql
  mutation LoyaltyAutomaticDiscountUpdate($id: ID!, $automaticBasicDiscount: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $automaticBasicDiscount) {
      automaticDiscountNode { id }
      userErrors { field code message }
    }
  }
`;

const DELETE_AUTOMATIC_DISCOUNT = `#graphql
  mutation LoyaltyAutomaticDiscountDelete($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors { field code message }
    }
  }
`;

type DiscountMutationPayload = {
  data?: {
    discountAutomaticBasicCreate?: {
      automaticDiscountNode?: { id: string } | null;
      userErrors: Array<{ message: string }>;
    };
    discountAutomaticBasicUpdate?: {
      automaticDiscountNode?: { id: string } | null;
      userErrors: Array<{ message: string }>;
    };
    discountAutomaticDelete?: {
      deletedAutomaticDiscountId?: string | null;
      userErrors: Array<{ message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
};

export function automaticDiscountInput(settings: ProgramSettings) {
  const customerGetsValue =
    settings.rewardType === RewardType.PERCENTAGE
      ? { percentage: settings.rewardValue.dividedBy(100).toNumber() }
      : {
          discountAmount: {
            amount: settings.rewardValue.toFixed(2),
            appliesOnEachItem: false,
          },
        };

  const formattedValue =
    settings.rewardType === RewardType.PERCENTAGE
      ? `${settings.rewardValue.toString()} %`
      : `${settings.rewardValue.toFixed(2)} EUR`;

  return {
    title: `Katmikko - ${formattedValue} dès ${settings.threshold.toFixed(2)} EUR`,
    startsAt: (settings.programStartedAt ?? new Date()).toISOString(),
    minimumRequirement: {
      subtotal: {
        greaterThanOrEqualToSubtotal: settings.threshold.toFixed(2),
      },
    },
    customerGets: {
      value: customerGetsValue,
      items: { all: true },
    },
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
  };
}

function mutationErrors(payload: DiscountMutationPayload, userErrors: Array<{ message: string }>) {
  return [
    ...(payload.errors?.map((error) => error.message) ?? []),
    ...userErrors.map((error) => error.message),
  ];
}

export async function syncAutomaticOrderDiscount(
  admin: AdminGraphqlClient,
  shop: string,
  settings: ProgramSettings,
) {
  if (!settings.enabled) {
    if (!settings.automaticDiscountId) return { active: false as const };
    const response = await admin.graphql(DELETE_AUTOMATIC_DISCOUNT, {
      variables: { id: settings.automaticDiscountId },
    });
    const payload = (await response.json()) as DiscountMutationPayload;
    const result = payload.data?.discountAutomaticDelete;
    const errors = mutationErrors(payload, result?.userErrors ?? []);
    if (errors.length > 0) throw new Error(errors.join(", "));
    await prisma.programSettings.update({
      where: { shop },
      data: { automaticDiscountId: null },
    });
    return { active: false as const };
  }

  const input = automaticDiscountInput(settings);
  if (settings.automaticDiscountId) {
    const response = await admin.graphql(UPDATE_AUTOMATIC_DISCOUNT, {
      variables: {
        id: settings.automaticDiscountId,
        automaticBasicDiscount: input,
      },
    });
    const payload = (await response.json()) as DiscountMutationPayload;
    const result = payload.data?.discountAutomaticBasicUpdate;
    const errors = mutationErrors(payload, result?.userErrors ?? []);
    if (errors.length > 0 || !result?.automaticDiscountNode?.id) {
      throw new Error(errors.join(", ") || "Remise automatique Shopify introuvable.");
    }
    return { active: true as const, id: result.automaticDiscountNode.id };
  }

  const response = await admin.graphql(CREATE_AUTOMATIC_DISCOUNT, {
    variables: { automaticBasicDiscount: input },
  });
  const payload = (await response.json()) as DiscountMutationPayload;
  const result = payload.data?.discountAutomaticBasicCreate;
  const errors = mutationErrors(payload, result?.userErrors ?? []);
  if (errors.length > 0 || !result?.automaticDiscountNode?.id) {
    throw new Error(errors.join(", ") || "Création de la remise automatique impossible.");
  }
  await prisma.programSettings.update({
    where: { shop },
    data: { automaticDiscountId: result.automaticDiscountNode.id },
  });
  return { active: true as const, id: result.automaticDiscountNode.id };
}
