# Send yourself to-dos (Slack → inbox)

Add something to your to-do list by messaging yourself on Slack — even while your
Mac is asleep. The message is buffered by an always-on service and turned into a
to-do the next time the app is running and unlocked.

## How it works

The app watches an **inbox folder** inside your data directory:

```
<DATA_DIR>/inbox/
```

Anything an outside service drops there is drained into a to-do on the **latest
daily note** of your chosen workspace (Settings → *Inbox*), then the file is
deleted (the to-do is now stored encrypted). Because your `DATA_DIR` lives in a
cloud-sync folder (Google Drive / Dropbox / Box), the sync service is the
always-on buffer: a to-do you send at 2am lands whenever your Mac next wakes and
you unlock.

Draining happens automatically about once a minute while the app is unlocked (and
right after you unlock), so you don't have to do anything.

### File format

Drop any of these into `inbox/`:

- **`.txt` / `.md`** — each non-empty line becomes one to-do.
- **`.json`** — `{"text":"buy milk"}`, or `["a","b"]`, or `{"items":["a","b"]}`.

Filenames don't matter. Example `groceries.txt`:

```
buy milk
call the dentist
```

## Pick your glue — Zapier, Make, or Cloudflare

All three just need to **put a file in the inbox folder** (or POST to the app —
see “Direct HTTP” below). Use whichever you like.

### Option A — Zapier (no-code, free tier)

1. **Trigger:** *Slack → New Message Posted to Channel* (make a private channel
   like `#todo-inbox` and message it), or *New Pushed Message*.
2. **Action:** *Google Drive → Upload File* (or *Dropbox → Upload File*).
   - **Folder:** your `…/MeetingNotes/inbox` folder.
   - **File content / “Create from text”:** the Slack message text (map the
     `Text` field).
   - **File name:** anything unique, e.g. `{{zap_meta_human_now}}.txt`.
3. Turn it on. (Free Zapier polls Slack every ~15 min.)

### Option B — Make (Integromat) (no-code, free tier)

1. **Trigger:** *Slack → Watch Public/Private Channel Messages* on `#todo-inbox`.
2. **Action:** *Google Drive → Upload a File* (or *Dropbox → Upload a File*) into
   your `…/MeetingNotes/inbox` folder, with the message text as the file content
   and a unique `.txt` name (e.g. `{{now}}.txt`).
3. Turn the scenario on. (Free Make runs on a ~15-min interval.)

### Option C — Cloudflare Worker (free tier, near-instant)

A ~15-line Worker receives a Slack **slash command** and writes to your Dropbox
inbox folder. Deploy a free Worker, set two secrets, and add a slash command in
Slack pointing at the Worker URL.

```js
// wrangler secret put DROPBOX_TOKEN     (a Dropbox access token, scope files.content.write)
// Optional: verify Slack's signing secret for real security (omitted for brevity).
export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('ok');
    const form = new URLSearchParams(await req.text());     // Slack sends form-encoded
    const text = (form.get('text') || '').trim();
    if (!text) return new Response('Nothing to add.');
    const path = '/MeetingNotes/inbox/' + Date.now() + '.txt'; // adjust to YOUR Dropbox path
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.DROPBOX_TOKEN,
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true, mute: true }),
        'Content-Type': 'application/octet-stream',
      },
      body: text,
    });
    return new Response(r.ok ? ('✅ Added: ' + text) : ('⚠️ Dropbox error ' + r.status));
  },
};
```

In Slack: **Your app → Slash Commands → Create** `/todo`, Request URL = your
Worker URL. Now `/todo buy milk` from anywhere adds a to-do.

> Dropbox tokens are short-lived by default; for something you set and forget,
> create a Dropbox app with a **refresh token** and exchange it in the Worker, or
> use a long-lived token if your account still offers one.

## Direct HTTP (optional): `POST /api/inbox`

If your app is reachable (e.g. via a Cloudflare Tunnel / ngrok, or you point the
Worker above at the app instead of Dropbox), you can push straight to it. This is
**near-instant but only works while the app is awake** — messages sent while the
Mac is asleep are lost, so prefer the folder route for the asleep case.

Enable it by setting an env var before launch:

```bash
INBOX_TOKEN="a-long-random-string" node server.js
```

Then POST the token + text (JSON, form-encoded, or plain text all work):

```bash
curl -X POST https://your-host/api/inbox \
  -H "X-Inbox-Token: a-long-random-string" \
  -H "Content-Type: application/json" \
  -d '{"text":"buy milk"}'
```

To point the Cloudflare Worker at the app instead of Dropbox, replace its fetch
body with:

```js
await fetch('https://your-tunnel-host/api/inbox', {
  method: 'POST',
  headers: { 'X-Inbox-Token': env.INBOX_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
});
```

## Outbound: post your agenda to Slack

The reverse direction is built in — the app can post your **due & overdue to-dos**
to a Slack channel.

1. In Slack, create an **Incoming Webhook** (api.slack.com → *Incoming Webhooks*)
   for the channel you want, and copy the URL.
2. In the app: **Settings → Slack**, paste the webhook URL, **Save**.
3. Click **Send agenda now**, or tick **Auto-send daily at HH:MM**.

The browser can't post to Slack directly (strict CSP), so the app's server proxies
it; the webhook URL is stored encrypted in your settings (or set `SLACK_WEBHOOK_URL`).

> Auto-send is best-effort **while the app is open and unlocked** — it fires on the
> first check past your chosen time each day. For a post that happens even when the
> app is closed, trigger it externally instead (e.g. a scheduled Cloudflare Worker
> that calls `POST /api/inbox`… — that's inbound; a scheduled *outbound* post would
> need the app running with data access, which the local-only model doesn't provide
> while closed).

## Distinguishing inbox to-dos

To-dos added via the inbox show a small **📥** badge so you can tell them from ones
you typed. The badge carries forward with the to-do into the next daily note.

## Security notes

- Inbox files sit **unencrypted** in the sync folder until drained (seconds to a
  couple of minutes); your notes stay encrypted. Only inbound to-do text is
  briefly in the clear.
- The `/api/inbox` endpoint is **off unless `INBOX_TOKEN` is set**, is constant-
  time compared, and **cannot read or modify any encrypted data** — a leaked
  token only lets someone add a to-do, never read your notes.
- Choose the target workspace in **Settings → Inbox**. If it has no daily note
  yet, one is created so nothing is lost.
