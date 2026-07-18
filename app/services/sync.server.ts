import type { AdminGraphqlClient } from "./shopify-types.server";
import { upsertLoyaltyCustomer } from "./loyalty.server";
import prisma from "../db.server";

const CUSTOMERS_QUERY = `#graphql
  query LoyaltyCustomers($after: String) {
    customers(first: 100, after: $after, sortKey: ID) {
      nodes {
        id
        firstName
        lastName
        defaultEmailAddress { emailAddress }
        amountSpent { amount currencyCode }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function syncAllCustomers(
  admin: AdminGraphqlClient,
  shop: string,
  maximumPages = 50,
) {
  const settings = await prisma.programSettings.findUniqueOrThrow({
    where: { shop },
  });
  let cursor: string | null = settings.customerSyncCursor;
  let synced = 0;
  let hasNextPage = true;
  let page = 0;

  while (hasNextPage && page < maximumPages) {
    const response = await admin.graphql(CUSTOMERS_QUERY, {
      variables: { after: cursor },
    });
    const json = (await response.json()) as {
      data?: {
        customers?: {
          nodes: Array<{
            id: string;
            firstName: string | null;
            lastName: string | null;
            defaultEmailAddress: { emailAddress: string } | null;
            amountSpent: { amount: string; currencyCode: string };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };
    const customers = json.data?.customers;
    if (!customers) {
      throw new Error(
        json.errors?.map((error) => error.message).join(", ") ||
          "Shopify n'a pas renvoyé la liste des clients.",
      );
    }

    for (const customer of customers.nodes) {
      await upsertLoyaltyCustomer(shop, {
        id: customer.id,
        email: customer.defaultEmailAddress?.emailAddress ?? null,
        firstName: customer.firstName,
        lastName: customer.lastName,
        amountSpent: customer.amountSpent.amount,
        currencyCode: customer.amountSpent.currencyCode,
      });
      synced += 1;
    }

    hasNextPage = customers.pageInfo.hasNextPage;
    cursor = customers.pageInfo.endCursor;
    page += 1;

    await prisma.programSettings.update({
      where: { shop },
      data: {
        customerSyncCursor: hasNextPage ? cursor : null,
        customerSyncCompletedAt: hasNextPage ? undefined : new Date(),
      },
    });
  }

  return { synced, truncated: hasNextPage };
}
