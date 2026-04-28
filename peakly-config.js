// ─────────────────────────────────────────────────────────────────────────
// Peakly shared config + subscription helper.
// Loaded by every app page so plan/access state is consistent.
// ─────────────────────────────────────────────────────────────────────────
window.PeaklyConfig = {
  SUPABASE_URL: 'https://rofnthczzpsswdtlpahk.supabase.co',
  SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvZm50aGN6enBzc3dkdGxwYWhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MjgxNzEsImV4cCI6MjA5MjAwNDE3MX0.6K1IWbNSv0s0l283cGJbRQKF6FgnHQTAyK5s5z1zfeU',
  STRIPE_PUBLIC: 'pk_test_51TQX8KE3DQkfgMOI5keC9NahtQyFQP2YNIZbynMHqccp1yrhr6eUePoOFCmdPHsrYd2tufwc9SBmlozxvbVJfhhs00kBbo53rU',
  PRICE_MONTHLY: 'price_1TQd05E3DQkfgMOIeCTbYMx0',
  PRICE_YEARLY:  'price_1TQd05E3DQkfgMOImnOouGt8',
  SITE_URL: 'https://getpeakly.co',
  CREATE_CHECKOUT_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/create-checkout',
  CANCEL_SUBSCRIPTION_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/cancel-subscription'
};

// ─ Loads the user's subscription row and writes cache keys to localStorage.
// Returns { plan, hasAccess, trialDaysLeft, sub }. The Supabase row is
// authoritative — localStorage is only a cache to avoid flash on page nav.
window.PeaklyAuth = {
  async loadSubscription(sb, user){
    if(!sb || !user){
      return { plan:'free', hasAccess:false, trialDaysLeft:null, sub:null };
    }
    let sub = null;
    try{
      const { data } = await sb.from('subscriptions')
        .select('plan, status, trial_ends_at, current_period_end, cancel_at_period_end, billing_interval, stripe_customer_id, stripe_subscription_id')
        .eq('user_id', user.id)
        .single();
      sub = data;
    }catch(e){ /* network/RLS — fall through to free */ }

    let plan = sub?.plan || 'free';
    let hasAccess = false;
    let trialDaysLeft = null;

    if(plan === 'pro'){
      hasAccess = true;
    } else if(plan === 'trial'){
      if(sub?.trial_ends_at){
        const ends = new Date(sub.trial_ends_at);
        const now = new Date();
        const msLeft = ends - now;
        trialDaysLeft = Math.ceil(msLeft / 86400000);
        if(msLeft > 0){
          hasAccess = true;
        } else {
          // trial expired — flip to free server-side
          plan = 'free';
          hasAccess = false;
          try{ await sb.from('subscriptions').update({ plan:'free' }).eq('user_id', user.id); }catch(e){}
        }
      }
    }

    try{
      localStorage.setItem('peakly_pro', JSON.stringify(hasAccess));
      localStorage.setItem('peakly_trial', JSON.stringify(plan === 'trial'));
      localStorage.setItem('peakly_plan', plan);
      if(trialDaysLeft != null) localStorage.setItem('peakly_trial_days_left', String(trialDaysLeft));
      else localStorage.removeItem('peakly_trial_days_left');
    }catch(e){}

    return { plan, hasAccess, trialDaysLeft, sub };
  },

  // Renders a thin banner at the top of the page when a trial is nearing
  // expiry or already expired. No-op on free or pro plans.
  renderTrialBanner({ plan, trialDaysLeft }){
    const existing = document.getElementById('peakly-trial-banner');
    if(existing) existing.remove();
    if(plan !== 'trial' && plan !== 'free') return;
    if(plan === 'free' && !sessionStorage.getItem('peakly_trial_just_expired')) return;

    let msg = '', showUpgrade = true, showFree = false;
    if(plan === 'trial' && trialDaysLeft != null && trialDaysLeft <= 3 && trialDaysLeft > 0){
      msg = `Your Pro trial ends in ${trialDaysLeft} day${trialDaysLeft===1?'':'s'}. Upgrade to keep all features.`;
    } else if(plan === 'free' && sessionStorage.getItem('peakly_trial_just_expired')){
      msg = 'Your Pro trial has ended. Upgrade to Pro or continue with Free.';
      showFree = true;
    } else {
      return;
    }

    const bar = document.createElement('div');
    bar.id = 'peakly-trial-banner';
    bar.style.cssText = 'position:sticky;top:0;z-index:200;background:#FFF7ED;color:#C2410C;border-bottom:1px solid #FED7AA;padding:10px 16px;display:flex;align-items:center;justify-content:center;gap:12px;font-size:13px;font-weight:600;flex-wrap:wrap;';
    const txt = document.createElement('span');
    txt.textContent = '⏳ ' + msg;
    bar.appendChild(txt);

    if(showUpgrade){
      const up = document.createElement('a');
      up.href = 'peakly-plan.html';
      up.textContent = 'Upgrade';
      up.style.cssText = 'background:#F97316;color:#fff;padding:6px 14px;border-radius:8px;text-decoration:none;font-weight:700;font-size:12px;';
      bar.appendChild(up);
    }
    if(showFree){
      const fr = document.createElement('button');
      fr.textContent = 'Continue Free';
      fr.style.cssText = 'background:#fff;color:#C2410C;border:1px solid #FED7AA;padding:6px 14px;border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;';
      fr.onclick = ()=>{ sessionStorage.removeItem('peakly_trial_just_expired'); bar.remove(); };
      bar.appendChild(fr);
    }
    document.body.insertBefore(bar, document.body.firstChild);
  }
};
