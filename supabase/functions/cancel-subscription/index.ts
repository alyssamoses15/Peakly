// supabase/functions/cancel-subscription/index.ts
//
// Cancels a Stripe subscription at period end. The webhook will eventually
// flip plan -> 'free' when the period actually ends.
//
// Body: { userId }   (caller must be that user)
//
// Deploy:
//   npx supabase functions deploy cancel-subscription

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

async function findActiveSubscriptionByEmail(email?: string) {
  if (!email) return null;
  const customers = await stripe.customers.list({ email, limit: 10 });
  for (const customer of customers.data) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 10,
    });
    const subscription = subscriptions.data.find((sub: Stripe.Subscription) =>
      ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)
    );
    if (subscription) return { customerId: customer.id, subscription };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, function: 'cancel-subscription' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { userId, reactivate } = await req.json();
    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const supa = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supa.auth.getUser();
    if (!user || user.id !== userId) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supaAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );
    const { data: sub } = await supaAdmin.from('subscriptions')
      .select('stripe_subscription_id').eq('user_id', userId).single();
    let subscriptionId = sub?.stripe_subscription_id;

    if (!subscriptionId) {
      const repaired = await findActiveSubscriptionByEmail(user.email);
      if (repaired?.subscription) {
        subscriptionId = repaired.subscription.id;
        await supaAdmin.from('subscriptions').upsert({
          user_id: userId,
          stripe_customer_id: repaired.customerId,
          ...subToRow(repaired.subscription),
        }, { onConflict: 'user_id' });
      }
    }

    if (!subscriptionId) {
      return new Response(JSON.stringify({ error: 'no active subscription' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const updated = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: !reactivate,
    });

    // Optimistic update — the webhook will re-sync canonical state.
    await supaAdmin.from('subscriptions').update({
      cancel_at_period_end: !reactivate,
      current_period_end: new Date(updated.current_period_end * 1000).toISOString(),
    }).eq('user_id', userId);

    return new Response(JSON.stringify({ ok: true, cancel_at_period_end: !reactivate }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
