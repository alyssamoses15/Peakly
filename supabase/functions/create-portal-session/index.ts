// supabase/functions/create-portal-session/index.ts
//
// Creates a Stripe Customer Portal session so users can manage billing,
// update payment methods, and cancel subscriptions directly on Stripe.
//
// Requires: STRIPE_SECRET_KEY, SITE_URL secrets in Supabase.
// The Stripe Customer Portal must be enabled in:
//   Stripe Dashboard → Settings → Billing → Customer portal

import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://getpeakly.co';

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

async function findStripeBillingByEmail(email?: string) {
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
    ) ?? subscriptions.data[0] ?? null;
    if (subscription) return { customerId: customer.id, subscription };
    return { customerId: customer.id, subscription: null };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, function: 'create-portal-session' }), {
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
      .select('stripe_customer_id').eq('user_id', userId).single();
    let customerId = sub?.stripe_customer_id;

    if (!customerId) {
      const repaired = await findStripeBillingByEmail(user.email);
      if (repaired?.customerId) {
        customerId = repaired.customerId;
        await supaAdmin.from('subscriptions').upsert({
          user_id: userId,
          stripe_customer_id: customerId,
          ...(repaired.subscription ? subToRow(repaired.subscription) : {}),
        }, { onConflict: 'user_id' });
      }
    }

    if (!customerId) {
      return new Response(JSON.stringify({ error: 'no_billing_account' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${SITE_URL}/peakly-profile.html`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
