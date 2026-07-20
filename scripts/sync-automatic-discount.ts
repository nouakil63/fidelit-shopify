import prisma from "../app/db.server";
import { syncAutomaticOrderDiscount } from "../app/services/automatic-discount.server";

const shop = process.argv[2] ?? "t1adsm-fs.myshopify.com";

const session = await prisma.session.findFirst({
  where: { shop, isOnline: false },
  orderBy: { expires: "desc" },
});
if (!session?.accessToken) {
  throw new Error(`Aucune session hors ligne Shopify trouvée pour ${shop}.`);
}

const settings = await prisma.programSettings.findUnique({ where: { shop } });
if (!settings) throw new Error(`Paramètres introuvables pour ${shop}.`);

const admin = {
  graphql: async (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) =>
    fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query, variables: options?.variables }),
    }),
};

const result = await syncAutomaticOrderDiscount(admin, shop, settings);
if (!result.active || !result.id) {
  console.log(JSON.stringify(result));
  await prisma.$disconnect();
  process.exit(0);
}

const verificationResponse = await admin.graphql(
  `#graphql
    query VerifyLoyaltyAutomaticDiscount($id: ID!) {
      automaticDiscountNode(id: $id) {
        id
        automaticDiscount {
          ... on DiscountAutomaticBasic {
            title
            status
            startsAt
            minimumRequirement {
              ... on DiscountMinimumSubtotal {
                greaterThanOrEqualToSubtotal { amount currencyCode }
              }
            }
            customerGets {
              value {
                ... on DiscountPercentage { percentage }
              }
            }
            combinesWith {
              orderDiscounts
              productDiscounts
              shippingDiscounts
            }
          }
        }
      }
    }
  `,
  { variables: { id: result.id } },
);
const verification = await verificationResponse.json();
console.log(JSON.stringify({ result, verification }));
await prisma.$disconnect();
