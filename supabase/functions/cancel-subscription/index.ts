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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

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

    const { data: sub } = await supa.from('subscriptions')
      .select('stripe_subscription_id').eq('user_id', userId).single();
    if (!sub?.stripe_subscription_id) {
      return new Response(JSON.stringify({ error: 'no active subscription' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: !reactivate,
    });

    // Optimistic update — the webhook will re-sync canonical state.
    await supa.from('subscriptions').update({
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
