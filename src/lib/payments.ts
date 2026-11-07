import { env, isProduction } from "../app/config/env.config.js";

// One small adapter per payment provider, so adding SSLCommerz or bKash touches only this file and the
// route that receives their answer. The server sets the amount; the provider only collects it.
export interface CheckoutRequest {
  paymentId: string;
  amountMinor: bigint;
  currency: string;
  description: string;
  customer: { name: string; email: string };
}

export interface PaymentGateway {
  name: string;
  // Where to send the person to pay.
  startCheckout(request: CheckoutRequest): Promise<{ redirectUrl: string }>;
}

// A pretend payment page in the web app. Nothing is charged; the page lets you choose to pay, fail or
// cancel, to test what happens in each case.
const demoGateway: PaymentGateway = {
  name: "demo",
  startCheckout: async (request) => ({ redirectUrl: `${env.APP_URL}/pay/demo/${request.paymentId}` }),
};

export const demoGatewayAllowed = () => env.PAYMENT_GATEWAY === "demo" && (!isProduction || env.PAYMENT_DEMO_IN_PRODUCTION);

export const paymentGateway = (): PaymentGateway | null => {
  if (env.PAYMENT_GATEWAY === "demo") return demoGatewayAllowed() ? demoGateway : null;
  return null;
};
