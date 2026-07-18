export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type ShopifyCustomerSnapshot = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  amountSpent: string;
  currencyCode: string;
};

export type ShopifyOrderSnapshot = {
  id: string;
  name: string;
  processedAt: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string;
  currentTotalAmount: string;
  currencyCode: string;
  customer: ShopifyCustomerSnapshot | null;
};
