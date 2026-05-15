// supabase/functions/sync-checkout-session/index.ts
//
// Reconciles a completed Stripe Checkout Session back into Supabase. This is a
// post-checkout safety net for cases where the Stripe webhook is delayed or was
// not configured correctly.
//
// Body: { sessionId, userId }   (caller must be that user)

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, function: 'sync-checkout-session' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { sessionId, userId } = await req.json();
    if (!sessionId || !userId) {
      return new Response(JSON.stringify({ error: 'sessionId and userId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

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

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });
    const sessionUserId = session.metadata?.user_id || session.client_reference_id;
    if (session.mode !== 'subscription' || sessionUserId !== userId) {
      return new Response(JSON.stringify({ error: 'checkout session does not belong to user' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!session.subscription) {
      return new Response(JSON.stringify({ error: 'checkout session has no subscription' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const subscription = typeof session.subscription === 'string'
      ? await stripe.subscriptions.retrieve(session.subscription)
      : session.subscription as Stripe.Subscription;

    const customerId = typeof session.customer === 'string'
      ? session.customer
      : typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;

    const supaAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );
    const row = subToRow(subscription);
    const { error } = await supaAdmin.from('subscriptions').upsert({
      user_id: userId,
      ...row,
      stripe_customer_id: customerId,
    }, { onConflict: 'user_id' });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, plan: row.plan, status: row.status }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
