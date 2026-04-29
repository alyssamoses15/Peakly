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
  PAYMENT_LINK_MONTHLY: 'https://buy.stripe.com/test_cNi00j2jzafW4fsaD97Zu00',
  PAYMENT_LINK_YEARLY: 'https://buy.stripe.com/test_7sYaEX2jzafWh2efXt7Zu01',
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

// ─────────────────────────────────────────────────────────────────────────
// Cross-device data sync via JSONB backup of localStorage to Supabase.
// Phase 1 of the cross-device strategy — covers everything in one shot.
// ─────────────────────────────────────────────────────────────────────────
window.PeaklySync = {
  // localStorage keys that should NOT be synced (per-device only).
  _skipKey(k){
    return !k
      || k.startsWith('sb-')
      || k === 'peakly_logged_out'
      || k === 'peakly_last_user_id'
      || k === 'peakly_trial_days_left';
  },

  // Snapshot all syncable localStorage keys into a plain object.
  snapshot(){
    const out = {};
    for(let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      if(this._skipKey(k)) continue;
      out[k] = localStorage.getItem(k);
    }
    return out;
  },

  // Write snapshot back into localStorage. Wipes any keys not present in
  // the snapshot (so deletes propagate across devices).
  applySnapshot(snap){
    if(!snap || typeof snap !== 'object') return;
    const incoming = new Set(Object.keys(snap));
    // Remove local-only keys that aren't in the snapshot (deletions sync too).
    const toRemove = [];
    for(let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      if(this._skipKey(k)) continue;
      if(!incoming.has(k)) toRemove.push(k);
    }
    toRemove.forEach(k=>localStorage.removeItem(k));
    // Write the snapshot.
    for(const [k,v] of Object.entries(snap)){
      try{ localStorage.setItem(k, v); }catch(e){}
    }
  },

  // Push current localStorage to Supabase as the latest backup row.
  async backup(sb, user){
    if(!sb || !user) return { ok:false, reason:'no-user' };
    try{
      const data = this.snapshot();
      // Insert new backup as latest, then mark all others as not-latest.
      const { error: insertError } = await sb.from('data_backups').insert({
        user_id: user.id,
        backup_data: data,
        is_latest: true
      });
      if(insertError) throw insertError;
      // Mark all previous is_latest=true rows for this user as false to prevent conflicts.
      await sb.from('data_backups')
        .update({ is_latest: false })
        .eq('user_id', user.id)
        .eq('is_latest', true);
      localStorage.setItem('peakly_last_backup_at', String(Date.now()));
      return { ok:true };
    }catch(e){
      return { ok:false, reason:e.message };
    }
  },

  // Pull the latest backup from Supabase into localStorage. Returns
  // { ok, restored, reason }.
  async restore(sb, user){
    if(!sb || !user) return { ok:false, restored:false, reason:'no-user' };
    try{
      const { data, error } = await sb.from('data_backups')
        .select('backup_data, created_at')
        .eq('user_id', user.id)
        .eq('is_latest', true)
        .order('created_at', { ascending:false })
        .limit(1);
      if(error || !data || data.length === 0){
        return { ok:true, restored:false, reason:'no-backup' };
      }
      const backup = data[0];
      this.applySnapshot(backup.backup_data);
      localStorage.setItem('peakly_last_restore_at', String(Date.now()));
      return { ok:true, restored:true, at:backup.created_at };
    }catch(e){
      return { ok:false, restored:false, reason:e.message };
    }
  },

  // Debounced background backup. Call freely; only one push fires per
  // BACKUP_INTERVAL_MS. Use during normal app activity.
  _backupTimer: null,
  _BACKUP_INTERVAL_MS: 8000,
  scheduleBackup(sb, user){
    if(!sb || !user) return;
    clearTimeout(this._backupTimer);
    this._backupTimer = setTimeout(()=>{ this.backup(sb, user); }, this._BACKUP_INTERVAL_MS);
  },

  // Listen for any localStorage change and queue a backup. Call once on
  // page boot after auth is resolved.
  startAutoBackup(sb, user){
    if(!sb || !user) return;
    if(this._autoBackupStarted) return;
    this._autoBackupStarted = true;
    // Patch setItem/removeItem to schedule a backup on every change.
    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    const self = this;
    localStorage.setItem = function(k, v){
      origSet(k, v);
      if(!self._skipKey(k)) self.scheduleBackup(sb, user);
    };
    localStorage.removeItem = function(k){
      origRemove(k);
      if(!self._skipKey(k)) self.scheduleBackup(sb, user);
    };
    // Also push on tab close.
    window.addEventListener('beforeunload', ()=>{ self.backup(sb, user); });
  }
};
