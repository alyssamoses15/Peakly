// supabase/functions/expire-trial/index.ts
//
// Downgrades an expired trial to Free while preserving trial_ends_at as the
// durable one-time trial marker.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, function: 'expire-trial' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const { userId } = await req.json();
    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId required' }), {
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

    const supaAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );
    const { data: sub } = await supaAdmin.from('subscriptions')
      .select('plan, trial_ends_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (!sub?.trial_ends_at) {
      return new Response(JSON.stringify({ ok: true, changed: false, reason: 'no_trial' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const trialEndsAt = new Date(sub.trial_ends_at).getTime();
    if (Number.isNaN(trialEndsAt) || trialEndsAt > Date.now()) {
      return new Response(JSON.stringify({ ok: true, changed: false, reason: 'trial_active' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (sub.plan !== 'trial') {
      return new Response(JSON.stringify({ ok: true, changed: false, reason: 'not_trial_plan' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { error } = await supaAdmin.from('subscriptions').update({
      plan: 'free',
      status: 'expired',
    }).eq('user_id', userId);
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, changed: true, plan: 'free' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
