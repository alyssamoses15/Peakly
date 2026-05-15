// ─────────────────────────────────────────────────────────────────────────
// Peakly shared config + subscription helper.
// Loaded by every app page so plan/access state is consistent.
// ─────────────────────────────────────────────────────────────────────────

// Bootstrap: wait for the Supabase JS library to load. Mobile browsers,
// content blockers, and flaky networks can silently fail the primary CDN —
// fall back to unpkg if jsdelivr never resolves the global.
window.PeaklyBoot = {
  _SUPABASE_FALLBACKS: [
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js'
  ],
  _supabaseReady: null,

  // Returns a Promise that resolves once `window.supabase` is available, or
  // rejects after all fallbacks fail. Pages should `await PeaklyBoot.waitForSupabase()`
  // instead of bailing on `typeof supabase === 'undefined'`.
  waitForSupabase(timeoutMs = 6000){
    if(this._supabaseReady) return this._supabaseReady;
    this._supabaseReady = new Promise((resolve, reject) => {
      if(typeof window.supabase !== 'undefined') return resolve(window.supabase);
      const start = Date.now();
      const tryFallback = () => {
        const url = this._SUPABASE_FALLBACKS.shift();
        if(!url){
          console.error('[Peakly] Supabase JS library failed to load from any CDN. ' +
            'Sync, auth, and subscription features will be unavailable. ' +
            'Check ad blockers, content filters, or network connectivity.');
          return reject(new Error('supabase-cdn-blocked'));
        }
        console.warn('[Peakly] Primary Supabase CDN did not load — trying fallback:', url);
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => {
          if(typeof window.supabase !== 'undefined') resolve(window.supabase);
          else tryFallback();
        };
        s.onerror = tryFallback;
        document.head.appendChild(s);
      };
      // Poll briefly for the global before triggering fallback (jsdelivr may
      // simply be slow on mobile networks).
      const poll = setInterval(() => {
        if(typeof window.supabase !== 'undefined'){
          clearInterval(poll);
          resolve(window.supabase);
        } else if(Date.now() - start > timeoutMs){
          clearInterval(poll);
          tryFallback();
        }
      }, 100);
    });
    return this._supabaseReady;
  }
};

window.PeaklyConfig = {
  SUPABASE_URL: 'https://rofnthczzpsswdtlpahk.supabase.co',
  SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvZm50aGN6enBzc3dkdGxwYWhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MjgxNzEsImV4cCI6MjA5MjAwNDE3MX0.6K1IWbNSv0s0l283cGJbRQKF6FgnHQTAyK5s5z1zfeU',
  STRIPE_PUBLIC: 'pk_live_51TQX8KE3DQkfgMOIBAr0rSsCReSMEPICCYFYP37rNPvqyR0FswVP6gdthfdByIou5fuXfmPe42gNUSvwWCZI8qxBffxWx',
  PRICE_MONTHLY: 'price_1TQaUIE3DQkfgMOIUcCyy9B6',
  PRICE_YEARLY:  'price_1TQaVnE3DQkfgMOIXA3cUboC',
  SITE_URL: 'https://getpeakly.co',
  PAYMENT_LINK_MONTHLY: 'https://buy.stripe.com/cNi00j2jzafW4fsaD97Zu00',
  PAYMENT_LINK_YEARLY: 'https://buy.stripe.com/7sYaEX2jzafWh2efXt7Zu01',
  CANCEL_SUBSCRIPTION_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/cancel-subscription',
  CREATE_PORTAL_SESSION_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/create-portal-session'
};

// ─ Loads the user's subscription row and writes cache keys to localStorage.
// Returns { plan, hasAccess, trialDaysLeft, sub }. The Supabase row is
// authoritative — localStorage is only a cache to avoid flash on page nav.
window.PeaklyAuth = {
  _serverSubscription: null,

  _publishSubscription(result){
    const stamped = Object.assign({ fetchedAt: Date.now() }, result || {});
    this._serverSubscription = stamped;
    // Keep a simple global for the older static pages, but only from a
    // subscription row just loaded through Supabase in this page session.
    window.hasProAccess = !!stamped.hasAccess;
    try{
      window.dispatchEvent(new CustomEvent('peakly:entitlements-updated', { detail: stamped }));
    }catch(e){}
    return stamped;
  },

  hasServerAccess(maxAgeMs = null){
    const sub = this._serverSubscription;
    if(!sub || !sub.fetchedAt) return false;
    if(maxAgeMs != null && Date.now() - sub.fetchedAt > maxAgeMs) return false;
    return !!sub.hasAccess;
  },

  async loadSubscription(sb, user){
    if(!sb || !user){
      return this._publishSubscription({ plan:'free', hasAccess:false, trialDaysLeft:null, sub:null });
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

    return this._publishSubscription({ plan, hasAccess, trialDaysLeft, sub });
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
      || k.includes('supabase.auth')
      || k === 'peakly_logged_out'
      || k === 'peakly_last_user_id'
      || k === 'peakly_plan'
      || k === 'peakly_plan_intent'
      || k === 'peakly_plan_was_trial'
      || k === 'peakly_pro'
      || k === 'peakly_trial'
      || k === 'peakly_trial_days_left'
      || k === 'peakly_last_backup_at'
      || k === 'peakly_last_restore_at'
      || k === 'peakly_cloud_synced_at';
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
    if(this._isRestoring) return { ok:false, reason:'restoring' };
    try{
      const data = this.snapshot();
      const nowIso = new Date().toISOString();
      const { error } = await sb.from('data_backups').upsert({
        user_id: user.id,
        backup_data: data,
        created_at: nowIso
      }, { onConflict: 'user_id' });
      if(error) throw error;
      localStorage.setItem('peakly_last_backup_at', String(Date.now()));
      // Track the cloud version we just wrote so checkAndPull won't fight us.
      localStorage.setItem('peakly_cloud_synced_at', nowIso);
      console.log('[Peakly] ✓ Data synced to cloud');
      return { ok:true, at:nowIso };
    }catch(e){
      console.error('[Peakly] Sync failed:', e.message);
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
        .single();
      if(error || !data){
        return { ok:true, restored:false, reason:'no-backup' };
      }
      this._isRestoring = true;
      try{
        this.applySnapshot(data.backup_data);
      } finally {
        this._isRestoring = false;
      }
      localStorage.setItem('peakly_last_restore_at', String(Date.now()));
      localStorage.setItem('peakly_cloud_synced_at', data.created_at);
      return { ok:true, restored:true, at:data.created_at };
    }catch(e){
      this._isRestoring = false;
      return { ok:false, restored:false, reason:e.message };
    }
  },

  // Get just the cloud's latest backup timestamp (cheap query).
  async getCloudBackupTime(sb, user){
    if(!sb || !user) return null;
    try{
      const { data, error } = await sb.from('data_backups')
        .select('created_at')
        .eq('user_id', user.id)
        .single();
      if(error || !data) return null;
      return data.created_at;
    }catch(e){
      return null;
    }
  },

  // Compare cloud's latest version with what we last applied; if cloud is
  // newer, restore it. Fires `peakly:sync-restored` event on success.
  async checkAndPull(sb, user){
    if(!sb || !user) return { ok:false, restored:false, reason:'no-user' };
    if(this._isRestoring) return { ok:true, restored:false, reason:'in-progress' };
    if(this._checkInFlight) return { ok:true, restored:false, reason:'check-in-flight' };
    this._checkInFlight = true;
    try{
      const cloudAt = await this.getCloudBackupTime(sb, user);
      if(!cloudAt) return { ok:true, restored:false, reason:'no-cloud-backup' };
      const localAt = localStorage.getItem('peakly_cloud_synced_at');
      if(localAt && new Date(cloudAt).getTime() <= new Date(localAt).getTime()){
        return { ok:true, restored:false, reason:'up-to-date' };
      }
      // Cloud is newer, restore it.
      const r = await this.restore(sb, user);
      if(r.restored){
        try{ window.dispatchEvent(new CustomEvent('peakly:sync-restored', { detail:{ at:r.at } })); }catch(e){}
        console.log('[Peakly] ✓ Pulled newer data from cloud (' + cloudAt + ')');
      }
      return r;
    }catch(e){
      return { ok:false, restored:false, reason:e.message };
    } finally {
      this._checkInFlight = false;
    }
  },

  // Debounced background backup. Call freely; only one push fires per
  // BACKUP_INTERVAL_MS. Use during normal app activity.
  _backupTimer: null,
  _BACKUP_INTERVAL_MS: 3000,
  _PULL_INTERVAL_MS: 8000,
  _sbRef: null,
  _userRef: null,
  _isRestoring: false,
  _checkInFlight: false,
  _hooksInstalled: false,
  _beforeUnloadInstalled: false,
  scheduleBackup(sb, user){
    this._sbRef = sb;
    this._userRef = user;
    clearTimeout(this._backupTimer);
    this._backupTimer = setTimeout(async ()=>{
      if(this._sbRef && this._userRef) await this.backup(this._sbRef, this._userRef);
    }, this._BACKUP_INTERVAL_MS);
  },

  _fireRestored(at){
    try{ window.dispatchEvent(new CustomEvent('peakly:sync-restored', { detail:{ at } })); }catch(e){}
  },

  // Install hooks on Storage.prototype. Assigning localStorage.setItem directly
  // is ignored in some browsers, which meant edits were never queued for backup.
  _installStorageHooks(){
    if(this._hooksInstalled) return;
    const self = this;
    const install = (target, bindTarget) => {
      const origSet = target.setItem;
      const origRemove = target.removeItem;
      const origClear = target.clear;
      if(typeof origSet !== 'function' || typeof origRemove !== 'function') return false;
      target.setItem = function(k, v){
        const storage = bindTarget || this;
        const oldValue = storage === localStorage ? storage.getItem(k) : null;
        const result = origSet.call(storage, k, v);
        if(storage === localStorage && !self._isRestoring && !self._skipKey(k) && oldValue !== String(v)){
          self.scheduleBackup(self._sbRef, self._userRef);
        }
        return result;
      };
      target.removeItem = function(k){
        const storage = bindTarget || this;
        const hadValue = storage === localStorage && storage.getItem(k) !== null;
        const result = origRemove.call(storage, k);
        if(storage === localStorage && !self._isRestoring && !self._skipKey(k) && hadValue){
          self.scheduleBackup(self._sbRef, self._userRef);
        }
        return result;
      };
      if(typeof origClear === 'function'){
        target.clear = function(){
          const storage = bindTarget || this;
          let hadSyncableData = false;
          if(storage === localStorage){
            for(let i=0; i<storage.length; i++){
              const k = storage.key(i);
              if(!self._skipKey(k)){
                hadSyncableData = true;
                break;
              }
            }
          }
          const result = origClear.call(storage);
          if(storage === localStorage && hadSyncableData && !self._isRestoring){
            self.scheduleBackup(self._sbRef, self._userRef);
          }
          return result;
        };
      }
      return true;
    };
    try{
      const proto = Object.getPrototypeOf(localStorage);
      if(install(proto, null)){
        this._hooksInstalled = true;
        return;
      }
    }catch(e){}
    try{
      if(install(localStorage, localStorage)) this._hooksInstalled = true;
    }catch(e){}
  },

  // Listen for any localStorage change and queue a backup. Call on every
  // page boot after auth is resolved.
  startAutoBackup(sb, user){
    if(!sb || !user) return;
    this._sbRef = sb;
    this._userRef = user;
    this._installStorageHooks();
    const self = this;
    // Also push on tab close.
    if(!this._beforeUnloadInstalled){
      this._beforeUnloadInstalled = true;
      window.addEventListener('beforeunload', ()=>{ self.backup(self._sbRef, self._userRef); });
    }
  },

  // Pull from cloud on tab focus, visibility change, and on a periodic
  // interval. Call once per page after auth is resolved. Pages that want
  // to refresh their UI when remote data lands should listen for the
  // `peakly:sync-restored` window event.
  startSyncPolling(sb, user){
    if(!sb || !user) return;
    this._sbRef = sb;
    this._userRef = user;
    if(this._pollingStarted) return;
    this._pollingStarted = true;
    const self = this;
    const pull = ()=>{ if(!document.hidden) self.checkAndPull(self._sbRef, self._userRef); };
    // Initial pull
    pull();
    // Periodic pull
    this._pullInterval = setInterval(pull, this._PULL_INTERVAL_MS);
    // Pull when tab gains focus
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) self.checkAndPull(self._sbRef, self._userRef); });
    window.addEventListener('focus', ()=>{ self.checkAndPull(self._sbRef, self._userRef); });
  },

  // Shared page bootstrap: pull newer cloud data first, create the initial
  // backup when none exists, then watch local edits and poll for remote edits.
  async init(sb, user, opts = {}){
    if(!sb || !user) return { ok:false, restored:false, reason:'no-user' };
    this._sbRef = sb;
    this._userRef = user;
    const options = Object.assign({ backupIfMissing:true, reloadOnRestore:false, dispatchOnRestore:true }, opts);
    let result = { ok:true, restored:false, reason:'up-to-date' };
    try{
      const cloudAt = await this.getCloudBackupTime(sb, user);
      const localAt = localStorage.getItem('peakly_cloud_synced_at');
      if(cloudAt && (!localAt || new Date(cloudAt).getTime() > new Date(localAt).getTime())){
        result = await this.restore(sb, user);
        if(result.restored){
          if(options.dispatchOnRestore) this._fireRestored(result.at);
          if(options.reloadOnRestore){
            window.location.reload();
            return result;
          }
        }
      } else if(!cloudAt && options.backupIfMissing){
        result = await this.backup(sb, user);
      }
    }catch(e){
      result = { ok:false, restored:false, reason:e.message };
    } finally {
      this.startAutoBackup(sb, user);
      this.startSyncPolling(sb, user);
    }
    return result;
  }
};