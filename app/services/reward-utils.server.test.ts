import { describe, expect, it } from "vitest";

import {
  createRewardDiscountCode,
  isOrderThresholdReached,
  isReferralEligible,
  isRewardRetryable,
} from "./reward-utils.server";

describe("createRewardDiscountCode", () => {
  it("returns the same code for the same reward", () => {
    const first = createRewardDiscountCode(
      "gid://shopify/Customer/123456",
      "cm1234567890reward",
    );
    const second = createRewardDiscountCode(
      "gid://shopify/Customer/123456",
      "cm1234567890reward",
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^FID-23456-[A-Z0-9]{10}$/);
  });

  it("changes the code when the reward changes", () => {
    expect(
      createRewardDiscountCode("gid://shopify/Customer/123456", "reward-one"),
    ).not.toBe(
      createRewardDiscountCode("gid://shopify/Customer/123456", "reward-two"),
    );
  });
});

describe("isRewardRetryable", () => {
  const staleBefore = new Date("2026-07-18T12:00:00.000Z");

  it.each(["PENDING", "FAILED"] as const)(
    "retries %s rewards",
    (status) => {
      expect(isRewardRetryable(status, new Date(), staleBefore)).toBe(true);
    },
  );

  it("retries only stale processing rewards", () => {
    expect(
      isRewardRetryable(
        "PROCESSING",
        new Date("2026-07-18T11:59:59.000Z"),
        staleBefore,
      ),
    ).toBe(true);
    expect(
      isRewardRetryable(
        "PROCESSING",
        new Date("2026-07-18T12:00:00.000Z"),
        staleBefore,
      ),
    ).toBe(false);
  });

  it.each(["ISSUED", "EMAILED"] as const)(
    "does not retry %s rewards",
    (status) => {
      expect(isRewardRetryable(status, new Date(0), staleBefore)).toBe(false);
    },
  );
});

describe("isOrderThresholdReached", () => {
  it("requires one order to reach the full threshold", () => {
    expect(isOrderThresholdReached("299.99", "300")).toBe(false);
    expect(isOrderThresholdReached("300", "300")).toBe(true);
    expect(isOrderThresholdReached("450", "300")).toBe(true);
  });

  it("does not combine separate orders", () => {
    const orders = [150, 150];
    expect(orders.some((amount) => isOrderThresholdReached(amount, 300))).toBe(
      false,
    );
  });

  it("rejects invalid thresholds", () => {
    expect(isOrderThresholdReached(300, 0)).toBe(false);
    expect(isOrderThresholdReached("invalid", 300)).toBe(false);
  });
});

describe("isReferralEligible", () => {
  it("accepts a customer who has never spent money", () => {
    expect(isReferralEligible("0.00")).toBe(true);
  });

  it("rejects a customer who already purchased", () => {
    expect(isReferralEligible("0.01")).toBe(false);
    expect(isReferralEligible("125.50")).toBe(false);
  });

  it("rejects an invalid Shopify amount", () => {
    expect(isReferralEligible("invalid")).toBe(false);
  });
});
