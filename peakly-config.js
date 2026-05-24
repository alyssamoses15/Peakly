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
  CREATE_CHECKOUT_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/create-checkout',
  SYNC_CHECKOUT_SESSION_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/sync-checkout-session',
  SET_FREE_PLAN_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/set-free-plan',
  START_TRIAL_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/start-trial',
  EXPIRE_TRIAL_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/expire-trial',
  CANCEL_SUBSCRIPTION_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/cancel-subscription',
  CREATE_PORTAL_SESSION_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/create-portal-session',
  DELETE_ACCOUNT_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/delete-account',
  ANALYZE_MEAL_PHOTO_URL: 'https://rofnthczzpsswdtlpahk.supabase.co/functions/v1/analyze-meal-photo'
};

window.PeaklyEdge = {
  async isMissing(url){
    try{
      const res = await fetch(url, { method:'GET', cache:'no-store' });
      if(res.status !== 404) return false;
      const body = await res.text().catch(()=>'');
      return res.headers.get('sb-error-code') === 'NOT_FOUND'
        || body.includes('Requested function was not found');
    }catch(e){
      return false;
    }
  },

  async postJson(url, { headers = {}, body = {}, missingMessage = '' } = {}){
    if(await this.isMissing(url)){
      const err = new Error(missingMessage || 'Billing server is not deployed yet. Please deploy the Supabase Edge Function and try again.');
      err.code = 'edge_function_missing';
      throw err;
    }

    try{
      return await fetch(url, {
        method:'POST',
        headers,
        body: JSON.stringify(body)
      });
    }catch(e){
      const msg = String(e?.message || e || '');
      if(msg.includes('Failed to fetch') || msg.includes('NetworkError')){
        const err = new Error(missingMessage || 'Billing server is not reachable. Please deploy the Supabase Edge Function and try again.');
        err.code = 'edge_function_fetch_failed';
        err.cause = e;
        throw err;
      }
      throw e;
    }
  }
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
          try{
            await window.PeaklyEdge.postJson(window.PeaklyConfig.EXPIRE_TRIAL_URL, {
              headers:{
                'Content-Type':'application/json',
                'Authorization': `Bearer ${(await sb.auth.getSession()).data.session?.access_token || ''}`,
                'apikey': window.PeaklyConfig.SUPABASE_KEY
              },
              body:{ userId:user.id },
              missingMessage:'Trial expiry service is not deployed yet.'
            });
          }catch(e){
            try{ await sb.from('subscriptions').update({ plan:'free', status:'expired' }).eq('user_id', user.id); }catch(_){}
          }
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

// Shared goal/task cache helpers. Goal pages keep denormalized today/week task
// caches in peakly_goals so the static pages can render quickly from storage.
window.PeaklyGoals = {
  get(k, d){
    try{
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    }catch(e){
      return d;
    }
  },

  set(k, v){
    try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){}
  },

  dateKey(date = new Date()){
    if(date instanceof Date && !isNaN(date)) return date.toDateString();
    if(typeof date === 'string'){
      const parsed = new Date(date);
      return isNaN(parsed) ? date : parsed.toDateString();
    }
    return new Date().toDateString();
  },

  timeKey(goalId, taskId, dateStr){
    const tid = String(taskId);
    return dateStr ? 'time_' + goalId + '_' + tid + '_' + dateStr : 'time_' + goalId + '_' + tid;
  },

  getTaskTime(goalId, taskId, dateStr, fallback = ''){
    const dayTime = dateStr ? this.get(this.timeKey(goalId, taskId, dateStr), '') : '';
    if(dayTime) return dayTime;
    return this.get(this.timeKey(goalId, taskId), '') || fallback;
  },

  customTaskId(ct){
    return 'ct_' + String(ct && ct.id != null ? ct.id : '');
  },

  taskId(t){
    return String((t && (t.taskId != null ? t.taskId : t.id)) || '');
  },

  notifyChange(detail = {}){
    try{
      window.dispatchEvent(new CustomEvent('peakly:data-changed', {
        detail: Object.assign({ keys:['peakly_goals'] }, detail)
      }));
    }catch(e){}
  },

  customCacheTasks(goal, dateStr){
    const tasks = this.get('custom_tasks_' + goal.id, []);
    if(!Array.isArray(tasks) || !tasks.length) return [];
    return tasks
      .filter(ct => ct && !ct.deleted && (ct.text || ct.task || ct.name))
      .map(ct => {
        const tid = this.customTaskId(ct);
        const savedTime = this.getTaskTime(goal.id, tid, dateStr, ct.time || '09:00');
        return {
          task: ct.text || ct.task || ct.name || 'Custom task',
          time: savedTime,
          taskId: tid,
          date: dateStr,
          taskType: 'custom',
          customTaskId: ct.id,
          note: ct.note || '',
          homeKey: 'home_task_' + goal.id + '_' + tid + '_' + dateStr
        };
      });
  },

  mergeCustomTasks(goal){
    if(!goal || !goal.id) return false;
    let changed = false;
    const today = this.dateKey();
    const merge = (existing, dateStr) => {
      const base = Array.isArray(existing) ? existing.filter(t => t && t.taskType !== 'custom') : [];
      const custom = this.customCacheTasks(goal, dateStr);
      return base.concat(custom);
    };

    const nextToday = merge(goal.todayTasks, today);
    if(JSON.stringify(goal.todayTasks || []) !== JSON.stringify(nextToday)){
      goal.todayTasks = nextToday;
      changed = true;
    }

    if(goal.weekTasks && typeof goal.weekTasks === 'object'){
      Object.keys(goal.weekTasks).forEach(dateStr => {
        const next = merge(goal.weekTasks[dateStr], dateStr);
        if(JSON.stringify(goal.weekTasks[dateStr] || []) !== JSON.stringify(next)){
          goal.weekTasks[dateStr] = next;
          changed = true;
        }
      });
    }

    return changed;
  },

  syncCustomTasks(goalId, opts = {}){
    const goals = this.get('peakly_goals', []);
    if(!Array.isArray(goals)) return false;
    let changed = false;
    goals.forEach(g => {
      if(goalId != null && String(g.id) !== String(goalId)) return;
      if(this.mergeCustomTasks(g)) changed = true;
    });
    if(changed) this.set('peakly_goals', goals);
    if(changed && opts.notify !== false) this.notifyChange({ source:'custom-tasks', goalId });
    return changed;
  },

  applyTaskTime(goalId, taskId, time, opts = {}){
    if(goalId == null || taskId == null) return false;
    const tid = String(taskId);
    const dateStr = opts.dateStr || opts.dateKey || this.dateKey(opts.date || new Date());
    this.set(this.timeKey(goalId, tid, dateStr), time || '');

    const goals = this.get('peakly_goals', []);
    let changed = false;
    if(Array.isArray(goals)){
      const goal = goals.find(g => String(g.id) === String(goalId));
      if(goal){
        const updateList = list => {
          if(!Array.isArray(list)) return false;
          let listChanged = false;
          list.forEach(t => {
            if(this.taskId(t) === tid && t.time !== time){
              t.time = time;
              t.date = dateStr;
              listChanged = true;
            }
          });
          return listChanged;
        };
        if(dateStr === this.dateKey() && updateList(goal.todayTasks)) changed = true;
        if(goal.weekTasks && typeof goal.weekTasks === 'object' && updateList(goal.weekTasks[dateStr])) changed = true;
      }
    }

    if(changed && Array.isArray(goals)) this.set('peakly_goals', goals);
    if(opts.notify !== false) this.notifyChange({ source:'task-time', goalId, taskId:tid, dateStr });
    return changed;
  },

  applyTaskDone(goalId, taskId, done, opts = {}){
    const goals = this.get('peakly_goals', []);
    if(!Array.isArray(goals)) return false;
    let changed = false;
    goals.forEach(g => {
      if(String(g.id) !== String(goalId)) return;
      (g.todayTasks || []).forEach(t => {
        if(this.taskId(t) === String(taskId) && t.done !== done){
          t.done = done;
          changed = true;
        }
      });
    });
    if(changed) this.set('peakly_goals', goals);
    if(changed && opts.notify !== false) this.notifyChange({ source:'task-done', goalId, taskId });
    return changed;
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Cross-device data sync via JSONB backup of localStorage to Supabase.
// Phase 1 of the cross-device strategy — covers everything in one shot.
// ─────────────────────────────────────────────────────────────────────────
window.PeaklySync = {
  _PHOTO_DATA_URL_SYNC_LIMIT: 90000,
  _lastSnapshotSanitized: false,

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

  _sanitizeCalorieEntriesValue(v){
    this._lastSnapshotSanitized = false;
    if(!v) return v;
    try{
      const entries = JSON.parse(v);
      if(!Array.isArray(entries)) return v;
      let changed = false;
      const safeEntries = entries.map(entry => {
        if(!entry || typeof entry !== 'object') return entry;
        if(typeof entry.photo === 'string' && entry.photo.startsWith('data:image/') && entry.photo.length > this._PHOTO_DATA_URL_SYNC_LIMIT){
          changed = true;
          return Object.assign({}, entry, {
            photo: '',
            photoOmitted: true
          });
        }
        return entry;
      });
      this._lastSnapshotSanitized = changed;
      return changed ? JSON.stringify(safeEntries) : v;
    }catch(e){
      return v;
    }
  },

  _sanitizeValueForBackup(k, v){
    if(k !== 'calorie_entries') return v;
    return this._sanitizeCalorieEntriesValue(v);
  },

  cleanupLocalHeavyData(){
    try{
      const current = localStorage.getItem('calorie_entries');
      const cleaned = this._sanitizeCalorieEntriesValue(current);
      if(this._lastSnapshotSanitized && cleaned !== current){
        localStorage.setItem('calorie_entries', cleaned);
        return true;
      }
    }catch(e){}
    return false;
  },

  // Snapshot all syncable localStorage keys into a plain object.
  snapshot(){
    const out = {};
    for(let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      if(this._skipKey(k)) continue;
      out[k] = this._sanitizeValueForBackup(k, localStorage.getItem(k));
    }
    return out;
  },

  // Write snapshot back into localStorage. Wipes any keys not present in
  // the snapshot (so deletes propagate across devices).
  applySnapshot(snap){
    if(!snap || typeof snap !== 'object') return false;
    let sanitized = false;
    const safeSnap = {};
    for(const [k,v] of Object.entries(snap)){
      if(this._skipKey(k)){
        sanitized = true;
        continue;
      }
      if(k === 'calorie_entries'){
        const cleaned = this._sanitizeCalorieEntriesValue(v);
        if(this._lastSnapshotSanitized) sanitized = true;
        safeSnap[k] = cleaned;
      } else {
        safeSnap[k] = v;
      }
    }
    const incoming = new Set(Object.keys(safeSnap));
    // Remove local-only keys that aren't in the snapshot (deletions sync too).
    const toRemove = [];
    for(let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      if(this._skipKey(k)) continue;
      if(!incoming.has(k)) toRemove.push(k);
    }
    toRemove.forEach(k=>localStorage.removeItem(k));
    // Write the snapshot.
    for(const [k,v] of Object.entries(safeSnap)){
      try{ localStorage.setItem(k, v); }catch(e){}
    }
    return sanitized;
  },

  cleanupSignedInDeviceState(user){
    try{ localStorage.removeItem('peakly_logged_out'); }catch(e){}
    if(user?.id){
      try{ localStorage.setItem('peakly_last_user_id', user.id); }catch(e){}
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
      let sanitized = false;
      try{
        sanitized = this.applySnapshot(data.backup_data);
      } finally {
        this._isRestoring = false;
      }
      localStorage.setItem('peakly_last_restore_at', String(Date.now()));
      localStorage.setItem('peakly_cloud_synced_at', data.created_at);
      if(sanitized){
        // Replace old oversized cloud snapshots so mobile browsers do not keep
        // restoring data that can crowd out the Supabase session.
        await this.backup(sb, user);
      }
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
      this.cleanupSignedInDeviceState(user);
      const cleanedLocal = this.cleanupLocalHeavyData();
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
      } else if(cleanedLocal){
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

// ── Mobile-safe auth helpers ─────────────────────────────────────────────
// On mobile (especially iPhone Safari), getSession() can return null briefly
// while the session token is still loading from IndexedDB/localStorage.
// This helper retries with backoff and then listens for the auth state change
// before giving up and redirecting to login.

window.PeaklyAuth = window.PeaklyAuth || {};

// Creates a Supabase client with persistence options required for mobile.
window.PeaklyAuth.createClient = function(url, key){
  return supabase.createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    }
  });
};

// Resolves to a session object, or null after all retries are exhausted.
// Never throws. Caller is responsible for redirecting if null is returned.
window.PeaklyAuth.robustGetSession = async function(sbClient){
  // Mobile may still be loading storage, especially after Safari restores a tab.
  // Retry a few times before redirecting so a slow session read does not look
  // like a logout.
  const waits = [0, 350, 900, 1800];
  for(const wait of waits){
    if(wait) await new Promise(r => setTimeout(r, wait));
    try{
      const { data:{ session } } = await sbClient.auth.getSession();
      if(session) return session;
    }catch(e){}
  }

  // Still nothing — listen for up to 4s for INITIAL_SESSION/SIGNED_IN to fire.
  return new Promise(resolve => {
    let sub;
    const timer = setTimeout(() => {
      try{ sub?.subscription?.unsubscribe(); }catch(e){}
      resolve(null);
    }, 4000);
    try{
      sub = sbClient.auth.onAuthStateChange((_event, sess) => {
        if(sess){
          clearTimeout(timer);
          try{ sub?.subscription?.unsubscribe(); }catch(e){}
          resolve(sess);
        }
      });
    }catch(e){ clearTimeout(timer); resolve(null); }
  });
};

window.PeaklyAuth.getSession = async function(sbClient){
  if(!sbClient) return null;
  if(this.robustGetSession) return this.robustGetSession(sbClient);
  try{
    const { data:{ session } } = await sbClient.auth.getSession();
    return session || null;
  }catch(e){
    return null;
  }
};