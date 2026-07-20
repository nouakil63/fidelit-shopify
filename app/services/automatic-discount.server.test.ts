import { Prisma, RewardType, type ProgramSettings } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { automaticDiscountInput } from "./automatic-discount.server";

function settings(overrides: Partial<ProgramSettings> = {}) {
  return {
    shop: "example.myshopify.com",
    enabled: true,
    threshold: new Prisma.Decimal(300),
    rewardType: RewardType.PERCENTAGE,
    rewardValue: new Prisma.Decimal(15),
    programStartedAt: new Date("2026-07-20T12:00:00.000Z"),
    ...overrides,
  } as ProgramSettings;
}

describe("automaticDiscountInput", () => {
  it("creates an immediate 15 percent discount from 300 EUR", () => {
    const input = automaticDiscountInput(settings());

    expect(input.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal).toBe(
      "300.00",
    );
    expect(input.customerGets.value).toEqual({ percentage: 0.15 });
    expect(input.customerGets.items).toEqual({ all: true });
  });

  it("disables every discount combination", () => {
    expect(automaticDiscountInput(settings()).combinesWith).toEqual({
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    });
  });
});
