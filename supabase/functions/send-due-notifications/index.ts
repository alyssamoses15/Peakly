// supabase/functions/send-due-notifications/index.ts
//
// Scheduled job (run this on a cron, e.g. every 5 minutes) that pushes a
// background notification to every subscribed device when a task or event
// is about to start. Works even when the user doesn't have Peakly open,
// unlike the in-tab setTimeout-based reminders.
//
// Required Supabase secrets:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   (see peakly-config.js for the
//                                          matching public key)
//   CRON_SECRET                            shared secret this function
//                                          requires in an `x-cron-secret`
//                                          header, so it can't be triggered
//                                          by random internet requests.
// Optional:
//   VAPID_SUBJECT   (defaults to 'mailto:support@getpeakly.co')
//
// Data source: rather than a normalized events table, Peakly's app data
// lives in each user's `data_backups.backup_data` JSONB blob (a snapshot of
// their localStorage, kept fresh by the app's existing auto-backup). This
// function reads that same snapshot and re-derives "what's due soon" for:
//   - cal_manual_events   (manual calendar events, incl. simple repeats)
//   - cal_events          (Life Admin / vehicle / medical / etc. reminders)
//   - peakly_goals        (today's goal tasks)
// Routines and work-shift calendar entries aren't covered yet — those still
// rely on the in-tab reminder while the app is open.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function parseJSON<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    const p = JSON.parse(v);
    return (p ?? fallback) as T;
  } catch {
    return fallback;
  }
}

// Converts a wall-clock date/time in an IANA timezone to the equivalent UTC Date.
function zonedTimeToUtc(y: number, mo: number, d: number, hh: number, mi: number, tz: string): Date {
  const asUTC = Date.UTC(y, mo - 1, d, hh, mi, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(asUTC))) parts[p.type] = p.value;
  const asIfLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
  const offset = asIfLocal - asUTC;
  return new Date(asUTC - offset);
}

// Y/M/D "today" for a given instant, as observed in `tz`.
function partsInTz(now: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(now)) parts[p.type] = p.value;
  return { y: +parts.year, mo: +parts.month, d: +parts.day, dow: parts.weekday };
}

// Mirrors JS Date.prototype.toDateString(), e.g. "Wed Jul 03 2026" — matches
// the key format the client uses for per-day time overrides (time_<goal>_<task>_<dateStr>).
function toDateStringInTz(now: Date, tz: string) {
  const p = partsInTz(now, tz);
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dowIdx = WD.indexOf(p.dow);
  return `${WD[dowIdx] ?? p.dow} ${MO[p.mo - 1]} ${String(p.d).padStart(2, '0')} ${p.y}`;
}

function daysBetween(aY: number, aMo: number, aD: number, bY: number, bMo: number, bD: number) {
  const a = Date.UTC(aY, aMo - 1, aD);
  const b = Date.UTC(bY, bMo - 1, bD);
  return Math.round((b - a) / 86400000);
}

interface DueItem { key: string; title: string; body: string; url: string; notifyAtUtc: Date; }

const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function computeDueItems(snap: Record<string, string>, now: Date, tz: string): DueItem[] {
  const items: DueItem[] = [];
  const today = partsInTz(now, tz);
  const todayDateStr = toDateStringInTz(now, tz);

  // ── Manual calendar events (cal_manual_events) ──────────────────────────
  const manual = parseJSON<any[]>(snap['cal_manual_events'], []);
  for (const e of manual) {
    if (!e || !e.time || !e.date) continue;
    const base = new Date(e.date);
    if (isNaN(base.getTime())) continue;
    const repeat = e.repeat || 'none';
    const diff = daysBetween(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), today.y, today.mo, today.d);
    let occursToday = false;
    if (repeat === 'none') occursToday = diff === 0;
    else if (diff >= 0) {
      if (repeat === 'daily') occursToday = true;
      else if (repeat === 'weekly') occursToday = diff % 7 === 0;
      else if (repeat === 'weekdays') occursToday = DOW_INDEX[today.dow] >= 1 && DOW_INDEX[today.dow] <= 5;
      else if (repeat === 'monthly') occursToday = base.getUTCDate() === today.d;
    }
    if (!occursToday) continue;
    const [hh, mm] = String(e.time).split(':').map((n: string) => parseInt(n, 10));
    if (isNaN(hh)) continue;
    const eventUtc = zonedTimeToUtc(today.y, today.mo, today.d, hh, mm, tz);
    const notifyAtUtc = new Date(eventUtc.getTime() - 5 * 60 * 1000);
    items.push({
      key: 'manual_' + e.id + '_' + todayDateStr,
      title: '⏰ Starting in 5 min: ' + (e.title || 'Event'),
      body: e.time + ' — tap to open Peakly',
      url: '/peakly-calendar.html',
      notifyAtUtc,
    });
  }

  // ── Life Admin / vehicle / medical calendar events (cal_events) ────────
  const calEvents = parseJSON<any[]>(snap['cal_events'], []);
  calEvents.forEach((e, i) => {
    if (!e || !e.date || e.type === 'goal_task') return;
    const d = new Date(e.date);
    if (isNaN(d.getTime())) return;
    let evTime = e.time || '';
    if (!evTime && typeof e.date === 'string' && e.date.includes('T')) {
      const tPart = e.date.split('T')[1];
      if (tPart) evTime = tPart.slice(0, 5);
    }
    if (!evTime) return; // no specific time -> nothing to schedule a "ready" push for

    let occursToday = false;
    if (e.type === 'chore' && e.recurring) {
      const diff = daysBetween(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), today.y, today.mo, today.d);
      if (diff >= 0) {
        if (e.recurring === 'daily') occursToday = true;
        else if (e.recurring === 'weekly') occursToday = diff % 7 === 0;
        else if (e.recurring === 'biweekly') occursToday = diff % 14 === 0;
        else if (e.recurring === 'monthly') occursToday = d.getUTCDate() === today.d;
        else if (e.recurring === 'annually') occursToday = d.getUTCDate() === today.d && (d.getUTCMonth() + 1) === today.mo;
      }
    } else {
      occursToday = daysBetween(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), today.y, today.mo, today.d) === 0;
    }
    if (!occursToday) return;

    const [hh, mm] = evTime.split(':').map((n: string) => parseInt(n, 10));
    if (isNaN(hh)) return;
    const eventUtc = zonedTimeToUtc(today.y, today.mo, today.d, hh, mm, tz);
    const notifyAtUtc = new Date(eventUtc.getTime() - 5 * 60 * 1000);
    items.push({
      key: 'lifeadmin_' + i + '_' + (e.key || e.title || 'item') + '_' + todayDateStr,
      title: '⏰ Coming up: ' + (e.title || 'Reminder'),
      body: evTime + ' — tap to open Peakly',
      url: '/peakly-second-brain-1.html',
      notifyAtUtc,
    });
  });

  // ── Today's goal tasks (peakly_goals) ───────────────────────────────────
  const goals = parseJSON<any[]>(snap['peakly_goals'], []);
  for (const g of goals) {
    if (!g || !g.startedDate || g.completed) continue;
    const sd = new Date(g.startedDate);
    if (isNaN(sd.getTime())) continue;
    const dayNum = daysBetween(sd.getUTCFullYear(), sd.getUTCMonth() + 1, sd.getUTCDate(), today.y, today.mo, today.d) + 1;
    const totalDays = g.totalDays || 90;
    if (dayNum < 1 || dayNum > totalDays) continue;
    for (const t of g.todayTasks || []) {
      const tid = t.taskId || t.id || 'task';
      const overrideKey1 = `time_${g.id}_${tid}_${todayDateStr}`;
      const overrideKey2 = `time_${g.id}_${tid}`;
      const time = snap[overrideKey1] || snap[overrideKey2] || t.time || '09:00';
      const [hh, mm] = String(time).split(':').map((n: string) => parseInt(n, 10));
      if (isNaN(hh)) continue;
      const eventUtc = zonedTimeToUtc(today.y, today.mo, today.d, hh, mm, tz);
      const notifyAtUtc = new Date(eventUtc.getTime() - 5 * 60 * 1000);
      items.push({
        key: 'goal_' + g.id + '_' + tid + '_' + todayDateStr,
        title: '⏰ Task ready: ' + (t.task || t.name || 'Task'),
        body: (g.name ? g.name + ' — ' : '') + time,
        url: '/peakly-goals.html',
        notifyAtUtc,
      });
    }
  }

  return items;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('x-cron-secret') !== cronSecret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
  if (!vapidPublic || !vapidPrivate) return json({ error: 'Push notifications are not configured yet (missing VAPID keys).' }, 501);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supa = createClient(supabaseUrl, serviceKey);

  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:support@getpeakly.co', vapidPublic, vapidPrivate);

  const { data: subs, error: subsErr } = await supa.from('push_subscriptions').select('*');
  if (subsErr) return json({ error: subsErr.message }, 500);
  if (!subs || subs.length === 0) return json({ ok: true, checked: 0, sent: 0 });

  const byUser = new Map<string, any[]>();
  for (const s of subs) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id)!.push(s);
  }

  const now = new Date();
  let checked = 0;
  let sent = 0;

  for (const [userId, userSubs] of byUser) {
    checked++;
    const { data: backupRow } = await supa.from('data_backups').select('backup_data').eq('user_id', userId).maybeSingle();
    const snap = backupRow?.backup_data as Record<string, string> | undefined;
    if (!snap) continue;

    const tz = userSubs[0].timezone || 'UTC';
    const dueItems = computeDueItems(snap, now, tz).filter(it => {
      const msSinceNotifyAt = now.getTime() - it.notifyAtUtc.getTime();
      return msSinceNotifyAt >= 0 && msSinceNotifyAt < 10 * 60 * 1000; // fire within a 10-min window of the target time
    });
    if (dueItems.length === 0) continue;

    for (const item of dueItems) {
      const { data: already } = await supa.from('push_notification_log').select('id').eq('user_id', userId).eq('item_key', item.key).maybeSingle();
      if (already) continue;

      let deliveredToAny = false;
      for (const sub of userSubs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({ title: item.title, body: item.body, url: item.url, tag: item.key })
          );
          deliveredToAny = true;
          sent++;
        } catch (err: any) {
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await supa.from('push_subscriptions').delete().eq('id', sub.id);
          }
        }
      }
      if (deliveredToAny) {
        await supa.from('push_notification_log').insert({ user_id: userId, item_key: item.key });
      }
    }
  }

  return json({ ok: true, checked, sent });
});
