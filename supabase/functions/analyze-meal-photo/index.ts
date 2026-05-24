// supabase/functions/analyze-meal-photo/index.ts
//
// Uses an OpenAI vision model to estimate foods and calories from a meal photo.
// Required Supabase secret:
//   OPENAI_API_KEY
// Optional:
//   OPENAI_VISION_MODEL (defaults to gpt-4o-mini)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') return json({ ok: true, function: 'analyze-meal-photo' });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const apiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
    if (!apiKey) return json({ error: 'Meal photo analysis is not configured yet.' }, 501);

    const authHeader = req.headers.get('Authorization') ?? '';
    const supa = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: 'unauthorized' }, 401);

    const { image, hint } = await req.json();
    if (!image || typeof image !== 'string') return json({ error: 'image is required' }, 400);
    if (image.startsWith('data:image/') && image.length > 2_500_000) {
      return json({ error: 'image is too large; please try a smaller photo' }, 413);
    }

    const prompt = [
      'Estimate the foods and calories visible in this meal photo.',
      'Return JSON only with this shape:',
      '{"name":"short meal name","calories":number,"items":["item"],"confidence":"low|medium|high","notes":"brief caveat"}',
      'Calories should be a practical estimate for the visible plate portion, not per 100g.',
      hint ? `User hint: ${hint}` : '',
    ].filter(Boolean).join('\n');

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: Deno.env.get('OPENAI_VISION_MODEL') || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: 'You are a nutrition assistant. Estimate calories from images, be conservative, and return valid JSON only.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: image, detail: 'low' } },
            ],
          },
        ],
      }),
    });

    const raw = await openaiRes.json().catch(() => ({}));
    if (!openaiRes.ok) {
      return json({ error: raw.error?.message || 'Meal photo analysis failed' }, openaiRes.status);
    }

    const content = raw.choices?.[0]?.message?.content || '{}';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch (_e) {
      return json({ error: 'Meal photo analysis returned an unreadable result' }, 502);
    }

    const calories = Math.max(0, Math.round(Number(parsed.calories) || 0));
    const items = Array.isArray(parsed.items) ? parsed.items.map(String).slice(0, 8) : [];
    return json({
      name: String(parsed.name || items.join(', ') || 'Meal'),
      calories,
      items,
      confidence: String(parsed.confidence || 'medium'),
      notes: String(parsed.notes || 'Estimate only; adjust for your actual portion size.'),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
