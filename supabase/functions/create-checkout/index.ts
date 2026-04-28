// supabase/functions/create-checkout/index.ts
//
// Creates a Stripe Checkout Session for a Peakly Pro subscription.
// Frontend calls this with { priceId, userId } and the function returns
// { url } which the client redirects the user to.
//
// Deploy:
//   npx supabase functions deploy create-checkout
//
// Required Supabase secrets:
//   STRIPE_SECRET_KEY  — sk_test_... or sk_live_...
//   SITE_URL           — e.g. https://getpeakly.co
//
// CORS: allows the frontend origin to POST. Adjust ALLOWED_ORIGIN in prod.

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { priceId, userId, email } = await req.json();
    if (!priceId || !userId) {
      return new Response(JSON.stringify({ error: 'priceId and userId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify the caller is the user they claim to be via JWT.
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

    // Reuse an existing Stripe customer for this user if we have one.
    let customerId: string | undefined;
    const { data: subRow } = await supa.from('subscriptions')
      .select('stripe_customer_id').eq('user_id', userId).single();
    if (subRow?.stripe_customer_id) customerId = subRow.stripe_customer_id;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer: customerId,
      customer_email: customerId ? undefined : (email || user.email),
      client_reference_id: userId,
      metadata: { user_id: userId },
      subscription_data: { metadata: { user_id: userId } },
      success_url: `${SITE_URL}/peakly.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${SITE_URL}/peakly-plan.html?checkout=canceled`,
      allow_promotion_codes: true,
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
