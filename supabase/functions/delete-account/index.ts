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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

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

    // Cancel Stripe subscription immediately if one exists.
    const { data: sub } = await supaAnon.from('subscriptions')
      .select('stripe_subscription_id').eq('user_id', userId).single();

    if (sub?.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(sub.stripe_subscription_id);
      } catch (stripeErr: unknown) {
        // If the subscription is already cancelled or doesn't exist in Stripe,
        // that's fine — continue with account deletion.
        const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr);
        if (!msg.includes('No such subscription') && !msg.includes('already canceled')) {
          throw stripeErr;
        }
      }
    }

    // Use the service role client for privileged operations.
    const supaAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Delete subscription row.
    await supaAdmin.from('subscriptions').delete().eq('user_id', userId);

    // Delete the auth user — this cascades to any tables with FK on auth.users.
    const { error: deleteError } = await supaAdmin.auth.admin.deleteUser(userId);
    if (deleteError) throw deleteError;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
