// supabase/functions/delete-account/index.ts
//
// Immediately cancels a Stripe subscription (if any), removes the
// subscriptions row, then deletes the Supabase auth user.
//
// Body: { userId }   (caller must be that user)
//
// Required Supabase secrets:
//   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  — needed to delete auth users
//
// Deploy:
//   npx supabase functions deploy delete-account

import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BILLABLE_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
  'paused',
]);

async function listBillableSubscriptionIdsForCustomer(customerId: string) {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });
  return subscriptions.data
    .filter((sub: Stripe.Subscription) => BILLABLE_STATUSES.has(sub.status))
    .map((sub: Stripe.Subscription) => sub.id);
}

async function findBillableSubscriptionIdsByEmail(email?: string) {
  if (!email) return [];
  const ids = new Set<string>();
  const customers = await stripe.customers.list({ email, limit: 100 });
  for (const customer of customers.data) {
    const customerIds = await listBillableSubscriptionIdsForCustomer(customer.id);
    customerIds.forEach((id: string) => ids.add(id));
  }
  return [...ids];
}

async function cancelSubscriptionNow(subscriptionId: string) {
  try {
    await stripe.subscriptions.cancel(subscriptionId);
    return true;
  } catch (stripeErr: unknown) {
    const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr);
    if (msg.includes('No such subscription') || msg.includes('already canceled')) {
      return false;
    }
    throw stripeErr;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, function: 'delete-account' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { userId } = await req.json();
    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify the caller is the user they claim to be via JWT.
    const authHeader = req.headers.get('Authorization') ?? '';
    const supaAnon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supaAnon.auth.getUser();
    if (!user || user.id !== userId) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Use the service role client for privileged operations.
    const supaAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Cancel every Stripe subscription we can associate with this user before
    // deleting the auth account. If cancellation fails, abort deletion so the
    // user can retry instead of silently leaving a billable subscription behind.
    const { data: sub } = await supaAdmin.from('subscriptions')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('user_id', userId)
      .single();
    const subscriptionIds = new Set<string>();
    if (sub?.stripe_subscription_id) subscriptionIds.add(sub.stripe_subscription_id);
    if (sub?.stripe_customer_id) {
      const ids = await listBillableSubscriptionIdsForCustomer(sub.stripe_customer_id);
      ids.forEach((id: string) => subscriptionIds.add(id));
    }
    const emailIds = await findBillableSubscriptionIdsByEmail(user.email);
    emailIds.forEach((id) => subscriptionIds.add(id));

    const canceledSubscriptionIds: string[] = [];
    for (const subscriptionId of subscriptionIds) {
      const canceled = await cancelSubscriptionNow(subscriptionId);
      if (canceled) canceledSubscriptionIds.push(subscriptionId);
    }

    // Delete subscription row.
    await supaAdmin.from('subscriptions').delete().eq('user_id', userId);

    // Delete the auth user — this cascades to any tables with FK on auth.users.
    const { error: deleteError } = await supaAdmin.auth.admin.deleteUser(userId);
    if (deleteError) throw deleteError;

    return new Response(JSON.stringify({ ok: true, canceled_subscription_ids: canceledSubscriptionIds }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
