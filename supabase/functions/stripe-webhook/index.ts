// supabase/functions/stripe-webhook/index.ts
//
// Receives Stripe webhook events and keeps the Supabase `subscriptions`
// table in sync. Handles:
//   - checkout.session.completed       → activate pro subscription
//   - customer.subscription.updated    → sync plan/status/period changes
//   - customer.subscription.deleted    → downgrade to free
//   - invoice.payment_failed           → mark payment failure
//
// Required Supabase secrets:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET   (whsec_... from Stripe Dashboard → Webhooks)
//
// Deploy:
//   npx supabase functions deploy stripe-webhook

import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

const supaAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Maps a Stripe subscription object to the columns in our subscriptions table.
function subToRow(sub: Stripe.Subscription) {
  const interval = (sub.items.data[0]?.plan?.interval === 'year') ? 'year' : 'month';
  const status = sub.status;
  const plan = (status === 'active' || status === 'trialing') ? 'pro' : 'free';

  return {
    plan,
    status,
    billing_interval: interval,
    stripe_subscription_id: sub.id,
    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    cancel_at_period_end: sub.cancel_at_period_end,
    trial_ends_at: null,
  };
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.user_id || session.client_reference_id;
  if (!userId) {
    console.error('[webhook] checkout.session.completed missing user_id');
    return;
  }

  const subId = session.subscription as string;
  if (!subId) {
    console.error('[webhook] checkout.session.completed missing subscription id');
    return;
  }
  const sub = await stripe.subscriptions.retrieve(subId);
  const row = subToRow(sub);
  const customerId = typeof session.customer === 'string'
    ? session.customer
    : typeof sub.customer === 'string'
      ? sub.customer
      : sub.customer.id;

  console.log(`[webhook] checkout completed — userId=${userId} subId=${subId} status=${sub.status}`);

  const { error } = await supaAdmin.from('subscriptions').upsert({
    user_id: userId,
    ...row,
    stripe_customer_id: customerId,
  }, { onConflict: 'user_id' });

  if (error) {
    console.error('[webhook] failed to upsert subscriptions on checkout:', error.message);
  } else {
    console.log(`[webhook] ✓ checkout completed for user ${userId} — plan set to ${row.plan}, status=${row.status}`);
  }
}

async function handleSubscriptionUpdated(sub: Stripe.Subscription) {
  const userId = sub.metadata?.user_id;
  if (!userId) {
    const { data } = await supaAdmin.from('subscriptions')
      .select('user_id').eq('stripe_subscription_id', sub.id).single();
    if (!data?.user_id) {
      console.error('[webhook] subscription.updated — cannot find user for sub', sub.id);
      return;
    }
    await supaAdmin.from('subscriptions').update(subToRow(sub)).eq('user_id', data.user_id);
    console.log(`[webhook] ✓ subscription updated for user ${data.user_id} — status: ${sub.status}`);
    return;
  }

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const { error } = await supaAdmin.from('subscriptions').upsert({
    user_id: userId,
    ...subToRow(sub),
    stripe_customer_id: customerId,
  }, { onConflict: 'user_id' });
  if (error) {
    console.error('[webhook] failed to update subscription:', error.message);
  } else {
    console.log(`[webhook] ✓ subscription updated for user ${userId} — status: ${sub.status}`);
  }
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription) {
  const { data } = await supaAdmin.from('subscriptions')
    .select('user_id').eq('stripe_subscription_id', sub.id).single();

  if (!data?.user_id) {
    console.error('[webhook] subscription.deleted — cannot find user for sub', sub.id);
    return;
  }

  const { error } = await supaAdmin.from('subscriptions').update({
    plan: 'free',
    status: 'canceled',
    cancel_at_period_end: false,
    stripe_subscription_id: sub.id,
  }).eq('user_id', data.user_id);

  if (error) {
    console.error('[webhook] failed to downgrade on subscription delete:', error.message);
  } else {
    console.log(`[webhook] ✓ subscription deleted for user ${data.user_id} — downgraded to free`);
  }
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const subId = invoice.subscription as string;
  if (!subId) return;

  const { data } = await supaAdmin.from('subscriptions')
    .select('user_id').eq('stripe_subscription_id', subId).single();

  if (!data?.user_id) {
    console.error('[webhook] invoice.payment_failed — cannot find user for sub', subId);
    return;
  }

  const { error } = await supaAdmin.from('subscriptions').update({
    status: 'past_due',
  }).eq('user_id', data.user_id);

  if (error) {
    console.error('[webhook] failed to mark past_due:', error.message);
  } else {
    console.log(`[webhook] ✓ payment failed for user ${data.user_id} — marked past_due`);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const sig = req.headers.get('stripe-signature');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

  if (!sig || !webhookSecret) {
    console.error('[webhook] missing stripe-signature or STRIPE_WEBHOOK_SECRET');
    return new Response('Webhook secret not configured', { status: 400, headers: corsHeaders });
  }

  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err) {
    console.error('[webhook] signature verification failed:', (err as Error).message);
    return new Response(`Webhook signature failed: ${(err as Error).message}`, {
      status: 400, headers: corsHeaders,
    });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      default:
        console.log(`[webhook] unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error('[webhook] handler error:', (err as Error).message);
    return new Response(`Handler error: ${(err as Error).message}`, {
      status: 500, headers: corsHeaders,
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
